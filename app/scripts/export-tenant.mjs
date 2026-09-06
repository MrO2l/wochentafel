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
 * ============================================================================ */

import pg from 'pg';

const DATABASE_URL = process.env.DATABASE_URL;

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
(households/users/weeks/invites/recipes) nach STDOUT. Bilddateien zu
recipes.image_path sind NICHT enthalten (separates Volume-Backup, siehe
Kommentar am Dateikopf). Fehler-/Statusmeldungen gehen
nach STDERR, damit STDOUT ausschliesslich das reine Exportdokument enthaelt
(wichtig fuer die Weiterverarbeitung/Pipe in ops/backup-tenant-offsite.sh).

Voraussetzung: Umgebungsvariable DATABASE_URL (Owner-/Migrator-Rolle) muss
gesetzt sein -- im Docker-Compose-Stack bereits der Fall.
`);
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
    const householdsRes = await client.query(
      `SELECT id, name, template_data, created_at, migrated_from_instance, migrated_at
         FROM households WHERE id = $1`, [householdId]);
    if (householdsRes.rowCount === 0) {
      console.error(`Fehler: Kein Haushalt mit id=${householdId} gefunden. Kein Export erzeugt.`);
      process.exit(1);
    }

    const usersRes = await client.query(
      `SELECT id, household_id, email, name, password_hash, role, created_at
         FROM users WHERE household_id = $1 ORDER BY id`, [householdId]);

    const weeksRes = await client.query(
      `SELECT id, household_id, week_start, data, updated_at, updated_by
         FROM weeks WHERE household_id = $1 ORDER BY week_start`, [householdId]);

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
    };

    process.stdout.write(JSON.stringify(doc));
    console.error(
      `Export ok: household_id=${householdId} ("${householdsRes.rows[0].name}"), ` +
      `${usersRes.rowCount} Nutzer, ${weeksRes.rowCount} Wochen, ${invitesRes.rowCount} Einladungen, ` +
      `${recipesRes.rowCount} Rezepte.`);
  } finally {
    await client.end();
  }
}

main().catch(err => {
  console.error('Unerwarteter Fehler:', err.message);
  process.exit(1);
});
