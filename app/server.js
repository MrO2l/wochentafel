import express from 'express';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import bcrypt from 'bcryptjs';
import pg from 'pg';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import multer from 'multer';

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

/* Rezeptkarten-Bildablage (AP2.1, projects/wochenplaner-rezeptkarten/plan.md).
 * RECIPE_IMAGES_DIR ist bereits von ART3MIS in docker-compose.yml/.env.example/
 * app/Dockerfile verdrahtet (persistentes Named Volume "recipe_images",
 * Default-Pfad /data/recipe-images, dort mit passenden Berechtigungen fuer
 * den Nicht-root-Prozess vorbereitet -- siehe Kommentare dort). Ohne gesetzte
 * Umgebungsvariable (z. B. lokaler Entwicklungsbetrieb ausserhalb von
 * Docker) faellt die App auf ein Verzeichnis unterhalb des Projektordners
 * zurueck. path.resolve() macht den Pfad in jedem Fall absolut, da
 * res.sendFile() (Bild-Auslieferung weiter unten) einen absoluten Pfad
 * voraussetzt.
 * Ablagestruktur auf der Platte: bewusst FLACH, direkt in RECIPE_IMAGES_DIR,
 * mit household_id als Dateinamens-Praefix "<household_id>_<recipe_id>_
 * <uuid>.<ext>" (Konvention aus docker-compose.yml/ops/backup-tenant-
 * offsite.sh, die per Praefix-Glob genau die Bilder eines Mandanten fuer den
 * Offsite-Backup-Export selektieren) -- KEIN Unterordner pro Haushalt, das
 * waere mit dem flachen-Dateiname-CHECK-Constraint auf recipes.image_path
 * (008_recipes.sql) ohnehin nicht abbildbar UND wuerde die bereits gebaute
 * Backup-Filterung brechen. Autorisierung laeuft trotzdem ausschliesslich
 * ueber die RLS-gestuetzte DB-Abfrage vor jedem Dateizugriff (siehe GET
 * .../image weiter unten) -- der Dateiname-Praefix ist ein Backup-
 * Hilfsmittel, keine Zugriffsschranke. */
const RECIPE_IMAGES_DIR      = path.resolve(process.env.RECIPE_IMAGES_DIR || path.join(__dirname, 'data', 'recipe-images'));
const RECIPE_IMAGE_MAX_BYTES = 5 * 1024 * 1024; // 5 MB, F4-Default (MORROW, ap1.1-datenmodell.md Abschnitt 2.5)

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

/* Rezeptkarten-Bildverzeichnis anlegen, falls es noch nicht existiert
 * (AP2.1). Im Docker-Stack ist das dank ART3MIS bereits ein gemountetes,
 * beschreibbares Volume (recipe_images) -- dieser Aufruf ist dort im
 * Normalfall ein No-Op (Verzeichnis existiert schon). Schlaegt es dennoch
 * fehl (z. B. lokaler Betrieb ohne Docker mit einem nicht beschreibbaren
 * Pfad), soll das NICHT den gesamten Start verhindern -- alle anderen
 * Endpunkte (inkl. der uebrigen Rezeptkarten-Routen ausser dem Bild-Upload)
 * funktionieren unabhaengig davon weiter. Eine deutliche Warnung im Log
 * macht das Problem trotzdem sofort sichtbar. */
async function ensureRecipeImageDir() {
  try {
    await fs.mkdir(RECIPE_IMAGES_DIR, { recursive: true });
  } catch (err) {
    console.warn(
      `Warnung: Bildverzeichnis fuer Rezeptkarten (${RECIPE_IMAGES_DIR}) konnte nicht angelegt werden ` +
      `(${err.message}). Bild-Uploads fuer Rezeptkarten schlagen fehl, bis RECIPE_IMAGES_DIR auf ein ` +
      `beschreibbares Verzeichnis zeigt.`
    );
  }
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
  goals: 12, goalText: 100, highlights: 8, highlightText: 200, calls: 20, callText: 100,
  // Rezeptkarten (AP2.1, MORROWs Vorschlag aus ap1.1-datenmodell.md Abschnitt
  // 4.3 -- spiegeln die CHECK-Constraints aus 008_recipes.sql, wo vorhanden).
  recipeTitle: 200, recipeIngredients: 60, ingredientName: 100, ingredientUnit: 20, instructions: 20000
};
const ICON_RE = /^i-[a-z0-9-]{2,30}$/;
const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
const MEAL_LABELS = ['Frühstück', 'Mittagessen', 'Abendessen', 'Snack'];

// allowRecipe:true oeffnet einen vierten, sonst ungueltigen Token-Typ
// ('recipe') -- ausschliesslich fuer Mahlzeiten-Zellen gedacht (cleanMeals()
// unten ist der einzige Aufrufer, der true uebergibt), siehe AP3.1/
// ap1.1-datenmodell.md Abschnitt 4.1/4.2: normale Personen-/Sammelzeilen
// (cleanRow()-Zweig ohne mode:'week') sowie motto/notes (cleanWeek()) rufen
// weiterhin ohne opts auf und verwerfen 'recipe'-Tokens damit unveraendert
// wie jeden anderen unbekannten Token-Typ. hasRecipe erzwingt zusaetzlich
// A3CHs Entscheidung "hoechstens ein recipe-Token pro Zelle" (siehe
// Begleitdokument Abschnitt 4.2, dort als Empfehlung/offener Punkt markiert):
// weitere recipe-Tokens im selben Array werden -- wie jeder ungueltige
// Token -- stillschweigend uebersprungen, nicht als Fehler gemeldet.
function cleanTokens(input, opts = {}) {
  if (!Array.isArray(input)) return [];
  const allowRecipe = opts.allowRecipe === true;
  const out = [];
  let hasRecipe = false;
  for (const tok of input.slice(0, LIMITS.tokens)) {
    if (!tok || typeof tok !== 'object') continue;
    if (tok.t === 'text') { const v = str(tok.v, LIMITS.text); if (v) out.push({ t: 'text', v }); }
    else if (tok.t === 'br') out.push({ t: 'br' });
    else if (tok.t === 'icon' && ICON_RE.test(String(tok.v || ''))) {
      out.push({ t: 'icon', v: String(tok.v), l: str(tok.l, LIMITS.icon) });
    } else if (allowRecipe && tok.t === 'recipe' && !hasRecipe) {
      const cleaned = cleanRecipeToken(tok);
      if (cleaned) { out.push(cleaned); hasRecipe = true; }
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

// Rezeptkarten-Zutatenliste (AP2.1): {amount, unit, name}-Eintraege, bezogen auf
// recipes.base_servings. Dieselbe Funktion ist laut ap1.1-datenmodell.md Abschnitt
// 4.3 auch fuer den kuenftigen Zuweisungs-Snapshot in weeks.data (AP3.1, 't':'recipe'-
// Token) vorgesehen -- hier zunaechst nur fuer recipes.ingredients selbst verwendet,
// da AP3.1 noch nicht Teil dieses Arbeitspakets ist. Struktur identisch zu
// cleanListItems()/cleanCalls() oben: Array kappen, jeden Eintrag pruefen, Eintraege
// ohne Namen verwerfen (name ist die einzige Pflichtangabe -- amount darf explizit
// fehlen/null sein, z. B. "Salz, nach Geschmack").
function cleanIngredients(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  for (const it of input.slice(0, LIMITS.recipeIngredients)) {
    if (!it || typeof it !== 'object') continue;
    const name = str(it.name, LIMITS.ingredientName).trim();
    if (!name) continue;
    const unit = str(it.unit, LIMITS.ingredientUnit).trim();
    const amount = (typeof it.amount === 'number' && Number.isFinite(it.amount)) ? it.amount : null;
    out.push({ amount, unit, name });
  }
  return out;
}

// Mengenumrechnung fuer die Rezept-Zuweisung (AP3.1, F5-Entscheidung des
// Nutzers, plan.md "Designentscheidungen"): linear von base_servings auf
// targetServings skalieren, auf zwei Nachkommastellen runden -- ein
// praktikabler Vorschlagswert, den der Nutzer danach im Grid frei manuell
// korrigieren kann (F5 sieht die manuelle Nachbearbeitung explizit als
// Regelfall vor, nicht als Ausnahme, z. B. bei nicht linear skalierbaren
// Angaben wie "2 Eier" oder "1 Prise"). amount:null (z. B. "nach Geschmack")
// bleibt unveraendert, da es sich naturgemaess nicht skalieren laesst
// (ap1.1-datenmodell.md Abschnitt 4.1, letzter Punkt). base_servings ist
// durch den DB-CHECK auf recipes (1-20) garantiert > 0, keine
// Division-durch-Null moeglich.
function scaleIngredients(ingredients, baseServings, targetServings) {
  const factor = targetServings / baseServings;
  const list = Array.isArray(ingredients) ? ingredients : [];
  return list.map(ing => {
    if (typeof ing.amount !== 'number' || !Number.isFinite(ing.amount)) {
      return { amount: null, unit: ing.unit, name: ing.name };
    }
    // Runden auf zwei Nachkommastellen passt sowohl fuer kleine Mengen
    // (z. B. 0.25 TL) als auch fuer groessere (z. B. 500 g) und faengt
    // nebenbei Fliesskomma-Rundungsfehler aus der reinen Multiplikation ab.
    const rounded = Math.round(ing.amount * factor * 100) / 100;
    return { amount: rounded, unit: ing.unit, name: ing.name };
  });
}

// Validierung des Zuweisungs-Snapshot-Tokens {t:'recipe',...} (AP3.1,
// ap1.1-datenmodell.md Abschnitt 4.1) -- durchlaeuft sowohl den vom
// Zuweisungs-Endpunkt selbst frisch erzeugten Token (Defense-in-Depth, siehe
// dort) als auch einen vom Client beim normalen PUT /api/weeks/:monday
// zurueckgeschickten, ggf. manuell editierten Token (F6: die Zelle ist nach
// der Zuweisung wie jede andere Zelle frei editierbar, laeuft ueber den
// bestehenden Speicherpfad statt einen eigenen). recipeId ist bewusst NUR
// eine informative Zahl (F6: kein DB-FK, darf nach Rezept-Loeschung ins
// Leere zeigen) -- hier wird lediglich die FORM gepueft (positive Ganzzahl),
// keine Existenz in der recipes-Tabelle. Gibt bei ungueltiger Form null
// zurueck (Token wird dann wie jeder andere ungueltige Token verworfen,
// siehe cleanTokens()).
function cleanRecipeToken(tok) {
  const recipeId = Number(tok.recipeId);
  if (!Number.isInteger(recipeId) || recipeId < 1) return null;
  const recipeTitle = str(tok.recipeTitle, LIMITS.recipeTitle).trim();
  if (!recipeTitle) return null;
  const servings = Number(tok.servings);
  // F3-Wertebereich (1-20) gilt fuer die Zuweisungs-Personenzahl identisch,
  // unabhaengig von recipes.base_servings des Original-Rezepts (Abschnitt 4.1).
  if (!Number.isInteger(servings) || servings < 1 || servings > 20) return null;
  return { t: 'recipe', recipeId, recipeTitle, servings, ingredients: cleanIngredients(tok.ingredients) };
}

// Fuer Zeilen mit mode:'week' (aktuell "Essen & Kochen"): keine sieben unabhaengigen
// Tageszellen mehr, sondern vier Mahlzeiten-Unterzeilen mit je einem Token[] pro Tag —
// strukturell wie eine Mini-Ausgabe des Hauptrasters (siehe Umsetzungsplan).
// allowRecipe:true (siehe cleanTokens()): NUR hier ist der 'recipe'-Token-Typ
// gueltig, gemaess ap1.1-datenmodell.md Abschnitt 4.2.
function cleanMeals(input) {
  const arr = Array.isArray(input) ? input : [];
  return Array.from({ length: MEAL_LABELS.length }, (_, i) => {
    const m = arr[i];
    return {
      label: str(m && m.label, LIMITS.label) || MEAL_LABELS[i],
      cells: Array.from({ length: 7 }, (_, d) => cleanTokens(m && m.cells && m.cells[d], { allowRecipe: true }))
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
 * Verschluesselungs-Envelope-Helfer (AP2.1, projects/wochenplaner-
 * termine-verschluesselung/plan.md; Datenmodell: MORROW, ap1.2-datenmodell.md
 * Abschnitt 6.1). Ciphertext/Nonce werden hier AUSSCHLIESSLICH als opake Bytes
 * behandelt -- keine dieser Funktionen liest je den entschluesselten Inhalt,
 * das waere ein Bruch des E2E-Ziels dieses Projekts. Geprueft wird nur Form/
 * Groesse (Schutz vor offensichtlichem Missbrauch/Speicherverbrauch), nie der
 * Inhalt selbst. pgcrypto oder eine sonstige serverseitige Ver-/Entschluesselung
 * kommt an keiner Stelle dieser Datei zum Einsatz (ZANDORs AP1.1-Vorgabe).
 * ------------------------------------------------------------------ */
const XCHACHA20_NONCE_BYTES = 24; // ZANDORs AP1.1-Empfehlung: XChaCha20-Poly1305 statt AES-256-GCM
const MAX_CIPHERTEXT_B64_LEN = 400000; // grosszuegige Obergrenze, vgl. express.json({limit:'512kb'}) unten

function decodeBase64Field(value, expectedLength) {
  if (typeof value !== 'string' || !value) return null;
  if (value.length > MAX_CIPHERTEXT_B64_LEN) return null;
  let buf;
  try { buf = Buffer.from(value, 'base64'); } catch { return null; }
  if (!buf.length) return null;
  if (expectedLength != null && buf.length !== expectedLength) return null;
  return buf;
}

// Liest {encrypted:true, keyVersion, nonce, ciphertext} aus einem Request-Body. Liefert entweder
// {nonce, ciphertext, keyVersion} (Buffer/Zahl, formal geprueft) oder null bei ungueltiger Form --
// der aufrufende Handler antwortet dann mit 400, ohne je zu versuchen, den Inhalt zu deuten.
function parseEncryptedPayload(body) {
  if (!body || body.encrypted !== true) return null;
  const keyVersion = Number(body.keyVersion);
  if (!Number.isInteger(keyVersion) || keyVersion < 1) return null;
  const nonce = decodeBase64Field(body.nonce, XCHACHA20_NONCE_BYTES);
  if (!nonce) return null;
  const ciphertext = decodeBase64Field(body.ciphertext);
  if (!ciphertext) return null;
  return { nonce, ciphertext, keyVersion };
}

// households.template_data bleibt EINE jsonb-Spalte (fuer diese Tabelle liegt kein MORROW-Schema-
// Entwurf mit eigenen Ciphertext-Spalten vor -- Migration 009 deckt nur weeks ab, siehe Ruecklauf
// an ANORAK/MORROW im Abschlussbericht zu diesem Arbeitspaket). Eine verschluesselte Vorlage wird
// deshalb als eigenes, klar erkennbares JSON-Envelope INNERHALB dieser bereits nullable jsonb-
// Spalte abgelegt, statt wie bei weeks neue bytea-Spalten anzulegen -- "__enc:true" ist der
// Diskriminator, den migrateLegacyWeek()/cleanWeek() (reine Klartext-Pfade) nie zu Gesicht
// bekommen, weil GET/PUT /api/template unten vorher danach verzweigen.
function isEncryptedTemplateEnvelope(value) {
  return !!value && typeof value === 'object' && value.__enc === true;
}
function buildTemplateEnvelope(nonce, ciphertext, keyVersion) {
  return { __enc: true, v: 1, keyVersion, nonce: nonce.toString('base64'), ciphertext: ciphertext.toString('base64') };
}

/* ------------------------------------------------------------------ *
 * Verschluesselungs-Bootstrap bei der Registrierung (AP2.1) -- prueft
 * ausschliesslich FORM/GROESSE der beiden Wraps (password/recovery_code),
 * die der Client beim Anlegen eines NEUEN Haushalts mitschickt (siehe
 * /api/auth/register unten). Der Server generiert/interpretiert keinen
 * dieser Werte selbst -- er reicht sie nur an household_key_wraps durch
 * (ap1.2-datenmodell.md Abschnitt 2.2/3). Nur fuer NEU angelegte Haushalte
 * (kein Einladungscode) -- Bootstrap fuer Bestandsmitglieder eines bereits
 * verschluesselten Haushalts ist AP2.3 und hier bewusst nicht gebaut.
 * ------------------------------------------------------------------ */
const ARGON2ID_SALT_BYTES = 16;         // libsodium crypto_pwhash_SALTBYTES
const WRAPPED_HOUSEHOLD_KEY_BYTES = 48; // 32-Byte-Haushalts-Schluessel + 16-Byte-Poly1305-Tag
// AP2.6 (ap1.2-datenmodell.md Abschnitt 2.2a): der "verifier" ist ein zweiter, unabhaengiger
// Argon2id-Output DESSELBEN Wiederherstellungscodes (eigenes Salt, gleiche Kostenparameter) --
// derselbe angeforderte Output-Laenge wie wrap_key (32 Byte, siehe crypto.js deriveWrapKey()).
const RECOVERY_VERIFIER_BYTES = 32;

function parseWrapPayload(w) {
  if (!w || typeof w !== 'object') return null;
  if (w.kdfAlgo !== 'argon2id') return null; // ZANDORs AP1.1-Vorgabe, keine anderen KDFs zulassen
  const kdfTimeCost = Number(w.kdfTimeCost), kdfMemoryCost = Number(w.kdfMemoryCost), kdfParallelism = Number(w.kdfParallelism);
  if (!Number.isInteger(kdfTimeCost) || kdfTimeCost < 1) return null;
  if (!Number.isInteger(kdfMemoryCost) || kdfMemoryCost < 1) return null;
  if (!Number.isInteger(kdfParallelism) || kdfParallelism < 1) return null;
  const kdfSalt = decodeBase64Field(w.kdfSalt, ARGON2ID_SALT_BYTES);
  if (!kdfSalt) return null;
  const wrappedKey = decodeBase64Field(w.wrappedKey, WRAPPED_HOUSEHOLD_KEY_BYTES);
  if (!wrappedKey) return null;
  const wrapNonce = decodeBase64Field(w.wrapNonce, XCHACHA20_NONCE_BYTES);
  if (!wrapNonce) return null;
  return { kdfAlgo: 'argon2id', kdfTimeCost, kdfMemoryCost, kdfParallelism, kdfSalt, wrappedKey, wrapNonce };
}

// AP2.6 (ap1.2-datenmodell.md Abschnitt 2.2a): prueft Form/Groesse von {verifierSalt, verifier}
// und hasht den vom Client gesendeten ROHEN verifier-Wert selbst server-seitig mit SHA-256 --
// analog zu bcrypt beim Passwort: der Client schickt das Klartext-Geheimnis (hier: einen Argon2id-
// Output, kein Nutzerpasswort), der Server hasht/speichert, niemals umgekehrt. Der rohe verifier-
// Wert selbst wird NICHT zurueckgegeben und darf nirgends geloggt werden (siehe Aufrufer).
function parseRecoveryVerifierPayload(v) {
  if (!v || typeof v !== 'object') return null;
  const verifierSalt = decodeBase64Field(v.verifierSalt, ARGON2ID_SALT_BYTES);
  if (!verifierSalt) return null;
  const verifierRaw = decodeBase64Field(v.verifier, RECOVERY_VERIFIER_BYTES);
  if (!verifierRaw) return null;
  return { verifierSalt, verifierHash: crypto.createHash('sha256').update(verifierRaw).digest() };
}

function parseCryptoBootstrapPayload(body) {
  const c = body && body.crypto;
  if (!c || typeof c !== 'object') return null;
  const passwordWrap = parseWrapPayload(c.passwordWrap);
  const recoveryWrap = parseWrapPayload(c.recoveryWrap);
  const recoveryVerifier = parseRecoveryVerifierPayload(c.recoveryVerifier);
  if (!passwordWrap || !recoveryWrap || !recoveryVerifier) return null;
  return { passwordWrap, recoveryWrap, recoveryVerifier };
}

async function insertKeyWrap(client, { householdId, userId, wrapType, wrap, verifierSalt = null, verifierHash = null }) {
  await client.query(
    `INSERT INTO household_key_wraps
       (household_id, user_id, wrap_type, key_version, wrapped_key, wrap_nonce,
        kdf_salt, kdf_algo, kdf_time_cost, kdf_memory_cost, kdf_parallelism,
        recovery_verifier_salt, recovery_verifier_hash)
     VALUES ($1,$2,$3,1,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [householdId, userId, wrapType, wrap.wrappedKey, wrap.wrapNonce,
     wrap.kdfSalt, wrap.kdfAlgo, wrap.kdfTimeCost, wrap.kdfMemoryCost, wrap.kdfParallelism,
     verifierSalt, verifierHash]);
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
  // 'wasm-unsafe-eval' (AP2.1, Termine-Verschluesselung): vendor/libsodium/libsodium.js
  // instanziiert WebAssembly.instantiate() fuer die Argon2id-/XChaCha20-Poly1305-Implementierung
  // (public/crypto.js). Deutlich enger als 'unsafe-eval' -- erlaubt AUSSCHLIESSLICH das
  // Kompilieren/Instanziieren von WebAssembly-Modulen, keine String-zu-Code-Auswertung
  // (eval()/new Function()) irgendeiner Art. Ohne dieses Schluesselwort blockieren moderne
  // Browser WebAssembly.instantiate() unter einer 'script-src'-Policy ohne 'unsafe-eval';
  // die vendorte Bibliothek faellt dann zwar automatisch auf ein reines JS-Backup-Modul zurueck
  // (kein Absturz), aber spuerbar langsamer -- daher hier bewusst erlaubt.
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' data:; " +
    "font-src 'self'; connect-src 'self'; " +
    "object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'");
  next();
});

/* ------------------------------------------------------------------ *
 * Zwei getrennte Session-Bereiche (AP2.1, Wochenplaner-Admin-Bereich):
 * Haushalts-Sessions (bestehend, req.session.userId/householdId) und
 * Admin-Sessions (neu, req.session.adminId) laufen ueber ZWEI eigene
 * express-session-Middlewares mit unterschiedlichem Cookie-Namen
 * ('wochenplan.sid' vs. 'wochenplan.admin.sid'), aber demselben
 * PgSession-Store (dieselbe `session`-Tabelle, keine neue Migration
 * noetig -- der Haushaltsbezug bzw. Admin-Bezug steckt jeweils nur im
 * sess-JSON, siehe ap1.1-datenmodell.md Abschnitt 4).
 *
 * WARUM zwei Middlewares statt einer gemeinsamen mit einem zusaetzlichen
 * "isAdmin"-Flag im selben req.session: express-session haengt IMMER an
 * genau EINEM req.session-Objekt, das aus GENAU EINEM Request-Cookie
 * gelesen wird. Eine gemeinsame Session wuerde bedeuten, dass ein und
 * dasselbe Cookie sowohl Haushalts- als auch Admin-Zugriff traegt -- ein
 * gestohlenes Haushalts-Cookie haette dann potenziell denselben
 * Angriffsvektor auf den Admin-Bereich wie ein gestohlenes Admin-Cookie.
 * Mit zwei komplett getrennten Cookies/Sessions ist ein Haushalts-Login
 * strukturell unfaehig, jemals adminId zu tragen (die Admin-Login-Route
 * unten schreibt ausschliesslich in die admin-Session, nie in die
 * Haushalts-Session) -- "keine Vermischung mit Haushalts-Sessions"
 * (Auftrag AP2.1) ist damit auf Code-Ebene erzwungen, nicht nur Konvention.
 *
 * mountUnless() sorgt dafuer, dass auf /api/admin/* NUR die Admin-Session-
 * Middleware laeuft (nicht zusaetzlich, verschwendet, die Haushalts-
 * Middleware) und auf allen anderen Pfaden weiterhin NUR die bestehende
 * Haushalts-Session-Middleware -- unveraendertes Verhalten fuer alle
 * bereits bestehenden Routen (keine Regression).
 * ------------------------------------------------------------------ */
const PgSession = connectPgSimple(session);
function mountUnless(prefix, middleware) {
  return (req, res, next) => (req.path.startsWith(prefix) ? next() : middleware(req, res, next));
}

const householdSessionMiddleware = session({
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
});
app.use(mountUnless('/api/admin', householdSessionMiddleware));

// Admin-Session bewusst deutlich kuerzer als die 60-Tage-Haushalts-Session:
// der Admin-Bereich hat Lösch-/Sperrrechte auf alle Kundendaten (plan.md,
// Risiko "Unautorisierter Zugriff auf Admin-Endpunkte") -- ein
// liegengelassenes, noch gueltiges Admin-Cookie ueber Wochen/Monate waere
// ein unverhaeltnismaessig grosses Zeitfenster fuer diese Rechte. 8 Stunden
// (rolling, verlaengert sich bei Aktivitaet) ist eine bewusste
// sicherheitsrelevante Annahme dieser Implementierung, im Plan nicht
// explizit vorgegeben -- Hinweis fuer ZANDORs Review (AP2.2), bei Bedarf
// leicht per Konstante anpassbar.
const ADMIN_SESSION_MAX_AGE_MS = 1000 * 60 * 60 * 8;
const adminSessionMiddleware = session({
  store: new PgSession({ pool: appPool, tableName: 'session', createTableIfMissing: false }),
  name: 'wochenplan.admin.sid',
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: SECURE_COOKIES,
    maxAge: ADMIN_SESSION_MAX_AGE_MS
  }
});
app.use('/api/admin', adminSessionMiddleware);

/* --- Bremse gegen Passwortraten: wiederverwendbare Fabrikfunktion --
 * (AP2.1: "Rate-Limiting analog bestehendem Muster" fuer den Admin-Login.
 * Urspruenglich fest verdrahtete Modul-Funktionen, hier zu einer Fabrik
 * gemacht, damit Haushalts- und Admin-Login je eine eigene, unabhaengige
 * Zaehler-Map bekommen -- sonst koennte ein Angreifer, der viele
 * Haushalts-Login-Fehlversuche mit einer E-Mail-Adresse erzeugt, die
 * zufaellig dem Admin-Benutzernamen entspricht, den echten Admin-Login
 * mit aussperren (und umgekehrt).
 *
 * ESKALIERENDE SPERRDAUER (Fix fuer ZANDORs Sicherheitsreview AP2.2, Fund 1
 * -- "Admin-Login-Lockout-DoS", 2026-08-24): Beim Haushalts-Login ist eine
 * fixe 5-Minuten-Sperre unkritisch (viele unabhaengige Accounts, ein
 * gesperrter Account blockiert nur sich selbst). Beim Admin-Login (F2:
 * genau EIN Account, kein Mehrbenutzermodell) reicht eine fixe, kurze
 * Sperre dagegen einem Angreifer, um mit vergleichsweise wenigen Requests
 * (< adminAuthLimiter-Schwelle von 30/15min) den EINZIGEN Admin-Zugang
 * dauerhaft lahmzulegen: 15 gezielte Fehlversuche pro 15-Minuten-Fenster
 * genuegen, um die 5-Minuten-Sperre lueckenlos am Laufen zu halten. Die
 * `escalating`-Option laesst die Sperrdauer bei jedem erneuten Erreichen
 * des Schwellenwerts eine Stufe weiterwandern (5min -> 15min -> 60min ->
 * 240min -> 1440min, danach Obergrenze bei 24h) statt immer wieder bei 5
 * Minuten neu zu beginnen -- ein Angreifer muesste die Anfragerate mit
 * jeder Eskalationsstufe drastisch absenken, waehrend ein einzelner
 * verpasster Login-Fehlversuch (z. B. Tippfehler) fuer den echten Admin
 * weiterhin nur eine kurze Anfangssperre ausloest. Verhalten des
 * Haushalts-Logins (`escalating: false`, Default) bleibt exakt wie zuvor
 * (5 Fehlversuche -> fixe 5 Minuten Sperre, keine Eskalation). */
function createLoginThrottle({ escalating = false } = {}) {
  const attempts = new Map();
  // Eskalationsleiter, nur wirksam mit escalating:true. Letzter Wert wirkt
  // als Obergrenze (Array-Index wird bei weiteren Wiederholungen gekappt),
  // damit ein dauerhaft angreifender Client nicht unbegrenzt lange sperrt.
  const ESCALATION_STEPS_MS = [5, 15, 60, 240, 1440].map(minutes => minutes * 60 * 1000);
  function throttle(key) {
    const now = Date.now();
    const rec = attempts.get(key) || { n: 0, until: 0, last: 0, escalationLevel: 0 };
    if (rec.until > now) return Math.ceil((rec.until - now) / 1000);
    return 0;
  }
  function noteFailure(key) {
    const now = Date.now();
    const rec = attempts.get(key) || { n: 0, until: 0, last: 0, escalationLevel: 0 };
    rec.n += 1;
    rec.last = now;
    if (rec.n >= 5) {
      if (escalating) {
        const stepIndex = Math.min(rec.escalationLevel, ESCALATION_STEPS_MS.length - 1);
        rec.until = now + ESCALATION_STEPS_MS[stepIndex];
        rec.escalationLevel += 1;
      } else {
        rec.until = now + 5 * 60 * 1000;
      }
      rec.n = 0;
    }
    attempts.set(key, rec);
  }
  const clearFailures = key => attempts.delete(key);
  // Ohne Aufraeumen waechst die Map unbegrenzt, wenn jemand viele verschiedene
  // (auch erfundene) Schluessel durchprobiert. Eintraege, die seit einer
  // Stunde weder gesperrt sind noch angefasst wurden, koennen weg -- greift
  // unveraendert auch bei eskalierten, laenger gesperrten Eintraegen (die
  // Sperre selbst haelt `until` in der Zukunft, das Aufraeumen entfernt sie
  // erst nach Ablauf UND einer zusaetzlichen Stunde Inaktivitaet).
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of attempts) if (v.until < now && now - v.last > 60 * 60 * 1000) attempts.delete(k);
  }, 30 * 60 * 1000).unref();
  return { throttle, noteFailure, clearFailures };
}
const { throttle, noteFailure, clearFailures } = createLoginThrottle();
const { throttle: adminThrottle, noteFailure: adminNoteFailure, clearFailures: adminClearFailures } =
  createLoginThrottle({ escalating: true });

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
const apiLimiter      = rateLimiter({ windowMs: 60 * 1000,      max: 120 });  // generelle Bremse ueber alle API-Aufrufe
const authLimiter     = rateLimiter({ windowMs: 15 * 60 * 1000, max: 30 });   // Login und Registrierung
const inviteLimiter   = rateLimiter({ windowMs: 60 * 60 * 1000, max: 20 });   // Einladungscodes erzeugen
const adminAuthLimiter = rateLimiter({ windowMs: 15 * 60 * 1000, max: 30 }); // Admin-Login (AP2.1, analog authLimiter)
// AP5.2-Ergaenzung (ZANDOR-Review, Fund "Speicher-Erschoepfung durch nebenlaeufige
// Bild-Uploads", MITTEL): multer.memoryStorage() puffert bis zu RECIPE_IMAGE_MAX_BYTES
// (5 MB) je Upload vollstaendig im RAM, BEVOR die Route selbst laeuft. Der generelle
// apiLimiter (120/Min) begrenzt zwar die Anfragenzahl, laesst aber genug gleichzeitige/
// kurz aufeinanderfolgende Uploads zu, um im Shared-Instance-Modell (eine App-Instanz
// fuer alle Mandanten, mem_limit:256m in docker-compose.yml) den Container fuer ALLE
// Haushalte zum Absturz zu bringen -- ein einzelner authentifizierter Nutzer koennte
// sonst genug 5-MB-Puffer parallel im RAM halten. Eigener, deutlich engerer Limiter nur
// fuer die beiden Rezept-Schreibrouten (POST/PUT /api/recipes, beide gehen ausnahmslos
// durch multipart/form-data und damit durch handleRecipeImageUpload -- siehe dortige
// Route-Definitionen), VOR handleRecipeImageUpload eingehaengt, damit eine bereits
// limitierte Anfrage gar nicht erst gepuffert wird.
const recipeImageUploadLimiter = rateLimiter({ windowMs: 60 * 1000, max: 8 }); // max. 8 Rezept-Uploads/Min je IP
app.use('/api', apiLimiter);

function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Nicht angemeldet' });
  next();
}

/* ------------------------------------------------------------------ *
 * Admin-Auth-Middleware (AP2.1). 403 statt 401 bei fehlender/ungueltiger
 * Admin-Session -- bewusst einheitlich fuer JEDEN Aufrufer (anonym oder
 * mit gueltiger Haushalts-Session), weil requireAdminAuth aus der
 * admin-scoped Session (siehe oben) grundsaetzlich nicht erkennen kann,
 * ob ein Aufrufer "nur nicht eingeloggt" oder "als Haushalts-Nutzer
 * eingeloggt, aber kein Admin" ist (beides sieht fuer 'wochenplan.admin.sid'
 * identisch aus: kein adminId im Session-JSON). 403 deckt in diesem
 * einheitlichen Fall sowohl den Plan-Wortlaut "403 fuer Haushalts-Nutzer
 * auf Admin-Routen" als auch das Erfolgskriterium "401/403" ab, siehe
 * plan.md AP2.1.
 * ------------------------------------------------------------------ */
function requireAdminAuth(req, res, next) {
  if (!req.session.adminId) return res.status(403).json({ error: 'Kein Zugriff' });
  next();
}

// Hinweis fuer kuenftige /api/admin/*-Endpunkte (AP3.1-3.3, F1-Feldliste
// etc.): dieser Datei-Stil deklariert requireAuth/requireAdminAuth explizit
// PRO ROUTE (kein blanket Router-Gate), analog dem bestehenden Muster bei
// den Haushalts-Routen unten -- jede neue Admin-Route MUSS requireAdminAuth
// selbst einbinden, sonst bleibt sie ungeschuetzt. ZANDOR sollte das bei
// jedem neuen Admin-Endpunkt gezielt gegenpruefen (AP5.1).

/* ------------------------------------------------------------------ *
 * CSRF-Schutz fuer den Admin-Bereich (Arbeitspaket "Admin-Frontend",
 * ergaenzt ZANDORs AP2.2-Fund 5 "Double-Submit-Cookie-Token", der explizit
 * zurueckgestellt wurde, SOLANGE kein browserbasiertes Admin-Frontend
 * existiert -- mit admin.html/admin-login.html ist genau dieser Fall jetzt
 * eingetreten, die Entscheidung wird hiermit nachgeholt.
 *
 * Double-Submit-Cookie, mit einer bewussten Haertung ueber das reine
 * Grundmuster hinaus: ein zufaelliges Token wird bei Admin-Login UND bei
 * GET /api/admin/me (Seitenaufruf von admin.html) (1) in ein eigenes,
 * admin-scoped Cookie geschrieben UND (2) serverseitig in
 * req.session.csrfToken abgelegt UND (3) im JSON-Antwortkoerper an den
 * Client zurueckgegeben. Der Client speichert ausschliesslich die per JSON
 * gelieferte Kopie (kein clientseitiges document.cookie-Parsing noetig) und
 * schickt sie bei jedem zustandsaendernden Request im Header
 * "X-CSRF-Token" zurueck; das Cookie selbst wird vom Browser automatisch
 * mitgeschickt (Cookies werden unabhaengig von httpOnly immer gesendet,
 * httpOnly verhindert nur das Auslesen per JS). requireAdminCsrf verlangt
 * unten Uebereinstimmung ALLER DREI Werte (Header, Cookie, Session) --
 * strenger als ein reines Double-Submit-Cookie (das nur Header gegen Cookie
 * prueft), weil hier zusaetzlich ein serverseitig an die konkrete
 * Admin-Session gebundener Wert verglichen wird. Das CSRF-Cookie ist daher
 * bewusst httpOnly (anders als beim "klassischen" Double-Submit-Muster, das
 * ein per JS lesbares Cookie braucht) -- der Client braucht es nie per JS zu
 * lesen, da der massgebliche Wert ohnehin per JSON geliefert wird; httpOnly
 * verkleinert die Angriffsflaeche zusaetzlich, ohne die Funktion
 * einzuschraenken.
 *
 * Warum das ueberhaupt noetig ist, obwohl SameSite=Lax bereits (wie bei
 * allen bestehenden Endpunkten dieser App) cross-origin-initiierte
 * POST/DELETE-Anfragen blockiert: SameSite=Lax ist eine Browser-Verteidigung
 * mit Sonderfaellen (u. a. aeltere/nicht standardkonforme Browser, sowie
 * Top-Level-Navigationen per GET, die hier zwar nicht direkt greifen, aber
 * das grundsaetzliche Prinzip "nicht ausschliesslich auf ein einzelnes
 * Cookie-Attribut verlassen" gilt fuer einen Admin-Bereich mit
 * Loesch-/Sperrrechten auf alle Kundendaten strenger als fuer die uebrigen
 * Haushalts-Endpunkte) -- Defense-in-Depth, kein Ersatz fuer SameSite,
 * zusaetzlich dazu.
 * ------------------------------------------------------------------ */
const ADMIN_CSRF_COOKIE = 'wochenplan.admin.csrf';

// req.cookies existiert nicht (kein cookie-parser als Abhaengigkeit, siehe
// package.json -- bewusst schlank gehalten, analog zum Rest dieser Datei,
// die z. B. auch eigene Rate-Limiter statt einer Bibliothek schreibt).
// Liest ein einzelnes Cookie direkt aus dem Request-Header.
function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

// Erzeugt (bzw. erneuert) das Admin-CSRF-Token fuer die aktuelle Admin-
// Session: setzt das Cookie UND den Session-Wert, gibt das Token zurueck,
// damit der Aufrufer es zusaetzlich im JSON-Antwortkoerper mitliefern kann.
function issueAdminCsrfToken(req, res) {
  const token = crypto.randomBytes(32).toString('hex');
  req.session.csrfToken = token;
  res.cookie(ADMIN_CSRF_COOKIE, token, {
    httpOnly: true,           // siehe Begruendung oben -- Client braucht das Cookie nie per JS zu lesen
    sameSite: 'lax',
    secure: SECURE_COOKIES,
    path: '/api/admin',
    maxAge: ADMIN_SESSION_MAX_AGE_MS
  });
  return token;
}

// Middleware ausschliesslich fuer die drei zustandsaendernden
// Admin-Endpunkte (deactivate/reactivate/delete) -- bewusst NICHT als Teil
// von requireAdminAuth selbst, damit lesende Admin-Routen (GET
// /api/admin/me, GET /api/admin/households) unveraendert ohne Token
// funktionieren (dort gibt es nichts zu faelschen). Muss NACH
// requireAdminAuth eingehaengt werden (braucht eine bereits gueltige
// req.session.adminId/req.session.csrfToken).
// Zeitkonstanter String-Vergleich fuer Secret-Werte (ZANDORs Nachbesserung zum
// CSRF-Review, CWE-208): ein einfaches "==="/"!==" auf Strings vergleicht
// intern zeichenweise und bricht beim ersten Unterschied ab -- die
// Vergleichsdauer haengt dadurch minimal von der Anzahl uebereinstimmender
// Anfangszeichen ab, was einem Angreifer mit sehr genauer Zeitmessung
// theoretisch erlauben koennte, ein gueltiges Token Zeichen fuer Zeichen zu
// erraten. crypto.timingSafeEqual() vergleicht stattdessen immer alle Bytes,
// unabhaengig vom Ergebnis. Erfordert gleich lange Buffer (wirft sonst) --
// die Laengenpruefung davor ist daher kein zusaetzliches Informationsleck
// (Cookie-/Header-/Session-Tokens haben ohnehin alle dieselbe feste Laenge
// von issueAdminCsrfToken(), ein Laengenunterschied bedeutet immer schon
// "kein gueltiges Token"), sondern verhindert nur den Wurf.
function timingSafeTokenEquals(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function requireAdminCsrf(req, res, next) {
  const headerToken = req.get('X-CSRF-Token');
  const cookieToken = readCookie(req, ADMIN_CSRF_COOKIE);
  const sessionToken = req.session.csrfToken;
  if (!sessionToken || !headerToken || !cookieToken ||
      !timingSafeTokenEquals(headerToken, cookieToken) ||
      !timingSafeTokenEquals(headerToken, sessionToken)) {
    return res.status(403).json({ error: 'CSRF-Token fehlt oder ist ungueltig. Bitte Seite neu laden und erneut versuchen.' });
  }
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

    if (inviteCode) {
      // AP2.1 (Termine-Verschluesselung): Beitritt zu einem Haushalt, der die Verschluesselung
      // bereits aktiviert hat, braucht einen 'pending'-Wrap fuer das neue Mitglied (Bootstrap-
      // /Aktivierungs-UX, AP2.3 -- separates, noch nicht beauftragtes Arbeitspaket). Ohne diesen
      // Wrap koennte das neue Mitglied nach der Registrierung zwar einen Account haben, aber nie
      // den Haushalts-Schluessel entpacken -- daher hier bewusst ein klarer Fehler statt eines
      // stillen, spaeter schwer nachvollziehbaren Zugriffsproblems. Bewusst ERST HIER (nach
      // setTenantContext() oben), nicht schon direkt nach dem Invite-Lookup: households
      // unterliegt RLS (003_rls_policies.sql) -- ein Lesezugriff vor gesetztem Tenant-Kontext
      // fuehrte beim Testen auf einer wiederverwendeten Pool-Verbindung zu einem harten Fehler
      // statt eines einfachen "0 Zeilen" (current_setting() liefert nach einem bereits einmal in
      // der Session gesetzten Custom-GUC beim Zuruecksetzen einen LEEREN STRING statt NULL,
      // ''::bigint wirft "invalid input syntax" -- live reproduziert, siehe identischer Fund/Fix
      // bei /api/auth/recover weiter unten).
      const hCheck = await client.query('SELECT encryption_status FROM households WHERE id=$1', [householdId]);
      if (hCheck.rows[0]?.encryption_status !== 'plaintext') {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: 'Dieser Haushalt hat die Termin-Verschluesselung bereits aktiviert. Der Beitritt ' +
            'weiterer Mitglieder zu einem bereits verschluesselten Haushalt wird mit einem ' +
            'spaeteren Update unterstuetzt.'
        });
      }
    }

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
    let householdEncrypted = false; // fuer die Antwort unten -- true, wenn der Bootstrap gegriffen hat
    if (inviteCode) {
      await client.query('UPDATE invites SET used_at=now(), used_by=$1 WHERE code=$2', [user.rows[0].id, inviteCode]);
    } else {
      // Verschluesselungs-Bootstrap NUR fuer neu angelegte Haushalte (kein Einladungscode) --
      // Bestandsmitglieder-Bootstrap eines bereits existierenden Haushalts ist AP2.3 (separates,
      // noch nicht beauftragtes Arbeitspaket), siehe Kommentar im Einladungs-Zweig oben. Der
      // Client generiert den Haushalts-Schluessel, beide Wraps UND den Wiederherstellungscode
      // ausschliesslich lokal (public/crypto.js) -- crypto ist hier rein optional: fehlt das Feld
      // (z. B. ein aelterer/abweichender Client), bleibt der Haushalt einfach 'plaintext'
      // (Default, siehe Migration 009) und verhaelt sich exakt wie vor diesem Arbeitspaket.
      const cryptoPayload = parseCryptoBootstrapPayload(req.body);
      if (cryptoPayload) {
        const newUserId = user.rows[0].id;
        await insertKeyWrap(client, { householdId, userId: newUserId, wrapType: 'password', wrap: cryptoPayload.passwordWrap });
        // recovery_code ist bewusst HAUSHALTSWEIT, nicht an user_id gebunden (Nutzerentscheidung
        // 2026-09-06, siehe ap1.2-datenmodell.md Abschnitt 2.2/Migration 009 CHECK-Constraint
        // household_key_wraps_subject_shape) -- user_id bleibt hier daher NULL.
        // AP2.6-Nachtrag: recovery_verifier_salt/-hash gehoeren untrennbar zum selben Code wie
        // wrappedKey -- werden hier gemeinsam mit dem recovery_code-Wrap angelegt (nie getrennt).
        await insertKeyWrap(client, {
          householdId, userId: null, wrapType: 'recovery_code', wrap: cryptoPayload.recoveryWrap,
          verifierSalt: cryptoPayload.recoveryVerifier.verifierSalt, verifierHash: cryptoPayload.recoveryVerifier.verifierHash
        });
        // Einziges Mitglied dieses frischen Haushalts hat jetzt sofort einen echten password-Wrap
        // -- der Uebergangszustand 'activating' (fuer Haushalte mit noch nicht durchgaengig
        // gewrappten Bestandsmitgliedern, siehe ap1.2-datenmodell.md Abschnitt 2.5) ist hier nicht
        // noetig, es gibt ja noch kein zweites Mitglied.
        await client.query(`UPDATE households SET encryption_status='active' WHERE id=$1`, [householdId]);
        householdEncrypted = true;
      }
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
      res.status(201).json({ user: user.rows[0], householdEncrypted });
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

/* ------------------------------------------------------------------ *
 * Wiederherstellungscode-Abfrage (AP2.1, erweitert in AP2.6 -- Phase 1 des
 * Passwort-Reset-Flusses, ap1.2-datenmodell.md Abschnitt 7a)
 *
 * Dieser Endpunkt bleibt weiterhin rein LESEND und veraendert nie Sitzung,
 * Passwort oder Wraps -- er liefert die bereits AEAD-geschuetzten Wrap-Felder
 * des haushaltsweiten recovery_code-Wraps zu einer E-Mail-Adresse (analog zum
 * Login-Lookup, nur ohne password_hash) sowie -- rein zu Demonstrations-/
 * Testzwecken -- die Ciphertext-Bytes der zuletzt geaenderten Woche desselben
 * Haushalts. AP2.6-Ergaenzung: liefert jetzt zusaetzlich
 * recoveryVerifierSalt (unkritisch, siehe Migration 009 Kommentar) -- damit
 * kann der Client lokal denselben "verifier"-Wert reproduzieren, den Phase 2
 * (POST /api/auth/password-reset unten) prueft. recovery_verifier_hash bleibt
 * server-intern und wird HIER NICHT in die Antwort uebernommen (siehe dortiger
 * Kommentar) -- AP2.1s urspruenglich hier dokumentierte Einschraenkung ("kein
 * Passwort-Reset moeglich, da kein Verifier-Wert existiert") ist mit AP2.6
 * behoben, siehe POST /api/auth/password-reset weiter unten.
 * ------------------------------------------------------------------ */
app.post('/api/auth/recover', authLimiter, wrap(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const wait = throttle(`recover:${email}`);
  if (wait) return res.status(429).json({ error: `Zu viele Versuche. Bitte ${wait} Sekunden warten.` });

  const q = await appPool.query('SELECT * FROM auth_lookup_recovery_wrap($1)', [email]);
  const row = q.rows[0];
  if (!row) {
    noteFailure(`recover:${email}`);
    return res.status(404).json({ error: 'Fuer diese E-Mail-Adresse ist kein Wiederherstellungscode hinterlegt' });
  }
  clearFailures(`recover:${email}`);

  // WICHTIG (beim Umsetzen/Docker-Testlauf entdeckt): weeks unterliegt RLS (003_rls_policies.sql)
  // -- ein blanker appPool.query() OHNE vorher gesetzten Tenant-Kontext funktioniert deshalb NICHT
  // zuverlaessig wie ein einfaches "liefert dann eben 0 Zeilen": auf einer wiederverwendeten
  // Pool-Verbindung, auf der der GUC app.current_household_id bereits MINDESTENS EINMAL zuvor
  // (in einer anderen Anfrage) transaktionslokal gesetzt wurde, liefert current_setting(...) nach
  // COMMIT nicht mehr NULL, sondern einen LEEREN STRING (Postgres-Eigenheit bei erstmals in der
  // Session gesetzten Custom-GUCs) -- ''::bigint wirft dann "invalid input syntax for type
  // bigint", statt die RLS-Policy einfach 0 Zeilen liefern zu lassen. Live reproduziert. Fix:
  // den Tenant-Kontext hier explizit setzen (household_id ist ja bereits bekannt, siehe row oben)
  // -- exakt dasselbe etablierte Muster wie jeder andere Endpunkt in dieser Datei
  // (withTenantClient()), statt RLS "zufaellig" mit einem impliziten NULL-Kontext zu umgehen.
  const sample = await withTenantClient(row.household_id, async client => {
    const sampleQ = await client.query(
      `SELECT to_char(week_start,'YYYY-MM-DD') AS "weekStart", data_nonce, data_ciphertext
         FROM weeks WHERE household_id=$1 AND data_ciphertext IS NOT NULL
         ORDER BY updated_at DESC LIMIT 1`, [row.household_id]);
    return sampleQ.rowCount ? sampleQ.rows[0] : null;
  });
  const sampleOut = sample ? {
    weekStart: sample.weekStart,
    nonce: sample.data_nonce.toString('base64'),
    ciphertext: sample.data_ciphertext.toString('base64')
  } : null;

  res.json({
    keyVersion: row.key_version,
    wrappedKey: row.wrapped_key.toString('base64'),
    wrapNonce: row.wrap_nonce.toString('base64'),
    kdfSalt: row.kdf_salt.toString('base64'),
    kdfAlgo: row.kdf_algo,
    kdfTimeCost: row.kdf_time_cost,
    kdfMemoryCost: row.kdf_memory_cost,
    kdfParallelism: row.kdf_parallelism,
    // AP2.6: recoveryVerifierSalt darf raus (unkritisch, wie kdfSalt) -- recovery_verifier_hash
    // (row.recovery_verifier_hash) wird an dieser Stelle BEWUSST NICHT gelesen/uebernommen, siehe
    // Dateikopf-Kommentar und ap1.2-datenmodell.md Abschnitt 2.2a.
    recoveryVerifierSalt: row.recovery_verifier_salt.toString('base64'),
    sample: sampleOut
  });
}));

/* ------------------------------------------------------------------ *
 * AP2.6, Phase 2 -- Passwort-Reset via Wiederherstellungscode
 * (ap1.2-datenmodell.md Abschnitt 7a, MORROWs Design; Rate-Limiting-Vorgaben
 * von ZANDOR, siehe unten -- beides woertlich umgesetzt, nicht optional).
 *
 * Ablauf: Client hat bereits per POST /api/auth/recover (Phase 1, oben)
 * wrappedKey/wrapNonce/kdfSalt/recoveryVerifierSalt geladen, den eingegebenen
 * Wiederherstellungscode lokal in ZWEI unabhaengige Argon2id-Outputs
 * ueberfuehrt (wrap_key ueber kdfSalt, verifier ueber recoveryVerifierSalt --
 * unterschiedliche Salts, siehe ap1.2-datenmodell.md Abschnitt 2.2a) und
 * lokal per AEAD-Unwrap bereits verifiziert, dass wrap_key den Haushalts-
 * Schluessel tatsaechlich entpackt (misslingt das, bricht der Client VOR
 * diesem Request ab -- kein Server-Roundtrip fuer diese Pruefung noetig).
 * Dieser Endpunkt bekommt NUR den rohen verifier-Wert (NICHT wrap_key, NICHT
 * den Code selbst, NICHT den Haushalts-Schluessel) sowie einen fertigen,
 * bereits clientseitig neu gewrappten password-Wrap fuer das eine, ueber die
 * E-Mail identifizierte Konto.
 *
 * Sicherheitseigenschaft (server-seitige Sicht): der Server kann NIE selbst
 * pruefen, dass der neue Wrap tatsaechlich denselben Haushalts-Schluessel
 * kapselt wie der bestehende recovery_code-Wrap (E2E-Prinzip, identisch zum
 * Registrierungs-Bootstrap AP2.1) -- die einzige serverseitig pruefbare
 * Autorisierung ist der verifier-Vergleich. Ein falscher/erratener verifier
 * fuehrt zu 401, ohne dass irgendein Wrap/Passwort veraendert wird.
 * ------------------------------------------------------------------ */

// ZANDORs Vorgabe 2 (Rate-Limiting): dedizierter IP-Limiter, NICHT im geteilten
// authLimiter-Budget -- ein Angreifer, der viele E-Mail-Adressen gegen denselben
// Endpunkt durchprobiert, soll nicht durch die grosszuegigere authLimiter-Quote
// (30/15min, geteilt mit Login/Registrierung) gedeckt sein.
const passwordResetLimiter = rateLimiter({ windowMs: 15 * 60 * 1000, max: 10 });
// ZANDORs Vorgabe 2: escalating Pro-Konto-Bremse analog zum bestehenden Admin-
// Login-Muster (createLoginThrottle({escalating:true})) -- 5 Fehlversuche loesen
// die naechste Eskalationsstufe aus (5/15/60/240/1440 min), Key "pwreset:<email>".
const { throttle: pwResetThrottle, noteFailure: pwResetNoteFailure, clearFailures: pwResetClearFailures } =
  createLoginThrottle({ escalating: true });

app.post('/api/auth/password-reset', passwordResetLimiter, wrap(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const throttleKey = `pwreset:${email}`;
  const wait = pwResetThrottle(throttleKey);
  if (wait) return res.status(429).json({ error: `Zu viele Versuche. Bitte ${wait} Sekunden warten.` });

  const newPassword = String(req.body.newPassword || '');
  if (newPassword.length < 10) return res.status(400).json({ error: 'Das neue Passwort muss mindestens 10 Zeichen haben' });

  const passwordWrap = parseWrapPayload(req.body?.passwordWrap);
  const verifierRaw = decodeBase64Field(req.body?.verifier, RECOVERY_VERIFIER_BYTES);
  if (!passwordWrap || !verifierRaw) return res.status(400).json({ error: 'Ungueltige oder fehlende Daten' });

  const q = await appPool.query('SELECT * FROM auth_lookup_recovery_wrap($1)', [email]);
  const row = q.rows[0];
  // Generische Fehlermeldung fuer "E-Mail unbekannt" UND "verifier falsch" -- verhindert E-Mail-
  // Enumeration (ap1.2-datenmodell.md Abschnitt 7a, Schritt 4). Ein Dummy-Hash-Vergleich haelt die
  // Antwortzeit fuer den "E-Mail unbekannt"-Fall auf demselben Niveau wie einen echten Vergleich
  // (identisches Muster wie beim bestehenden Login-Dummy-bcrypt-Vergleich).
  const providedHash = crypto.createHash('sha256').update(verifierRaw).digest();
  const storedHash = row ? row.recovery_verifier_hash : crypto.createHash('sha256').update(Buffer.alloc(RECOVERY_VERIFIER_BYTES)).digest();
  // timingSafeEqual verlangt gleich lange Buffer -- beide sind hier immer exakt 32 Byte (SHA-256-
  // Digest-Laenge), daher kein Laengen-Mismatch-Sonderfall noetig.
  const verifierMatches = row ? crypto.timingSafeEqual(providedHash, storedHash) : false;

  if (!row || !verifierMatches) {
    pwResetNoteFailure(throttleKey);
    // KEIN Logging von email/verifier/newPassword hier -- nur die generische Fehlerkategorie.
    return res.status(401).json({ error: 'E-Mail-Adresse oder Wiederherstellungscode ist falsch' });
  }
  pwResetClearFailures(throttleKey);

  const client = await appPool.connect();
  try {
    await client.query('BEGIN');
    await setTenantContext(client, row.household_id);

    const passwordHash = await bcrypt.hash(newPassword, 12);
    await client.query('UPDATE users SET password_hash=$1 WHERE id=$2', [passwordHash, row.user_id]);

    // Bestehenden password-Wrap ersetzen (haeufigster Fall) ODER neu anlegen (Nachzuegler-
    // Mitglied ohne bisherigen password-Wrap, z. B. noch nicht abgeschlossene AP2.3-Aktivierung --
    // ap1.2-datenmodell.md Abschnitt 7a, Schritt 5).
    const existing = await client.query(
      `SELECT id FROM household_key_wraps
        WHERE household_id=$1 AND user_id=$2 AND wrap_type='password' AND revoked_at IS NULL
        FOR UPDATE`,
      [row.household_id, row.user_id]);
    if (existing.rowCount) {
      await client.query(
        `UPDATE household_key_wraps
            SET wrapped_key=$1, wrap_nonce=$2, kdf_salt=$3, kdf_algo=$4,
                kdf_time_cost=$5, kdf_memory_cost=$6, kdf_parallelism=$7, updated_at=now()
          WHERE id=$8`,
        [passwordWrap.wrappedKey, passwordWrap.wrapNonce, passwordWrap.kdfSalt, passwordWrap.kdfAlgo,
         passwordWrap.kdfTimeCost, passwordWrap.kdfMemoryCost, passwordWrap.kdfParallelism, existing.rows[0].id]);
    } else {
      await insertKeyWrap(client, { householdId: row.household_id, userId: row.user_id, wrapType: 'password', wrap: passwordWrap });
    }
    // recovery_code-Wrap bleibt UNVERAENDERT (ap1.2-datenmodell.md Abschnitt 7: Passwort-/Code-
    // Kompromittierung sind unabhaengige Ereignisse) -- ZANDORs Vorgabe 3: keine automatische/
    // stille Verifier-Rotation, der Client fordert den Nutzer stattdessen zur manuellen
    // Neu-Erzeugung auf (siehe Konto-Ansicht, app.js).

    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally { client.release(); }
}));

/* ------------------------------------------------------------------ *
 * Admin-Authentifizierung (AP2.1, Wochenplaner-Admin-Bereich)
 *
 * Ein-Account-Modell (F2, plan.md "Entscheidungen"): admin_account traegt
 * bewusst keine Rolle-Spalte, kein Verwaltungs-Endpunkt legt neue
 * Admin-Accounts an -- Anlage ausschliesslich per CLI-Skript
 * scripts/create-admin.mjs (analog create-tenant.mjs), siehe dort.
 *
 * admin_account hat KEINE Row-Level-Security (005_admin_foundation.sql legt
 * bewusst kein ENABLE ROW LEVEL SECURITY dafuer an -- anders als
 * households/users ist diese Tabelle nicht mandantenbezogen, sondern trägt
 * global genau eine Zeile). Der Lookup unten laeuft daher als normale
 * Abfrage direkt ueber appPool (wochenplan_app hat SELECT-Grant, siehe
 * Migration Abschnitt 1) -- anders als beim Haushalts-Login braucht es
 * dafuer KEINE SECURITY-DEFINER-Funktion wie auth_lookup_by_email().
 * ------------------------------------------------------------------ */
app.post('/api/admin/auth/login', adminAuthLimiter, wrap(async (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  const usernameKey = username.toLowerCase();
  // Throttle-Schluessel bewusst aus Benutzername UND Quell-IP zusammengesetzt
  // (Fix fuer ZANDORs Fund 1, 2026-08-24 -- Ergaenzung zur Eskalation oben,
  // siehe Begruendung bei createLoginThrottle()). Wirkung: eine Sperre trifft
  // ausschliesslich Anfragen von genau dieser IP gegen genau diesen
  // Benutzernamen -- ein Angreifer kann damit nicht mehr per reinem
  // Benutzernamen-Keying den EINEN Admin-Account global fuer JEDE IP
  // (also auch fuer den echten Admin von seiner eigenen IP aus) sperren.
  // ZANDORs eigene Einordnung gilt unveraendert: das allein reicht NICHT
  // als alleinige Verteidigung (ein Angreifer mit vielen IPs oder mit
  // Kenntnis/Kontrolle der Admin-IP umgeht das), daher zusaetzlich zur --
  // nicht statt der -- Eskalation zu verstehen, reine zusaetzliche
  // Haertung. req.ip beruecksichtigt bereits TRUST_PROXY (app.set('trust
  // proxy', 1) oben), identisches Muster wie im bestehenden rateLimiter().
  const throttleKey = `${usernameKey}|${req.ip}`;
  const wait = adminThrottle(throttleKey);
  if (wait) return res.status(429).json({ error: `Zu viele Fehlversuche. Bitte ${wait} Sekunden warten.` });

  const q = await appPool.query(
    'SELECT id, username, password_hash FROM admin_account WHERE lower(username) = lower($1)', [username]);
  const row = q.rows[0];
  // Dummy-Hash-Vergleich bei unbekanntem Benutzernamen (identisches Muster
  // wie beim Haushalts-Login oben): verhindert, dass die Antwortzeit einen
  // Rueckschluss zulaesst, ob der Benutzername ueberhaupt existiert.
  const ok = row ? await bcrypt.compare(password, row.password_hash) : await bcrypt.compare(password, '$2a$12$' + 'x'.repeat(53));
  if (!row || !ok) {
    adminNoteFailure(throttleKey);
    // Audit-Log (ZANDOR AP2.2, Fund 2 -- 006_admin_audit_log.sql): bewusst
    // AWAIT statt fire-and-forget -- schlaegt der INSERT fehl, soll die
    // Anfrage mit 500 statt einem stillschweigend unprotokollierten 401
    // enden (fail-closed, konsistent mit dem bereits etablierten Muster von
    // set_tenant_context_audited() aus 004, das bei einem Audit-Fehler
    // ebenfalls die gesamte Anfrage scheitern laesst statt den Fehler zu
    // verschlucken). admin_id ist bei unbekanntem Benutzernamen NULL (kein
    // admin_account-Datensatz zum Verknuepfen); detail traegt den
    // (kleingeschriebenen) versuchten Benutzernamen -- der einzige Admin-
    // Benutzername, kein Kunden-PII.
    await appPool.query(
      `INSERT INTO admin_audit_log(event_type, admin_id, ip_address, detail)
       VALUES ('admin_login_failure', $1, $2, $3)`,
      [row ? row.id : null, req.ip, usernameKey]);
    return res.status(401).json({ error: 'Benutzername oder Passwort stimmt nicht' });
  }

  adminClearFailures(throttleKey);
  // regenerate() VOR dem Setzen von adminId: verhindert Session-Fixation
  // (identisches Muster wie beim Haushalts-Login/Registrierung oben).
  req.session.regenerate(err => {
    if (err) return res.status(500).json({ error: 'Anmeldung fehlgeschlagen' });
    req.session.adminId = row.id;
    // CSRF-Token (Arbeitspaket "Admin-Frontend", siehe requireAdminCsrf oben):
    // erst NACH regenerate() ausstellen, damit es an der NEUEN Session-ID
    // haengt, nicht an der vor der Anmeldung bestehenden (Session-Fixation-
    // Analogie zu adminId selbst).
    const csrfToken = issueAdminCsrfToken(req, res);
    // Audit-Log-Insert liegt bewusst NACH regenerate() (neue Session-ID muss
    // stehen) und VOR der Erfolgsantwort. Schlaegt der INSERT fehl, wird die
    // gerade erst regenerierte Session wieder verworfen, statt dem Client
    // einen 500er zu melden, waehrend das admin.sid-Cookie durch den
    // automatischen express-session-Save am Response-Ende trotzdem eine
    // gueltige, eingeloggte Session persistieren wuerde (session.destroy()
    // verhindert genau dieses Auseinanderlaufen von Client-Antwort und
    // tatsaechlichem Server-Zustand).
    appPool.query(
      `INSERT INTO admin_audit_log(event_type, admin_id, ip_address)
       VALUES ('admin_login_success', $1, $2)`,
      [row.id, req.ip]
    ).then(
      () => res.json({ admin: { id: row.id, username: row.username }, csrfToken }),
      auditErr => {
        console.error('Admin-Audit-Log (Login-Erfolg) fehlgeschlagen:', auditErr);
        req.session.destroy(() => res.status(500).json({ error: 'Anmeldung fehlgeschlagen' }));
      }
    );
  });
}));

app.post('/api/admin/auth/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('wochenplan.admin.sid');
    res.clearCookie(ADMIN_CSRF_COOKIE, { path: '/api/admin' });
    res.json({ ok: true });
  });
});

app.get('/api/admin/me', requireAdminAuth, wrap(async (req, res) => {
  const q = await appPool.query('SELECT id, username FROM admin_account WHERE id=$1', [req.session.adminId]);
  // admin_account-Zeile koennte zwischen Login und Folge-Request
  // theoretisch verschwinden (kein Loesch-Endpunkt in diesem Plan
  // vorgesehen, F2 -- aber Defense-in-Depth statt stillschweigender
  // Annahme, analog GET /api/me oben).
  if (!q.rowCount) return req.session.destroy(() => res.status(401).json({ error: 'Nicht angemeldet' }));
  // CSRF-Token (Arbeitspaket "Admin-Frontend"): admin.html ruft diese Route
  // bei jedem Seitenaufruf als Auth-Check auf und nutzt genau diesen
  // Zeitpunkt, um sein CSRF-Token zu (be-)ziehen -- entweder das bereits in
  // der Session bestehende (Normalfall) oder, falls eine bereits vor
  // Einfuehrung dieses Mechanismus bestehende Admin-Session noch keines
  // traegt, ein frisch ausgestelltes (Selbstheilung ohne erzwungenen
  // Re-Login).
  const csrfToken = req.session.csrfToken || issueAdminCsrfToken(req, res);
  res.json({ admin: q.rows[0], csrfToken });
}));

/* ------------------------------------------------------------------ *
 * Admin-Uebersicht (AP3.1, Wochenplaner-Admin-Bereich)
 *
 * Nutzt ausschliesslich die SECURITY-DEFINER-Funktion admin_list_households()
 * aus 005_admin_foundation.sql -- kein direkter Tabellenzugriff auf
 * households (waere durch RLS ohnehin auf den eigenen Sitzungskontext
 * beschraenkt und liefert fuer eine admin-scoped Session, die keinen
 * household_id-Kontext setzt, schlicht 0 Zeilen). Die Funktion selbst
 * braucht keinen p_admin_id-Parameter (reiner Lesezugriff, kein Audit-Feld
 * zu befuellen) -- anders als bei den kommenden AP3.2/AP3.3-Schreib-
 * Endpunkten, siehe Hinweis dort.
 *
 * Feldliste exakt nach F1-Entscheidung (plan.md "Entscheidungen"): nur
 * Haushalts-ID, Erstellungsdatum, Mitgliederzahl, Status inkl. Grund-Code
 * -- kein Klarname, keine E-Mail. admin_list_households() liefert selbst
 * bereits nur diese Spalten, ein zusaetzliches Whitelisting hier waere
 * redundant, aber die explizite Spaltenbenennung im SELECT (statt eines
 * impliziten "alles was die Funktion liefert") macht diese Begrenzung auch
 * im Anwendungscode sichtbar und robust gegen eine kuenftige, versehentlich
 * erweiterte Funktionssignatur.
 * ------------------------------------------------------------------ */
app.get('/api/admin/households', requireAdminAuth, wrap(async (req, res) => {
  const q = await appPool.query(
    `SELECT household_id  AS "householdId",
            created_at    AS "createdAt",
            member_count  AS "memberCount",
            status,
            status_reason AS "statusReason"
       FROM admin_list_households()`);
  res.json({ households: q.rows });
}));

// Haushalts-ID aus einem URL-Parameter/Body-Feld robust parsen -- nur
// positive Ganzzahlen sind gueltig, alles andere (leer, NaN, negativ,
// Bruchzahl, Fuehrungs-/Folgezeichen) liefert null statt eines evtl.
// missverstaendlichen Postgres-Typkonvertierungsfehlers weiter unten.
function parseHouseholdId(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// Identische Pruefung wie parseHouseholdId(), eigener Name fuer Rezept-IDs
// (AP2.1) -- rein zur Lesbarkeit an den jeweiligen Aufrufstellen, keine
// fachlich unterschiedliche Regel.
function parseRecipeId(raw) {
  return parseHouseholdId(raw);
}

/* ------------------------------------------------------------------ *
 * Deaktivieren/Reaktivieren/Loeschen (AP3.2/AP3.3, Wochenplaner-Admin-
 * Bereich) + Session-Invalidierung (AP4.1)
 *
 * Alle drei Endpunkte nutzen ausschliesslich die SECURITY-DEFINER-
 * Funktionen aus 005_admin_foundation.sql/006_admin_audit_log.sql -- kein
 * direkter Tabellenzugriff auf households (waere durch RLS ohnehin auf den
 * -- bei einer admin-scoped Session gar nicht gesetzten -- Sitzungskontext
 * beschraenkt).
 *
 * ZANDORs expliziter Pruefpunkt (Ruecklauf aus AP3.1): p_admin_id wird in
 * ALLEN drei Endpunkten AUSSCHLIESSLICH aus req.session.adminId gelesen,
 * NIE aus req.body/req.params/req.query -- die Admin-Session ist die
 * einzige Quelle, wer eine Aenderung vorgenommen hat (auch relevant fuer
 * die Audit-Log-Eintraege aus 006, die admin_id direkt von hier
 * uebernehmen).
 *
 * CSRF (ZANDORs Fund 5, AP2.2, damals bewusst zurueckgestellt "solange kein
 * browserbasiertes Admin-Frontend existiert"): mit admin.html/admin-
 * login.html (Arbeitspaket "Admin-Frontend") ist dieser Fall jetzt
 * eingetreten -- alle drei Endpunkte pruefen daher zusaetzlich zu
 * requireAdminAuth jetzt requireAdminCsrf (siehe dortige ausfuehrliche
 * Begruendung: Double-Submit-Cookie + Session-Bindung). Diese Neubewertung
 * ist ausdruecklich fuer ein erneutes ZANDOR-Review vorgemerkt.
 * ------------------------------------------------------------------ */

app.post('/api/admin/households/:id/deactivate', requireAdminAuth, requireAdminCsrf, wrap(async (req, res) => {
  const householdId = parseHouseholdId(req.params.id);
  if (householdId == null) return res.status(400).json({ error: 'Ungueltige Haushalts-ID' });

  // status_reason (F5, plan.md): admin_deactivate_household legt den Wert
  // 'admin_manual' fest im Funktionskoerper fest (005_admin_foundation.sql)
  // -- bewusst KEIN vom Aufrufer frei waehlbarer Parameter (MORROWs
  // Begruendung: kleinere Angriffsflaeche als eine generische
  // admin_set_household_status(status, reason)-Funktion). Dieser Endpunkt
  // erwartet trotzdem ein status_reason-Feld im Body (Auftrag ANORAK) --
  // als explizite Bestaetigung/Deklaration der Aufrufabsicht, NICHT als
  // frei durchgereichter Wert an die DB-Funktion. 'non_payment' bleibt
  // einer kuenftigen, hier NICHT gebauten Billing-Automatisierung
  // vorbehalten (eigener, noch nicht existierender Codepfad) -- wird
  // deshalb hier explizit abgelehnt statt stillschweigend ignoriert.
  const statusReason = req.body?.status_reason;
  if (statusReason !== undefined && statusReason !== 'admin_manual') {
    return res.status(400).json({
      error: "status_reason muss 'admin_manual' sein -- dieser Endpunkt fuehrt ausschliesslich manuelle " +
             "Admin-Deaktivierungen aus. 'non_payment' ist fuer eine kuenftige Billing-Automatisierung " +
             "reserviert und wird von diesem Endpunkt nicht unterstuetzt."
    });
  }

  const client = await appPool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT admin_deactivate_household($1, $2)', [householdId, req.session.adminId]);
    // AP4.1: bereits laufende Sessions dieses Haushalts sofort ungueltig
    // machen, statt auf den Ablauf der bis zu 60-Tage-rolling-Session zu
    // warten. In derselben Transaktion wie der Statuswechsel, damit nicht
    // der Fall entstehen kann "Haushalt deaktiviert, aber alte Session
    // bleibt wirksam" (z. B. bei einem Fehler zwischen beiden Schritten).
    // Referenzabfrage: ap1.1-datenmodell.md Abschnitt 4 /
    // 005_admin_foundation.sql Abschnitt 6.2. connect-pg-simple liest die
    // Session-Zeile bei JEDEM Request neu aus dieser Tabelle -- ist sie
    // geloescht, sieht express-session ab dem naechsten Request des
    // betroffenen Haushalts keine gueltige Session mehr (req.session.userId
    // ist dann undefined), requireAuth() weist die Anfrage bereits mit dem
    // bestehenden 401-Pfad ab. Ein zusaetzlicher Statuscheck in requireAuth
    // war daher fuer DIESES Erfolgskriterium ("beim naechsten Request sofort
    // ausgeloggt", nicht "sofort waehrend eines noch laufenden Requests")
    // nicht mehr noetig -- als offener Abwaegungspunkt trotzdem an ANORAK
    // zurueckgemeldet, siehe dortige Antwort.
    await client.query(`DELETE FROM session WHERE (sess->>'householdId')::bigint = $1`, [householdId]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.code === 'P0002') return res.status(404).json({ error: 'Haushalt nicht gefunden' });
    // ADM01 (ZANDOR AP5.1, Fund A1, 007_admin_status_guards.sql): Haushalt
    // ist bereits im Zielstatus -- state-transition guard in der DB-Funktion
    // hat die Anfrage schon abgelehnt, BEVOR ein Update/Audit-Eintrag
    // stattfand. 409 statt eines generischen 500 (frueher: unbehandelter
    // CHECK-Constraint-Crash beim Versuch, einen bereits geloeschten
    // Haushalt zu deaktivieren, siehe Fund A1).
    if (err.code === 'ADM01') return res.status(409).json({ error: 'Haushalt ist bereits deaktiviert' });
    throw err;
  } finally { client.release(); }

  res.json({ ok: true, householdId, status: 'deactivated', statusReason: 'admin_manual' });
}));

app.post('/api/admin/households/:id/reactivate', requireAdminAuth, requireAdminCsrf, wrap(async (req, res) => {
  const householdId = parseHouseholdId(req.params.id);
  if (householdId == null) return res.status(400).json({ error: 'Ungueltige Haushalts-ID' });

  try {
    // Produktentscheidung (offener Punkt aus ap1.1-datenmodell.md Abschnitt
    // 6, hier von A3CH/ANORAK entschieden): admin_reactivate_household
    // erlaubt technisch auch die Wiederherstellung aus status='deleted'
    // (nicht nur 'deactivated'). Dieser Endpunkt schraenkt das NICHT
    // zusaetzlich ein -- Reaktivierung ist fuer BEIDE Ausgangsstatus
    // erlaubt. Begruendung: F3 (Soft-Delete) sieht eine Aufbewahrungsfrist
    // gerade deshalb vor, damit ein Haushalt vor der (optionalen,
    // noch nicht gebauten) Hard-Purge (AP3.4) wiederherstellbar bleibt --
    // eine Ablehnung hier wuerde diesen Zweck der Frist faktisch aushebeln
    // und einen Restore nur per direktem DB-Zugriff erlauben, was dem Sinn
    // eines Admin-Bereichs widerspraeche. Kein Session-Invalidierungsschritt
    // noetig: Reaktivierung stellt Zugriff wieder her, sperrt ihn nicht.
    await appPool.query('SELECT admin_reactivate_household($1, $2)', [householdId, req.session.adminId]);
  } catch (err) {
    if (err.code === 'P0002') return res.status(404).json({ error: 'Haushalt nicht gefunden' });
    // ADM01, siehe Kommentar beim Deaktivieren-Endpunkt oben.
    if (err.code === 'ADM01') return res.status(409).json({ error: 'Haushalt ist bereits aktiv' });
    throw err;
  }

  res.json({ ok: true, householdId, status: 'active' });
}));

app.delete('/api/admin/households/:id', requireAdminAuth, requireAdminCsrf, wrap(async (req, res) => {
  const householdId = parseHouseholdId(req.params.id);
  if (householdId == null) return res.status(400).json({ error: 'Ungueltige Haushalts-ID' });

  // Bestaetigungsschritt gegen Fehlbedienung (plan.md AP3.3-Erfolgskriterium).
  // BEWUSST NICHT per erneuter Eingabe des Haushaltsnamens (wie im Plan als
  // Beispiel genannt): das wuerde einen neuen Weg brauchen, den Klarnamen
  // eines Haushalts an den Admin-Bereich offenzulegen, und wuerde damit die
  // vom Nutzer explizit entschiedene F1-Grenze ("kein Klarname" in der
  // Admin-Uebersicht, admin_list_households() liefert bewusst keinen Namen)
  // faktisch unterlaufen. Stattdessen: die Haushalts-ID muss im Body
  // wiederholt werden -- dem Admin aus der Uebersicht (AP3.1) ohnehin
  // bekannt, funktional aequivalenter Tippfehler-/Fehlklick-Schutz ohne neue
  // PII-Exposition.
  const confirmId = parseHouseholdId(req.body?.confirmHouseholdId);
  if (confirmId !== householdId) {
    return res.status(400).json({
      error: 'Bestaetigung fehlt oder stimmt nicht ueberein: confirmHouseholdId im Body muss der ' +
             'Haushalts-ID aus der URL entsprechen'
    });
  }

  const client = await appPool.connect();
  try {
    await client.query('BEGIN');
    // F3: Soft-Delete, KEIN Hard-DELETE -- admin_soft_delete_household setzt
    // ausschliesslich status/deleted_at (005_admin_foundation.sql).
    await client.query('SELECT admin_soft_delete_household($1, $2)', [householdId, req.session.adminId]);
    // AP4.1, identischer Mechanismus wie beim Deaktivieren-Endpunkt oben --
    // ein geloeschter Haushalt muss ebenso sofort gesperrt sein.
    await client.query(`DELETE FROM session WHERE (sess->>'householdId')::bigint = $1`, [householdId]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.code === 'P0002') return res.status(404).json({ error: 'Haushalt nicht gefunden' });
    // ADM01 (ZANDOR AP5.1, Fund A1): verhindert, dass ein wiederholter
    // Loeschaufruf auf einem bereits geloeschten Haushalt deleted_at
    // stillschweigend erneut auf now() setzt und damit die
    // F3-Aufbewahrungsfrist verlaengert -- die DB-Funktion lehnt das bereits
    // ab, bevor irgendein Update stattfindet.
    if (err.code === 'ADM01') return res.status(409).json({ error: 'Haushalt ist bereits geloescht' });
    throw err;
  } finally { client.release(); }

  res.json({ ok: true, householdId, status: 'deleted' });
}));

app.get('/api/me', wrap(async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Nicht angemeldet' });
  // AP2.1: LEFT JOIN auf den eigenen aktiven password-Wrap (falls vorhanden) + households.
  // encryption_status -- der Client (app.js/boot()) braucht das bei JEDEM Seitenaufruf, um zu
  // wissen, ob/wie er das Passwort erneut abfragen und den Haushalts-Schluessel lokal entpacken
  // muss (login.html und index.html sind zwei getrennte Dokumente/JS-Kontexte -- der Schluessel
  // darf laut Risikotabelle des Plans NIE ausserhalb des JS-Arbeitsspeichers der jeweils
  // LAUFENDEN Seite liegen, kann also nicht einfach von login.html "mitgenommen" werden, siehe
  // Kommentar in boot()/unlockHousehold() in app.js).
  // AP2.3: zusaetzlich ein zweiter LEFT JOIN auf den eigenen AUSSTEHENDEN ('pending') Wrap --
  // ein Nachzuegler-Mitglied eines bereits von einem anderen Mitglied aktivierten Haushalts
  // (encryption_status='activating'/'active') hat noch KEINEN password-Wrap, aber einen
  // pending-Wrap (siehe Bootstrap-Kommentar bei /api/crypto/bootstrap-existing unten). app.js/
  // boot() unterscheidet anhand dessen, ob es das normale Entsperren-Dialog (Passwort) oder das
  // Aktivierungs-Dialog (Aktivierungscode) zeigen muss.
  const q = await withTenantClient(req.session.householdId, client => client.query(
    `SELECT u.id, u.name, u.email, u.role, u.household_id AS "householdId", h.name AS "householdName",
            h.encryption_status AS "encryptionStatus",
            w.key_version AS "wrapKeyVersion", w.wrapped_key AS "wrapWrappedKey", w.wrap_nonce AS "wrapNonce",
            w.kdf_salt AS "wrapKdfSalt", w.kdf_algo AS "wrapKdfAlgo", w.kdf_time_cost AS "wrapKdfTimeCost",
            w.kdf_memory_cost AS "wrapKdfMemoryCost", w.kdf_parallelism AS "wrapKdfParallelism",
            p.key_version AS "pendingKeyVersion", p.wrapped_key AS "pendingWrappedKey", p.wrap_nonce AS "pendingWrapNonce",
            p.kdf_salt AS "pendingKdfSalt", p.kdf_algo AS "pendingKdfAlgo", p.kdf_time_cost AS "pendingKdfTimeCost",
            p.kdf_memory_cost AS "pendingKdfMemoryCost", p.kdf_parallelism AS "pendingKdfParallelism"
       FROM users u
       JOIN households h ON h.id = u.household_id
       LEFT JOIN household_key_wraps w
              ON w.user_id = u.id AND w.wrap_type = 'password' AND w.revoked_at IS NULL
       LEFT JOIN household_key_wraps p
              ON p.user_id = u.id AND p.wrap_type = 'pending' AND p.revoked_at IS NULL
      WHERE u.id=$1`, [req.session.userId]));
  if (!q.rowCount) return req.session.destroy(() => res.status(401).json({ error: 'Nicht angemeldet' }));
  const row = q.rows[0];
  const user = { id: row.id, name: row.name, email: row.email, role: row.role,
                 householdId: row.householdId, householdName: row.householdName };
  const cryptoInfo = {
    encryptionStatus: row.encryptionStatus,
    keyVersion: row.wrapKeyVersion,
    wrappedKey: row.wrapWrappedKey ? row.wrapWrappedKey.toString('base64') : null,
    wrapNonce: row.wrapNonce ? row.wrapNonce.toString('base64') : null,
    kdfSalt: row.wrapKdfSalt ? row.wrapKdfSalt.toString('base64') : null,
    kdfAlgo: row.wrapKdfAlgo || null,
    kdfTimeCost: row.wrapKdfTimeCost,
    kdfMemoryCost: row.wrapKdfMemoryCost,
    kdfParallelism: row.wrapKdfParallelism,
    pendingWrap: row.pendingWrappedKey ? {
      keyVersion: row.pendingKeyVersion,
      wrappedKey: row.pendingWrappedKey.toString('base64'),
      wrapNonce: row.pendingWrapNonce.toString('base64'),
      kdfSalt: row.pendingKdfSalt.toString('base64'),
      kdfAlgo: row.pendingKdfAlgo,
      kdfTimeCost: row.pendingKdfTimeCost,
      kdfMemoryCost: row.pendingKdfMemoryCost,
      kdfParallelism: row.pendingKdfParallelism
    } : null
  };
  res.json({ user, crypto: cryptoInfo });
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
 * AP2.3: Bootstrap-/Aktivierungs-UX fuer BESTANDSHAUSHALTE (encryption_
 * status='plaintext' beim ersten Login nach dem Verschluesselungs-Rollout).
 * ap1.2-datenmodell.md Abschnitt 4.2: das einloggende Mitglied erzeugt den
 * Haushalts-Schluessel, wrapt ihn fuer sich selbst (password) UND haushaltsweit
 * fuer den Wiederherstellungscode (recovery_code) sowie fuer JEDES ANDERE
 * Mitglied einen 'pending'-Wrap mit einem NUR clientseitig existierenden,
 * frisch erzeugten Aktivierungsgeheimnis (nie an den Server uebertragen,
 * siehe Migration 009 Abschnitt 2.3) -- das bootstrappende Mitglied teilt
 * dieses Geheimnis dem jeweiligen anderen Mitglied offline mit. Ein Mitglied
 * mit 'pending'-Wrap erhaelt ueber /api/me (siehe oben) dessen Krypto-Felder
 * und ruft nach Eingabe des Geheimnisses /api/crypto/activate auf.
 * ------------------------------------------------------------------ */

// Liefert die Mitgliederliste des eigenen Haushalts (id/name/email) -- Grundlage dafuer, dass das
// bootstrappende Mitglied weiss, fuer wen es je einen pending-Wrap erzeugen muss, und welches
// Aktivierungsgeheimnis zu wem gehoert (Anzeige im Bootstrap-Dialog, app.js).
app.get('/api/household/members', requireAuth, rejectForeignHouseholdId, wrap(async (req, res) => {
  const q = await withTenantClient(req.session.householdId, client => client.query(
    `SELECT id, name, email FROM users WHERE household_id=$1 ORDER BY id`, [req.session.householdId]));
  res.json({ members: q.rows });
}));

app.post('/api/crypto/bootstrap-existing', requireAuth, rejectForeignHouseholdId, wrap(async (req, res) => {
  const cryptoPayload = parseCryptoBootstrapPayload(req.body);
  if (!cryptoPayload) return res.status(400).json({ error: 'Ungueltige oder fehlende Verschluesselungsdaten' });

  const pendingWrapsRaw = Array.isArray(req.body.pendingWraps) ? req.body.pendingWraps : [];
  const pendingWraps = [];
  for (const p of pendingWrapsRaw) {
    const userId = Number(p?.userId);
    if (!Number.isInteger(userId) || userId < 1) return res.status(400).json({ error: 'Ungueltige userId in pendingWraps' });
    const wrap = parseWrapPayload(p);
    if (!wrap) return res.status(400).json({ error: 'Ungueltiges Wrap-Format in pendingWraps' });
    pendingWraps.push({ userId, wrap });
  }

  const client = await appPool.connect();
  try {
    await client.query('BEGIN');
    await setTenantContext(client, req.session.householdId);
    // FOR UPDATE verhindert einen doppelten Bootstrap, falls zwei Mitglieder gleichzeitig
    // einloggen und beide den (noch) 'plaintext'-Zustand sehen.
    const hQ = await client.query('SELECT encryption_status FROM households WHERE id=$1 FOR UPDATE', [req.session.householdId]);
    if (hQ.rows[0]?.encryption_status !== 'plaintext') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Dieser Haushalt wurde zwischenzeitlich bereits aktiviert (vermutlich von einem anderen Mitglied). Bitte die Seite neu laden.' });
    }
    // Die mitgeschickten pendingWraps muessen EXAKT alle anderen aktuellen Mitglieder abdecken --
    // sonst bliebe ein Mitglied nach der Aktivierung dauerhaft ohne jeden Wrap zurueck.
    const membersQ = await client.query('SELECT id FROM users WHERE household_id=$1', [req.session.householdId]);
    const otherMemberIds = new Set(membersQ.rows.map(r => String(r.id)).filter(id => id !== String(req.session.userId)));
    const providedIds = new Set(pendingWraps.map(p => String(p.userId)));
    const sameSet = otherMemberIds.size === providedIds.size && [...otherMemberIds].every(id => providedIds.has(id));
    if (!sameSet) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Die Mitgliederliste hat sich zwischenzeitlich geaendert. Bitte die Seite neu laden und erneut versuchen.' });
    }

    await insertKeyWrap(client, { householdId: req.session.householdId, userId: req.session.userId, wrapType: 'password', wrap: cryptoPayload.passwordWrap });
    // recovery_code ist haushaltsweit (user_id NULL), siehe /api/auth/register-Kommentar oben.
    // AP2.6-Nachtrag: recovery_verifier_salt/-hash gemeinsam mit dem Wrap anlegen (siehe dort).
    await insertKeyWrap(client, {
      householdId: req.session.householdId, userId: null, wrapType: 'recovery_code', wrap: cryptoPayload.recoveryWrap,
      verifierSalt: cryptoPayload.recoveryVerifier.verifierSalt, verifierHash: cryptoPayload.recoveryVerifier.verifierHash
    });
    for (const p of pendingWraps) {
      await insertKeyWrap(client, { householdId: req.session.householdId, userId: p.userId, wrapType: 'pending', wrap: p.wrap });
    }
    // Kein weiteres Mitglied -> sofort aktiv (identisch zum AP2.1-Fall bei der Registrierung
    // eines brandneuen Haushalts). Sonst 'activating', bis jedes Mitglied seinen pending-Wrap
    // ueber /api/crypto/activate in einen echten password-Wrap umgewandelt hat.
    const newStatus = otherMemberIds.size === 0 ? 'active' : 'activating';
    await client.query('UPDATE households SET encryption_status=$1 WHERE id=$2', [newStatus, req.session.householdId]);
    await client.query('COMMIT');
    res.json({ ok: true, encryptionStatus: newStatus });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally { client.release(); }
}));

// Nachzuegler-Mitglied: wandelt den eigenen 'pending'-Wrap (nach erfolgreichem clientseitigem
// Unwrap mit dem offline erhaltenen Aktivierungsgeheimnis) in einen echten 'password'-Wrap um.
// Der Server sieht dabei nur die neuen Wrap-Bytes -- ob der Client tatsaechlich denselben
// Haushalts-Schluessel korrekt entpackt/neu verpackt hat, kann/muss der Server hier NICHT
// verifizieren (identisches Prinzip wie beim urspruenglichen Registrierungs-Bootstrap, AP2.1) --
// der Aufrufer ist bereits ueber eine gueltige, per Passwort authentifizierte Sitzung
// legitimiert, ein potenziell fehlerhafter Client kann hier ausschliesslich SICH SELBST
// aussperren, nicht ein fremdes Konto (kein Authentifizierungs-Bypass-Risiko wie bei
// /api/auth/recover, siehe dortiger Kommentar).
app.post('/api/crypto/activate', requireAuth, rejectForeignHouseholdId, wrap(async (req, res) => {
  // Lokale Variable bewusst NICHT "wrap" genannt -- wuerde die aeussere Express-Route-Wrapper-
  // Funktion wrap() (siehe "const wrap = fn => ..." oben) innerhalb dieses Handlers verdecken.
  const passwordWrap = parseWrapPayload(req.body?.passwordWrap);
  if (!passwordWrap) return res.status(400).json({ error: 'Ungueltiges Wrap-Format' });

  const client = await appPool.connect();
  try {
    await client.query('BEGIN');
    await setTenantContext(client, req.session.householdId);
    const pendingQ = await client.query(
      `SELECT id FROM household_key_wraps
        WHERE household_id=$1 AND user_id=$2 AND wrap_type='pending' AND revoked_at IS NULL
        FOR UPDATE`,
      [req.session.householdId, req.session.userId]);
    if (!pendingQ.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Kein ausstehender Aktivierungs-Wrap fuer dieses Konto gefunden' });
    }
    // Nicht loeschen, sondern revoked_at setzen (Nachvollziehbarkeit, ap1.2-datenmodell.md
    // Abschnitt 2.2) -- derselbe Nutzer koennte diesen Endpunkt sonst kein zweites Mal sauber
    // aufrufen, ohne dass der partielle Unique-Index (user_id, wrap_type) WHERE revoked_at IS
    // NULL einen neuen password-Wrap blockiert.
    await client.query(`UPDATE household_key_wraps SET revoked_at=now() WHERE id=$1`, [pendingQ.rows[0].id]);
    await insertKeyWrap(client, { householdId: req.session.householdId, userId: req.session.userId, wrapType: 'password', wrap: passwordWrap });

    // Aktivierung abschliessen, sobald ALLE aktuellen Mitglieder einen password-Wrap haben.
    const countsQ = await client.query(
      `SELECT (SELECT count(*) FROM users WHERE household_id=$1) AS member_count,
              (SELECT count(*) FROM household_key_wraps
                WHERE household_id=$1 AND wrap_type='password' AND revoked_at IS NULL) AS wrap_count`,
      [req.session.householdId]);
    const { member_count: memberCount, wrap_count: wrapCount } = countsQ.rows[0];
    let encryptionStatus = 'activating';
    if (Number(wrapCount) >= Number(memberCount)) {
      await client.query(`UPDATE households SET encryption_status='active' WHERE id=$1`, [req.session.householdId]);
      encryptionStatus = 'active';
    }
    await client.query('COMMIT');
    res.json({ ok: true, encryptionStatus });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally { client.release(); }
}));

/* ------------------------------------------------------------------ *
 * AP2.6, Teil A -- normale Passwort-Aenderung (eingeloggt, UI-Heimat: die
 * Konto-Ansicht aus AP2.2b). ap1.2-datenmodell.md Abschnitt 7: altes Passwort
 * wird weiterhin serverseitig per bcrypt geprueft (bestehendes Verhalten),
 * der Client hat den Haushalts-Schluessel bereits im Speicher (laufende
 * Sitzung), leitet aus dem NEUEN Passwort einen neuen Wrap-Schluessel ab und
 * schickt nur den fertigen, neu gewrappten password-Wrap. Betrifft
 * ausschliesslich users.password_hash und GENAU EINE Zeile in
 * household_key_wraps (der eigene password-Wrap, per UPDATE ersetzt, nicht
 * neu angelegt) -- kein einziges Byte weeks-Ciphertext aendert sich, der
 * recovery_code-Wrap bleibt unberuehrt (unabhaengige Geheimnisse, siehe
 * Abschnitt 7).
 * ------------------------------------------------------------------ */
app.put('/api/account/password', requireAuth, rejectForeignHouseholdId, wrap(async (req, res) => {
  const oldPassword = String(req.body.oldPassword || '');
  const newPassword = String(req.body.newPassword || '');
  if (newPassword.length < 10) return res.status(400).json({ error: 'Das neue Passwort muss mindestens 10 Zeichen haben' });
  const newPasswordWrap = parseWrapPayload(req.body?.passwordWrap);
  if (!newPasswordWrap) return res.status(400).json({ error: 'Ungueltige oder fehlende Verschluesselungsdaten' });

  const client = await appPool.connect();
  try {
    await client.query('BEGIN');
    await setTenantContext(client, req.session.householdId);

    const userQ = await client.query('SELECT password_hash FROM users WHERE id=$1 FOR UPDATE', [req.session.userId]);
    if (!userQ.rowCount) { await client.query('ROLLBACK'); return res.status(401).json({ error: 'Nicht angemeldet' }); }
    const ok = await bcrypt.compare(oldPassword, userQ.rows[0].password_hash);
    if (!ok) { await client.query('ROLLBACK'); return res.status(401).json({ error: 'Aktuelles Passwort stimmt nicht' }); }

    const wrapQ = await client.query(
      `SELECT id FROM household_key_wraps
        WHERE household_id=$1 AND user_id=$2 AND wrap_type='password' AND revoked_at IS NULL
        FOR UPDATE`,
      [req.session.householdId, req.session.userId]);
    if (!wrapQ.rowCount) {
      await client.query('ROLLBACK');
      // Haushalt hat die Verschluesselung noch nicht aktiviert (kein password-Wrap vorhanden) --
      // ohne Haushalts-Schluessel im Speicher kann der Client keinen neuen Wrap bilden. Passwort-
      // Aenderung ist in diesem Fall bewusst nicht Teil dieses Arbeitspakets (kein Wrap zum
      // Re-Wrappen vorhanden).
      return res.status(409).json({ error: 'Passwort-Aenderung ist erst nach Aktivierung der Termin-Verschluesselung fuer diesen Haushalt moeglich' });
    }

    const newHash = await bcrypt.hash(newPassword, 12);
    await client.query('UPDATE users SET password_hash=$1 WHERE id=$2', [newHash, req.session.userId]);
    await client.query(
      `UPDATE household_key_wraps
          SET wrapped_key=$1, wrap_nonce=$2, kdf_salt=$3, kdf_algo=$4,
              kdf_time_cost=$5, kdf_memory_cost=$6, kdf_parallelism=$7, updated_at=now()
        WHERE id=$8`,
      [newPasswordWrap.wrappedKey, newPasswordWrap.wrapNonce, newPasswordWrap.kdfSalt, newPasswordWrap.kdfAlgo,
       newPasswordWrap.kdfTimeCost, newPasswordWrap.kdfMemoryCost, newPasswordWrap.kdfParallelism, wrapQ.rows[0].id]);

    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally { client.release(); }
}));

/* ------------------------------------------------------------------ *
 * AP2.6, Teil B (ZANDORs Vorgabe 3) -- Wiederherstellungscode NEU erzeugen.
 * Bewusst ein eigener, EXPLIZITER Endpunkt statt einer automatischen/stillen
 * Rotation nach einem Passwort-Reset: eine stille Rotation wuerde den
 * geteilten Haushalts-Code fuer ALLE anderen Mitglieder ohne Vorwarnung
 * invalidieren. Der Client (Konto-Ansicht, app.js) fordert nach einem
 * erfolgreichen Reset zwingend zu diesem Schritt auf, erzwingt ihn aber
 * nicht serverseitig (Nutzer koennte den Dialog theoretisch wegklicken --
 * das Risiko liegt dann beim alten, dem Nutzer selbst bekannten Code, kein
 * zusaetzliches serverseitiges Risiko).
 * ------------------------------------------------------------------ */
app.post('/api/crypto/recovery-code', requireAuth, rejectForeignHouseholdId, wrap(async (req, res) => {
  const recoveryVerifier = parseRecoveryVerifierPayload(req.body?.recoveryVerifier);
  const recoveryWrap = parseWrapPayload(req.body?.recoveryWrap);
  if (!recoveryVerifier || !recoveryWrap) return res.status(400).json({ error: 'Ungueltige oder fehlende Verschluesselungsdaten' });

  const client = await appPool.connect();
  try {
    await client.query('BEGIN');
    await setTenantContext(client, req.session.householdId);
    // Alte Zeile revoken (nicht loeschen, Nachvollziehbarkeit) statt UPDATE -- ein alter Code soll
    // nach Neuerzeugung explizit ungueltig werden (anders als beim Passwort-Wrap, das per UPDATE
    // ueberschrieben wird, siehe ap1.2-datenmodell.md Abschnitt 7 letzter Absatz).
    await client.query(
      `UPDATE household_key_wraps SET revoked_at=now()
        WHERE household_id=$1 AND wrap_type='recovery_code' AND revoked_at IS NULL`,
      [req.session.householdId]);
    await insertKeyWrap(client, {
      householdId: req.session.householdId, userId: null, wrapType: 'recovery_code', wrap: recoveryWrap,
      verifierSalt: recoveryVerifier.verifierSalt, verifierHash: recoveryVerifier.verifierHash
    });
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally { client.release(); }
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

// AP2.5 (clientseitiges Sweep-Feature): rein lesende Grundlage -- listet ALLE (kein LIMIT 200 wie
// oben, das Sweep-Feature darf keine Altwoche uebersehen) noch unverschluesselten weeks-Zeilen des
// eigenen Haushalts. Der eigentliche Verschluesselungsschritt passiert ausschliesslich clientseitig
// ueber den bestehenden PUT /api/weeks/:monday-Zyklus (app.js) -- dieser Endpunkt liefert nur die
// Arbeitsliste, schreibt selbst nie etwas (ap1.2-datenmodell.md Abschnitt 4.1/4.2 Schritt 4).
app.get('/api/weeks/sweep-status', requireAuth, rejectForeignHouseholdId, wrap(async (req, res) => {
  const q = await withTenantClient(req.session.householdId, client => client.query(
    `SELECT to_char(week_start,'YYYY-MM-DD') AS "weekStart"
       FROM weeks WHERE household_id=$1 AND data IS NOT NULL
      ORDER BY week_start`, [req.session.householdId]));
  res.json({ plaintextWeeks: q.rows.map(r => r.weekStart) });
}));

app.get('/api/weeks/:monday', requireAuth, rejectForeignHouseholdId, wrap(async (req, res) => {
  const monday = req.params.monday;
  if (!isMonday(monday)) return res.status(400).json({ error: 'Datum muss ein Montag im Format JJJJ-MM-TT sein' });
  const result = await withTenantClient(req.session.householdId, async (client) => {
    const q = await client.query(
      `SELECT data, data_ciphertext, data_nonce, key_version, updated_at AS "updatedAt"
         FROM weeks WHERE household_id=$1 AND week_start=$2`,
      [req.session.householdId, monday]);
    if (q.rowCount) {
      const row = q.rows[0];
      // AP2.1 (ap1.2-datenmodell.md Abschnitt 2.1/6.1): data_ciphertext IS NOT NULL <=> diese
      // Zeile ist bereits clientseitig verschluesselt (der XOR-CHECK aus Migration 009 garantiert
      // serverseitig, dass niemals beide/keine der beiden Formen gleichzeitig vorliegen). Der
      // Server liefert in diesem Fall NUR die opaken Bytes weiter (Base64 fuer den JSON-Transport)
      // -- migrateLegacyWeek()/cleanWeek() (Klartext-Normalisierung) kommen hier nie zum Einsatz.
      if (row.data_ciphertext) {
        return { weekStart: monday, exists: true, encrypted: true, keyVersion: row.key_version,
                 nonce: row.data_nonce.toString('base64'), ciphertext: row.data_ciphertext.toString('base64'),
                 updatedAt: row.updatedAt };
      }
      return { weekStart: monday, exists: true, encrypted: false, data: migrateLegacyWeek(row.data), updatedAt: row.updatedAt };
    }
    const h = await client.query(
      'SELECT encryption_status, template_data FROM households WHERE id=$1', [req.session.householdId]);
    const encryptionStatus = h.rows[0]?.encryption_status || 'plaintext';
    const templateRaw = h.rows[0]?.template_data || null;
    // Ist der Haushalt bereits aktiv verschluesselt ODER die Vorlage selbst schon verschluesselt,
    // kann der Server sie NICHT lesen/in eine neue Woche mergen (kein Klartextzugriff moeglich,
    // das ist ja gerade der Zweck der Uebung). Bewusste, an ANORAK zurueckgemeldete Vereinfachung
    // fuer AP2.1 (vollstaendiges clientseitiges Vorlagen-Merge ist AP2.2, ap1.2-datenmodell.md
    // Abschnitt 6.3 sinngemaess): eine neue Woche startet in diesem Fall serverseitig als
    // unbestueckter Standardaufbau; "mustEncryptOnSave" sagt dem Client, dass er beim ERSTEN
    // Speichern dieser Woche bereits den verschluesselten Envelope statt Klartext senden muss
    // (siehe PUT unten) -- unabhaengig davon, ob eine Vorlage existiert.
    if (encryptionStatus === 'active' || isEncryptedTemplateEnvelope(templateRaw)) {
      return { weekStart: monday, exists: false, encrypted: false, mustEncryptOnSave: true,
               fromTemplate: false, templateEncrypted: isEncryptedTemplateEnvelope(templateRaw),
               data: defaultWeek(), updatedAt: null };
    }
    const template = templateRaw ? migrateLegacyWeek(templateRaw) : null;
    // Neue Woche: die Vorlage wird vollstaendig uebernommen (Namen inklusive),
    // fehlende Zeilen ergaenzt der Standardaufbau.
    const fresh = template ? mergeTemplate(structuredClone(template), defaultWeek()) : defaultWeek();
    return { weekStart: monday, exists: false, encrypted: false, mustEncryptOnSave: false,
             fromTemplate: !!template, data: fresh, updatedAt: null };
  });
  res.json(result);
}));

app.put('/api/weeks/:monday', requireAuth, rejectForeignHouseholdId, wrap(async (req, res) => {
  const monday = req.params.monday;
  if (!isMonday(monday)) return res.status(400).json({ error: 'Datum muss ein Montag im Format JJJJ-MM-TT sein' });

  // AP2.1: entweder ein Ciphertext-Envelope ({encrypted:true, keyVersion, nonce, ciphertext} --
  // Haushalt hat die Verschluesselung aktiviert) ODER klassische Klartextdaten, NIE beides.
  // cleanWeek()/cleanRow()/... (serverseitige Normalisierung) laufen ausschliesslich im
  // Klartext-Zweig -- bei Ciphertext gibt es inhaltlich nichts zu pruefen/normalisieren, der
  // Server sieht nur opake, vom Client bereits AEAD-verschluesselte Bytes (ap1.2-datenmodell.md
  // Abschnitt 6.1). parseEncryptedPayload() prueft ausschliesslich Form/Groesse.
  const encPayload = parseEncryptedPayload(req.body);
  let plainData = null;
  if (!encPayload) {
    try { plainData = cleanWeek(req.body.data); }
    catch { return res.status(400).json({ error: 'Wochendaten haben ein unerwartetes Format' }); }
  }

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
          `SELECT data, data_ciphertext, data_nonce, key_version, updated_at AS "updatedAt"
             FROM weeks WHERE household_id=$1 AND week_start=$2`,
          [req.session.householdId, monday]);
        await client.query('COMMIT');
        const freshRow = fresh.rows[0];
        // AP2.1: Konflikt-Antwort spiegelt dieselbe encrypted-Unterscheidung wie GET oben --
        // sonst wuerde der Client bei einem Konflikt versehentlich ein Ciphertext-Objekt als
        // Klartext behandeln (oder umgekehrt).
        const conflictBody = freshRow.data_ciphertext
          ? { encrypted: true, keyVersion: freshRow.key_version,
              nonce: freshRow.data_nonce.toString('base64'), ciphertext: freshRow.data_ciphertext.toString('base64') }
          : { encrypted: false, data: migrateLegacyWeek(freshRow.data) };
        return res.status(409).json({
          error: 'Diese Woche wurde zwischenzeitlich auf einem anderen Geraet geaendert',
          ...conflictBody, updatedAt: freshRow.updatedAt });
      }
    }
    // Zwei getrennte UPSERT-Formen statt einer gemeinsamen mit bedingten Spalten: die XOR-CHECK-
    // Constraint (weeks_plaintext_xor_ciphertext, Migration 009) verlangt in JEDEM Fall einen
    // vollstaendigen, eindeutigen Zustand -- beide Zweige setzen deshalb explizit ALLE fuenf
    // betroffenen Spalten (auch die jeweils "andere" Gruppe auf NULL), nie nur eine Teilmenge.
    const saved = encPayload
      ? await client.query(
          `INSERT INTO weeks(household_id, week_start, data, data_ciphertext, data_nonce, key_version, updated_by)
           VALUES ($1,$2,NULL,$3,$4,$5,$6)
           ON CONFLICT (household_id, week_start)
           DO UPDATE SET data=NULL, data_ciphertext=EXCLUDED.data_ciphertext, data_nonce=EXCLUDED.data_nonce,
                         key_version=EXCLUDED.key_version, updated_by=EXCLUDED.updated_by, updated_at=now()
           RETURNING updated_at AS "updatedAt"`,
          [req.session.householdId, monday, encPayload.ciphertext, encPayload.nonce, encPayload.keyVersion, req.session.userId])
      : await client.query(
          `INSERT INTO weeks(household_id, week_start, data, data_ciphertext, data_nonce, key_version, updated_by)
           VALUES ($1,$2,$3,NULL,NULL,NULL,$4)
           ON CONFLICT (household_id, week_start)
           DO UPDATE SET data=EXCLUDED.data, data_ciphertext=NULL, data_nonce=NULL, key_version=NULL,
                         updated_by=EXCLUDED.updated_by, updated_at=now()
           RETURNING updated_at AS "updatedAt"`,
          [req.session.householdId, monday, plainData, req.session.userId]);
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
  const raw = q.rows[0]?.template_data || null;
  // AP2.1: template_data bleibt EINE jsonb-Spalte (siehe Kommentar bei isEncryptedTemplateEnvelope()
  // oben) -- eine verschluesselte Vorlage traegt den Diskriminator "__enc:true" und liefert dann
  // NUR den Ciphertext-Envelope, exakt wie GET /api/weeks/:monday fuer eine verschluesselte Woche.
  if (isEncryptedTemplateEnvelope(raw)) {
    return res.json({ template: null, encrypted: true, keyVersion: raw.keyVersion, nonce: raw.nonce, ciphertext: raw.ciphertext });
  }
  res.json({ template: raw ? migrateLegacyWeek(raw) : null, encrypted: false });
}));

app.put('/api/template', requireAuth, rejectForeignHouseholdId, wrap(async (req, res) => {
  const encPayload = parseEncryptedPayload(req.body);
  let stored;
  if (encPayload) {
    stored = buildTemplateEnvelope(encPayload.nonce, encPayload.ciphertext, encPayload.keyVersion);
  } else {
    try { stored = cleanWeek(req.body.data); }
    catch { return res.status(400).json({ error: 'Vorlage hat ein unerwartetes Format' }); }
  }
  await withTenantClient(req.session.householdId, client => client.query(
    'UPDATE households SET template_data=$1 WHERE id=$2', [stored, req.session.householdId]));
  res.json({ ok: true });
}));

app.delete('/api/template', requireAuth, rejectForeignHouseholdId, wrap(async (req, res) => {
  await withTenantClient(req.session.householdId, client => client.query(
    'UPDATE households SET template_data=NULL WHERE id=$1', [req.session.householdId]));
  res.json({ ok: true });
}));

/* ------------------------------------------------------------------ *
 * Rezeptkarten (AP2.1, projects/wochenplaner-rezeptkarten/plan.md)
 *
 * CRUD + Bild-Upload fuer die `recipes`-Tabelle (008_recipes.sql,
 * MORROW/ap1.1-datenmodell.md). Household-Isolation laeuft -- wie bei
 * weeks/template oben -- ausschliesslich ueber withTenantClient()/RLS, nie
 * ueber ein client-seitig mitgeschicktes Feld (rejectForeignHouseholdId als
 * zusaetzliche, sichtbare Absicherung, identisches Muster wie bei den
 * bestehenden Haushalts-Routen). Kein CSRF-Token noetig (anders als der
 * Admin-Bereich): diese Routen laufen unter der Haushalts-Session, deren
 * bestehender Schutz (SameSite=Lax-Cookie) fuer alle zustandsaendernden
 * Endpunkte dieser App bereits einheitlich gilt (siehe requireAdminCsrf-
 * Kommentar oben zur Abgrenzung, warum der Admin-Bereich zusaetzlich einen
 * Token braucht und die Haushalts-Routen bislang nicht).
 *
 * Bild-Upload laeuft ueber multer mit memoryStorage (kein Zwischenschreiben
 * einer noch nicht validierten Datei auf die Platte) und einer serverseitig
 * per Magic-Bytes geprueften Typerkennung (detectImageExtension) -- NICHT
 * ueber den vom Client gesendeten Content-Type/die Dateiendung, wie von
 * MORROW in ap1.1-datenmodell.md Abschnitt 2.5 explizit gefordert (Content-
 * Type-Sniffing-Schutz). Der auf der Platte gespeicherte Dateiname wird
 * ausschliesslich serverseitig erzeugt (generateImageFilename: household_id
 * + Rezept-ID + zufaellige UUID + erkannte Endung, siehe RECIPE_IMAGES_DIR-
 * Kommentar oben zur Praefix-Konvention) und nie aus dem Client-
 * Originalnamen uebernommen -- Pfadtraversal ist dadurch bereits strukturell
 * ausgeschlossen, zusaetzlich zum flachen-Dateiname-CHECK-Constraint in
 * 008_recipes.sql (Defense-in-Depth, siehe dortige Begruendung).
 * ------------------------------------------------------------------ */

// multer selbst begrenzt bereits die Rohgroesse (Schutz vor Speicherverbrauch
// durch memoryStorage), die *inhaltliche* Format-/Groessenpruefung passiert
// zusaetzlich weiter unten anhand der tatsaechlich gelesenen Bytes.
const recipeImageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: RECIPE_IMAGE_MAX_BYTES, files: 1 }
}).single('image');

// multer liefert Fehler (u. a. Groessenueberschreitung) ueber einen eigenen
// Callback-Kanal statt per throw/Promise-Reject -- daher hier bewusst kein
// wrap(), sondern eine eigene, explizite Fehlerbehandlung mit sprechender
// Meldung statt eines generischen 500ers.
function handleRecipeImageUpload(req, res, next) {
  recipeImageUpload(req, res, err => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: `Bild ist zu gross (maximal ${RECIPE_IMAGE_MAX_BYTES / (1024 * 1024)} MB)` });
    }
    return res.status(400).json({ error: 'Bild-Upload fehlgeschlagen: ' + err.message });
  });
}

// Magic-Bytes-Erkennung statt Vertrauen in Client-Content-Type/-Dateiendung
// (ap1.1-datenmodell.md Abschnitt 2.5, F4-Default): liefert die erkannte
// Dateiendung, oder null, wenn keines der drei erlaubten Formate erkannt wird.
const IMAGE_SIGNATURES = [
  { ext: 'jpg', matches: buf => buf.length >= 3 && buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF },
  { ext: 'png', matches: buf => buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])) },
  // WebP: RIFF-Container (Bytes 0-3) mit "WEBP"-Kennung ab Byte 8 -- Bytes 4-7
  // sind die (hier irrelevante) RIFF-Chunk-Groesse.
  { ext: 'webp', matches: buf => buf.length >= 12 && buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP' }
];
function detectImageExtension(buffer) {
  const sig = IMAGE_SIGNATURES.find(s => s.matches(buffer));
  return sig ? sig.ext : null;
}

// Serverseitig erzeugter, garantiert flacher Dateiname (erfuellt den
// image_path-CHECK-Constraint aus 008_recipes.sql) -- Format
// "<household_id>_<recipe_id>_<uuid>.<ext>" gemaess der mit ART3MIS
// abgestimmten Konvention (docker-compose.yml/ops/backup-tenant-offsite.sh):
// das household_id-Praefix erlaubt dem Offsite-Backup-Skript, per einfachem
// Datei-Glob genau die Bilder EINES Mandanten zu selektieren, obwohl alle
// Rezeptbilder aller Haushalte flach im selben Verzeichnis liegen (kein
// Unterordner pro Haushalt moeglich, siehe RECIPE_IMAGES_DIR-Kommentar
// oben). Die eigentliche Eindeutigkeit kommt von der UUID.
function generateImageFilename(householdId, recipeId, ext) {
  return `${householdId}_${recipeId}_${crypto.randomUUID()}.${ext}`;
}
// Zweite, unabhaengige Pruefung desselben Musters wie der DB-CHECK-Constraint
// (Defense-in-Depth) -- greift beim Ausliefern eines Bildes (siehe GET
// .../image unten), bevor ein aus der DB gelesener image_path zu einem
// Dateisystempfad zusammengebaut wird.
//
// ZANDOR-Review (AP5.1, Fund 3): das vorherige Muster schloss "/" aus,
// verbot aber nicht den Sonderfall, dass der gesamte Wert nur aus Punkten
// besteht ("." oder ".."). Aktuell nicht erreichbar, da image_path
// ausschliesslich serverseitig ueber generateImageFilename() (UUID-basiert)
// gesetzt wird -- reine Defense-in-Depth-Haertung, damit path.join() auch
// bei einem hypothetisch manipulierten DB-Wert nie auf das Elternverzeichnis
// (image_path === "..") oder RECIPE_IMAGES_DIR selbst (image_path === ".")
// aufloest.
const FLAT_FILENAME_RE = /^(?!\.{1,2}$)[A-Za-z0-9_.-]{1,255}$/;

// Validiert/normalisiert die Textfelder eines Rezepts (title/baseServings/
// instructions/ingredients) -- gemeinsam fuer POST und PUT verwendet. Wirft
// bei ungueltiger Eingabe einen Error mit nutzerverstaendlicher Meldung, den
// die Route in eine 400-Antwort uebersetzt. req.body stammt hier aus einem
// multipart/form-data-Request (multer) -- alle Felder liegen daher als
// String vor, auch baseServings und ingredients (Letzteres JSON-kodiert).
function validateRecipeInput(body) {
  const title = str(body?.title, LIMITS.recipeTitle).trim();
  if (!title) throw new Error('Titel darf nicht leer sein');

  const baseServings = Number(body?.baseServings);
  if (!Number.isInteger(baseServings) || baseServings < 1 || baseServings > 20) {
    // F3: Pflichtfeld, ganzzahlig, 1-20 -- spiegelt recipes_base_servings_range
    // aus 008_recipes.sql.
    throw new Error('Personenzahl (baseServings) muss eine ganze Zahl zwischen 1 und 20 sein');
  }

  const instructions = str(body?.instructions, LIMITS.instructions);

  let ingredientsRaw = [];
  if (body?.ingredients) {
    try { ingredientsRaw = JSON.parse(body.ingredients); }
    catch { throw new Error('Zutatenliste hat ein ungueltiges Format (kein gueltiges JSON)'); }
  }

  return { title, baseServings, instructions, ingredients: cleanIngredients(ingredientsRaw) };
}

app.get('/api/recipes', requireAuth, rejectForeignHouseholdId, wrap(async (req, res) => {
  // Uebersichtsliste (AP2.2): bewusst ohne ingredients/instructions, um die
  // Antwort klein zu halten -- Details holt der Client bei Bedarf ueber
  // GET /api/recipes/:id.
  const q = await withTenantClient(req.session.householdId, client => client.query(
    `SELECT id, title, base_servings AS "baseServings", image_path AS "imagePath", updated_at AS "updatedAt"
       FROM recipes WHERE household_id=$1 ORDER BY title`, [req.session.householdId]));
  res.json({ recipes: q.rows });
}));

app.get('/api/recipes/:id', requireAuth, rejectForeignHouseholdId, wrap(async (req, res) => {
  const id = parseRecipeId(req.params.id);
  if (id == null) return res.status(400).json({ error: 'Ungueltige Rezept-ID' });
  const q = await withTenantClient(req.session.householdId, client => client.query(
    `SELECT id, title, base_servings AS "baseServings", instructions, ingredients,
            image_path AS "imagePath", updated_at AS "updatedAt"
       FROM recipes WHERE id=$1 AND household_id=$2`, [id, req.session.householdId]));
  if (!q.rowCount) return res.status(404).json({ error: 'Rezept nicht gefunden' });
  res.json({ recipe: q.rows[0] });
}));

// Liefert die Bilddatei eines Rezepts aus -- eigener Endpunkt statt eines
// direkten express.static() auf RECIPE_IMAGES_DIR, weil der Zugriff genau
// wie jede andere Rezeptkarten-Route ueber withTenantClient/RLS auf den
// eigenen Haushalt beschraenkt sein muss: die Bilder aller Haushalte liegen
// flach im selben Verzeichnis (siehe RECIPE_IMAGES_DIR-Kommentar oben), ein
// erratener/durchprobierter Dateiname darf daher niemals das Bild eines
// fremden Haushalts liefern -- die DB-Abfrage unten ist die einzige
// Autorisierungsschranke, das household_id-Praefix im Dateinamen selbst ist
// nur eine Backup-Konvention, keine Zugriffskontrolle.
app.get('/api/recipes/:id/image', requireAuth, rejectForeignHouseholdId, wrap(async (req, res) => {
  const id = parseRecipeId(req.params.id);
  if (id == null) return res.status(400).json({ error: 'Ungueltige Rezept-ID' });
  const q = await withTenantClient(req.session.householdId, client => client.query(
    'SELECT image_path AS "imagePath" FROM recipes WHERE id=$1 AND household_id=$2', [id, req.session.householdId]));
  if (!q.rowCount || !q.rows[0].imagePath) return res.status(404).json({ error: 'Kein Bild vorhanden' });
  const imagePath = q.rows[0].imagePath;
  // Defense-in-Depth: derselbe flache-Dateiname-Test wie der DB-CHECK-
  // Constraint, unmittelbar bevor daraus ein Dateisystempfad entsteht.
  if (!FLAT_FILENAME_RE.test(imagePath)) return res.status(500).json({ error: 'Ungueltiger Bildpfad' });
  const fullPath = path.join(RECIPE_IMAGES_DIR, imagePath);
  res.sendFile(fullPath, err => {
    if (err && !res.headersSent) res.status(404).json({ error: 'Bilddatei nicht gefunden' });
  });
}));

app.post('/api/recipes', requireAuth, recipeImageUploadLimiter, handleRecipeImageUpload, rejectForeignHouseholdId, wrap(async (req, res) => {
  let clean;
  try { clean = validateRecipeInput(req.body); }
  catch (err) { return res.status(400).json({ error: err.message }); }

  let imageExt = null;
  if (req.file) {
    imageExt = detectImageExtension(req.file.buffer);
    if (!imageExt) return res.status(400).json({ error: 'Bilddatei hat ein nicht unterstuetztes Format (erlaubt: JPEG, PNG, WebP)' });
  }

  // Reihenfolge bewusst: erst die Zeile OHNE Bild anlegen (liefert die id,
  // die generateImageFilename() fuer den Dateinamen braucht), danach -- falls
  // ein Bild mitgeschickt wurde -- Datei schreiben und image_path in derselben
  // Transaktion nachtragen. Schlaegt der Dateischreibvorgang fehl, wirft der
  // withTenantClient()-Callback, die gesamte Transaktion (inkl. INSERT) wird
  // zurueckgerollt -- kein verwaister DB-Eintrag ohne (gewuenschtes) Bild.
  let writtenFilePath = null;
  try {
    const recipe = await withTenantClient(req.session.householdId, async client => {
      const inserted = await client.query(
        `INSERT INTO recipes(household_id, title, base_servings, instructions, ingredients, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$6) RETURNING id`,
        [req.session.householdId, clean.title, clean.baseServings, clean.instructions,
         JSON.stringify(clean.ingredients), req.session.userId]);
      const id = inserted.rows[0].id;

      if (imageExt) {
        const filename = generateImageFilename(req.session.householdId, id, imageExt);
        await fs.mkdir(RECIPE_IMAGES_DIR, { recursive: true });
        const fullPath = path.join(RECIPE_IMAGES_DIR, filename);
        await fs.writeFile(fullPath, req.file.buffer);
        writtenFilePath = fullPath;
        await client.query('UPDATE recipes SET image_path=$1 WHERE id=$2', [filename, id]);
      }

      const full = await client.query(
        `SELECT id, title, base_servings AS "baseServings", instructions, ingredients,
                image_path AS "imagePath", updated_at AS "updatedAt"
           FROM recipes WHERE id=$1`, [id]);
      return full.rows[0];
    });
    res.status(201).json({ recipe });
  } catch (err) {
    // Verwaiste Datei aufraeumen, falls das Schreiben zwar gelang, die
    // Transaktion aber aus einem anderen Grund fehlschlug (siehe Kommentar
    // oben).
    if (writtenFilePath) await fs.unlink(writtenFilePath).catch(() => {});
    throw err;
  }
}));

app.put('/api/recipes/:id', requireAuth, recipeImageUploadLimiter, handleRecipeImageUpload, rejectForeignHouseholdId, wrap(async (req, res) => {
  const id = parseRecipeId(req.params.id);
  if (id == null) return res.status(400).json({ error: 'Ungueltige Rezept-ID' });

  let clean;
  try { clean = validateRecipeInput(req.body); }
  catch (err) { return res.status(400).json({ error: err.message }); }

  let imageExt = null;
  if (req.file) {
    imageExt = detectImageExtension(req.file.buffer);
    if (!imageExt) return res.status(400).json({ error: 'Bilddatei hat ein nicht unterstuetztes Format (erlaubt: JPEG, PNG, WebP)' });
  }
  // Eigenes Formularfeld statt "kein neues Bild = loeschen": ohne diese
  // explizite Unterscheidung koennte ein Bearbeiten-Formular ohne
  // Bild-Feld (z. B. weil der Nutzer das Bild unveraendert lassen will)
  // versehentlich ein bestehendes Bild entfernen.
  const removeImage = req.body?.removeImage === 'true';

  let oldImagePath = null;
  let newImagePath = null;
  let writtenFilePath = null;
  try {
    const result = await withTenantClient(req.session.householdId, async client => {
      // FOR UPDATE: verhindert, dass zwei gleichzeitige Aktualisierungen
      // desselben Rezepts (z. B. zwei Geraete) sich beim Bild-Austausch
      // gegenseitig eine Datei unter den Fuessen wegloeschen.
      const cur = await client.query(
        'SELECT image_path AS "imagePath" FROM recipes WHERE id=$1 AND household_id=$2 FOR UPDATE',
        [id, req.session.householdId]);
      if (!cur.rowCount) return null;
      oldImagePath = cur.rows[0].imagePath;

      let imagePathValue = oldImagePath;
      if (imageExt) {
        const filename = generateImageFilename(req.session.householdId, id, imageExt);
        await fs.mkdir(RECIPE_IMAGES_DIR, { recursive: true });
        const fullPath = path.join(RECIPE_IMAGES_DIR, filename);
        await fs.writeFile(fullPath, req.file.buffer);
        writtenFilePath = fullPath;
        imagePathValue = filename;
      } else if (removeImage) {
        imagePathValue = null;
      }
      newImagePath = imagePathValue;

      const upd = await client.query(
        `UPDATE recipes SET title=$1, base_servings=$2, instructions=$3, ingredients=$4,
                image_path=$5, updated_by=$6, updated_at=now()
          WHERE id=$7 AND household_id=$8
          RETURNING id, title, base_servings AS "baseServings", instructions, ingredients,
                    image_path AS "imagePath", updated_at AS "updatedAt"`,
        [clean.title, clean.baseServings, clean.instructions, JSON.stringify(clean.ingredients),
         imagePathValue, req.session.userId, id, req.session.householdId]);
      return upd.rows[0];
    });
    if (!result) return res.status(404).json({ error: 'Rezept nicht gefunden' });

    // Altes Bild erst NACH erfolgreichem Commit loeschen (best effort,
    // Datei-Housekeeping ist nicht korrektheitsrelevant fuer die DB) -- nur
    // wenn sich der image_path tatsaechlich geaendert hat.
    if (oldImagePath && oldImagePath !== newImagePath) {
      fs.unlink(path.join(RECIPE_IMAGES_DIR, oldImagePath)).catch(() => {});
    }
    res.json({ recipe: result });
  } catch (err) {
    if (writtenFilePath) await fs.unlink(writtenFilePath).catch(() => {});
    throw err;
  }
}));

app.delete('/api/recipes/:id', requireAuth, rejectForeignHouseholdId, wrap(async (req, res) => {
  const id = parseRecipeId(req.params.id);
  if (id == null) return res.status(400).json({ error: 'Ungueltige Rezept-ID' });
  const result = await withTenantClient(req.session.householdId, client => client.query(
    'DELETE FROM recipes WHERE id=$1 AND household_id=$2 RETURNING image_path AS "imagePath"',
    [id, req.session.householdId]));
  if (!result.rowCount) return res.status(404).json({ error: 'Rezept nicht gefunden' });
  // F6 (Snapshot einfrieren, siehe ap1.1-datenmodell.md Abschnitt 4.1): eine
  // bereits per Drag&Drop zugewiesene Mahlzeit traegt ihre eigene, von
  // recipes unabhaengige Kopie in weeks.data -- das Loeschen hier braucht
  // daher keine Ruecksicht auf bestehende Zuweisungen zu nehmen (kein FK,
  // kein Kaskadieren noetig, ausserhalb des Scopes von AP2.1/AP3.1).
  const imagePath = result.rows[0].imagePath;
  if (imagePath) {
    fs.unlink(path.join(RECIPE_IMAGES_DIR, imagePath)).catch(() => {});
  }
  res.json({ ok: true });
}));

/* ------------------------------------------------------------------ *
 * Rezept-Zuweisung im Essensplaner (AP3.1, projects/wochenplaner-
 * rezeptkarten/plan.md; Spezifikation: ap1.1-datenmodell.md Abschnitt 4)
 *
 * Nimmt Rezept-ID + Zieltag/-slot + gewuenschte Personenzahl entgegen,
 * berechnet die linear auf "servings" skalierte Zutatenliste (F5) und
 * schreibt den Snapshot-Token {t:'recipe',...} in die passende Zelle der
 * "Essen & Kochen"-Zeile (mode:'week') von weeks.data. Kein eigenstaendiges
 * neues Datenformat: die Schreiblogik laeuft am Ende ueber denselben
 * cleanWeek()-Normalisierungspfad und dieselbe INSERT ... ON CONFLICT-
 * Anweisung wie PUT /api/weeks/:monday, nur dass hier statt eines vom
 * Client geschickten kompletten Wochendokuments EIN serverseitig berechneter
 * Token in genau eine Zelle geschrieben wird.
 *
 * A3CH-Entscheidung (offener Punkt aus ap1.1-datenmodell.md Abschnitt 4.2/6,
 * "genau ein recipe-Token pro Zelle vs. mehrere"): Eine Zuweisung ERSETZT
 * den kompletten bisherigen Zelleninhalt (auch etwaige Freitext-/Icon-
 * Tokens) durch genau einen neuen recipe-Token. Begruendung: (1) passt zur
 * Ackerkarten-Metapher "eine Mahlzeit pro Slot/Tag", die AP3.2s Drag&Drop-UX
 * laut Plan ohnehin vorsieht -- ein Nutzer, der eine neue Rezeptkarte auf
 * eine bereits belegte Zelle zieht, erwartet intuitiv einen Ersatz, kein
 * stilles Nebeneinander zweier Mahlzeiten im selben Slot; (2) vermeidet
 * mehrdeutige Kombinationen aus Alt-Freitext (v. a. relevant kurz nach dem
 * F1-Wipe in AP1.2, falls dort einzelne Zellen doch Text behalten haetten)
 * und neuer strukturierter Zuweisung; (3) haelt die Kombination "hoechstens
 * ein recipe-Token" aus cleanTokens()/cleanMeals() (siehe dort) und das
 * Verhalten dieses Endpunkts konsistent -- ein zweiter recipe-Token wuerde
 * beim naechsten Speichern ohnehin stillschweigend verworfen. Ein spaeterer
 * manueller Zusatztext NACH der Zuweisung bleibt weiterhin moeglich: die
 * Zelle ist danach ganz normal ueber PUT /api/weeks/:monday editierbar (F6),
 * dort kann der Nutzer z. B. eine Notiz als zusaetzlichen text-Token neben
 * dem bestehenden recipe-Token ergaenzen.
 *
 * Kein optimistisches Locking ueber baseUpdatedAt (Abwaegung, siehe
 * Ruecklauf an ANORAK): anders als PUT /api/weeks/:monday erhaelt dieser
 * Endpunkt kein vom Client vorgehaltenes, potenziell veraltetes
 * Gesamtdokument -- er liest den aktuellen DB-Stand INNERHALB der eigenen
 * Transaktion (FOR UPDATE) und aendert ausschliesslich die eine Zielzelle.
 * Ein "Lost Update" im Sinne von PUT (Client A ueberschreibt unbemerkt
 * Client Bs zwischenzeitliche Aenderung an einer ANDEREN Zelle) ist damit
 * strukturell ausgeschlossen. Zwei Zuweisungen exakt derselben Zelle nahezu
 * gleichzeitig sind das einzige denkbare Wettlauf-Szenario -- dort gewinnt
 * die zuletzt committete (FOR UPDATE serialisiert beide Transaktionen strikt
 * nacheinander), ein unkritisches, erwartbares "letzter Drop gewinnt".
 * ------------------------------------------------------------------ */
// AP2 (projects/wochenplaner-design-nacharbeiten/plan.md), analog zu AP0s Erweiterung von
// add-ingredient-to-list: optionaler targetWeekStart-Parameter, damit der Essensplan-Dialog (AP1.2)
// auch fuer die auf state.weekStart FOLGENDE Woche zuweisen kann, ohne dass das Frontend dafuer
// einen zweiten vollen GET/PUT/baseUpdatedAt-Zyklus fuer diese Woche haelt (MORROWs Kernempfehlung,
// siehe Ruecklauf an ANORAK). Anders als bei add-ingredient-to-list gibt es hier keine "Quelle" in
// der URL-Woche zu lesen (das Rezept kommt aus der haushaltsweiten recipes-Tabelle, nicht aus
// weeks.data) -- deshalb einfacher: bei abweichendem targetWeekStart laufen FOR UPDATE/Vorlagen-
// Fallback/INSERT ... ON CONFLICT direkt gegen targetWeekStart statt gegen monday, "monday" bleibt
// nur fuer die URL-/Validierungs-Konsistenz mit den uebrigen Endpunkten erhalten.
app.post('/api/weeks/:monday/assign-recipe', requireAuth, rejectForeignHouseholdId, wrap(async (req, res) => {
  const monday = req.params.monday;
  if (!isMonday(monday)) return res.status(400).json({ error: 'Datum muss ein Montag im Format JJJJ-MM-TT sein' });

  const targetWeekStart = (req.body?.targetWeekStart != null && req.body.targetWeekStart !== '')
    ? String(req.body.targetWeekStart)
    : monday;
  if (!isMonday(targetWeekStart)) {
    return res.status(400).json({ error: 'targetWeekStart muss ein Montag im Format JJJJ-MM-TT sein' });
  }

  const recipeId = parseRecipeId(req.body?.recipeId);
  const dayIndex = Number(req.body?.dayIndex);
  const slotIndex = Number(req.body?.slotIndex);
  const servings = Number(req.body?.servings);

  if (recipeId == null) return res.status(400).json({ error: 'Ungueltige Rezept-ID' });
  if (!Number.isInteger(dayIndex) || dayIndex < 0 || dayIndex > 6) {
    return res.status(400).json({ error: 'dayIndex muss eine Ganzzahl zwischen 0 und 6 sein (0=Montag ... 6=Sonntag)' });
  }
  if (!Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex >= MEAL_LABELS.length) {
    return res.status(400).json({ error: `slotIndex muss eine Ganzzahl zwischen 0 und ${MEAL_LABELS.length - 1} sein (Reihenfolge: ${MEAL_LABELS.join(', ')})` });
  }
  if (!Number.isInteger(servings) || servings < 1 || servings > 20) {
    // F3: identischer Wertebereich wie recipes.base_servings/das servings-Feld im Token.
    return res.status(400).json({ error: 'servings (Personenzahl) muss eine ganze Zahl zwischen 1 und 20 sein' });
  }

  const result = await withTenantClient(req.session.householdId, async client => {
    // AP2.1-Guard (ap1.2-datenmodell.md Abschnitt 6.3, dort als Datenfluss-Konsequenz benannt,
    // Umsetzung selbst ist AP2.2): dieser gezielte Schreibpfad liest+schreibt weeks.data direkt
    // serverseitig -- fuer einen bereits verschluesselten Haushalt (oder eine bereits
    // verschluesselte Zielwoche) kann der Server das nicht mehr (er sieht nur Ciphertext). Statt
    // eines Absturzes (cleanWeek(null) o.ae.) hier ein klarer, sprechender Fehler; der volle
    // Lese-Aendern-Schreiben-Zyklus fuer verschluesselte Haushalte folgt mit AP2.2.
    const encCheck = await client.query(
      `SELECT h.encryption_status AS "encryptionStatus",
              (SELECT data_ciphertext IS NOT NULL FROM weeks
                WHERE household_id=h.id AND week_start=$2) AS "weekEncrypted"
         FROM households h WHERE h.id=$1`,
      [req.session.householdId, targetWeekStart]);
    if (encCheck.rows[0]?.encryptionStatus === 'active' || encCheck.rows[0]?.weekEncrypted) {
      return { error: 'encrypted_household' };
    }

    // RLS schraenkt ohnehin auf den eigenen Haushalt ein -- die explizite
    // household_id-Bedingung im WHERE ist identisches Defense-in-Depth-Muster
    // wie bei den uebrigen /api/recipes/:id-Routen oben.
    const recipeQ = await client.query(
      `SELECT id, title, base_servings AS "baseServings", ingredients
         FROM recipes WHERE id=$1 AND household_id=$2`,
      [recipeId, req.session.householdId]);
    if (!recipeQ.rowCount) return { error: 'recipe_not_found' };
    const recipe = recipeQ.rows[0];

    // FOR UPDATE: serialisiert konkurrierende Zuweisungen/PUTs derselben
    // Woche (siehe Begruendung oben) -- identisches Sperrmuster wie
    // PUT /api/weeks/:monday. Laeuft gegen targetWeekStart (== monday im Normalfall, siehe
    // AP2-Kommentar oben).
    const weekQ = await client.query(
      `SELECT data FROM weeks WHERE household_id=$1 AND week_start=$2 FOR UPDATE`,
      [req.session.householdId, targetWeekStart]);

    let data;
    if (weekQ.rowCount) {
      data = cleanWeek(migrateLegacyWeek(weekQ.rows[0].data));
    } else {
      // Noch keine Woche unter diesem Datum angelegt: identischer
      // Vorlagen-Fallback wie GET /api/weeks/:monday, damit eine Zuweisung
      // auch auf eine noch nicht besuchte Woche moeglich ist, ohne dass das
      // Frontend vorher zwingend GET+PUT durchlaufen muesste.
      const t = await client.query('SELECT template_data FROM households WHERE id=$1', [req.session.householdId]);
      const template = t.rows[0]?.template_data ? migrateLegacyWeek(t.rows[0].template_data) : null;
      data = cleanWeek(template ? mergeTemplate(structuredClone(template), defaultWeek()) : defaultWeek());
    }

    // Die "Essen & Kochen"-Zeile hat keine feste ID, nur ihre Zeilenform
    // (kind:'shared', mode:'week') -- siehe migrateLegacyRow()-Kommentar
    // weiter oben zur selben Einschraenkung. In der Praxis legt
    // defaultWeek() genau eine solche Zeile an und die bestehende Anwendung
    // bietet keinen Weg, mode:'week' vom Nutzer setzen/entfernen zu lassen;
    // dieser Zweig ist trotzdem ein bewusster Schutz gegen ein
    // unvorhergesehen abweichendes Dokument, kein erwarteter Normalfall.
    const mealRow = data.rows.find(r => r && r.kind === 'shared' && r.mode === 'week');
    if (!mealRow) return { error: 'meal_row_missing' };

    const scaledIngredients = cleanIngredients(scaleIngredients(recipe.ingredients, recipe.baseServings, servings));
    const recipeTitle = str(recipe.title, LIMITS.recipeTitle).trim() || recipe.title;
    // Number(...): recipes.id ist bigint -- node-postgres liefert bigint-Spalten
    // grundsaetzlich als String (Praezisionsschutz), hier aber bewusst als JSON-
    // Zahl im Token abgelegt, damit die Form exakt MORROWs Spezifikation
    // (ap1.1-datenmodell.md Abschnitt 4.1, Beispiel "recipeId": 42) entspricht
    // und identisch zu dem ist, was cleanRecipeToken() beim erneuten
    // Validieren eines vom Client zurueckgeschickten Tokens ohnehin erzeugt
    // (Number(tok.recipeId)) -- ohne diese Umwandlung wuerde derselbe Token
    // vor und nach einer manuellen Bearbeitung/erneutem Speichern
    // unterschiedliche Typen fuer dasselbe Feld tragen.
    const token = { t: 'recipe', recipeId: Number(recipe.id), recipeTitle, servings, ingredients: scaledIngredients };

    // Ersetzt den kompletten bisherigen Zelleninhalt, siehe Entscheidung oben.
    mealRow.meals[slotIndex].cells[dayIndex] = [token];

    const saved = await client.query(
      `INSERT INTO weeks(household_id, week_start, data, updated_by)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (household_id, week_start)
       DO UPDATE SET data=EXCLUDED.data, updated_by=EXCLUDED.updated_by, updated_at=now()
       RETURNING updated_at AS "updatedAt"`,
      [req.session.householdId, targetWeekStart, data, req.session.userId]);

    return { ok: true, token, data, updatedAt: saved.rows[0].updatedAt };
  });

  if (result.error === 'encrypted_household') {
    return res.status(409).json({ error: 'Diese Funktion ist fuer Haushalte mit aktivierter Termin-Verschluesselung ' +
      'noch nicht verfuegbar (folgt mit einem spaeteren Update). Bitte die Zuweisung stattdessen ueber die normale ' +
      'Wochenansicht bearbeiten.' });
  }
  if (result.error === 'recipe_not_found') return res.status(404).json({ error: 'Rezept nicht gefunden' });
  if (result.error === 'meal_row_missing') return res.status(409).json({ error: '"Essen & Kochen"-Zeile in dieser Woche nicht gefunden' });

  res.json({
    ok: true, weekStart: monday, targetWeekStart, dayIndex, slotIndex,
    token: result.token, data: result.data, updatedAt: result.updatedAt
  });
}));

/* ------------------------------------------------------------------ *
 * AP2 (projects/wochenplaner-design-nacharbeiten/plan.md, Stufe 2): gezielter Schreibpfad fuer
 * die 4 "einfachen" Essensplan-Dialog-Optionen (Freitext/Außerhalb/Reste/Nicht geplant, AP1.2) --
 * schreibt GENAU EINE Mahlzeiten-Zelle, exakt nach demselben FOR-UPDATE-/Vorlagen-Fallback-/
 * INSERT-ON-CONFLICT-Muster wie assign-recipe/add-ingredient-to-list oben, statt dass das Frontend
 * dafuer den vollen PUT /api/weeks/:monday-Zyklus (kompletter State + baseUpdatedAt-Konflikt-
 * pruefung) fuer eine zweite, nicht geladene Woche haelt (MORROWs Kernempfehlung). Fuer die
 * AKTUELL GELADENE Woche (targetWeekStart === state.weekStart im Frontend) bleibt der bisherige
 * Weg unveraendert bestehen (direkte state.data-Mutation + markDirty()/Autosave, siehe app.js) --
 * dieser Endpunkt wird vom Frontend ausschliesslich fuer die FOLGENDE, nicht geladene Woche
 * genutzt (AP2), ist aber bewusst generisch (kein AP2-Sonderfall im Code) und funktioniert fuer
 * jede Woche.
 *
 * Bewusst OHNE "allowRecipe" bei cleanTokens(): ein 'recipe'-Token darf ausschliesslich ueber
 * assign-recipe entstehen (dort serverseitig aus recipes/recipeId+servings berechnet, inkl.
 * Mengen-Skalierung) -- ein Client, der versucht, hier direkt einen {t:'recipe',...}-Token
 * einzuschleusen, wuerde ihn durch cleanTokens() ohne allowRecipe stillschweigend verwerfen (wie
 * jeden anderen unbekannten Token-Typ), analog zur bestehenden Absicherung in cleanTokens() selbst.
 * ------------------------------------------------------------------ */
app.post('/api/weeks/:monday/set-meal-cell', requireAuth, rejectForeignHouseholdId, wrap(async (req, res) => {
  const monday = req.params.monday;
  if (!isMonday(monday)) return res.status(400).json({ error: 'Datum muss ein Montag im Format JJJJ-MM-TT sein' });

  const targetWeekStart = (req.body?.targetWeekStart != null && req.body.targetWeekStart !== '')
    ? String(req.body.targetWeekStart)
    : monday;
  if (!isMonday(targetWeekStart)) {
    return res.status(400).json({ error: 'targetWeekStart muss ein Montag im Format JJJJ-MM-TT sein' });
  }

  const dayIndex = Number(req.body?.dayIndex);
  const slotIndex = Number(req.body?.slotIndex);
  if (!Number.isInteger(dayIndex) || dayIndex < 0 || dayIndex > 6) {
    return res.status(400).json({ error: 'dayIndex muss eine Ganzzahl zwischen 0 und 6 sein (0=Montag ... 6=Sonntag)' });
  }
  if (!Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex >= MEAL_LABELS.length) {
    return res.status(400).json({ error: `slotIndex muss eine Ganzzahl zwischen 0 und ${MEAL_LABELS.length - 1} sein (Reihenfolge: ${MEAL_LABELS.join(', ')})` });
  }
  const tokens = cleanTokens(req.body?.tokens); // kein allowRecipe, siehe Kommentar oben

  const result = await withTenantClient(req.session.householdId, async client => {
    // AP2.1-Guard, siehe identischer Kommentar bei assign-recipe oben.
    const encCheck = await client.query(
      `SELECT h.encryption_status AS "encryptionStatus",
              (SELECT data_ciphertext IS NOT NULL FROM weeks
                WHERE household_id=h.id AND week_start=$2) AS "weekEncrypted"
         FROM households h WHERE h.id=$1`,
      [req.session.householdId, targetWeekStart]);
    if (encCheck.rows[0]?.encryptionStatus === 'active' || encCheck.rows[0]?.weekEncrypted) {
      return { error: 'encrypted_household' };
    }

    const weekQ = await client.query(
      `SELECT data FROM weeks WHERE household_id=$1 AND week_start=$2 FOR UPDATE`,
      [req.session.householdId, targetWeekStart]);

    let data;
    if (weekQ.rowCount) {
      data = cleanWeek(migrateLegacyWeek(weekQ.rows[0].data));
    } else {
      // Noch keine Woche unter diesem Datum angelegt: identischer Vorlagen-Fallback wie bei
      // assign-recipe/GET /api/weeks/:monday.
      const t = await client.query('SELECT template_data FROM households WHERE id=$1', [req.session.householdId]);
      const template = t.rows[0]?.template_data ? migrateLegacyWeek(t.rows[0].template_data) : null;
      data = cleanWeek(template ? mergeTemplate(structuredClone(template), defaultWeek()) : defaultWeek());
    }

    const mealRow = data.rows.find(r => r && r.kind === 'shared' && r.mode === 'week');
    if (!mealRow) return { error: 'meal_row_missing' };

    // Ersetzt den kompletten bisherigen Zelleninhalt (leeres Array raeumt die Zelle) -- identisches
    // Verhalten zu assign-recipe/den 4 einfachen Dialog-Optionen im Frontend (app.js,
    // handleMealSlotOption()/submitMealSlotText()).
    mealRow.meals[slotIndex].cells[dayIndex] = tokens;

    const saved = await client.query(
      `INSERT INTO weeks(household_id, week_start, data, updated_by)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (household_id, week_start)
       DO UPDATE SET data=EXCLUDED.data, updated_by=EXCLUDED.updated_by, updated_at=now()
       RETURNING updated_at AS "updatedAt"`,
      [req.session.householdId, targetWeekStart, data, req.session.userId]);

    return { ok: true, data, updatedAt: saved.rows[0].updatedAt };
  });

  if (result.error === 'encrypted_household') {
    return res.status(409).json({ error: 'Diese Funktion ist fuer Haushalte mit aktivierter Termin-Verschluesselung ' +
      'noch nicht verfuegbar (folgt mit einem spaeteren Update). Bitte die Zelle stattdessen ueber die normale ' +
      'Wochenansicht bearbeiten.' });
  }
  if (result.error === 'meal_row_missing') return res.status(409).json({ error: '"Essen & Kochen"-Zeile in dieser Woche nicht gefunden' });

  res.json({
    ok: true, weekStart: monday, targetWeekStart, dayIndex, slotIndex,
    data: result.data, updatedAt: result.updatedAt
  });
}));

// AP4.1: baut aus einer Zutat {amount, unit, name} einen einzelnen Anzeigetext fuer einen
// Tagesliste-Eintrag, passend zum Format, das der bestehende Composer im Frontend fuer manuell
// erfasste Eintraege erzeugt (ein einzelner text-Token, siehe buildComposer()/openDayList() in
// app.js). amount:null (z.B. wenn der Name bereits "Salz, nach Geschmack" lautet) liefert nur
// den Namen; amount+unit werden sonst mit einem Leerzeichen davor ergaenzt (z.B. "500 g Mehl").
// String(amount) statt toFixed(): liefert Zahlen ohne unnoetige Nachkommastellen (500 statt
// 500.00), waehrend von scaleIngredients() gerundete Werte wie 0.25 unveraendert bleiben.
function formatIngredientText(ingredient) {
  const amountUnit = [
    typeof ingredient.amount === 'number' && Number.isFinite(ingredient.amount) ? String(ingredient.amount) : null,
    ingredient.unit || null
  ].filter(Boolean).join(' ');
  return amountUnit ? `${amountUnit} ${ingredient.name}` : ingredient.name;
}

/* ------------------------------------------------------------------ *
 * AP4.1 (F2-Entscheidung des Nutzers, plan.md "Designentscheidungen"):
 * eine einzelne Zutat aus einer bestehenden Rezept-Zuweisung ("Essen &
 * Kochen", 't':'recipe'-Token, siehe assign-recipe oben) in die Tagesliste
 * der "Einkauf & Besorgungen"-Zeile (listMode:true) uebernehmen.
 *
 * Eingabeformat -- Referenz statt vollstaendigem {amount,unit,name}-Objekt
 * vom Client (dayIndex/slotIndex der Zuweisung + ingredientIndex innerhalb
 * ingredients[]), bewusst die robustere der beiden im Auftrag genannten
 * Varianten:
 *  (1) Der Snapshot im recipe-Token IST bereits die Wahrheit fuer eine
 *      zugewiesene Mahlzeit (F6, inkl. evtl. bereits manueller Korrektur
 *      ueber PUT /api/weeks/:monday) -- ein zusaetzlich vom Client
 *      mitgeschicktes {amount,unit,name} koennte veraltet sein (Client hat
 *      eine inzwischen ueberholte Kopie im Speicher) oder frei erfunden;
 *      die Referenz-Variante schliesst diese Diskrepanz strukturell aus.
 *  (2) Kein zweiter Validierungspfad fuer {amount,unit,name} noetig -- die
 *      referenzierte Zutat hat cleanIngredients()/cleanRecipeToken() bereits
 *      beim Zuweisen bzw. letzten Speichern durchlaufen.
 *  (3) Gleiches "innerhalb derselben Transaktion lesen und schreiben"-Muster
 *      wie assign-recipe (FOR UPDATE) -- kein zusaetzlicher Abgleich noetig,
 *      ob eine vom Client mitgeschickte Zutat noch zur aktuellen Zelle passt.
 * targetDayIndex ist ein eigener Pflicht-Parameter (F2): das Frontend
 * (AP4.2) befuellt ihn standardmaessig mit demselben Wert wie dayIndex, der
 * Nutzer kann ihn im Tag-Auswahl-Dialog aber auf einen beliebigen Wochentag
 * aendern -- der Server kennt/erzwingt keinen Default, er nimmt den vom
 * Client gesendeten Wert entgegen.
 *
 * Existiert fuer targetDayIndex noch keine Tagesliste (leeres Array), wird
 * sie durch das Hinzufuegen des ersten Eintrags faktisch neu angelegt --
 * identisches Verhalten zum bestehenden manuellen Composer-Pfad
 * (openDayList()/buildComposer() in app.js: `items.push(...); row.cells[d]
 * = items;`), keine gesonderte "Liste anlegen"-Logik noetig.
 *
 * Kein Dedublizieren (Auftrag Punkt 6): dieselbe Zutat mehrfach hinzuzufuegen
 * (z.B. aus zwei verschiedenen Rezepten) ist kein Fehler, jeder Aufruf haengt
 * einen weiteren eigenstaendigen Eintrag an.
 *
 * AP0 (projects/wochenplaner-design-nacharbeiten/plan.md), von MORROW geprueft:
 * optionaler Body-Parameter targetWeekStart erweitert den Endpunkt um einen
 * gezielten wochenuebergreifenden Schreibpfad -- Vorbereitung fuer den in
 * AP1.2 kommenden Monatspicker beim Einkaufsdatum. Default ist "monday" aus
 * der URL (100% abwaertskompatibel: kein bestehender Aufrufer sendet das
 * Feld). Quelle (Rezept-Token/Zutat ueber dayIndex/slotIndex/ingredientIndex)
 * bleibt IMMER die URL-Woche "monday" -- nur das Ziel (listRow/targetList,
 * INSERT ... ON CONFLICT) kann davon abweichen. Fuer targetWeekStart !==
 * monday wird dieselbe Lade-/Vorlagen-Fallback-Logik wie oben bei
 * assign-recipe verwendet (Zielwoche existiert evtl. noch nicht) -- inklusive
 * derselben, dort bereits akzeptierten Einschraenkung: eine noch nicht
 * angelegte Zielwoche kann nicht per FOR UPDATE gesperrt werden (nichts zum
 * Sperren vorhanden), das Wettlauf-Risiko zweier gleichzeitiger Ersterstellungen
 * derselben neuen Zielwoche ist identisch zu dem bereits dort akzeptierten Fall.
 * Bereits existierende Zielwochen werden weiterhin per FOR UPDATE serialisiert.
 * Die Response traegt targetWeekStart, damit der Client zuverlaessig
 * unterscheiden kann, ob data/updatedAt zur aktuell geladenen Woche gehoeren
 * (siehe submitIngredientToList() in app.js) -- PUT /api/weeks/:monday und
 * dessen baseUpdatedAt-Optimistic-Lock sind von alldem unberuehrt, dieser
 * Endpunkt kennt wie bisher kein eigenes optimistisches Locking (Begruendung
 * siehe Kommentar bei assign-recipe oben).
 * ------------------------------------------------------------------ */
app.post('/api/weeks/:monday/add-ingredient-to-list', requireAuth, rejectForeignHouseholdId, wrap(async (req, res) => {
  const monday = req.params.monday;
  if (!isMonday(monday)) return res.status(400).json({ error: 'Datum muss ein Montag im Format JJJJ-MM-TT sein' });

  // AP0: leer/undefined -> Default "monday" (bestehendes Verhalten unveraendert).
  const targetWeekStart = (req.body?.targetWeekStart != null && req.body.targetWeekStart !== '')
    ? String(req.body.targetWeekStart)
    : monday;
  if (!isMonday(targetWeekStart)) {
    return res.status(400).json({ error: 'targetWeekStart muss ein Montag im Format JJJJ-MM-TT sein' });
  }

  const dayIndex = Number(req.body?.dayIndex);
  const slotIndex = Number(req.body?.slotIndex);
  const ingredientIndex = Number(req.body?.ingredientIndex);
  const targetDayIndex = Number(req.body?.targetDayIndex);

  if (!Number.isInteger(dayIndex) || dayIndex < 0 || dayIndex > 6) {
    return res.status(400).json({ error: 'dayIndex muss eine Ganzzahl zwischen 0 und 6 sein (0=Montag ... 6=Sonntag)' });
  }
  if (!Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex >= MEAL_LABELS.length) {
    return res.status(400).json({ error: `slotIndex muss eine Ganzzahl zwischen 0 und ${MEAL_LABELS.length - 1} sein (Reihenfolge: ${MEAL_LABELS.join(', ')})` });
  }
  if (!Number.isInteger(ingredientIndex) || ingredientIndex < 0) {
    return res.status(400).json({ error: 'ingredientIndex muss eine nicht-negative Ganzzahl sein' });
  }
  if (!Number.isInteger(targetDayIndex) || targetDayIndex < 0 || targetDayIndex > 6) {
    return res.status(400).json({ error: 'targetDayIndex muss eine Ganzzahl zwischen 0 und 6 sein (0=Montag ... 6=Sonntag)' });
  }

  const result = await withTenantClient(req.session.householdId, async client => {
    // AP2.1-Guard, siehe identischer Kommentar bei assign-recipe oben -- hier auf Quell- UND
    // Zielwoche geprueft, da beide serverseitig gelesen/geschrieben werden.
    const encCheck = await client.query(
      `SELECT h.encryption_status AS "encryptionStatus",
              (SELECT data_ciphertext IS NOT NULL FROM weeks
                WHERE household_id=h.id AND week_start=$2) AS "sourceEncrypted",
              (SELECT data_ciphertext IS NOT NULL FROM weeks
                WHERE household_id=h.id AND week_start=$3) AS "targetEncrypted"
         FROM households h WHERE h.id=$1`,
      [req.session.householdId, monday, targetWeekStart]);
    const encRow = encCheck.rows[0];
    if (encRow?.encryptionStatus === 'active' || encRow?.sourceEncrypted || encRow?.targetEncrypted) {
      return { error: 'encrypted_household' };
    }

    // Anders als assign-recipe kein Vorlagen-Fallback fuer die QUELL-Woche (monday): die hier
    // referenzierte Zutat kann nur existieren, wenn zuvor bereits eine Rezept-Zuweisung
    // stattgefunden hat -- und assign-recipe legt die weeks-Zeile dabei immer per UPSERT an.
    // Existiert die Quell-Woche nicht, kann dayIndex/slotIndex keine gueltige Zuweisung
    // referenzieren; 404 statt eines irrefuehrenden Vorlagen-Zugriffs.
    const weekQ = await client.query(
      `SELECT data FROM weeks WHERE household_id=$1 AND week_start=$2 FOR UPDATE`,
      [req.session.householdId, monday]);
    if (!weekQ.rowCount) return { error: 'week_not_found' };
    const data = cleanWeek(migrateLegacyWeek(weekQ.rows[0].data));

    const mealRow = data.rows.find(r => r && r.kind === 'shared' && r.mode === 'week');
    if (!mealRow) return { error: 'meal_row_missing' };

    const recipeToken = mealRow.meals[slotIndex].cells[dayIndex].find(t => t.t === 'recipe');
    if (!recipeToken) return { error: 'no_recipe_assigned' };
    const ingredient = recipeToken.ingredients[ingredientIndex];
    if (!ingredient) return { error: 'ingredient_not_found' };

    // AP0: Ziel-Datensatz ist entweder derselbe wie oben (targetWeekStart === monday, identisches
    // Verhalten zu vor AP0) oder eine zweite, unabhaengige Zeile -- fuer die, analog zu
    // assign-recipe, dieselbe Lade-/Vorlagen-Fallback-Logik greift, falls sie noch nicht existiert.
    let targetData;
    if (targetWeekStart === monday) {
      targetData = data;
    } else {
      const targetWeekQ = await client.query(
        `SELECT data FROM weeks WHERE household_id=$1 AND week_start=$2 FOR UPDATE`,
        [req.session.householdId, targetWeekStart]);
      if (targetWeekQ.rowCount) {
        targetData = cleanWeek(migrateLegacyWeek(targetWeekQ.rows[0].data));
      } else {
        const t = await client.query('SELECT template_data FROM households WHERE id=$1', [req.session.householdId]);
        const template = t.rows[0]?.template_data ? migrateLegacyWeek(t.rows[0].template_data) : null;
        targetData = cleanWeek(template ? mergeTemplate(structuredClone(template), defaultWeek()) : defaultWeek());
      }
    }

    const listRow = targetData.rows.find(r => r && r.kind === 'shared' && r.listMode === true);
    if (!listRow) return { error: 'list_row_missing' };

    const targetList = listRow.cells[targetDayIndex];
    // LIMITS.listItems (40) wird von cleanListItems() beim naechsten Normalisieren ohnehin
    // durchgesetzt (slice(0, LIMITS.listItems)) -- der explizite Check hier verhindert, dass
    // ein frisch hinzugefuegter Eintrag beim naechsten Laden kommentarlos abgeschnitten wird,
    // statt den Fehler erst spaeter unbemerkt auftreten zu lassen.
    if (targetList.length >= LIMITS.listItems) return { error: 'list_full' };

    const item = { done: false, tokens: cleanTokens([{ t: 'text', v: formatIngredientText(ingredient) }]) };
    targetList.push(item);

    const saved = await client.query(
      `INSERT INTO weeks(household_id, week_start, data, updated_by)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (household_id, week_start)
       DO UPDATE SET data=EXCLUDED.data, updated_by=EXCLUDED.updated_by, updated_at=now()
       RETURNING updated_at AS "updatedAt"`,
      [req.session.householdId, targetWeekStart, targetData, req.session.userId]);

    return { ok: true, item, data: targetData, updatedAt: saved.rows[0].updatedAt };
  });

  if (result.error === 'encrypted_household') {
    return res.status(409).json({ error: 'Diese Funktion ist fuer Haushalte mit aktivierter Termin-Verschluesselung ' +
      'noch nicht verfuegbar (folgt mit einem spaeteren Update). Bitte den Eintrag stattdessen ueber die normale ' +
      'Wochenansicht bearbeiten.' });
  }
  if (result.error === 'week_not_found') return res.status(404).json({ error: 'Woche nicht gefunden -- eine Zutat kann nur aus einer bereits bestehenden Rezept-Zuweisung uebernommen werden' });
  if (result.error === 'meal_row_missing') return res.status(409).json({ error: '"Essen & Kochen"-Zeile in dieser Woche nicht gefunden' });
  if (result.error === 'list_row_missing') return res.status(409).json({ error: '"Einkauf & Besorgungen"-Zeile in der Zielwoche nicht gefunden' });
  if (result.error === 'no_recipe_assigned') return res.status(404).json({ error: 'In dieser Zelle ist aktuell kein Rezept zugewiesen' });
  if (result.error === 'ingredient_not_found') return res.status(404).json({ error: 'Zutat mit diesem Index nicht gefunden' });
  if (result.error === 'list_full') return res.status(400).json({ error: `Tagesliste ist bereits voll (max. ${LIMITS.listItems} Eintraege)` });

  res.json({
    ok: true, weekStart: monday, targetWeekStart, targetDayIndex,
    item: result.item, data: result.data, updatedAt: result.updatedAt
  });
}));

/* ------------------------------------------------------------------ *
 * Betrieb
 * ------------------------------------------------------------------ */
app.get('/api/health', wrap(async (req, res) => {
  await appPool.query('SELECT 1');
  res.json({ status: 'ok' });
}));

// AP5 (projects/wochenplaner-design-nacharbeiten/plan.md): "/" liefert jetzt die neue, rein
// statische Landingpage (landing.html) statt direkt der App (index.html) -- express.static()s
// "index"-Option bestimmt, welche Datei bei einem Verzeichnis-Request (hier: der nackten Root)
// ausgeliefert wird, das war zuvor rein zufaellig "index.html". Minimal-invasiv: nur dieser eine
// Wert geaendert, keine neue Route/kein neues Framework noetig. index.html/login.html (sowie das
// getrennte Admin-Subsystem admin.html/admin-login.html) bleiben unter ihren bisherigen,
// expliziten Dateinamen unveraendert erreichbar -- geprueft (login.js/app.js/admin.js leiten
// durchgaengig ueber explizite Dateinamen weiter, nichts im Code haengt an der nackten Root).
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h', index: 'landing.html' }));

app.use((req, res) => res.status(404).json({ error: 'Nicht gefunden' }));
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Interner Fehler' });
});

migrate()
  .then(() => ensureAppRolePassword())
  .then(() => ensureRecipeImageDir())
  .then(() => app.listen(PORT, () => console.log(`Wochenplaner laeuft auf Port ${PORT}`)))
  .catch(err => { console.error(err); process.exit(1); });

const shutdown = () => Promise.all([migratorPool.end(), appPool.end()]).finally(() => process.exit(0));
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
