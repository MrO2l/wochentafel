#!/usr/bin/env node
/* ============================================================================
 * export-tenant.mjs
 *
 * AP3.2 (Wochenplaner-Mandantenfaehigkeit): Per-Tenant-Export fuer Backup/
 * Restore bei Row-Level-Isolation. Bei einer gemeinsamen DB mit gemeinsamen
 * Tabellen gibt es KEIN natives `pg_dump --schema=...` pro Kunde (siehe
 * isolationsstrategie-ap0.1.md Abschnitt 3) -- dieses Skript filtert die
 * vier fachlichen Tabellen (households, users, weeks, invites -- NICHT
 * session, ephemer, siehe ap1.1-datenmodell-migration.md) explizit nach
 * genau einem household_id und schreibt das Ergebnis als portables
 * JSON-Dokument nach STDOUT.
 *
 * NACHTRAG (Rezeptkarten-Feature, urspruenglich am 2026-08-30 als Luecke
 * dokumentiert -- knowledge/entries/2026-08-30-rezeptkarten-feature-
 * abschluss-wochenplaner.md): exportiert zusaetzlich die fuenfte fachliche
 * Tabelle `recipes` (household-gebundene Rezeptkarten, siehe
 * migrations/008_recipes.sql). `recipes.image_path` referenziert NUR einen
 * Dateinamen (kein Pfad, kein Blob in der DB) -- die eigentliche Bilddatei
 * wird von DIESEM Skript NICHT gesichert, sondern separat ueber das
 * Volume-Backup (ops/backup-tenant-offsite.sh / ops/restore-tenant-from-
 * offsite.sh). Ein vollstaendiger Tenant-Umzug erfordert daher BEIDES:
 * dieses JSON-Dokument UND das Volume-Backup der Bilddateien.
 *
 * Rollenwahl (WICHTIG): verbindet bewusst ueber DATABASE_URL (Owner-/
 * Migrator-Rolle), NICHT DATABASE_URL_APP. Backup ist ein administrativer
 * Vorgang, kein App-Laufzeitzugriff (siehe Briefing AP3.2) -- die
 * Owner-Rolle ist ohnehin von RLS ausgenommen (Owner-Bypass, siehe
 * ap1.2-rls-konzept.md Abschnitt 1), der explizite `WHERE household_id =
 * $1`-Filter pro Tabelle uebernimmt hier genau die Filterung, die fuer die
 * eingeschraenkte Laufzeit-Rolle sonst RLS leisten wuerde.
 *
 * Aufruf (innerhalb des laufenden app-Containers, gleiche Umgebung wie
 * create-tenant.mjs):
 *   docker compose exec app node scripts/export-tenant.mjs --household-id 6 \
 *     > tenant-6.json
 *
 * Verschluesselung ist BEWUSST NICHT Teil dieses Skripts (Trennung von
 * Zustaendigkeiten: dieses Skript kennt nur die DB, keine Kryptografie) --
 * siehe ops/backup-tenant-offsite.sh (Host-Ebene, GPG) fuer den
 * vollstaendigen Backup-Ablauf inkl. Verschluesselung und Ablage. Details
 * siehe projects/wochenplaner-mandantenfaehigkeit/ap3.2-backup-konzept.md.
 *
 * NACHTRAG (AP3.2, projects/wochenplaner-termine-verschluesselung/plan.md,
 * Migration 009_weeks_encryption.sql): Datenmodell fuer clientseitige
 * Ende-zu-Ende-Verschluesselung von weeks.data. Zwei Aenderungen hier:
 *   1. weeks: zusaetzlich data_ciphertext/data_nonce/key_version exportiert
 *      (data bleibt bestehen, ist aber bei verschluesselten Wochen NULL --
 *      atomarer Swap laut MORROWs Konzept, siehe weeks_plaintext_xor_
 *      ciphertext-CHECK in der Migration). Alle vier Spalten werden 1:1
 *      mitgenommen, unabhaengig vom Verschluesselungszustand der Zeile.
 *   2. NEUE Tabelle household_key_wraps wird zusaetzlich exportiert (Wrap-
 *      Daten des Haushalts-Schluessels je Nutzer/Zweck) -- OHNE diese Tabelle
 *      waere ein verschluesselter Haushalt nach einem Tenant-Umzug fuer immer
 *      unlesbar (die Ciphertext-Bytes in weeks waeren zwar korrekt kopiert,
 *      aber ohne Wrap kein Weg mehr, an den Haushalts-Schluessel zu kommen --
 *      der Schluessel selbst ist NIRGENDS serverseitig gespeichert, siehe
 *      Migration Abschnitt 3).
 * bytea-Spalten (data_ciphertext/data_nonce sowie die fuenf bytea-Spalten von
 * household_key_wraps) werden als base64-Text in JSON kodiert (siehe
 * b64() unten) -- ausschliesslich eine verlustfreie Byte-zu-Text-Kodierung
 * fuer den JSON-Transport, KEINE Ver-/Entschluesselung. Dieses Skript
 * entschluesselt an keiner Stelle etwas und kann es auch nicht: es verbindet
 * ueber die Owner-/Migrator-Rolle ohne Kenntnis irgendeines Nutzerpassworts
 * oder Wiederherstellungscodes.
 *
 * NACHTRAG (AP6.2, Migration 010_name_encryption.sql, MORROW AP6.1-Datenmodell):
 * households.name/users.name sind jetzt jsonb statt text (Klartext-String ODER Ciphertext-
 * Envelope, identisches __enc:true-Muster wie template_data) -- werden UNVERAENDERT als Teil der
 * jeweiligen Zeile mit exportiert (kein Interpretieren, kein Entschluesseln noetig, node-postgres
 * liefert den jsonb-Wert bereits als fertigen JS-String/Objekt). Einzige Anpassung: die
 * abschliessende Log-Zeile formatiert den Haushaltsnamen jetzt ueber describeHouseholdName()
 * (siehe unten), damit ein Ciphertext-Envelope dort nicht als nichtssagendes "[object Object]"
 * erscheint.
 * ============================================================================ */

import pg from 'pg';

const DATABASE_URL = process.env.DATABASE_URL;

// AP6.2: households.name ist seit Migration 010 entweder ein Klartext-String oder ein
// Ciphertext-Envelope-Objekt -- rein fuer die lesbare Log-Zeile am Ende von main(), keine
// Auswirkung auf den eigentlichen Export (doc.households wird unveraendert geschrieben).
function describeHouseholdName(name) {
  return (name && typeof name === 'object') ? '(verschlüsselt)' : name;
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--help' || token === '-h') { args.help = true; continue; }
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`Fehlender Wert fuer Option --${key}`);
    }
    args[key] = value;
    i++;
  }
  return args;
}

function printUsage() {
  console.error(`
Verwendung:
  node scripts/export-tenant.mjs --household-id <id> > export.json

Schreibt ein JSON-Dokument mit allen Daten des angegebenen Haushalts
(households/users/weeks/invites/recipes/household_key_wraps) nach STDOUT.
weeks.data_ciphertext/data_nonce und die bytea-Spalten von
household_key_wraps sind base64-kodiert (reine Transportkodierung, keine
Ent-/Verschluesselung -- siehe Kommentar am Dateikopf). Bilddateien zu
recipes.image_path sind NICHT enthalten (separates Volume-Backup, siehe
Kommentar am Dateikopf). Fehler-/Statusmeldungen gehen
nach STDERR, damit STDOUT ausschliesslich das reine Exportdokument enthaelt
(wichtig fuer die Weiterverarbeitung/Pipe in ops/backup-tenant-offsite.sh).

Voraussetzung: Umgebungsvariable DATABASE_URL (Owner-/Migrator-Rolle) muss
gesetzt sein -- im Docker-Compose-Stack bereits der Fall.
`);
}

// Reine Byte-zu-Text-Transportkodierung fuer bytea-Spalten (JSON kennt keinen
// Binaertyp) -- node-postgres liefert bytea-Werte als Buffer, NULL bleibt NULL.
// KEINE Kryptografie, siehe Kommentar am Dateikopf.
function b64(buf) {
  return buf == null ? null : Buffer.from(buf).toString('base64');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { printUsage(); process.exit(0); }

  if (!DATABASE_URL) {
    console.error('Fehler: Umgebungsvariable DATABASE_URL fehlt.');
    process.exit(1);
  }
  const householdId = Number(args['household-id']);
  if (!Number.isInteger(householdId) || householdId <= 0) {
    console.error('Fehler: --household-id fehlt oder ist keine positive ganze Zahl.');
    printUsage();
    process.exit(2);
  }

  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    // households.encryption_status (Migration 009) mitexportiert -- reines
    // Statusfeld (plaintext/activating/active), keine bytea-Spalte, kein
    // Envelope-Verstaendnis noetig. template_data wird UNVERAENDERT als JSON-
    // Wert durchgereicht -- ob es ein Legacy-Klartext-Objekt oder ein
    // Ciphertext-Envelope ({__enc:true, nonce, ciphertext, keyVersion}) ist,
    // spielt fuer dieses Skript keine Rolle (siehe Migration Abschnitt 1b).
    const householdsRes = await client.query(
      `SELECT id, name, template_data, encryption_status, created_at,
              migrated_from_instance, migrated_at
         FROM households WHERE id = $1`, [householdId]);
    if (householdsRes.rowCount === 0) {
      console.error(`Fehler: Kein Haushalt mit id=${householdId} gefunden. Kein Export erzeugt.`);
      process.exit(1);
    }

    const usersRes = await client.query(
      `SELECT id, household_id, email, name, password_hash, role, created_at
         FROM users WHERE household_id = $1 ORDER BY id`, [householdId]);

    // weeks: data_ciphertext/data_nonce/key_version (Migration 009) zusaetzlich
    // zur alten data-Spalte exportiert. Genau eine der beiden Seiten ist pro
    // Zeile NULL (weeks_plaintext_xor_ciphertext-CHECK) -- dieses Skript
    // unterscheidet nicht zwischen verschluesselten und Klartext-Wochen,
    // sondern nimmt beide Spaltenpaare unveraendert mit, egal welche Seite
    // gerade NULL ist.
    const weeksRaw = await client.query(
      `SELECT id, household_id, week_start, data, data_ciphertext, data_nonce,
              key_version, updated_at, updated_by
         FROM weeks WHERE household_id = $1 ORDER BY week_start`, [householdId]);
    const weeksRes = { rowCount: weeksRaw.rowCount, rows: weeksRaw.rows.map(w => ({
      ...w,
      data_ciphertext: b64(w.data_ciphertext),
      data_nonce: b64(w.data_nonce),
    })) };

    const invitesRes = await client.query(
      `SELECT code, household_id, created_by, created_at, expires_at, used_at, used_by
         FROM invites WHERE household_id = $1 ORDER BY created_at`, [householdId]);

    // recipes: household-gebundene Rezeptkarten (migrations/008_recipes.sql).
    // Kein FK von weeks auf recipes -- die Grid-Zuweisung ist ein
    // unabhaengiger Snapshot-Token in weeks.data (recipeId ist informativ,
    // kein DB-FK, darf ins Leere zeigen) -- deshalb hier unabhaengig von
    // weeks exportierbar, keine Reihenfolgen-Kopplung noetig.
    // image_path ist NUR ein Dateiname, siehe Kommentar am Dateikopf --
    // die Bilddatei selbst wird hier NICHT mit exportiert.
    const recipesRes = await client.query(
      `SELECT id, household_id, title, base_servings, instructions, ingredients,
              image_path, created_at, updated_at, created_by, updated_by
         FROM recipes WHERE household_id = $1 ORDER BY id`, [householdId]);

    // NEU (AP3.2, Migration 009_weeks_encryption.sql): household_key_wraps --
    // die verpackten Kopien des Haushalts-Schluessels je Nutzer/Zweck
    // (wrap_type password/recovery_code/pending). Ohne diese Tabelle waeren
    // exportierte Ciphertext-Wochen nach einem Restore fuer immer unlesbar,
    // siehe Kommentar am Dateikopf. Alle fuenf bytea-Spalten werden base64-
    // kodiert (b64()) -- reine Transportkodierung, keine Kryptografie.
    const keyWrapsRaw = await client.query(
      `SELECT id, household_id, user_id, invite_code, wrap_type, key_version,
              wrapped_key, wrap_nonce, kdf_salt, kdf_algo, kdf_time_cost,
              kdf_memory_cost, kdf_parallelism, recovery_verifier_salt,
              recovery_verifier_hash, created_at, updated_at, expires_at, revoked_at
         FROM household_key_wraps WHERE household_id = $1 ORDER BY id`, [householdId]);
    const keyWrapsRes = { rowCount: keyWrapsRaw.rowCount, rows: keyWrapsRaw.rows.map(w => ({
      ...w,
      wrapped_key: b64(w.wrapped_key),
      wrap_nonce: b64(w.wrap_nonce),
      kdf_salt: b64(w.kdf_salt),
      recovery_verifier_salt: b64(w.recovery_verifier_salt),
      recovery_verifier_hash: b64(w.recovery_verifier_hash),
    })) };

    // Bewusst KEIN Zugriff auf/Export von "session" -- ephemerer
    // Sitzungsspeicher (connect-pg-simple), keine Kundendaten im fachlichen
    // Sinn, siehe ap1.1-datenmodell-migration.md ("Migrationsweg").
    const doc = {
      format: 'wochenplaner-tenant-backup-v1',
      exported_at: new Date().toISOString(),
      source_household_id: householdId,
      households: householdsRes.rows,
      users: usersRes.rows,
      weeks: weeksRes.rows,
      invites: invitesRes.rows,
      recipes: recipesRes.rows,
      household_key_wraps: keyWrapsRes.rows,
    };

    process.stdout.write(JSON.stringify(doc));
    console.error(
      `Export ok: household_id=${householdId} ("${describeHouseholdName(householdsRes.rows[0].name)}"), ` +
      `${usersRes.rowCount} Nutzer, ${weeksRes.rowCount} Wochen, ${invitesRes.rowCount} Einladungen, ` +
      `${recipesRes.rowCount} Rezepte, ${keyWrapsRes.rowCount} Schluessel-Wraps ` +
      `(Haushalt-Verschluesselungsstatus: ${householdsRes.rows[0].encryption_status}).`);
  } finally {
    await client.end();
  }
}

main().catch(err => {
  console.error('Unerwarteter Fehler:', err.message);
  process.exit(1);
});
