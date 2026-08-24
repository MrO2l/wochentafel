#!/usr/bin/env node
/* ============================================================================
 * create-tenant.mjs
 *
 * AP2.3 (Wochenplaner-Mandantenfaehigkeit): rein technischer Mechanismus zum
 * Anlegen eines neuen Mandanten (= Haushalt + erster Admin-/Owner-Nutzer),
 * ohne manuelle DB-Handarbeit. Bewusst KEIN Self-Service-UX, KEIN Billing --
 * ein Betreiber mit Zugriff auf die laufende App-Instanz fuehrt dieses
 * Skript manuell aus (analog zum "Admin legt Kunden manuell an"-Muster aus
 * projects/kunden-demo-portal/plan.md Abschnitte 2.2/2.3, dort aber mit
 * anderem Isolationsmodell -- App-seitige Trennung statt RLS -- daher nur
 * als Diskussionsgrundlage, nicht 1:1 uebernommen).
 *
 * Design-Entscheidungen (ausfuehrliche Begruendung siehe Rueckmeldung an
 * ANORAK / projects/wochenplaner-mandantenfaehigkeit/ap2.3-mandanten-anlage.md):
 *
 *   1. CLI statt HTTP-Admin-Endpunkt: Die App kennt heute keine haushalts-
 *      uebergreifende Admin-Rolle/-Authentifizierung. Ein HTTP-Endpunkt
 *      bräuchte genau das erst noch (neue Rolle, neue Session-/Auth-Grenze,
 *      zusaetzlicher authentifizierter Pfad) -- das waere mehr als der
 *      geforderte "rein technische Mechanismus". Ein CLI-Skript, das nur
 *      mit Zugriff auf die laufende Container-Umgebung ausfuehrbar ist,
 *      erreicht dasselbe Ziel ohne zusaetzliche HTTP-Angriffsflaeche.
 *
 *   2. DB-Rolle: laeuft bewusst ueber dieselbe eingeschraenkte Laufzeit-
 *      Rolle wochenplan_app (DATABASE_URL_APP), NICHT ueber die Owner-/
 *      Migrator-Rolle. Der komplette Vorgang (Haushalt anlegen, ersten
 *      Owner-Nutzer anlegen) ist bereits ueber die RLS-Policies aus
 *      003_rls_policies.sql fuer wochenplan_app erlaubt: household_creation
 *      ist WITH CHECK(true), und die users-Policy erlaubt INSERT, sobald
 *      der Sitzungskontext (set_config) auf die neue household_id gesetzt
 *      ist -- exakt der Pfad, den auch die Registrierung (server.js) fuer
 *      den Neuanlage-Zweig nutzt. Ein Admin-Werkzeug mit Owner-Rechten waere
 *      maechtiger, aber auch ein groesseres Angriffsziel, falls es je
 *      (versehentlich) HTTP-erreichbar wuerde oder ueber einen Fehlerpfad
 *      missbraucht wird. Da hier keine Owner-Rechte gebraucht werden, gibt
 *      es keinen Grund, dieses Risiko einzugehen.
 *
 *   3. Anlage-Logik (nextval()-Vorgehen fuer die neue households.id, danach
 *      set_config auf genau diese id, danach explizites INSERT mit id) ist
 *      inhaltlich aus dem Registrierungs-Handler in server.js uebernommen
 *      (dort entdeckt, geloest und live verifiziert -- siehe
 *      ap2.2-testlauf-protokoll.md Abschnitt 0.4: Postgres prueft die
 *      RETURNING-Ausgabe eines INSERT zusaetzlich gegen die SELECT-Policy,
 *      nicht nur gegen WITH CHECK). Bewusst NICHT per Import von server.js
 *      wiederverwendet, weil server.js beim Laden Migrationen ausfuehrt und
 *      einen HTTP-Listener startet -- unerwuenscht fuer ein einmalig
 *      laufendes CLI-Skript. Aenderungen an diesem Muster in server.js
 *      sollten hier gespiegelt werden (und umgekehrt) -- beide Stellen
 *      verweisen jetzt aufeinander.
 *
 *   4. Passwort: wird entweder per --admin-password explizit vorgegeben
 *      oder zufaellig generiert und einmalig auf stdout ausgegeben (nirgends
 *      gespeichert oder geloggt). Kein Einladungslink: Das bestehende
 *      invites-Schema legt neue Mitglieder immer als role='member' an
 *      (siehe server.js, Registrierungs-Handler) -- der erste Nutzer eines
 *      neuen Mandanten muss aber role='owner' sein (sonst kann er z. B.
 *      selbst keine Einladungen fuer weitere Haushaltsmitglieder erzeugen).
 *      Direktes Passwort-Setzen ist daher der einfachere UND korrekte Weg
 *      fuer diesen Spezialfall; der Betreiber gibt das ausgegebene Passwort
 *      danach ueber einen separaten, vertrauenswuerdigen Kanal an den neuen
 *      Kunden weiter (z. B. Chat/Telefon) -- kein Versand im Klartext per
 *      unverschluesselter E-Mail.
 *
 * Aufruf (Voraussetzung: DATABASE_URL_APP ist gesetzt -- im Docker-Compose-
 * Stack bereits der Fall, dieselbe Variable, die auch server.js fuer den
 * Laufzeit-Pool nutzt):
 *
 *   docker compose exec app node scripts/create-tenant.mjs \
 *     --name "Haushalt Muster" --admin-email a@example.test
 *
 *   # oder ueber das npm-Skript (identisch, siehe package.json):
 *   docker compose exec app npm run create-tenant -- \
 *     --name "Haushalt Muster" --admin-email a@example.test
 *
 * Optionale Flags: --admin-name "Anzeigename" (Default: lokaler Teil der
 * E-Mail-Adresse, wie im Registrierungs-Handler), --admin-password "..."
 * (Default: zufaellig generiert und einmalig ausgegeben).
 * ============================================================================ */

import pg from 'pg';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';

const DATABASE_URL_APP = process.env.DATABASE_URL_APP;

// Dieselben Validierungsregeln wie im Registrierungs-Handler (server.js),
// damit ein per CLI angelegter Mandant sich in nichts von einem organisch
// registrierten unterscheidet.
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const MIN_PASSWORD_LENGTH = 10;
const MAX_NAME_LENGTH = 80;

function printUsage() {
  console.error(`
Verwendung:
  node scripts/create-tenant.mjs --name "Haushaltsname" --admin-email a@example.test [Optionen]

Pflichtangaben:
  --name             Name des neuen Haushalts/Mandanten (max. ${MAX_NAME_LENGTH} Zeichen)
  --admin-email       E-Mail-Adresse des ersten Admin-/Owner-Nutzers

Optionen:
  --admin-name        Anzeigename des Admin-Nutzers (Default: lokaler Teil der E-Mail-Adresse)
  --admin-password    Initiales Passwort (Default: wird zufaellig generiert und einmalig ausgegeben)
  --help               Diese Hilfe anzeigen

Voraussetzung: Umgebungsvariable DATABASE_URL_APP muss gesetzt sein (im
Docker-Compose-Stack bereits der Fall -- am einfachsten ausfuehren mit:
  docker compose exec app node scripts/create-tenant.mjs --name ... --admin-email ...
`);
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

function trim(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

// Zufaelliges, ausreichend starkes Initialpasswort, falls keines uebergeben
// wurde -- 18 zufaellige Bytes, base64url-kodiert (24 Zeichen, weit ueber
// dem Minimum von 10 Zeichen aus server.js).
function generatePassword() {
  return crypto.randomBytes(18).toString('base64url');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { printUsage(); process.exit(0); }

  if (!DATABASE_URL_APP) {
    console.error('Fehler: Umgebungsvariable DATABASE_URL_APP fehlt. Dieses Skript muss mit derselben ' +
      'DB-Verbindung laufen wie die App selbst (siehe docker-compose.yml).');
    process.exit(1);
  }

  const householdName = trim(args.name, MAX_NAME_LENGTH);
  const email = trim(args['admin-email'], 200).toLowerCase();
  const adminName = trim(args['admin-name'], MAX_NAME_LENGTH) || email.split('@')[0];
  let password = args['admin-password'];
  const passwordWasGenerated = !password;
  if (!password) password = generatePassword();

  if (!householdName) { console.error('Fehler: --name (Haushaltsname) fehlt.'); printUsage(); process.exit(2); }
  if (!EMAIL_RE.test(email)) { console.error('Fehler: --admin-email ist keine gueltige E-Mail-Adresse.'); process.exit(2); }
  if (String(password).length < MIN_PASSWORD_LENGTH) {
    console.error(`Fehler: --admin-password muss mindestens ${MIN_PASSWORD_LENGTH} Zeichen haben.`);
    process.exit(2);
  }

  const client = new pg.Client({ connectionString: DATABASE_URL_APP });
  await client.connect();
  try {
    await client.query('BEGIN');

    // Identisches Vorgehen wie im Neuanlage-Zweig von POST /api/auth/register
    // (server.js): id vorab per nextval() reservieren (Sequenzen unterliegen
    // keiner RLS), Sitzungskontext auf genau diese id setzen, danach
    // explizit mit dieser id einfuegen -- sonst scheitert RETURNING an der
    // SELECT-Policy, siehe Kommentar dort und ap2.2-testlauf-protokoll.md
    // Abschnitt 0.4.
    const idRes = await client.query(
      `SELECT nextval(pg_get_serial_sequence('households', 'id')) AS id`);
    const householdId = idRes.rows[0].id;
    await client.query(`SELECT set_config('app.current_household_id', $1, true)`, [String(householdId)]);
    await client.query('INSERT INTO households(id, name) VALUES ($1,$2)', [householdId, householdName]);

    const passwordHash = await bcrypt.hash(String(password), 12);
    let user;
    try {
      user = await client.query(
        `INSERT INTO users(household_id, email, name, password_hash, role)
         VALUES ($1,$2,$3,$4,'owner') RETURNING id, name, email, role, household_id`,
        [householdId, email, adminName, passwordHash]);
    } catch (err) {
      await client.query('ROLLBACK');
      if (err.code === '23505') {
        console.error(`Fehler: Diese E-Mail-Adresse (${email}) ist bereits registriert (globaler ` +
          'UNIQUE-Index ueber alle Mandanten). Kein Haushalt wurde angelegt.');
        process.exit(1);
      }
      throw err;
    }

    await client.query('COMMIT');

    console.log('Neuer Mandant erfolgreich angelegt:');
    console.log(`  Haushalt:      ${householdName} (household_id=${householdId})`);
    console.log(`  Admin-Nutzer:  ${user.rows[0].email} (user_id=${user.rows[0].id}, role=owner)`);
    if (passwordWasGenerated) {
      console.log('');
      console.log(`  Initialpasswort (nur jetzt sichtbar, nirgends gespeichert): ${password}`);
      console.log('  Bitte ueber einen separaten, vertrauenswuerdigen Kanal an den Kunden weitergeben');
      console.log('  (nicht per unverschluesselter E-Mail) -- eine Funktion zum Passwortwechsel nach');
      console.log('  dem ersten Login existiert in der App aktuell nicht, siehe Rueckmeldung an ANORAK.');
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Fehler beim Anlegen des Mandanten:', err.message);
    process.exit(1);
  } finally {
    await client.end();
  }
}

main().catch(err => {
  console.error('Unerwarteter Fehler:', err.message);
  process.exit(1);
});
