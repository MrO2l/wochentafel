import express from 'express';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import bcrypt from 'bcryptjs';
import pg from 'pg';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/* ------------------------------------------------------------------ *
 * Konfiguration
 * ------------------------------------------------------------------ */
const PORT                  = Number(process.env.PORT || 3000);
const DATABASE_URL          = process.env.DATABASE_URL;
const DATABASE_URL_APP      = process.env.DATABASE_URL_APP;
const WOCHENPLAN_APP_PASSWORD = process.env.WOCHENPLAN_APP_PASSWORD;
const SESSION_SECRET        = process.env.SESSION_SECRET;
const TRUST_PROXY           = process.env.TRUST_PROXY === 'true';
const ALLOW_REGISTRATION    = process.env.ALLOW_REGISTRATION !== 'false';
const SECURE_COOKIES        = process.env.SECURE_COOKIES === 'true' || TRUST_PROXY;

if (!DATABASE_URL)     { console.error('DATABASE_URL fehlt.'); process.exit(1); }
if (!DATABASE_URL_APP) { console.error('DATABASE_URL_APP fehlt.'); process.exit(1); }
if (!WOCHENPLAN_APP_PASSWORD || WOCHENPLAN_APP_PASSWORD.length < 8) {
  console.error('WOCHENPLAN_APP_PASSWORD fehlt oder ist zu kurz (mindestens 8 Zeichen).');
  process.exit(1);
}
if (!SESSION_SECRET || SESSION_SECRET.length < 16) {
  console.error('SESSION_SECRET fehlt oder ist zu kurz (mindestens 16 Zeichen).');
  process.exit(1);
}

/* ------------------------------------------------------------------ *
 * Zwei getrennte Connection-Pools (AP2.2, ap1.2-rls-konzept.md Abschnitt 1)
 *
 * migratorPool: Owner-/Migrator-Rolle. Fuehrt ausschliesslich migrate() und
 *   das (idempotente) Setzen des wochenplan_app-Passworts aus. Als Tabellen-
 *   eigentuemerin von Row-Level-Security grundsaetzlich ausgenommen
 *   (Owner-Bypass) -- bewusst NIE fuer Laufzeit-/Anfrageverkehr verwendet,
 *   sonst waeren die RLS-Policies aus 003_rls_policies.sql wirkungslos.
 * appPool: eingeschraenkte Rolle wochenplan_app, nicht Tabelleneigentuemerin.
 *   Aller Laufzeitverkehr laeuft hierueber, inklusive des Session-Stores --
 *   RLS greift fuer diese Verbindung tatsaechlich.
 *
 * Timeouts (AP3.3, ART3MIS, ergaenzt nach einem live reproduzierten Vorfall
 * im lokalen Testumfeld -- siehe projects/wochenplaner-mandantenfaehigkeit/
 * ap3.3-ressourcen-grundschutz.md Abschnitt 2): appPool.max=10 ist ein
 * einziger, von ALLEN Mandanten gemeinsam genutzter Pool. Ohne Timeouts
 * wartet ein appPool.connect()-Aufruf unbegrenzt lange auf eine freie
 * Verbindung. Ein Lastspitzentest hat gezeigt, dass ein einzelner Mandant
 * mit vielen gleichzeitigen, auf dieselbe Zeile konkurrierenden
 * Schreib-Requests (PUT /api/weeks/:monday, FOR-UPDATE-Konfliktpfad) alle
 * zehn Pool-Verbindungen gleichzeitig belegen und dabei -- durch eine
 * verschachtelte zweite Pool-Anforderung innerhalb des Konfliktpfads, bevor
 * die aeussere Verbindung freigegeben wird -- in einen echten Deadlock
 * laufen kann: der gesamte appPool haengt dauerhaft fest, betrifft dann
 * AUSNAHMSLOS ALLE Mandanten (nicht nur den verursachenden), und der
 * Prozess erholt sich ohne Neustart nicht von selbst. connectionTimeoutMillis
 * wandelt ein unbegrenztes Haengenbleiben in einen definierten Fehlschlag
 * nach wenigen Sekunden um -- kein struktureller Fix des zugrunde liegenden
 * Anwendungscode-Musters (siehe Fund/Empfehlung an A3CH im o.g. Dokument),
 * aber eine wirksame Infrastruktur-Schutzschicht, die verhindert, dass ein
 * einzelner Mandant den gesamten Dienst dauerhaft lahmlegt. statement_timeout
 * begrenzt zusaetzlich einzelne Anfragen serverseitig (Postgres bricht eine
 * Anweisung, die laenger als das Limit laeuft oder auf eine Sperre wartet,
 * selbst ab) -- greift u.a. bei einem FOR-UPDATE-Lock-Stau durch denselben
 * Mandanten.
 * ------------------------------------------------------------------ */
const migratorPool = new pg.Pool({
  connectionString: DATABASE_URL, max: 2,
  connectionTimeoutMillis: 5000
});
const appPool = new pg.Pool({
  connectionString: DATABASE_URL_APP, max: 10,
  connectionTimeoutMillis: 5000,   // Warten auf eine freie Pool-Verbindung: max. 5s statt unbegrenzt
  idleTimeoutMillis: 30000,        // ungenutzte Verbindungen nach 30s schliessen (pg-Default: 10s -- hier bewusst etwas hoeher, s. Doku)
  statement_timeout: 15000,        // serverseitiges Limit je Anweisung/Sperrwartezeit (Postgres bricht selbst ab)
});

/* ------------------------------------------------------------------ *
 * Migrationen (laufen ausschliesslich ueber die Owner-/Migrator-Rolle)
 * ------------------------------------------------------------------ */
async function migrate() {
  const dir = path.join(__dirname, 'migrations');
  await migratorPool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      filename text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const files = (await fs.readdir(dir)).filter(f => f.endsWith('.sql')).sort();
  for (const f of files) {
    const { rowCount } = await migratorPool.query('SELECT 1 FROM schema_migrations WHERE filename=$1', [f]);
    if (rowCount) continue;
    const sql = await fs.readFile(path.join(dir, f), 'utf8');
    const client = await migratorPool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations(filename) VALUES ($1)', [f]);
      await client.query('COMMIT');
      console.log('Migration angewendet:', f);
    } catch (err) {
      await client.query('ROLLBACK');
      throw new Error(`Migration ${f} fehlgeschlagen: ${err.message}`);
    } finally { client.release(); }
  }
}

/* ------------------------------------------------------------------ *
 * Passwort der Laufzeit-Rolle wochenplan_app setzen (idempotent, bei
 * jedem Start). Migration 002 legt die Rolle bewusst OHNE Passwort an
 * (Secret gehoert nicht in eine versionierte SQL-Datei, siehe
 * ap1.1-datenmodell-migration.md, Abschnitt "Infrastruktur-Bedarf") --
 * das tatsaechliche Setzen passiert hier, ausserhalb der Migrationsdateien,
 * ueber die Owner-Rolle (die als Superuser des Postgres-Images beliebige
 * Rollenpasswoerter setzen darf).
 *
 * ALTER ROLE ... PASSWORD erwartet an dieser Stelle grammatikalisch ein
 * String-Literal, keinen gebundenen Parameter ($1) -- node-postgres kann
 * hier also nicht wie sonst ueblich parametrisieren. Da der Wert aus einer
 * vertrauenswuerdigen Quelle (Umgebungsvariable, kein Nutzereingabefeld)
 * stammt, genuegt einfaches Verdoppeln von Apostrophen fuer ein sicheres
 * String-Literal (Standard-Postgres-Escaping bei aktivem
 * standard_conforming_strings, das ist seit Postgres 9.1 der Default).
 * ------------------------------------------------------------------ */
function pgQuoteLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}
async function ensureAppRolePassword() {
  await migratorPool.query(`ALTER ROLE wochenplan_app WITH PASSWORD ${pgQuoteLiteral(WOCHENPLAN_APP_PASSWORD)}`);
}

/* ------------------------------------------------------------------ *
 * Tenant-Kontext-Transaktionshelfer (AP2.2, ap1.2-rls-konzept.md
 * Abschnitt 4) -- setzt den Sitzungskontext, an dem die RLS-Policies aus
 * 003_rls_policies.sql pruefen (current_setting('app.current_household_id')).
 *
 * set_config(..., true) statt SET LOCAL app.current_household_id = $1:
 * node-postgres kann SET LOCAL nicht parametrisieren (das SET-Kommando
 * akzeptiert im Extended-Query-Protokoll keinen gebundenen Wert), was
 * String-Interpolation erzwungen haette. set_config() ist eine normale,
 * parametrisierbare Funktion mit identischer Wirkung (dritter Parameter
 * true = is_local, gilt nur bis COMMIT/ROLLBACK der Transaktion).
 *
 * Ruft ab AP3.3 (ART3MIS, app/migrations/004_tenant_context_audit.sql) die
 * SECURITY-DEFINER-Funktion set_tenant_context_audited() statt set_config()
 * direkt auf: identische Wirkung auf app.current_household_id, zusaetzlich
 * schreibt jeder Aufruf eine Zeile in tenant_context_audit (Backend-PID +
 * household_id + Zeitstempel) -- Grundlage fuer den Monitoring-Alert auf
 * auffaellige household_id-Zugriffsmuster, siehe projects/wochenplaner-
 * mandantenfaehigkeit/ap3.3-ressourcen-grundschutz.md Abschnitt 3. Einziger
 * Aufrufpunkt fuer alle ca. elf Endpunkte -- keine Aenderung an den
 * einzelnen Routen noetig.
 * ------------------------------------------------------------------ */
async function setTenantContext(client, householdId) {
  await client.query(
    `SELECT set_tenant_context_audited($1)`,
    [String(householdId)]
  );
}

async function withTenantClient(householdId, fn) {
  if (householdId == null) throw new Error('withTenantClient ohne householdId aufgerufen');
  const client = await appPool.connect();
  try {
    await client.query('BEGIN');
    await setTenantContext(client, householdId);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/* ------------------------------------------------------------------ *
 * Wochendaten: Struktur pruefen und normalisieren
 * Zellen bestehen aus Tokens, nicht aus HTML:
 *   {t:'text', v:'Turnen 16:00'} | {t:'icon', v:'i-sport', l:'Sport'} | {t:'br'}
 * Dadurch kann im Browser nichts eingeschleust werden, was dort als
 * Markup ausgefuehrt wuerde, und die Eintraege bleiben auswertbar.
 * ------------------------------------------------------------------ */
const LIMITS = {
  rows: 40, tokens: 120, text: 400, label: 80, icon: 40, listItems: 40,
  // Fokusbloecke "Wochenziele"/"Besonders diese Woche"/"Anrufen/Kontaktieren"
  // (siehe Datenmodell-Fokusbloecke-v2.md, Abschnitt 3.4).
  goals: 12, goalText: 100, highlights: 8, highlightText: 200, calls: 20, callText: 100
};
const ICON_RE = /^i-[a-z0-9-]{2,30}$/;
const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
const MEAL_LABELS = ['Frühstück', 'Mittagessen', 'Abendessen', 'Snack'];

function cleanTokens(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  for (const tok of input.slice(0, LIMITS.tokens)) {
    if (!tok || typeof tok !== 'object') continue;
    if (tok.t === 'text') { const v = str(tok.v, LIMITS.text); if (v) out.push({ t: 'text', v }); }
    else if (tok.t === 'br') out.push({ t: 'br' });
    else if (tok.t === 'icon' && ICON_RE.test(String(tok.v || ''))) {
      out.push({ t: 'icon', v: String(tok.v), l: str(tok.l, LIMITS.icon) });
    }
  }
  return out;
}

// Fuer Zeilen mit listMode:true (aktuell "Einkauf & Besorgungen"): statt eines Token[]
// pro Tag eine Liste einzelner Eintraege, jeder mit Erledigt-Haken. Tokens innerhalb
// eines Eintrags durchlaufen dieselbe Pruefung wie ueberall sonst (cleanTokens).
function cleanListItems(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  for (const it of input.slice(0, LIMITS.listItems)) {
    if (!it || typeof it !== 'object') continue;
    const tokens = cleanTokens(it.tokens);
    if (tokens.length) out.push({ done: it.done === true, tokens });
  }
  return out;
}

// Fokusbloecke der Wochenuebersicht (Datenmodell-Fokusbloecke-v2.md): eigenstaendige
// Top-Level-Felder in weeks.data, kein Bezug zu den Raster-Zeilen/Tokens oben. Analog
// zu cleanListItems() wird das Array gekappt, jedes Element geprueft und leere Eintraege
// (nach Kuerzen leerer/nur-Whitespace-Text) verworfen.
function cleanGoals(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  for (const it of input.slice(0, LIMITS.goals)) {
    if (!it || typeof it !== 'object') continue;
    const text = str(it.text, LIMITS.goalText).trim();
    if (text) out.push({ done: it.done === true, text });
  }
  return out;
}

// "Besonders diese Woche": reine Textzeilen ohne Erledigt-Haken (Mockup zeigt hier keine
// Checkbox) -- daher ein Array aus Strings statt aus Objekten, anders als bei Zielen/Anrufen.
function cleanHighlights(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  for (const it of input.slice(0, LIMITS.highlights)) {
    const text = str(it, LIMITS.highlightText).trim();
    if (text) out.push(text);
  }
  return out;
}

function cleanCalls(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  for (const it of input.slice(0, LIMITS.calls)) {
    if (!it || typeof it !== 'object') continue;
    const text = str(it.text, LIMITS.callText).trim();
    if (text) out.push({ done: it.done === true, text });
  }
  return out;
}

// Fuer Zeilen mit mode:'week' (aktuell "Essen & Kochen"): keine sieben unabhaengigen
// Tageszellen mehr, sondern vier Mahlzeiten-Unterzeilen mit je einem Token[] pro Tag —
// strukturell wie eine Mini-Ausgabe des Hauptrasters (siehe Umsetzungsplan).
function cleanMeals(input) {
  const arr = Array.isArray(input) ? input : [];
  return Array.from({ length: MEAL_LABELS.length }, (_, i) => {
    const m = arr[i];
    return {
      label: str(m && m.label, LIMITS.label) || MEAL_LABELS[i],
      cells: Array.from({ length: 7 }, (_, d) => cleanTokens(m && m.cells && m.cells[d]))
    };
  });
}

function cleanRow(r) {
  const kind = r && r.kind === 'shared' ? 'shared' : 'person';
  const base = { kind, label: str(r && r.label, LIMITS.label), role: str(r && r.role, LIMITS.label) };
  if (kind === 'shared' && r && r.mode === 'week') {
    return { ...base, mode: 'week', meals: cleanMeals(r.meals) };
  }
  if (kind === 'shared' && r && r.listMode === true) {
    return { ...base, listMode: true, cells: Array.from({ length: 7 }, (_, i) => cleanListItems(r.cells && r.cells[i])) };
  }
  return { ...base, cells: Array.from({ length: 7 }, (_, i) => cleanTokens(r && r.cells && r.cells[i])) };
}

function cleanWeek(input) {
  if (!input || typeof input !== 'object') throw new Error('Ungueltige Wochendaten');
  const rows = Array.isArray(input.rows) ? input.rows.slice(0, LIMITS.rows) : [];
  return {
    version: 2,
    motto: cleanTokens(input.motto),
    notes: cleanTokens(input.notes),
    goals: cleanGoals(input.goals),
    highlights: cleanHighlights(input.highlights),
    calls: cleanCalls(input.calls),
    rows: rows.map(cleanRow)
  };
}

/* --------------------------------------------------------------------
 * Migration von Bestandsdaten (reine JSON-Struktur-Erweiterung, kein
 * Schema-Wechsel): alte Wochen kennen weder "listMode" noch "mode:'week'"
 * und haben fuer "Einkauf & Besorgungen"/"Essen & Kochen" noch normale
 * Token[]-Tageszellen. Da Zeilen keine feste ID haben (nur ihre Position),
 * laesst sich das nicht zuverlaessig per SQL-Update auf allen historischen
 * Wochen nachziehen, ohne versehentlich vom Nutzer umbenannte oder eigene
 * Zeilen zu treffen. Stattdessen wird beim Lesen anhand des (unveraenderten)
 * Zeilennamens erkannt und verlustfrei in die neue Form gehoben; nichts
 * geht dabei verloren, nur eine Ebene Struktur kommt hinzu. Wird eine Zeile
 * umbenannt, bleibt sie schlicht eine normale Zeile (kein Absturz, kein
 * Datenverlust, nur ohne die neue Sonderdarstellung). Beim naechsten
 * Speichern schreibt cleanRow() die neue Form ohnehin dauerhaft fest. */
const LEGACY_LABEL_LIST = 'einkauf & besorgungen';
const LEGACY_LABEL_WEEK = 'essen & kochen';
function migrateLegacyRow(row) {
  if (!row || row.kind !== 'shared' || row.mode || row.listMode || !Array.isArray(row.cells)) return row;
  const label = String(row.label || '').trim().toLowerCase();
  if (label === LEGACY_LABEL_WEEK) {
    const meals = cleanMeals([]);
    meals[1].cells = row.cells; // Bestehender Freitext landet auf "Mittagessen" — bewusste Wahl,
                                 // da die alte Zelle keine Mahlzeit unterschied; siehe Rueckmeldung.
    return { kind: row.kind, label: row.label, role: row.role, mode: 'week', meals };
  }
  if (label === LEGACY_LABEL_LIST) {
    const cells = row.cells.map(cell => (Array.isArray(cell) && cell.length) ? [{ done: false, tokens: cell }] : []);
    return { kind: row.kind, label: row.label, role: row.role, listMode: true, cells };
  }
  return row;
}
function migrateLegacyWeek(data) {
  if (!data || !Array.isArray(data.rows)) return data;
  return { ...data, rows: data.rows.map(migrateLegacyRow) };
}

const emptyCells = () => Array.from({ length: 7 }, () => []);
function defaultWeek() {
  return {
    version: 2, motto: [], notes: [], goals: [], highlights: [], calls: [],
    rows: [
      { kind: 'person', label: 'Name 1', role: '', cells: emptyCells() },
      { kind: 'person', label: 'Name 2', role: '', cells: emptyCells() },
      { kind: 'person', label: 'Name 3', role: '', cells: emptyCells() },
      { kind: 'person', label: 'Name 4', role: '', cells: emptyCells() },
      { kind: 'shared', label: 'Essen & Kochen', role: '', mode: 'week', meals: cleanMeals([]) },
      { kind: 'shared', label: 'Einkauf & Besorgungen', role: '', listMode: true, cells: emptyCells() },
      { kind: 'shared', label: 'Haushalt & Sonstiges',  role: '', cells: emptyCells() }
    ]
  };
}
/** Vorlage uebernehmen, aber nichts ueberschreiben, was schon eingetragen ist.
 *  Beruecksichtigt alle drei Zeilenformen (normale Token[]-Zellen, Listen-Zeilen
 *  mit listMode und Wochen-Zeilen mit mode:'week'/meals). */
function mergeTemplate(week, template) {
  if (!template) return week;
  const out = structuredClone(week);
  // Namen (kind+label) bereits vorhandener Zeilen merken: eine Vorlage, die weniger oder
  // anders sortierte Zeilen hat als defaultWeek() (z. B. weil zuvor eine Zeile geloescht
  // wurde, bevor "Als Vorlage sichern" gedrueckt wurde), darf beim Auffuellen fehlender
  // Positionen keine Zeile duplizieren, die unter einem anderen Index bereits existiert —
  // sonst entstuende z. B. eine zweite "Einkauf & Besorgungen"-Zeile.
  const rowKey = r => (r.kind || '') + '|' + String(r.label || '').trim().toLowerCase();
  const existing = new Set(out.rows.map(rowKey));
  template.rows.forEach((trow, i) => {
    const row = out.rows[i];
    if (!row) {
      const key = rowKey(trow);
      if (trow.label && existing.has(key)) return; // schon vorhanden, nicht doppelt einfuegen
      out.rows[i] = structuredClone(trow);
      existing.add(key);
      return;
    }
    if (!row.label) row.label = trow.label;
    if (!row.role)  row.role  = trow.role;
    if (Array.isArray(trow.cells) && Array.isArray(row.cells)) {
      trow.cells.forEach((cell, d) => {
        if (cell.length && row.cells[d] && row.cells[d].length === 0) row.cells[d] = structuredClone(cell);
      });
    } else if (Array.isArray(trow.meals) && Array.isArray(row.meals)) {
      trow.meals.forEach((tmeal, mi) => {
        const meal = row.meals[mi];
        if (!meal) return;
        tmeal.cells.forEach((cell, d) => {
          if (cell.length && meal.cells[d] && meal.cells[d].length === 0) meal.cells[d] = structuredClone(cell);
        });
      });
    }
  });
  // Wird eine Zeile wegen bereits vorhandenem Namen übersprungen, während spätere Zeilen an
  // einem höheren, noch nicht belegten Index eingefügt werden, könnte im Array eine Lücke
  // entstehen (z. B. Index 5 fehlt, Index 6 ist gesetzt) — das würde beim Speichern als
  // "null"-Eintrag in "rows" landen. filter(Boolean) entfernt solche Lücken sauber.
  out.rows = out.rows.filter(Boolean);
  return out;
}

const MONDAY_RE = /^\d{4}-\d{2}-\d{2}$/;
function isMonday(iso) {
  if (!MONDAY_RE.test(iso)) return false;
  const d = new Date(iso + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.getUTCDay() === 1;
}

/* ------------------------------------------------------------------ *
 * App
 * ------------------------------------------------------------------ */
const app = express();
if (TRUST_PROXY) app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json({ limit: '512kb' }));

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  // Kein 'unsafe-inline': alle Skripte liegen in eigenen Dateien, alle Inline-Styles
  // wurden durch CSS-Klassen ersetzt (siehe style.css/style-v2.css).
  // Seit Design v2 (AP3.1) gibt es keine Google-Fonts-Ausnahme mehr: Bootstrap, Bootstrap
  // Icons und Open Sans liegen vollstaendig lokal unter public/vendor/ (siehe
  // Asset-Vendoring-Konzept-v2.md). img-src braucht zusaetzlich 'data:', weil Bootstrap 5.3
  // UI-Zustaende (u. a. das Checkbox-Haekchen in .form-check-input:checked) ueber
  // eingebettete data:image/svg+xml-URIs im CSS rendert -- ohne diese Ergaenzung wuerden
  // solche Grafiken lautlos von der CSP blockiert.
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
    "font-src 'self'; connect-src 'self'; " +
    "object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'");
  next();
});

const PgSession = connectPgSimple(session);
app.use(session({
  // Session-Store laeuft ueber die eingeschraenkte Laufzeit-Rolle (appPool) --
  // `session` traegt bewusst keine RLS (keine household_id-Spalte, ephemer,
  // siehe ap1.2-rls-konzept.md Abschnitt 3), Rechte darauf bereits per
  // Migration 002 an wochenplan_app vergeben.
  store: new PgSession({ pool: appPool, tableName: 'session', createTableIfMissing: false }),
  name: 'wochenplan.sid',
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: SECURE_COOKIES,
    maxAge: 1000 * 60 * 60 * 24 * 60      // 60 Tage
  }
}));

/* --- einfache Bremse gegen Passwortraten (pro E-Mail-Adresse) ------ */
const attempts = new Map();
function throttle(key) {
  const now = Date.now();
  const rec = attempts.get(key) || { n: 0, until: 0, last: 0 };
  if (rec.until > now) return Math.ceil((rec.until - now) / 1000);
  return 0;
}
function noteFailure(key) {
  const now = Date.now();
  const rec = attempts.get(key) || { n: 0, until: 0, last: 0 };
  rec.n += 1;
  rec.last = now;
  if (rec.n >= 5) { rec.until = now + 5 * 60 * 1000; rec.n = 0; }
  attempts.set(key, rec);
}
const clearFailures = key => attempts.delete(key);
// Ohne Aufraeumen waechst die Map unbegrenzt, wenn jemand viele verschiedene
// (auch erfundene) E-Mail-Adressen durchprobiert. Eintraege, die seit einer
// Stunde weder gesperrt sind noch angefasst wurden, koennen weg.
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of attempts) if (v.until < now && now - v.last > 60 * 60 * 1000) attempts.delete(k);
}, 30 * 60 * 1000).unref();

/* --- generische Rate-Bremse pro IP-Adresse -------------------------
 * Ergaenzt die E-Mail-Bremse oben: die dort ist gezielt gegen
 * Passwortraten auf ein Konto, diese hier gegen Massenanfragen
 * (z. B. Registrierungen oder Einladungscode-Raten) unabhaengig
 * vom verwendeten Konto. */
function rateLimiter({ windowMs, max }) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
  }, windowMs).unref();
  return (req, res, next) => {
    const key = req.ip;
    const now = Date.now();
    let rec = hits.get(key);
    if (!rec || rec.resetAt <= now) { rec = { count: 0, resetAt: now + windowMs }; hits.set(key, rec); }
    rec.count += 1;
    if (rec.count > max) {
      res.setHeader('Retry-After', String(Math.ceil((rec.resetAt - now) / 1000)));
      return res.status(429).json({ error: 'Zu viele Anfragen von dieser Adresse. Bitte kurz warten.' });
    }
    next();
  };
}
const apiLimiter    = rateLimiter({ windowMs: 60 * 1000,      max: 120 });  // generelle Bremse ueber alle API-Aufrufe
const authLimiter   = rateLimiter({ windowMs: 15 * 60 * 1000, max: 30 });   // Login und Registrierung
const inviteLimiter = rateLimiter({ windowMs: 60 * 60 * 1000, max: 20 });   // Einladungscodes erzeugen
app.use('/api', apiLimiter);

function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Nicht angemeldet' });
  next();
}
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/* ------------------------------------------------------------------ *
 * Tenant-Kontext-Haertung (AP2.1)
 * -----------------------------------------------------------------
 * Der Mandanten-/Haushaltskontext (household_id) wird in jedem Endpunkt
 * unten ausschliesslich aus req.session.householdId gelesen -- diese
 * Sitzungsvariable wird ausschliesslich serverseitig beim Login bzw. bei
 * der Registrierung gesetzt (siehe /api/auth/login, /api/auth/register),
 * nie aus req.params/req.body/req.query und nie aus Host-Header/Domain
 * (Betriebsmodell: eine gemeinsame Domain fuer alle Kunden, Trennung
 * ausschliesslich ueber Login/Session -- infrastrukturkosten-schaetzung.md
 * Abschnitt 10.3). Kein Endpunkt in server.js liest household_id/
 * householdId je aus Client-Daten -- ein Review aller Routen hat das
 * bestaetigt.
 *
 * Dieser Guard macht einen Manipulationsversuch trotzdem *sichtbar*
 * statt ihn nur stillschweigend zu ignorieren: schickt ein Client auf
 * einer haushaltsbezogenen Route dennoch ein household_id/householdId-
 * Feld mit (Body oder Query), wird die Anfrage explizit mit 403
 * abgelehnt, statt das Feld unbemerkt zu verwerfen. Das ist Defense-in-
 * Depth auf Anwendungsebene: schon *heute* haette so ein Feld keinerlei
 * Wirkung (die Handler lesen es nirgends), aber ein expliziter Abbruch
 * verhindert, dass ein kuenftiger Endpunkt ein mitgeschicktes Feld doch
 * einmal versehentlich uebernimmt, und macht Angriffsversuche in Logs/
 * Monitoring erkennbar statt lautlos folgenlos.
 * ------------------------------------------------------------------ */
function rejectForeignHouseholdId(req, res, next) {
  const smuggled = [req.body?.householdId, req.body?.household_id,
                     req.query?.householdId, req.query?.household_id]
    .some(v => v !== undefined && v !== null);
  if (smuggled) {
    return res.status(403).json({ error: 'Haushaltszuordnung wird ausschliesslich aus der Sitzung abgeleitet und darf nicht in der Anfrage angegeben werden' });
  }
  next();
}

/* ------------------------------------------------------------------ *
 * Authentifizierung
 * ------------------------------------------------------------------ */
app.get('/api/config', (req, res) => res.json({ allowRegistration: ALLOW_REGISTRATION }));

app.post('/api/auth/register', authLimiter, wrap(async (req, res) => {
  if (!ALLOW_REGISTRATION) return res.status(403).json({ error: 'Registrierung ist deaktiviert' });
  const email = String(req.body.email || '').trim().toLowerCase();
  const name = str(req.body.name, 80).trim() || email.split('@')[0];
  const password = String(req.body.password || '');
  const householdName = str(req.body.householdName, 80).trim();
  const inviteCode = String(req.body.inviteCode || '').trim().toUpperCase();

  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'Bitte eine gueltige E-Mail-Adresse angeben' });
  if (password.length < 10) return res.status(400).json({ error: 'Das Passwort muss mindestens 10 Zeichen haben' });
  if (!householdName && !inviteCode) return res.status(400).json({ error: 'Bitte einen Haushaltsnamen oder einen Einladungscode angeben' });

  const client = await appPool.connect();
  try {
    await client.query('BEGIN');
    let householdId;
    if (inviteCode) {
      // invites hat bewusst keine RLS (ap1.2-rls-konzept.md Abschnitt 3) --
      // Abfrage laeuft unveraendert, auch ohne bereits gesetzten Sitzungskontext.
      const inv = await client.query(
        `SELECT household_id FROM invites
          WHERE code=$1 AND used_at IS NULL AND expires_at > now() FOR UPDATE`, [inviteCode]);
      if (!inv.rowCount) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Einladungscode ist ungueltig oder abgelaufen' }); }
      householdId = inv.rows[0].household_id;
    } else {
      // households erlaubt INSERT bewusst permissiv (household_creation-Policy,
      // Migration 003, WITH CHECK (true)) -- das allein reicht hier aber NICHT:
      // Postgres prueft die RETURNING-Ausgabe eines INSERT zusaetzlich gegen
      // die SELECT-Policy (household_isolation_select), nicht nur gegen die
      // INSERT-WITH-CHECK-Policy. Ohne bereits gesetzten Sitzungskontext
      // wuerde "INSERT ... RETURNING id" daher mit "new row violates row-
      // level security policy" scheitern, obwohl die Zeile laut INSERT-Policy
      // haette angelegt werden duerfen (beim Umsetzen entdeckte Luecke, in
      // ap1.2-rls-konzept.md nicht beschrieben -- siehe Rueckmeldung an
      // ANORAK/MORROW). Dasselbe Muster verwendet auch scripts/create-tenant.mjs
      // (AP2.3) fuer die admin-seitige Mandantenanlage -- Aenderungen hier
      // dort spiegeln (und umgekehrt). Loesung: die neue id vorab per nextval() reservieren
      // (Sequenzen unterliegen keiner RLS), den Kontext auf genau diese id
      // setzen und danach explizit mit dieser id einfuegen -- dann erfuellt
      // die neue Zeile bereits beim RETURNING die SELECT-Policy.
      const idRes = await client.query(
        `SELECT nextval(pg_get_serial_sequence('households', 'id')) AS id`);
      const newHouseholdId = idRes.rows[0].id;
      await setTenantContext(client, newHouseholdId);
      const h = await client.query(
        'INSERT INTO households(id, name) VALUES ($1,$2) RETURNING id',
        [newHouseholdId, householdName]);
      householdId = h.rows[0].id;
    }

    // Sitzungskontext ab hier fuer den Rest der Transaktion setzen -- in
    // BEIDEN Zweigen (Einladung wie Neuanlage), direkt nach Bestimmung von
    // householdId und VOR dem ersten Zugriff auf `users` (dessen RLS-Policy
    // den Kontext bereits fuer den folgenden INSERT prueft). Siehe
    // ap1.2-rls-konzept.md Abschnitt 5.
    await setTenantContext(client, householdId);

    const hash = await bcrypt.hash(password, 12);
    const role = inviteCode ? 'member' : 'owner';
    let user;
    try {
      user = await client.query(
        `INSERT INTO users(household_id, email, name, password_hash, role)
         VALUES ($1,$2,$3,$4,$5) RETURNING id, name, email, role, household_id`,
        [householdId, email, name, hash, role]);
    } catch (err) {
      await client.query('ROLLBACK');
      if (err.code === '23505') return res.status(409).json({ error: 'Diese E-Mail-Adresse ist bereits registriert' });
      throw err;
    }
    if (inviteCode) {
      await client.query('UPDATE invites SET used_at=now(), used_by=$1 WHERE code=$2', [user.rows[0].id, inviteCode]);
    }
    await client.query('COMMIT');
    // session.regenerate() VOR dem Setzen der Session-Werte, analog zum
    // Login-Handler unten (AP4.1, Befund 2.2 -- Session-Fixation-Musterlücke).
    // Gilt fuer BEIDE Zweige oben (Einladung wie Neuanlage), da beide vor
    // dieser gemeinsamen Stelle bereits committet haben.
    req.session.regenerate(err => {
      if (err) return res.status(500).json({ error: 'Registrierung fehlgeschlagen' });
      req.session.userId = user.rows[0].id;
      req.session.householdId = householdId;
      res.status(201).json({ user: user.rows[0] });
    });
  } catch (err) {
    // Sicherheitsnetz gegen eine mit offener Transaktion an den Pool
    // zurueckgegebene Verbindung: set_config(..., true) endet zwar mit
    // COMMIT/ROLLBACK, aber ohne explizites ROLLBACK hier bliebe die
    // Transaktion (und ihr Tenant-Kontext) auf der Verbindung offen, bis sie
    // erneut verwendet wird -- mit RLS aktiv koennte das den Kontext eines
    // Haushalts in eine spaetere, andere Anfrage auf derselben gepoolten
    // Verbindung durchsickern lassen. Analog zu withTenantClient() oben.
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally { client.release(); }
}));

app.post('/api/auth/login', authLimiter, wrap(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const wait = throttle(email);
  if (wait) return res.status(429).json({ error: `Zu viele Fehlversuche. Bitte ${wait} Sekunden warten.` });

  // auth_lookup_by_email() ist eine SECURITY DEFINER-Funktion (Migration 003):
  // sie kapselt genau diesen einen, haushaltsuebergreifenden E-Mail-Lookup,
  // der noetig ist, BEVOR ein Sitzungskontext existiert. Eine direkte
  // SELECT ... FROM users JOIN households ...-Abfrage ueber die
  // eingeschraenkte Rolle wochenplan_app wuerde mit aktiver RLS immer 0
  // Zeilen liefern (current_setting('app.current_household_id', true) ist
  // zu diesem Zeitpunkt NULL) -- Login waere fuer alle Nutzer gebrochen.
  // Siehe ap1.2-rls-konzept.md Abschnitt 6.
  const q = await appPool.query('SELECT * FROM auth_lookup_by_email($1)', [email]);
  const row = q.rows[0];
  const ok = row ? await bcrypt.compare(password, row.password_hash) : await bcrypt.compare(password, '$2a$12$' + 'x'.repeat(53));
  if (!row || !ok) { noteFailure(email); return res.status(401).json({ error: 'E-Mail oder Passwort stimmt nicht' }); }

  clearFailures(email);
  req.session.regenerate(err => {
    if (err) return res.status(500).json({ error: 'Anmeldung fehlgeschlagen' });
    req.session.userId = row.id;
    req.session.householdId = row.household_id;
    res.json({ user: { id: row.id, name: row.name, email: row.email, role: row.role,
                       householdId: row.household_id, householdName: row.household_name } });
  });
}));

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => { res.clearCookie('wochenplan.sid'); res.json({ ok: true }); });
});

app.get('/api/me', wrap(async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Nicht angemeldet' });
  const q = await withTenantClient(req.session.householdId, client => client.query(
    `SELECT u.id, u.name, u.email, u.role, u.household_id AS "householdId", h.name AS "householdName"
       FROM users u JOIN households h ON h.id=u.household_id WHERE u.id=$1`, [req.session.userId]));
  if (!q.rowCount) return req.session.destroy(() => res.status(401).json({ error: 'Nicht angemeldet' }));
  res.json({ user: q.rows[0] });
}));

app.post('/api/invites', requireAuth, inviteLimiter, rejectForeignHouseholdId, wrap(async (req, res) => {
  const code = crypto.randomBytes(5).toString('hex').toUpperCase();
  await withTenantClient(req.session.householdId, client => client.query(
    `INSERT INTO invites(code, household_id, created_by, expires_at)
     VALUES ($1,$2,$3, now() + interval '14 days')`,
    [code, req.session.householdId, req.session.userId]));
  res.status(201).json({ code, expiresInDays: 14 });
}));

/* ------------------------------------------------------------------ *
 * Wochen
 * ------------------------------------------------------------------ */
app.get('/api/weeks', requireAuth, rejectForeignHouseholdId, wrap(async (req, res) => {
  const q = await withTenantClient(req.session.householdId, client => client.query(
    `SELECT to_char(w.week_start,'YYYY-MM-DD') AS "weekStart", w.updated_at AS "updatedAt", u.name AS "updatedBy"
       FROM weeks w LEFT JOIN users u ON u.id = w.updated_by
      WHERE w.household_id = $1
      ORDER BY w.week_start DESC LIMIT 200`, [req.session.householdId]));
  res.json({ weeks: q.rows });
}));

app.get('/api/weeks/:monday', requireAuth, rejectForeignHouseholdId, wrap(async (req, res) => {
  const monday = req.params.monday;
  if (!isMonday(monday)) return res.status(400).json({ error: 'Datum muss ein Montag im Format JJJJ-MM-TT sein' });
  const result = await withTenantClient(req.session.householdId, async (client) => {
    const q = await client.query(
      `SELECT data, updated_at AS "updatedAt" FROM weeks WHERE household_id=$1 AND week_start=$2`,
      [req.session.householdId, monday]);
    if (q.rowCount) {
      return { weekStart: monday, exists: true, data: migrateLegacyWeek(q.rows[0].data), updatedAt: q.rows[0].updatedAt };
    }
    const t = await client.query('SELECT template_data FROM households WHERE id=$1', [req.session.householdId]);
    const template = t.rows[0]?.template_data ? migrateLegacyWeek(t.rows[0].template_data) : null;
    // Neue Woche: die Vorlage wird vollstaendig uebernommen (Namen inklusive),
    // fehlende Zeilen ergaenzt der Standardaufbau.
    const fresh = template ? mergeTemplate(structuredClone(template), defaultWeek()) : defaultWeek();
    return { weekStart: monday, exists: false, fromTemplate: !!template, data: fresh, updatedAt: null };
  });
  res.json(result);
}));

app.put('/api/weeks/:monday', requireAuth, rejectForeignHouseholdId, wrap(async (req, res) => {
  const monday = req.params.monday;
  if (!isMonday(monday)) return res.status(400).json({ error: 'Datum muss ein Montag im Format JJJJ-MM-TT sein' });
  let data;
  try { data = cleanWeek(req.body.data); }
  catch { return res.status(400).json({ error: 'Wochendaten haben ein unerwartetes Format' }); }

  const base = req.body.baseUpdatedAt ? new Date(req.body.baseUpdatedAt) : null;
  const client = await appPool.connect();
  try {
    await client.query('BEGIN');
    await setTenantContext(client, req.session.householdId);
    const cur = await client.query(
      'SELECT updated_at FROM weeks WHERE household_id=$1 AND week_start=$2 FOR UPDATE',
      [req.session.householdId, monday]);
    if (cur.rowCount) {
      const serverTime = new Date(cur.rows[0].updated_at).getTime();
      if (!base || Math.abs(serverTime - base.getTime()) > 500) {
        // Konfliktfall: dem Client die aktuelle Version zurueckgeben, damit er
        // abgleichen kann.
        //
        // AP3.3-Root-Cause-Fix (siehe ap3.3-deadlock-fix.md): die fruehere
        // Fassung rief hier withTenantClient() auf und forderte damit eine
        // ZWEITE Pool-Verbindung an, waehrend die AEUSSERE (`client`) noch
        // gehalten wurde (erst im finally-Block unten freigegeben). Bei
        // Nebenlaeufigkeit >= appPool.max konnten dadurch alle Pool-
        // Verbindungen gleichzeitig als "aeussere" haengen, waehrend jede
        // von ihnen auf eine "innere" aus demselben, bereits erschoepften
        // Pool wartet -- ein klassischer Pool-Exhaustion-Deadlock (siehe
        // ap3.3-ressourcen-grundschutz.md Abschnitt 2.3/2.4). Fix: keine
        // zweite Verbindung anfordern, sondern die frischen Daten ueber
        // dieselbe, bereits gehaltene Verbindung (`client`) abfragen. Ein
        // ROLLBACK setzt den transaktionslokalen set_config-Kontext
        // zurueck (set_config(..., is_local=true) gilt nur bis
        // COMMIT/ROLLBACK) -- daher muss innerhalb einer neuen, kurzen
        // Transaktion auf derselben Verbindung erneut BEGIN +
        // setTenantContext() laufen, bevor die RLS-geschuetzte SELECT-
        // Abfrage ausgefuehrt wird.
        await client.query('ROLLBACK');
        await client.query('BEGIN');
        await setTenantContext(client, req.session.householdId);
        const fresh = await client.query(
          'SELECT data, updated_at AS "updatedAt" FROM weeks WHERE household_id=$1 AND week_start=$2',
          [req.session.householdId, monday]);
        await client.query('COMMIT');
        return res.status(409).json({
          error: 'Diese Woche wurde zwischenzeitlich auf einem anderen Geraet geaendert',
          data: migrateLegacyWeek(fresh.rows[0].data), updatedAt: fresh.rows[0].updatedAt });
      }
    }
    const saved = await client.query(
      `INSERT INTO weeks(household_id, week_start, data, updated_by)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (household_id, week_start)
       DO UPDATE SET data=EXCLUDED.data, updated_by=EXCLUDED.updated_by, updated_at=now()
       RETURNING updated_at AS "updatedAt"`,
      [req.session.householdId, monday, data, req.session.userId]);
    await client.query('COMMIT');
    res.json({ ok: true, updatedAt: saved.rows[0].updatedAt });
  } catch (err) {
    // Siehe Kommentar im Registrierungs-Handler: ohne explizites ROLLBACK
    // bliebe bei einem Fehler eine offene Transaktion (mit gesetztem Tenant-
    // Kontext) auf der an den Pool zurueckgegebenen Verbindung bestehen.
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally { client.release(); }
}));

app.delete('/api/weeks/:monday', requireAuth, rejectForeignHouseholdId, wrap(async (req, res) => {
  if (!isMonday(req.params.monday)) return res.status(400).json({ error: 'Ungueltiges Datum' });
  await withTenantClient(req.session.householdId, client => client.query(
    'DELETE FROM weeks WHERE household_id=$1 AND week_start=$2',
    [req.session.householdId, req.params.monday]));
  res.json({ ok: true });
}));

/* ------------------------------------------------------------------ *
 * Vorlage (Standardwoche)
 * ------------------------------------------------------------------ */
app.get('/api/template', requireAuth, rejectForeignHouseholdId, wrap(async (req, res) => {
  const q = await withTenantClient(req.session.householdId, client => client.query(
    'SELECT template_data FROM households WHERE id=$1', [req.session.householdId]));
  const template = q.rows[0]?.template_data || null;
  res.json({ template: template ? migrateLegacyWeek(template) : null });
}));

app.put('/api/template', requireAuth, rejectForeignHouseholdId, wrap(async (req, res) => {
  let data;
  try { data = cleanWeek(req.body.data); }
  catch { return res.status(400).json({ error: 'Vorlage hat ein unerwartetes Format' }); }
  await withTenantClient(req.session.householdId, client => client.query(
    'UPDATE households SET template_data=$1 WHERE id=$2', [data, req.session.householdId]));
  res.json({ ok: true });
}));

app.delete('/api/template', requireAuth, rejectForeignHouseholdId, wrap(async (req, res) => {
  await withTenantClient(req.session.householdId, client => client.query(
    'UPDATE households SET template_data=NULL WHERE id=$1', [req.session.householdId]));
  res.json({ ok: true });
}));

/* ------------------------------------------------------------------ *
 * Betrieb
 * ------------------------------------------------------------------ */
app.get('/api/health', wrap(async (req, res) => {
  await appPool.query('SELECT 1');
  res.json({ status: 'ok' });
}));

app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h', index: 'index.html' }));

app.use((req, res) => res.status(404).json({ error: 'Nicht gefunden' }));
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Interner Fehler' });
});

migrate()
  .then(() => ensureAppRolePassword())
  .then(() => app.listen(PORT, () => console.log(`Wochenplaner laeuft auf Port ${PORT}`)))
  .catch(err => { console.error(err); process.exit(1); });

const shutdown = () => Promise.all([migratorPool.end(), appPool.end()]).finally(() => process.exit(0));
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
