#!/usr/bin/env node
/* ============================================================================
 * create-admin.mjs
 *
 * AP2.1 (Wochenplaner-Admin-Bereich): einmalige Anlage des EINEN
 * Admin-Accounts (F2, plan.md "Entscheidungen (2026-08-24)" -- Ein-Account-
 * Modell, kein Rollensystem, kein Self-Service, kein Verwaltungs-Endpunkt).
 * Aufbau bewusst eng an scripts/create-tenant.mjs angelehnt (AP2.3 aus
 * projects/wochenplaner-mandantenfaehigkeit/) -- Aenderungen an einem der
 * beiden Skripte sollten am jeweils anderen gespiegelt werden, wo sinnvoll.
 *
 * Design-Entscheidungen:
 *
 *   1. CLI statt HTTP-Registrierungsendpunkt: Es gibt bewusst keinen
 *      "/api/admin/auth/register"-Endpunkt (F2). Ein CLI-Skript, das nur
 *      mit Zugriff auf die laufende Container-Umgebung ausfuehrbar ist,
 *      vermeidet eine zusaetzliche, dauerhaft erreichbare HTTP-Angriffs-
 *      flaeche fuer die Anlage von Admin-Accounts -- exakt dieselbe
 *      Abwaegung wie bei create-tenant.mjs.
 *
 *   2. DB-Rolle: laeuft ueber die eingeschraenkte Laufzeit-Rolle
 *      wochenplan_app (DATABASE_URL_APP), NICHT ueber die Owner-/
 *      Migrator-Rolle -- admin_account hat dafuer bereits SELECT/INSERT-
 *      Rechte fuer diese Rolle (005_admin_foundation.sql, Abschnitt 1).
 *      admin_account traegt KEINE Row-Level-Security (anders als
 *      households/users), ein normales INSERT genuegt, kein
 *      set_config()-Vorlauf noetig.
 *
 *   3. Ein-Account-Modell wird zusaetzlich auf DB-Ebene erzwungen
 *      (admin_account_singleton_uidx, ein Unique-Index auf dem konstanten
 *      Ausdruck (true) -- siehe 005_admin_foundation.sql). Ein zweiter
 *      Aufruf dieses Skripts (oder jeder andere zweite INSERT-Versuch)
 *      schlaegt daher hart fehl, statt einen zweiten, von F2 nicht
 *      vorgesehenen Admin-Account stillschweigend anzulegen. Dieses
 *      Skript faengt genau diesen Fall ab und meldet ihn verstaendlich.
 *
 *   4. Passwort: wird entweder per --password explizit vorgegeben oder
 *      zufaellig generiert und einmalig auf stdout ausgegeben (nirgends
 *      gespeichert oder geloggt) -- identisches Muster wie
 *      create-tenant.mjs. Mindestlaenge bewusst 12 Zeichen (nicht die im
 *      Haushalts-Registrierungs-Handler verwendeten 10) -- der
 *      Admin-Account hat Loesch-/Sperrrechte auf ALLE Kundendaten
 *      (plan.md, Risikoabschnitt), eine etwas hoehere Mindestanforderung
 *      ist dafuer angemessen. Sicherheitsrelevante Annahme dieser
 *      Implementierung, im Plan nicht explizit vorgegeben -- Hinweis fuer
 *      ZANDORs Review (AP2.2).
 *
 * Aufruf (Voraussetzung: DATABASE_URL_APP ist gesetzt -- im Docker-
 * Compose-Stack bereits der Fall):
 *
 *   docker compose exec app node scripts/create-admin.mjs --username admin
 *
 *   # oder ueber das npm-Skript (identisch, siehe package.json):
 *   docker compose exec app npm run create-admin -- --username admin
 *
 * Optionale Flags: --password "..." (Default: zufaellig generiert und
 * einmalig ausgegeben).
 * ============================================================================ */

import pg from 'pg';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';

const DATABASE_URL_APP = process.env.DATABASE_URL_APP;

const MIN_PASSWORD_LENGTH = 12;
const MAX_USERNAME_LENGTH = 60;

function printUsage() {
  console.error(`
Verwendung:
  node scripts/create-admin.mjs --username admin [Optionen]

Pflichtangaben:
  --username    Benutzername des (einzigen) Admin-Accounts (max. ${MAX_USERNAME_LENGTH} Zeichen)

Optionen:
  --password    Initiales Passwort (Default: wird zufaellig generiert und einmalig ausgegeben,
                mindestens ${MIN_PASSWORD_LENGTH} Zeichen)
  --help        Diese Hilfe anzeigen

Hinweis: Es kann laut Ein-Account-Modell (F2) nur GENAU EIN Admin-Account existieren.
Ein zweiter Aufruf dieses Skripts schlaegt erwartungsgemaess fehl, solange bereits
ein Account existiert.

Voraussetzung: Umgebungsvariable DATABASE_URL_APP muss gesetzt sein (im
Docker-Compose-Stack bereits der Fall -- am einfachsten ausfuehren mit:
  docker compose exec app node scripts/create-admin.mjs --username admin
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
// dem Minimum von 12 Zeichen).
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

  const username = trim(args.username, MAX_USERNAME_LENGTH);
  let password = args.password;
  const passwordWasGenerated = !password;
  if (!password) password = generatePassword();

  if (!username) { console.error('Fehler: --username fehlt.'); printUsage(); process.exit(2); }
  if (String(password).length < MIN_PASSWORD_LENGTH) {
    console.error(`Fehler: --password muss mindestens ${MIN_PASSWORD_LENGTH} Zeichen haben.`);
    process.exit(2);
  }

  const client = new pg.Client({ connectionString: DATABASE_URL_APP });
  await client.connect();
  try {
    const passwordHash = await bcrypt.hash(String(password), 12);
    let account;
    try {
      account = await client.query(
        `INSERT INTO admin_account(username, password_hash)
         VALUES ($1, $2) RETURNING id, username`,
        [username, passwordHash]);
    } catch (err) {
      if (err.code === '23505') {
        // Zwei moegliche UNIQUE-Verletzungen (005_admin_foundation.sql):
        // admin_account_username_uidx (Benutzername bereits vergeben) oder
        // admin_account_singleton_uidx (es existiert bereits IRGENDEIN
        // Admin-Account, F2 erlaubt nur genau einen) -- beide Faelle fuer
        // den Betreiber verstaendlich unterscheiden.
        if (err.constraint === 'admin_account_singleton_uidx') {
          console.error('Fehler: Es existiert bereits ein Admin-Account. Laut Ein-Account-Modell ' +
            '(F2, plan.md) ist kein zweiter Account vorgesehen. Kein neuer Account wurde angelegt.');
        } else {
          console.error(`Fehler: Der Benutzername "${username}" ist bereits vergeben. ` +
            'Kein neuer Account wurde angelegt.');
        }
        process.exit(1);
      }
      throw err;
    }

    console.log('Admin-Account erfolgreich angelegt:');
    console.log(`  Benutzername:  ${account.rows[0].username} (id=${account.rows[0].id})`);
    if (passwordWasGenerated) {
      console.log('');
      console.log(`  Initialpasswort (nur jetzt sichtbar, nirgends gespeichert): ${password}`);
      console.log('  Bitte ueber einen separaten, vertrauenswuerdigen Kanal sichern (nicht per');
      console.log('  unverschluesselter E-Mail) -- eine Funktion zum Passwortwechsel existiert in');
      console.log('  der App aktuell nicht (kein Verwaltungs-Endpunkt vorgesehen, F2).');
    }
  } catch (err) {
    console.error('Fehler beim Anlegen des Admin-Accounts:', err.message);
    process.exit(1);
  } finally {
    await client.end();
  }
}

main().catch(err => {
  console.error('Unerwarteter Fehler:', err.message);
  process.exit(1);
});
