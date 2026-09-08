#!/usr/bin/env node
/* ============================================================================
 * backfill-email-lookup.mjs
 *
 * AP6.4 (Wochenplaner-Termine-Verschluesselung, MORROW ap6.3-datenmodell.md
 * Abschnitt 3.2, migrations/011_email_blind_index.sql): eigenstaendiges
 * Admin-Skript fuer den E-Mail-Blindindex-Backfill (users.email_lookup),
 * ZUSAETZLICH zum verbindlichen, immer laufenden Boot-Backfill-Schritt in
 * server.js (siehe dortiger Kommentar bei backfillEmailLookupOnBoot()) --
 * KEIN Ersatz dafuer.
 *
 * Zweck (Begleitdokument Abschnitt 3.2, Punkt 2):
 *   - Kontrollierte Vorab-Verifikation VOR einem Deploy: mit --dry-run zeigen,
 *     wie viele Bestandszeilen betroffen sind, ohne zu schreiben.
 *   - Fuer einen Betreiber, der den Backfill bewusst VOR einem App-Neustart
 *     separat anstossen moechte (z. B. um die Downtime des Neustarts selbst
 *     kurz zu halten) -- der Boot-Schritt in server.js bleibt dabei trotzdem
 *     der verbindliche, sich selbst heilende Schutz gegen den Lockout aus
 *     Abschnitt 2 des Begleitdokuments, dieses Skript ist nur ein optionales
 *     Werkzeug zusaetzlich dazu.
 *
 * Teilt sich die eigentliche Backfill-Logik mit server.js ueber
 * lib/email-lookup.mjs (runEmailLookupBackfill()) -- keine Logikduplikation,
 * wie vom Begleitdokument empfohlen.
 *
 * DB-Rolle: verbindet bewusst ueber DATABASE_URL (Owner-/Migrator-Rolle),
 * NICHT DATABASE_URL_APP -- analog zu export-tenant.mjs ("Backup ist ein
 * administrativer Vorgang, kein App-Laufzeitzugriff") und aus demselben
 * technischen Grund wie beim Boot-Backfill in server.js: die RLS-Policy auf
 * users (003_rls_policies.sql) laesst ueber die eingeschraenkte Laufzeit-
 * Rolle wochenplan_app OHNE gesetzten Sitzungskontext keine Zeile
 * sichtbar/aktualisierbar sein -- fuer einen haushaltsUEBERGREIFENDEN
 * Bulk-Backfill ist zwingend die RLS-bypassende Owner-Rolle noetig.
 *
 * Sicherheitsvorgabe (Begleitdokument Abschnitt 3.3, siehe auch
 * lib/email-lookup.mjs): keine Klartext-E-Mail wird je geloggt -- weder im
 * Normal- noch im --dry-run-Betrieb, nur Zaehlwerte/user_id.
 *
 * Aufruf (Voraussetzung: DATABASE_URL und EMAIL_HMAC_KEY sind gesetzt --
 * im Docker-Compose-Stack bereits der Fall, dieselben Variablen, die auch
 * server.js/export-tenant.mjs nutzen):
 *
 *   docker compose exec app node scripts/backfill-email-lookup.mjs --dry-run
 *   docker compose exec app node scripts/backfill-email-lookup.mjs
 *
 *   # oder ueber das npm-Skript (identisch, siehe package.json):
 *   docker compose exec app npm run backfill-email-lookup -- --dry-run
 * ============================================================================ */

import pg from 'pg';
import { runEmailLookupBackfill } from '../lib/email-lookup.mjs';

const DATABASE_URL   = process.env.DATABASE_URL;
const EMAIL_HMAC_KEY = process.env.EMAIL_HMAC_KEY;

function parseArgs(argv) {
  const args = {};
  for (const token of argv) {
    if (token === '--help' || token === '-h') { args.help = true; continue; }
    if (token === '--dry-run') { args['dry-run'] = true; continue; }
  }
  return args;
}

function printUsage() {
  console.error(`
Verwendung:
  node scripts/backfill-email-lookup.mjs [--dry-run]

Befuellt users.email_lookup (Migration 011_email_blind_index.sql) fuer jeden
Bestandsnutzer, bei dem die Spalte noch NULL ist -- idempotent (bereits
befuellte Zeilen werden uebersprungen), gibt NIRGENDS eine Klartext-E-Mail
aus (nur Zaehlwerte/user_id).

Optionen:
  --dry-run    Fuehrt alle Berechnungen aus, schreibt aber nichts in die DB --
               zeigt nur an, wie viele Zeilen betroffen waeren.
  --help       Diese Hilfe anzeigen

Hinweis: Dieses Skript ist ein ZUSAETZLICHES Werkzeug fuer kontrollierte
Vorab-Verifikation/manuell angestossene Laeufe. Der eigentliche, verbindliche
Schutz gegen einen App-weiten Login-Lockout ist der Boot-Backfill-Schritt in
server.js (laeuft bei JEDEM Serverstart automatisch, vor dem HTTP-Listener) --
dieses Skript ersetzt ihn nicht.

Voraussetzung: Umgebungsvariablen DATABASE_URL (Owner-/Migrator-Rolle) UND
EMAIL_HMAC_KEY muessen gesetzt sein -- im Docker-Compose-Stack bereits der
Fall (dieselben Variablen wie server.js/export-tenant.mjs) -- am einfachsten
ausfuehren mit:
  docker compose exec app node scripts/backfill-email-lookup.mjs --dry-run
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { printUsage(); process.exit(0); }

  if (!DATABASE_URL) {
    console.error('Fehler: Umgebungsvariable DATABASE_URL fehlt.');
    process.exit(1);
  }
  // Dieselbe Mindestlaenge wie server.js (siehe dortige Pruefung) -- ein zu kurzer/fehlender
  // Schluessel wuerde sonst stillschweigend einen falschen/schwachen email_lookup-Wert erzeugen.
  if (!EMAIL_HMAC_KEY || EMAIL_HMAC_KEY.length < 32) {
    console.error('Fehler: Umgebungsvariable EMAIL_HMAC_KEY fehlt oder ist zu kurz (mindestens 32 Zeichen).');
    process.exit(1);
  }

  const dryRun = Boolean(args['dry-run']);
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    const summary = await runEmailLookupBackfill({
      query: (sql, params) => client.query(sql, params),
      emailHmacKey: EMAIL_HMAC_KEY,
      dryRun,
      log: console
    });
    if (summary.failed > 0) process.exit(1);
  } finally {
    await client.end();
  }
}

main().catch(err => {
  // Bewusst NUR err.message hier (kein Rueckgriff auf err.stack o. ae.) -- generische
  // Fehlermeldung fuer unerwartete Fehler AUSSERHALB der Pro-Zeile-Behandlung in
  // runEmailLookupBackfill() (dort bereits Klartext-frei, siehe lib/email-lookup.mjs). Ein
  // unerwarteter Fehler auf dieser Ebene (z. B. DB-Verbindungsabbruch) enthaelt strukturell keine
  // Nutzer-E-Mail.
  console.error('Unerwarteter Fehler:', err.message);
  process.exit(1);
});
