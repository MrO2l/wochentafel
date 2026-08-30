#!/usr/bin/env node
/* ============================================================================
 * wipe-meal-freetext.mjs
 *
 * AP1.2 (Wochenplaner-Rezeptkarten, projects/wochenplaner-rezeptkarten/plan.md):
 * Setzt die Nutzerentscheidung F1 um -- harter, einmaliger Wipe der bisher
 * FREITEXTLICHEN "Essen & Kochen"-Zeile in weeks.data, VOR dem Rollout des
 * Rezeptkarten-Features. Kein Migrationspfad, kein Koexistenz-Fallback: die
 * App wird aktuell nur privat genutzt, Datenverlust bei diesen Zellen ist
 * vom Nutzer explizit akzeptiert (siehe plan.md, Abschnitt "Designentschei-
 * dungen", F1).
 *
 * Bewusst KEINE SQL-Migrationsdatei (008_recipes.sql schliesst das laut
 * eigenem Dateikopf ausdruecklich aus): Dies ist eine einmalige DATEN-
 * Aenderung (DML) an weeks.data, kein Schema-Wechsel (DDL) -- gehoert nicht
 * in den ueber schema_migrations verfolgten migrate()-Mechanismus, der pro
 * Datei nur genau einmal ausgefuehrt wird und ausschliesslich fuer Schema
 * gedacht ist. Stattdessen ein eigenstaendiges CLI-Skript, analog zu
 * export-tenant.mjs/create-tenant.mjs.
 *
 * Rollenwahl: DATABASE_URL (Owner-/Migrator-Rolle), NICHT DATABASE_URL_APP --
 * dieser Wipe ist ein administrativer Vorgang ueber ALLE Haushalte hinweg
 * (nicht auf einen einzelnen household_id-Kontext beschraenkt), analog zur
 * Begruendung in export-tenant.mjs. Die Owner-Rolle ist von RLS ausgenommen
 * (Owner-Bypass), wir muessten sonst app.current_household_id in einer
 * Schleife je Haushalt umsetzen, ohne echten Sicherheitsgewinn fuer ein
 * einmalig manuell ausgefuehrtes Werkzeug.
 *
 * WAS wird zurueckgesetzt (siehe server.js, cleanMeals()/defaultWeek()):
 *   - Zeilen, die bereits im aktuellen Format vorliegen (kind:'shared',
 *     mode:'week', vier meals[]-Eintraege mit cells[7]) -- das strukturelle
 *     Merkmal mode==='week' identifiziert diese Zeile genau wie cleanRow()
 *     in server.js selbst, unabhaengig von einem evtl. vom Nutzer geaenderten
 *     Zeilenlabel. Alle cells[] jeder Mahlzeit werden auf [] zurueckgesetzt,
 *     die Mahlzeiten-Unterlabels (Fruehstueck/Mittagessen/Abendessen/Snack
 *     bzw. ein vom Nutzer umbenanntes Unterlabel) bleiben erhalten -- das
 *     sind Strukturbezeichner, kein Freitext-Karteninhalt.
 *   - Zeilen im AELTEREN, noch nicht auf mode:'week' gehobenen Format
 *     (kind:'shared', kein mode, kein listMode, label "Essen & Kochen",
 *     Freitext-cells[7]) -- erkannt wie migrateLegacyRow() in server.js.
 *     Diese Zeilen wurden seit Einfuehrung der Mahlzeiten-Struktur schlicht
 *     noch nicht erneut gespeichert. Statt sie unveraendert zu lassen (dann
 *     wuerde migrateLegacyRow() den alten Freitext beim naechsten Laden nach
 *     "Mittagessen" verschieben -- das Gegenteil eines harten Wipes), werden
 *     sie hier direkt in die neue leere mode:'week'-Struktur gehoben.
 *
 * WAS bleibt unangetastet: alle anderen Zeilen (Personen-Zeilen,
 * "Einkauf & Besorgungen" mit listMode:true, "Haushalt & Sonstiges" o.ae.),
 * motto/notes/goals/highlights/calls, sowie alle Wochen, die gar keine
 * "Essen & Kochen"-Zeile enthalten.
 *
 * Sicherheitsnetz: Standardmodus ist ein reiner Trockenlauf (zeigt an, was
 * geaendert wuerde, schreibt nichts). Erst mit --apply werden die
 * betroffenen weeks-Zeilen tatsaechlich per UPDATE geschrieben (siehe
 * plan.md, Risikotabelle: "Wipe-Schritt erst nach erfolgreichem Testlauf
 * der Migration auf Test-Instanz ausfuehren").
 *
 * Aufruf (innerhalb des laufenden app-Containers bzw. gegen eine
 * Test-Instanz mit passender DATABASE_URL):
 *   docker compose exec app node scripts/wipe-meal-freetext.mjs            # Trockenlauf, keine Schreibvorgaenge
 *   docker compose exec app node scripts/wipe-meal-freetext.mjs --apply    # fuehrt den Wipe tatsaechlich aus
 * ============================================================================ */

import pg from 'pg';

const DATABASE_URL = process.env.DATABASE_URL;

function parseArgs(argv) {
  const args = {};
  for (const token of argv) {
    if (token === '--help' || token === '-h') { args.help = true; continue; }
    if (token === '--apply') { args.apply = true; continue; }
  }
  return args;
}

function printUsage() {
  console.error(`
Verwendung:
  node scripts/wipe-meal-freetext.mjs            Trockenlauf: zeigt betroffene Wochen, schreibt nichts
  node scripts/wipe-meal-freetext.mjs --apply     fuehrt den Wipe tatsaechlich aus (UPDATE je betroffener Woche)

Setzt die "Essen & Kochen"-Zeile aller weeks-Datensaetze auf leere
Mahlzeiten-Zellen zurueck (Nutzerentscheidung F1, siehe
projects/wochenplaner-rezeptkarten/plan.md). Alle anderen Zeilen/Felder
bleiben unveraendert.

Voraussetzung: Umgebungsvariable DATABASE_URL (Owner-/Migrator-Rolle) muss
gesetzt sein -- im Docker-Compose-Stack bereits der Fall.
`);
}

// Vier leere Tageszellen-Arrays -- Bezeichnung/Reihenfolge exakt wie
// MEAL_LABELS in server.js.
const MEAL_LABELS = ['Frühstück', 'Mittagessen', 'Abendessen', 'Snack'];
const emptyMealCells = () => Array.from({ length: 7 }, () => []);

// Zaehlt, wie viele der 7*4=28 Zellen einer Mahlzeiten-Zeile ueberhaupt
// Inhalt hatten -- nur fuer die Trockenlauf-/Ergebnisanzeige, keine
// fachliche Bedeutung.
function countFilledMealCells(meals) {
  if (!Array.isArray(meals)) return 0;
  let n = 0;
  for (const meal of meals) {
    if (!meal || !Array.isArray(meal.cells)) continue;
    for (const cell of meal.cells) if (Array.isArray(cell) && cell.length) n++;
  }
  return n;
}
function countFilledLegacyCells(cells) {
  if (!Array.isArray(cells)) return 0;
  return cells.filter(c => Array.isArray(c) && c.length).length;
}

/** Baut aus vorhandenen Mahlzeiten-Unterlabels eine frische, leere
 *  meals[]-Struktur -- Unterlabels (Struktur, kein Freitext-Karteninhalt)
 *  bleiben erhalten, cells werden auf [] zurueckgesetzt. Fehlen Eintraege
 *  (z. B. weniger als vier), wird mit den Standardlabels aufgefuellt --
 *  identisches Verhalten zu cleanMeals([]) in server.js. */
function wipedMeals(existingMeals) {
  const arr = Array.isArray(existingMeals) ? existingMeals : [];
  return Array.from({ length: MEAL_LABELS.length }, (_, i) => ({
    label: (arr[i] && typeof arr[i].label === 'string' && arr[i].label) || MEAL_LABELS[i],
    cells: emptyMealCells()
  }));
}

const LEGACY_LABEL_WEEK = 'essen & kochen';

/** Untersucht eine einzelne Zeile aus weeks.data.rows[] und liefert, falls
 *  sie die "Essen & Kochen"-Zeile ist, die zurueckgesetzte Version zurueck
 *  -- sonst die Zeile unveraendert. filled = Anzahl vormals befuellter
 *  Zellen (nur fuer die Berichtsausgabe). */
function wipeRowIfMealRow(row) {
  if (!row || typeof row !== 'object' || row.kind !== 'shared') return { row, changed: false, filled: 0 };

  // Fall A: bereits auf das aktuelle mode:'week'-Format gehoben (die App
  // selbst erkennt die Zeile ebenso -- ueber die Struktur, nicht das Label,
  // siehe cleanRow() in server.js).
  if (row.mode === 'week') {
    const filled = countFilledMealCells(row.meals);
    if (filled === 0) return { row, changed: false, filled: 0 }; // schon leer, nichts zu tun
    return { row: { ...row, meals: wipedMeals(row.meals) }, changed: true, filled };
  }

  // Fall B: aelteres Format, noch nicht seit Einfuehrung der Mahlzeiten-
  // Struktur gespeichert -- kind:'shared', kein mode, kein listMode,
  // Freitext-cells[7], erkannt am Zeilenlabel wie migrateLegacyRow() in
  // server.js. Wird direkt in die neue LEERE Struktur gehoben (statt den
  // Freitext beim naechsten Laden nach "Mittagessen" verschieben zu lassen
  // -- das waere kein harter Wipe mehr).
  if (!row.mode && !row.listMode && Array.isArray(row.cells)) {
    const label = String(row.label || '').trim().toLowerCase();
    if (label === LEGACY_LABEL_WEEK) {
      const filled = countFilledLegacyCells(row.cells);
      return {
        row: { kind: row.kind, label: row.label, role: row.role, mode: 'week', meals: wipedMeals([]) },
        changed: true,
        filled
      };
    }
  }

  return { row, changed: false, filled: 0 };
}

/** Wendet den Wipe auf eine komplette weeks.data-Struktur an. Aendert NUR
 *  die "Essen & Kochen"-Zeile(n) -- alle anderen Zeilen sowie alle
 *  Top-Level-Felder (motto/notes/goals/highlights/calls/version) bleiben
 *  unveraendert (structuredClone + gezielter Zeilenersatz, kein
 *  Neuaufbau der gesamten Struktur). */
function wipeWeekData(data) {
  if (!data || !Array.isArray(data.rows)) return { data, changed: false, filled: 0 };
  let changed = false;
  let filled = 0;
  const rows = data.rows.map(row => {
    const result = wipeRowIfMealRow(row);
    if (result.changed) { changed = true; filled += result.filled; }
    return result.row;
  });
  if (!changed) return { data, changed: false, filled: 0 };
  return { data: { ...data, rows }, changed: true, filled };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { printUsage(); process.exit(0); }

  if (!DATABASE_URL) {
    console.error('Fehler: Umgebungsvariable DATABASE_URL fehlt. Dieses Skript muss mit der ' +
      'Owner-/Migrator-Rolle laufen (siehe docker-compose.yml).');
    process.exit(1);
  }

  const dryRun = !args.apply;
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    // FOR UPDATE nur im --apply-Modus noetig (verhindert einen verlorenen
    // Schreibvorgang, falls waehrend des Wipes parallel jemand dieselbe
    // Woche speichert); im Trockenlauf wird ohnehin nichts geschrieben.
    await client.query('BEGIN');
    const { rows: weeks } = await client.query(
      dryRun
        ? `SELECT id, household_id, week_start, data FROM weeks ORDER BY household_id, week_start`
        : `SELECT id, household_id, week_start, data FROM weeks ORDER BY household_id, week_start FOR UPDATE`
    );

    let weeksChanged = 0;
    let cellsWiped = 0;
    const householdsAffected = new Set();

    for (const week of weeks) {
      const { data: newData, changed, filled } = wipeWeekData(week.data);
      if (!changed) continue;
      weeksChanged++;
      cellsWiped += filled;
      householdsAffected.add(week.household_id);
      console.log(
        `${dryRun ? '[Trockenlauf] wuerde zuruecksetzen' : 'setze zurueck'}: ` +
        `household_id=${week.household_id} week_start=${week.week_start.toISOString().slice(0, 10)} ` +
        `(${filled} befuellte Zelle(n))`
      );
      if (!dryRun) {
        await client.query('UPDATE weeks SET data = $1, updated_at = now() WHERE id = $2', [newData, week.id]);
      }
    }

    if (dryRun) {
      await client.query('ROLLBACK');
    } else {
      await client.query('COMMIT');
    }

    console.log('');
    console.log(
      `${dryRun ? 'Trockenlauf abgeschlossen' : 'Wipe abgeschlossen'}: ` +
      `${weeksChanged} von ${weeks.length} Wochen betroffen, ` +
      `${householdsAffected.size} Haushalt(e), ${cellsWiped} befuellte Zelle(n) insgesamt.`
    );
    if (dryRun && weeksChanged > 0) {
      console.log('Kein Datensatz wurde veraendert (Trockenlauf). Mit --apply tatsaechlich ausfuehren.');
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Fehler beim Wipe:', err.message);
    process.exit(1);
  } finally {
    await client.end();
  }
}

main().catch(err => {
  console.error('Unerwarteter Fehler:', err.message);
  process.exit(1);
});
