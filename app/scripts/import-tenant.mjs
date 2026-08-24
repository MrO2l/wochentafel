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
invites-Tabellen vorhanden).
`);
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
    let newHouseholdId;
    if (forcedHouseholdId !== null) {
      await client.query(
        `INSERT INTO households (id, name, template_data, created_at, migrated_from_instance, migrated_at)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [forcedHouseholdId, srcHousehold.name, srcHousehold.template_data, srcHousehold.created_at,
          srcHousehold.migrated_from_instance, srcHousehold.migrated_at]);
      newHouseholdId = forcedHouseholdId;
    } else {
      const res = await client.query(
        `INSERT INTO households (name, template_data, created_at, migrated_from_instance, migrated_at)
         VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [srcHousehold.name, srcHousehold.template_data, srcHousehold.created_at,
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
        [newHouseholdId, u.email, u.name, u.password_hash, u.role, u.created_at]);
      userIdMap.set(u.id, res.rows[0].id);
    }

    // ------------------------------------------------------------------
    // 3. Wochen (weeks.id wird von keiner anderen Tabelle referenziert,
    //    daher kein eigenes Mapping fuer weeks.id noetig; UNIQUE(household_
    //    id, week_start) kollisionsfrei, da newHouseholdId frisch/eindeutig)
    // ------------------------------------------------------------------
    let weeksInserted = 0;
    for (const w of srcWeeks) {
      const updatedBy = w.updated_by != null ? (userIdMap.get(w.updated_by) ?? null) : null;
      await client.query(
        `INSERT INTO weeks (household_id, week_start, data, updated_at, updated_by)
         VALUES ($1,$2,$3,$4,$5)`,
        [newHouseholdId, w.week_start, w.data, w.updated_at, updatedBy]);
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
    // 5. Validierung vor dem Commit (Zaehlvergleich Quelle/Ziel, analog
    //    ap1.1-konsolidierungs-vorlage.sql Abschnitt 5)
    // ------------------------------------------------------------------
    const ok = srcUsers.length === userIdMap.size && srcWeeks.length === weeksInserted;

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
      `("${srcHousehold.name}"), ${userIdMap.size}/${srcUsers.length} Nutzer, ` +
      `${weeksInserted}/${srcWeeks.length} Wochen, ${invitesInserted}/${srcInvites.length} Einladungen.`);
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
