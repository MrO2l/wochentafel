#!/usr/bin/env node
/* ============================================================================
 * import-tenant.mjs
 *
 * AP3.2 (Wochenplaner-Mandantenfaehigkeit): Gegenstueck zu export-tenant.mjs.
 * Spielt ein per export-tenant.mjs erzeugtes JSON-Dokument in eine (ggf.
 * leere) Ziel-DB zurueck -- isoliert, ohne andere Mandanten in dieser DB zu
 * beruehren.
 *
 * Rollenwahl: verbindet wie export-tenant.mjs ueber DATABASE_URL (Owner-/
 * Migrator-Rolle) -- Restore ist wie Export ein administrativer Vorgang.
 *
 * Geprueft (Briefing AP3.2, Punkt 2): Weil ueber die Owner-Rolle verbunden
 * wird, GREIFT KEINE RLS -- die in AP2.2 geloeste Falle ("RETURNING" wird
 * bei INSERTs zusaetzlich gegen die SELECT-Policy geprueft, siehe
 * ap2.2-testlauf-protokoll.md Abschnitt 0.4, und das nextval()-Vorgehen in
 * create-tenant.mjs) ist HIER NICHT relevant: ein normales
 * `INSERT ... RETURNING id` funktioniert fuer die Owner-Rolle direkt, ohne
 * Vorab-Reservierung der id. Die nextval()-Technik bleibt ausschliesslich
 * fuer RLS-unterworfene Verbindungen (wochenplan_app) noetig, wie in
 * server.js (Registrierung) und create-tenant.mjs.
 *
 * PK-Kollisionsbehandlung (Briefing AP3.2, Punkt 2 -- analog zur
 * AP1.1-Konsolidierungsprozedur, ap1.1-konsolidierungs-vorlage.sql):
 *   - households.id: standardmaessig wird IMMER eine neue id vergeben
 *     (INSERT ... RETURNING id, wie eine frische Mandanten-Neuanlage) --
 *     dadurch ist eine Kollision mit einem bereits vorhandenen Mandanten in
 *     der Ziel-DB strukturell ausgeschlossen. Nur wenn --household-id
 *     EXPLIZIT angegeben wird (z. B. "denselben Mandanten 1:1 in eine leere
 *     Ziel-DB zuruecklegen"), wird diese id verwendet -- aber nur nach
 *     Kollisionspruefung (fail-closed: existiert die id bereits, wird
 *     abgebrochen, kein stilles Ueberschreiben).
 *   - users.id / weeks.updated_by / invites.created_by,used_by: zeilenweises
 *     ID-Mapping alt->neu, wortgleiches Muster wie
 *     ap1.1-konsolidierungs-vorlage.sql Abschnitt 2 ("robust, keine Annahme
 *     ueber RETURNING-Reihenfolge bei Mehrzeilen-INSERT noetig").
 *   - users.email: globaler UNIQUE-Index (users_email_uidx) gilt ueber ALLE
 *     Mandanten der Ziel-DB. Vor dem eigentlichen Insert wird geprueft, ob
 *     eine der zu importierenden E-Mail-Adressen in der Ziel-DB bereits
 *     vergeben ist (z. B. weil derselbe Mandant faelschlich zweimal
 *     restored wird, oder ein Namenskonflikt mit einem anderen Mandanten
 *     vorliegt) -- bei Kollision: kontrollierter Abbruch (ROLLBACK), kein
 *     Datenverlust, keine stille UEberschreibung. Analog zu
 *     ap1.1-konsolidierungs-vorlage.sql Abschnitt 0b.
 *   - invites.code: eigener globaler Primaerschluessel (kein household_id-
 *     Bezug). Bei Kollision wird NUR der betroffene Einladungscode
 *     uebersprungen (nicht der gesamte Restore abgebrochen) und am Ende
 *     als Warnung gemeldet -- Einladungscodes sind keine kritischen
 *     Kundendaten, ein einzelner uebersprungener Code darf den Restore der
 *     eigentlichen Haushalts-/Nutzer-/Wochendaten nicht verhindern.
 *   - recipes.id: analog weeks.id wird IMMER eine frische id vergeben
 *     (id-Spalte im INSERT bewusst ausgelassen, bigserial-Default) --
 *     keine PK-Kollision moeglich, kein Mapping fuer recipes.id noetig, weil
 *     keine andere Tabelle recipes.id per DB-FK referenziert (weeks.data
 *     enthaelt hoechstens einen informativen recipeId-Snapshot-Token, kein
 *     DB-FK, siehe migrations/008_recipes.sql). recipes.created_by/
 *     updated_by werden wie weeks.updated_by ueber das bestehende
 *     userIdMap alt->neu uebersetzt. Weil recipes unabhaengig von weeks
 *     ist, gibt es keine Reihenfolgen-Kopplung zwischen beiden Tabellen
 *     beim Import.
 *   - household_key_wraps.id: analog recipes.id immer frische id (bigserial-
 *     Default, id-Spalte im INSERT ausgelassen) -- keine andere Tabelle
 *     referenziert household_key_wraps.id.
 *   - household_key_wraps.user_id: ueber dasselbe userIdMap alt->neu wie
 *     weeks.updated_by/recipes.created_by uebersetzt. NULL bleibt NULL
 *     (recovery_code-Wraps haben nie einen user_id).
 *   - household_key_wraps.invite_code: FK auf invites(code) -- MUSS daher
 *     NACH invites (Schritt 4) importiert werden. Wird der zugehoerige
 *     Invite-Code wegen einer Code-Kollision uebersprungen (siehe Schritt 4),
 *     kann der davon abhaengige pending-Wrap NICHT sinnvoll importiert
 *     werden (er wuerde sonst auf einen fremden, bereits in der Ziel-DB
 *     vorhandenen Invite eines ANDEREN Haushalts zeigen) -- anders als bei
 *     uebersprungenen Invite-Codes selbst (unkritisch, siehe Schritt 4) ist
 *     ein verlorener Wrap ein Verlust von Schluesselmaterial und wird daher
 *     NICHT still uebersprungen, sondern bricht den gesamten Restore ab
 *     (ROLLBACK, fail-closed).
 *   - household_key_wraps.household_id: immer newHouseholdId (frischer
 *     Haushalt) -- die Unique-Indizes aus Migration 009 (hoechstens ein
 *     aktiver recovery_code-Wrap je Haushalt, hoechstens ein aktiver
 *     password-Wrap je Nutzer) koennen daher nicht mit bereits vorhandenen
 *     Zeilen in der Ziel-DB kollidieren.
 *
 * NACHTRAG (Rezeptkarten-Feature, urspruenglich am 2026-08-30 als Luecke
 * dokumentiert): recipes.image_path referenziert NUR einen Dateinamen, kein
 * Pfad, kein Blob in der DB. Dieses Skript stellt AUSSCHLIESSLICH die
 * DB-Zeile wieder her, NICHT die Bilddatei selbst -- die Bilddatei muss
 * separat ueber das Volume-Backup (ops/backup-tenant-offsite.sh / ops/
 * restore-tenant-from-offsite.sh) wiederhergestellt werden, sonst zeigt
 * image_path nach dem Restore ins Leere.
 *
 * Isolationsnachweis: Da dieses Skript ausschliesslich INSERTs auf frisch
 * reservierte bzw. explizit gepruefte households.id-Werte ausfuehrt, werden
 * bestehende Zeilen anderer Mandanten in der Ziel-DB nie gelesen (ausser
 * fuer die o. g. Kollisionspruefungen) und nie verAENDERT -- kein UPDATE,
 * kein DELETE in diesem Skript.
 *
 * Aufruf-Beispiele (innerhalb des laufenden app-Containers):
 *   # Restore in die per DATABASE_URL konfigurierte DB, neue household_id:
 *   node scripts/import-tenant.mjs < tenant-6.json
 *
 *   # Restore in eine ANDERE Datenbank auf demselben Postgres-Server
 *   # (z. B. eine isolierte Test-/Wiederherstellungs-DB):
 *   node scripts/import-tenant.mjs --target-db restore_test < tenant-6.json
 *
 *   # Testlauf ohne Schreibvorgang (zeigt an, was passieren wuerde):
 *   node scripts/import-tenant.mjs --target-db restore_test --dry-run < tenant-6.json
 *
 * Entschluesselung des Backups ist BEWUSST NICHT Teil dieses Skripts, siehe
 * export-tenant.mjs und ops/restore-tenant-from-offsite.sh (Host-Ebene,
 * GPG). Details siehe
 * projects/wochenplaner-mandantenfaehigkeit/ap3.2-backup-konzept.md.
 *
 * NACHTRAG (AP3.2, projects/wochenplaner-termine-verschluesselung/plan.md,
 * Migration 009_weeks_encryption.sql):
 *   - weeks: data_ciphertext/data_nonce/key_version werden zusaetzlich zur
 *     alten data-Spalte 1:1 zurueckgeschrieben (base64 -> Buffer, siehe
 *     unb64() unten). Welche der beiden Spaltenseiten NULL ist, entscheidet
 *     ausschliesslich der Exportzustand der Quellzeile -- dieses Skript
 *     interpretiert/veraendert das nicht.
 *   - NEU: household_key_wraps wird als sechste fachliche Tabelle importiert,
 *     analog zum bestehenden Muster fuer recipes (Schritt 5). Ohne diesen
 *     Schritt wuerde ein Restore eines verschluesselten Haushalts dessen
 *     Ciphertext-Wochen zwar korrekt kopieren, aber den Zugriffsweg auf den
 *     Haushalts-Schluessel verlieren -- fauler faktischer Totalverlust trotz
 *     technisch vollstaendiger Ciphertext-Kopie.
 *   - households.encryption_status wird mitgenommen (reines Statusfeld).
 *     households.template_data wird weiterhin UNVERAENDERT durchgereicht --
 *     ob Klartext-Objekt oder Ciphertext-Envelope, spielt fuer dieses Skript
 *     keine Rolle (kein Interpretieren, kein Aendern).
 *   - Dieses Skript ent-/verschluesselt an KEINER Stelle etwas (kann es auch
 *     nicht: Owner-/Migrator-Rolle, kein Zugriff auf Nutzerpasswort oder
 *     Wiederherstellungscode). Alle bytea-Werte werden ausschliesslich als
 *     Bytes bewegt (base64-Text <-> Buffer).
 *
 * NACHTRAG (AP6.2, projects/wochenplaner-termine-verschluesselung/plan.md,
 * Migration 010_name_encryption.sql, MORROW AP6.1-Datenmodell):
 *   - households.name/users.name sind jetzt jsonb statt text (Klartext-String ODER
 *     Ciphertext-Envelope, identisches __enc:true-Muster wie template_data). srcHousehold.name/
 *     u.name werden UNVERAENDERT durchgereicht (kein Interpretieren, kein Entschluesseln, gleiches
 *     Prinzip wie bei template_data oben) -- lediglich JSON.stringify() vor dem INSERT noetig,
 *     siehe Kommentar bei den beiden betroffenen INSERT-Stellen (Postgres quotiert einen rohen
 *     JS-String sonst nicht automatisch, "invalid input syntax for type json").
 * ============================================================================ */

import pg from 'pg';

const DATABASE_URL = process.env.DATABASE_URL;

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--help' || token === '-h') { args.help = true; continue; }
    if (token === '--dry-run') { args['dry-run'] = true; continue; }
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
  node scripts/import-tenant.mjs [Optionen] < export.json

Liest ein von export-tenant.mjs erzeugtes JSON-Dokument von STDIN und spielt
es in eine (ggf. leere) Ziel-DB zurueck.

Optionen:
  --target-db <name>    Name der Ziel-Datenbank auf demselben Postgres-Server
                         wie DATABASE_URL (ersetzt nur den DB-Namen, nicht
                         Host/User/Passwort). Default: DB aus DATABASE_URL.
  --household-id <id>   Erzwingt eine bestimmte Ziel-household_id statt
                         automatisch eine neue zu vergeben. Bricht ab, falls
                         diese id in der Ziel-DB bereits existiert.
  --dry-run              Fuehrt alle Pruefungen aus, committet aber nicht
                         (ROLLBACK am Ende) -- zeigt an, was passieren wuerde.
  --help                  Diese Hilfe anzeigen

Voraussetzung: Umgebungsvariable DATABASE_URL (Owner-/Migrator-Rolle) muss
gesetzt sein -- im Docker-Compose-Stack bereits der Fall. Die Ziel-DB muss
das Schema aus app/migrations/ bereits enthalten (households/users/weeks/
invites/recipes/household_key_wraps-Tabellen vorhanden, inkl. Migration
009_weeks_encryption.sql und 010_name_encryption.sql).

Hinweis: recipes.image_path verweist nur auf einen Dateinamen. Die
eigentliche Bilddatei wird von diesem Skript NICHT wiederhergestellt --
separat ueber das Volume-Backup restaurieren (ops/restore-tenant-from-
offsite.sh), sonst zeigt image_path nach dem Restore ins Leere.

Hinweis: weeks.data_ciphertext/data_nonce und die bytea-Spalten von
household_key_wraps werden 1:1 als Bytes wiederhergestellt (base64 -> Buffer)
-- dieses Skript ent-/verschluesselt nichts. Verschluesselte Wochen bleiben
nach dem Restore nur mit dem korrekten Passwort/Wiederherstellungscode des
Haushalts entschluesselbar, exakt wie vor dem Export.
`);
}

// Reine Byte-zu-Text-Transportkodierung (Gegenstueck zu b64() in
// export-tenant.mjs) -- KEINE Kryptografie.
function unb64(str) {
  return str == null ? null : Buffer.from(str, 'base64');
}

// Gueltiger, unquotierter Postgres-Bezeichner: Buchstabe/Unterstrich am Anfang,
// danach Buchstaben/Ziffern/Unterstriche, max. 63 Zeichen (NAMEDATALEN-Limit).
// Bewusst strikt (kein "?", "&", "=", "/", Leerzeichen o. ae.) -- verhindert
// Connection-String-Injection ueber --target-db (AP4.1, Befund 2.1): ohne
// diese Pruefung koennte ein "?host=..."-Suffix den tatsaechlichen
// Verbindungsziel-Host inkl. Owner-/Migrator-Zugangsdaten aus DATABASE_URL
// umlenken.
const DB_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/;

function validateDbName(dbName) {
  if (!DB_NAME_RE.test(dbName)) {
    throw new Error(
      `Ungueltiger Datenbankname fuer --target-db: "${dbName}". ` +
      'Erlaubt sind ausschliesslich Buchstaben, Ziffern und Unterstriche, ' +
      'Beginn mit Buchstabe/Unterstrich, max. 63 Zeichen (gueltiger Postgres-Bezeichner).');
  }
  return dbName;
}

function withDatabaseName(connectionString, dbName) {
  // Ersetzt ausschliesslich den Datenbanknamen (letztes Pfadsegment vor
  // einem optionalen Query-String) einer postgres://user:pass@host:port/db-
  // URL -- bewusst simple String-Ersetzung statt der WHATWG-URL-Klasse,
  // damit Benutzername/Passwort mit Sonderzeichen unangetastet bleiben und
  // das Passwort nicht ueber eine Kommandozeilen-Option erneut angegeben
  // werden muss (siehe ap3.2-backup-konzept.md, Abschnitt Secret-Handling).
  // dbName wird VOR jeder String-Konkatenation gegen eine strikte Allowlist
  // geprueft (validateDbName) -- kein zusaetzlicher URI-Parameter kann so
  // mehr eingeschleust werden.
  validateDbName(dbName);
  const match = connectionString.match(/^(.*\/)([^/?]+)(\?.*)?$/);
  if (!match) throw new Error(`DATABASE_URL hat unerwartetes Format, kann --target-db nicht anwenden: ${connectionString}`);
  const [, prefix, , query] = match;
  return `${prefix}${dbName}${query || ''}`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { printUsage(); process.exit(0); }

  if (!DATABASE_URL) {
    console.error('Fehler: Umgebungsvariable DATABASE_URL fehlt.');
    process.exit(1);
  }

  const targetConnectionString = args['target-db']
    ? withDatabaseName(DATABASE_URL, args['target-db'])
    : DATABASE_URL;

  const forcedHouseholdId = args['household-id'] !== undefined ? Number(args['household-id']) : null;
  if (args['household-id'] !== undefined && (!Number.isInteger(forcedHouseholdId) || forcedHouseholdId <= 0)) {
    console.error('Fehler: --household-id muss eine positive ganze Zahl sein.');
    process.exit(2);
  }
  const dryRun = Boolean(args['dry-run']);

  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  if (chunks.length === 0) {
    console.error('Fehler: Keine Eingabe auf STDIN. Erwartet wird das JSON-Dokument von export-tenant.mjs.');
    process.exit(2);
  }

  let doc;
  try {
    doc = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (err) {
    console.error('Fehler: STDIN ist kein gueltiges JSON:', err.message);
    process.exit(2);
  }

  if (doc.format !== 'wochenplaner-tenant-backup-v1') {
    console.error(`Fehler: Unbekanntes/fehlendes Exportformat "${doc.format}". Erwartet: wochenplaner-tenant-backup-v1.`);
    process.exit(2);
  }
  if (!Array.isArray(doc.households) || doc.households.length !== 1) {
    console.error('Fehler: Exportdokument enthaelt nicht genau einen Haushalt. Kein Restore durchgefuehrt.');
    process.exit(2);
  }

  const srcHousehold = doc.households[0];
  const srcUsers = doc.users || [];
  const srcWeeks = doc.weeks || [];
  const srcInvites = doc.invites || [];
  const srcRecipes = doc.recipes || [];
  // household_key_wraps fehlt in Exporten vor AP3.2 (aeltere v1-Dokumente
  // ohne Verschluesselungsschema) -- Fallback auf leeres Array, kein Fehler.
  const srcKeyWraps = doc.household_key_wraps || [];

  const client = new pg.Client({ connectionString: targetConnectionString });
  await client.connect();
  try {
    await client.query('BEGIN');

    // ------------------------------------------------------------------
    // 0. Kollisionspruefungen VOR jeder Schreiboperation (fail-closed,
    //    Muster aus ap1.1-konsolidierungs-vorlage.sql Abschnitt 0a/0b)
    // ------------------------------------------------------------------
    if (forcedHouseholdId !== null) {
      const exists = await client.query('SELECT 1 FROM households WHERE id = $1', [forcedHouseholdId]);
      if (exists.rowCount > 0) {
        await client.query('ROLLBACK');
        console.error(`Fehler: household_id=${forcedHouseholdId} existiert in der Ziel-DB bereits. ` +
          'Kein Restore durchgefuehrt (keine ueberschreibende Wiederherstellung).');
        process.exit(1);
      }
    }

    if (srcUsers.length > 0) {
      const emails = srcUsers.map(u => u.email.toLowerCase());
      const collisions = await client.query(
        `SELECT email FROM users WHERE lower(email) = ANY($1::text[])`, [emails]);
      if (collisions.rowCount > 0) {
        await client.query('ROLLBACK');
        console.error('Fehler: E-Mail-Kollision mit bereits vorhandenen Nutzern in der Ziel-DB. ' +
          'Kein Restore durchgefuehrt, kein Datensatz veraendert. Kollidierende Adresse(n): ' +
          collisions.rows.map(r => r.email).join(', '));
        process.exit(1);
      }
    }

    // ------------------------------------------------------------------
    // 1. Haushalt anlegen. Owner-Rolle, keine RLS -> normales RETURNING
    //    funktioniert direkt (siehe Kommentar am Dateikopf).
    // ------------------------------------------------------------------
    // encryption_status (Migration 009): faellt bei aelteren v1-Exporten ohne
    // Verschluesselungsschema weg -- 'plaintext' entspricht dann exakt dem
    // tatsaechlichen Zustand des Quell-Haushalts (Default-Wert der Spalte).
    // template_data wird UNVERAENDERT durchgereicht (Klartext-Objekt ODER
    // Ciphertext-Envelope, siehe Kommentar am Dateikopf) -- kein Interpretieren.
    const encryptionStatus = srcHousehold.encryption_status || 'plaintext';
    // AP6.2 (Migration 010_name_encryption.sql, MORROW AP6.1-Datenmodell): households.name/
    // users.name sind jetzt jsonb statt text. srcHousehold.name/u.name (unten) sind nach dem
    // JSON.parse() der STDIN-Eingabe entweder ein JS-String (Legacy-Klartext) oder ein Envelope-
    // Objekt ({__enc:true, nonce, ciphertext, keyVersion}) -- dasselbe Feld, das export-tenant.mjs
    // unveraendert aus der jsonb-Spalte ausgelesen hat. Ein roher JS-String wird von Postgres NICHT
    // automatisch gequotet ("invalid input syntax for type json"), daher hier explizit
    // JSON.stringify() fuer BEIDE Faelle -- reine Byte-/JSON-Bewegung, dieses Skript ent-/
    // verschluesselt nichts (siehe Kommentar am Dateikopf), analog zu JSON.stringify(r.ingredients)
    // weiter unten.
    let newHouseholdId;
    if (forcedHouseholdId !== null) {
      await client.query(
        `INSERT INTO households (id, name, template_data, encryption_status, created_at, migrated_from_instance, migrated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [forcedHouseholdId, JSON.stringify(srcHousehold.name), srcHousehold.template_data, encryptionStatus,
          srcHousehold.created_at, srcHousehold.migrated_from_instance, srcHousehold.migrated_at]);
      newHouseholdId = forcedHouseholdId;
    } else {
      const res = await client.query(
        `INSERT INTO households (name, template_data, encryption_status, created_at, migrated_from_instance, migrated_at)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [JSON.stringify(srcHousehold.name), srcHousehold.template_data, encryptionStatus, srcHousehold.created_at,
          srcHousehold.migrated_from_instance, srcHousehold.migrated_at]);
      newHouseholdId = res.rows[0].id;
    }

    // ------------------------------------------------------------------
    // 2. Nutzer, zeilenweises ID-Mapping (wortgleiches Muster wie
    //    ap1.1-konsolidierungs-vorlage.sql Abschnitt 2)
    // ------------------------------------------------------------------
    const userIdMap = new Map();
    for (const u of srcUsers) {
      const res = await client.query(
        `INSERT INTO users (household_id, email, name, password_hash, role, created_at)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [newHouseholdId, u.email, JSON.stringify(u.name), u.password_hash, u.role, u.created_at]);
      userIdMap.set(u.id, res.rows[0].id);
    }

    // ------------------------------------------------------------------
    // 3. Wochen (weeks.id wird von keiner anderen Tabelle referenziert,
    //    daher kein eigenes Mapping fuer weeks.id noetig; UNIQUE(household_
    //    id, week_start) kollisionsfrei, da newHouseholdId frisch/eindeutig).
    //    data_ciphertext/data_nonce/key_version (Migration 009) werden 1:1
    //    mitgeschrieben -- base64 -> Buffer via unb64(), sonst unveraendert.
    //    Fehlen diese Felder im Quelldokument (aelterer v1-Export ohne
    //    Verschluesselungsschema), sind sie schlicht NULL, data bleibt
    //    gesetzt -- entspricht exakt weeks_plaintext_xor_ciphertext.
    // ------------------------------------------------------------------
    let weeksInserted = 0;
    for (const w of srcWeeks) {
      const updatedBy = w.updated_by != null ? (userIdMap.get(w.updated_by) ?? null) : null;
      await client.query(
        `INSERT INTO weeks (household_id, week_start, data, data_ciphertext, data_nonce, key_version, updated_at, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [newHouseholdId, w.week_start, w.data ?? null, unb64(w.data_ciphertext), unb64(w.data_nonce),
          w.key_version ?? null, w.updated_at, updatedBy]);
      weeksInserted++;
    }

    // ------------------------------------------------------------------
    // 4. Einladungen. code ist globaler PK -- bei Kollision NUR diesen
    //    Code ueberspringen (nicht den gesamten Restore abbrechen), siehe
    //    Kommentar am Dateikopf.
    // ------------------------------------------------------------------
    let invitesInserted = 0;
    const skippedInviteCodes = [];
    for (const i of srcInvites) {
      const exists = await client.query('SELECT 1 FROM invites WHERE code = $1', [i.code]);
      if (exists.rowCount > 0) {
        skippedInviteCodes.push(i.code);
        continue;
      }
      const createdBy = i.created_by != null ? (userIdMap.get(i.created_by) ?? null) : null;
      const usedBy = i.used_by != null ? (userIdMap.get(i.used_by) ?? null) : null;
      await client.query(
        `INSERT INTO invites (code, household_id, created_by, created_at, expires_at, used_at, used_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [i.code, newHouseholdId, createdBy, i.created_at, i.expires_at, i.used_at, usedBy]);
      invitesInserted++;
    }

    // ------------------------------------------------------------------
    // 5. Rezeptkarten. Kein Mapping fuer recipes.id noetig (kein DB-FK
    //    referenziert recipes.id, siehe Kommentar am Dateikopf) -- id-Spalte
    //    bewusst nicht angegeben, bigserial vergibt automatisch eine
    //    kollisionsfreie neue id. created_by/updated_by ueber userIdMap
    //    uebersetzt, analog weeks.updated_by. Unabhaengig von weeks
    //    importierbar, keine Reihenfolgen-Kopplung zwischen beiden Tabellen.
    //    image_path wird 1:1 als Dateiname mitgenommen -- die Bilddatei
    //    selbst NICHT (separates Volume-Backup, siehe Kommentar am
    //    Dateikopf).
    // ------------------------------------------------------------------
    let recipesInserted = 0;
    for (const r of srcRecipes) {
      const createdBy = r.created_by != null ? (userIdMap.get(r.created_by) ?? null) : null;
      const updatedBy = r.updated_by != null ? (userIdMap.get(r.updated_by) ?? null) : null;
      // r.ingredients ist nach JSON.parse(STDIN) ein JS-Array. node-postgres
      // serialisiert rohe JS-Arrays als Postgres-ARRAY-Literal ("{...}"),
      // NICHT als JSON -- fuer eine jsonb-Spalte muss daher explizit
      // JSON.stringify() erfolgen, sonst schlaegt der INSERT mit "invalid
      // input syntax for type json" fehl. Gleiches Muster wie in server.js
      // (POST/PUT /api/recipes, JSON.stringify(clean.ingredients)).
      await client.query(
        `INSERT INTO recipes (household_id, title, base_servings, instructions, ingredients,
                               image_path, created_at, updated_at, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [newHouseholdId, r.title, r.base_servings, r.instructions, JSON.stringify(r.ingredients),
          r.image_path, r.created_at, r.updated_at, createdBy, updatedBy]);
      recipesInserted++;
    }

    // ------------------------------------------------------------------
    // 6. household_key_wraps (Migration 009, AP3.2). MUSS nach invites
    //    (Schritt 4) und users (Schritt 2) laufen -- FK auf invites(code)
    //    bzw. Mapping ueber userIdMap. id-Spalte bewusst ausgelassen
    //    (bigserial-Default, siehe Kommentar am Dateikopf). Alle bytea-
    //    Spalten via unb64() zurueck in Buffer gewandelt -- reine
    //    Byteverschiebung, kein Kryptografie-Schritt.
    //
    //    Fail-closed bei invite_code-Kollision (siehe Kommentar am
    //    Dateikopf): ein pending-Wrap, dessen Invite-Code in Schritt 4
    //    uebersprungen wurde, wuerde sonst auf einen fremden Invite in der
    //    Ziel-DB zeigen -- das ist ein Verlust von Schluesselmaterial, kein
    //    unkritischer Einzelfall wie bei den Invites selbst, daher hier
    //    KEIN stilles Ueberspringen, sondern Abbruch des gesamten Restores.
    // ------------------------------------------------------------------
    let keyWrapsInserted = 0;
    for (const w of srcKeyWraps) {
      if (w.invite_code != null && skippedInviteCodes.includes(w.invite_code)) {
        throw new Error(
          `household_key_wraps: Wrap fuer invite_code "${w.invite_code}" kann nicht importiert werden, ` +
          'weil der zugehoerige Invite wegen einer Code-Kollision uebersprungen wurde (siehe Schritt 4). ' +
          'Ohne diesen Wrap waere Schluesselmaterial verloren -- Restore abgebrochen (fail-closed).');
      }
      const userId = w.user_id != null ? (userIdMap.get(w.user_id) ?? null) : null;
      await client.query(
        `INSERT INTO household_key_wraps
           (household_id, user_id, invite_code, wrap_type, key_version,
            wrapped_key, wrap_nonce, kdf_salt, kdf_algo, kdf_time_cost,
            kdf_memory_cost, kdf_parallelism, recovery_verifier_salt,
            recovery_verifier_hash, created_at, updated_at, expires_at, revoked_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
        [newHouseholdId, userId, w.invite_code ?? null, w.wrap_type, w.key_version,
          unb64(w.wrapped_key), unb64(w.wrap_nonce), unb64(w.kdf_salt), w.kdf_algo,
          w.kdf_time_cost, w.kdf_memory_cost, w.kdf_parallelism,
          unb64(w.recovery_verifier_salt), unb64(w.recovery_verifier_hash),
          w.created_at, w.updated_at, w.expires_at ?? null, w.revoked_at ?? null]);
      keyWrapsInserted++;
    }

    // ------------------------------------------------------------------
    // 7. Validierung vor dem Commit (Zaehlvergleich Quelle/Ziel, analog
    //    ap1.1-konsolidierungs-vorlage.sql Abschnitt 5)
    // ------------------------------------------------------------------
    const ok = srcUsers.length === userIdMap.size && srcWeeks.length === weeksInserted
      && srcRecipes.length === recipesInserted && srcKeyWraps.length === keyWrapsInserted;

    if (dryRun || !ok) {
      await client.query('ROLLBACK');
      console.error(dryRun
        ? '--dry-run: keine Aenderungen committet.'
        : 'Fehler: Zaehlvergleich nach Restore stimmt nicht, ROLLBACK durchgefuehrt.');
    } else {
      await client.query('COMMIT');
    }

    console.error(
      `${dryRun ? '[dry-run] ' : ''}Restore ${ok ? 'ok' : 'FEHLGESCHLAGEN'}: neue household_id=${newHouseholdId} ` +
      `("${srcHousehold.name}", encryption_status=${encryptionStatus}), ${userIdMap.size}/${srcUsers.length} Nutzer, ` +
      `${weeksInserted}/${srcWeeks.length} Wochen, ${invitesInserted}/${srcInvites.length} Einladungen, ` +
      `${recipesInserted}/${srcRecipes.length} Rezepte, ${keyWrapsInserted}/${srcKeyWraps.length} Schluessel-Wraps.`);
    if (srcRecipes.some(r => r.image_path)) {
      console.error('Hinweis: recipes.image_path wurde als Dateiname wiederhergestellt, ' +
        'die zugehoerigen Bilddateien selbst NICHT -- separat aus dem Volume-Backup restaurieren.');
    }
    if (skippedInviteCodes.length > 0) {
      console.error(`Warnung: ${skippedInviteCodes.length} Einladungscode(s) wegen Kollision uebersprungen: ` +
        skippedInviteCodes.join(', '));
    }
    if (!ok) process.exit(1);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Fehler beim Restore:', err.message);
    process.exit(1);
  } finally {
    await client.end();
  }
}

main().catch(err => {
  console.error('Unerwarteter Fehler:', err.message);
  process.exit(1);
});
