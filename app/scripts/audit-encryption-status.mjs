#!/usr/bin/env node
/* ============================================================================
 * audit-encryption-status.mjs
 *
 * AP2.4 (projects/wochenplaner-termine-verschluesselung/plan.md): rein LESENDES
 * Audit-Werkzeug fuer den Rollout-Fortschritt der Termin-Verschluesselung.
 * Kein serverseitiges Verschluesselungs-Skript ist moeglich (ap1.2-datenmodell.md
 * Abschnitt 4.1) -- der Haushalts-Schluessel liegt architekturbedingt NIE
 * serverseitig vor, auch nicht kurzzeitig im Skriptprozess. Dieses Skript
 * schreibt daher an KEINER Stelle irgendetwas -- es zaehlt und listet nur.
 *
 * Rollenwahl: DATABASE_URL (Owner-/Migrator-Rolle), analog zu export-tenant.mjs/
 * wipe-meal-freetext.mjs -- ein Audit ueber ALLE Haushalte hinweg ist kein
 * einzelner household_id-Kontext, den die eingeschraenkte Laufzeitrolle
 * wochenplan_app (RLS) sinnvoll abdecken koennte.
 *
 * Was wird gezaehlt (je Haushalt):
 *   - encryption_status (plaintext | activating | active)
 *   - Mitgliederzahl (users) vs. Anzahl aktiver password-Wraps
 *     (household_key_wraps) -- bei 'activating' zeigt die Differenz, wie viele
 *     Mitglieder noch ausstehen (siehe AP2.3, /api/crypto/activate)
 *   - Anzahl noch unverschluesselter (data IS NOT NULL) vs. bereits
 *     verschluesselter (data_ciphertext IS NOT NULL) weeks-Zeilen
 *
 * Aufruf (innerhalb des laufenden app-Containers bzw. gegen eine Test-Instanz
 * mit passender DATABASE_URL):
 *   docker compose exec app node scripts/audit-encryption-status.mjs
 *   docker compose exec app node scripts/audit-encryption-status.mjs --only-pending   (nur Haushalte mit verbleibendem Klartext-Bestand)
 *   docker compose exec app node scripts/audit-encryption-status.mjs --json           (maschinenlesbare Ausgabe)
 * ============================================================================ */

import pg from 'pg';

const DATABASE_URL = process.env.DATABASE_URL;

function parseArgs(argv) {
  const args = {};
  for (const token of argv) {
    if (token === '--help' || token === '-h') { args.help = true; continue; }
    if (token === '--only-pending') { args.onlyPending = true; continue; }
    if (token === '--json') { args.json = true; continue; }
  }
  return args;
}

function printUsage() {
  console.error(`
Verwendung:
  node scripts/audit-encryption-status.mjs                Vollstaendiger Bericht ueber alle Haushalte
  node scripts/audit-encryption-status.mjs --only-pending  Nur Haushalte mit noch verbleibendem Klartext-Bestand
                                                            oder unvollstaendiger Mitglieder-Aktivierung
  node scripts/audit-encryption-status.mjs --json          Maschinenlesbare JSON-Ausgabe statt Tabellentext

Rein lesend -- fuehrt NIE eine Schreiboperation aus, verschluesselt nichts
(das kann serverseitig architekturbedingt nicht geschehen, siehe Dateikopf).

Voraussetzung: Umgebungsvariable DATABASE_URL (Owner-/Migrator-Rolle) muss
gesetzt sein -- im Docker-Compose-Stack bereits der Fall.
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { printUsage(); process.exit(0); }

  if (!DATABASE_URL) {
    console.error('Fehler: Umgebungsvariable DATABASE_URL fehlt. Dieses Skript muss mit der ' +
      'Owner-/Migrator-Rolle laufen (siehe docker-compose.yml).');
    process.exit(1);
  }

  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    // Rein lesend -- kein BEGIN/COMMIT noetig, eine einzelne konsistente Momentaufnahme reicht
    // fuer ein Audit-Werkzeug (kein FOR UPDATE, keine Sperren auf fremden Zeilen).
    const { rows } = await client.query(`
      SELECT
        h.id AS household_id,
        h.name AS household_name,
        h.encryption_status,
        (SELECT count(*) FROM users u WHERE u.household_id = h.id) AS member_count,
        (SELECT count(*) FROM household_key_wraps w
          WHERE w.household_id = h.id AND w.wrap_type = 'password' AND w.revoked_at IS NULL) AS password_wrap_count,
        (SELECT count(*) FROM household_key_wraps w
          WHERE w.household_id = h.id AND w.wrap_type = 'pending' AND w.revoked_at IS NULL) AS pending_wrap_count,
        (SELECT count(*) FROM household_key_wraps w
          WHERE w.household_id = h.id AND w.wrap_type = 'recovery_code' AND w.revoked_at IS NULL) AS recovery_wrap_count,
        (SELECT count(*) FROM weeks wk WHERE wk.household_id = h.id AND wk.data IS NOT NULL) AS plaintext_weeks,
        (SELECT count(*) FROM weeks wk WHERE wk.household_id = h.id AND wk.data_ciphertext IS NOT NULL) AS encrypted_weeks
      FROM households h
      ORDER BY h.id
    `);

    const report = rows.map(r => ({
      householdId: Number(r.household_id),
      householdName: r.household_name,
      encryptionStatus: r.encryption_status,
      memberCount: Number(r.member_count),
      passwordWrapCount: Number(r.password_wrap_count),
      pendingWrapCount: Number(r.pending_wrap_count),
      recoveryWrapPresent: Number(r.recovery_wrap_count) > 0,
      plaintextWeeks: Number(r.plaintext_weeks),
      encryptedWeeks: Number(r.encrypted_weeks),
      // "pending" im Sinn dieses Audits: es gibt noch etwas zu tun (Restklartext ODER noch nicht
      // durchgaengige Mitglieder-Aktivierung) -- rein informativ, keine DB-Bedeutung.
      needsAttention:
        Number(r.plaintext_weeks) > 0 ||
        (r.encryption_status !== 'plaintext' && Number(r.member_count) > Number(r.password_wrap_count))
    }));

    const filtered = args.onlyPending ? report.filter(r => r.needsAttention) : report;

    if (args.json) {
      console.log(JSON.stringify({
        generatedAt: new Date().toISOString(),
        totalHouseholds: report.length,
        households: filtered
      }, null, 2));
      return;
    }

    console.log(`Verschluesselungs-Rollout-Audit -- ${new Date().toLocaleString('de-DE')}`);
    console.log(`${report.length} Haushalt(e) insgesamt` + (args.onlyPending ? `, ${filtered.length} mit offenem Handlungsbedarf:` : ':'));
    console.log('');

    for (const r of filtered) {
      const statusLabel = { plaintext: 'Klartext (noch nicht begonnen)', activating: 'Aktivierung laeuft', active: 'Vollstaendig aktiv' }[r.encryptionStatus] || r.encryptionStatus;
      console.log(`Haushalt #${r.householdId} "${r.householdName}"`);
      console.log(`  Status:            ${r.encryptionStatus} (${statusLabel})`);
      console.log(`  Mitglieder:        ${r.memberCount}`);
      console.log(`  password-Wraps:    ${r.passwordWrapCount} von ${r.memberCount} Mitgliedern`);
      if (r.pendingWrapCount > 0) console.log(`  pending-Wraps:     ${r.pendingWrapCount} (warten auf Aktivierung durch das jeweilige Mitglied)`);
      console.log(`  Wiederherstellungscode: ${r.recoveryWrapPresent ? 'vorhanden' : 'FEHLT'}`);
      console.log(`  Wochen:            ${r.encryptedWeeks} verschluesselt, ${r.plaintextWeeks} noch im Klartext`);
      if (r.needsAttention) console.log('  -> Handlungsbedarf: ' + (r.plaintextWeeks > 0 ? 'Klartext-Bestand vorhanden (Sweep noch nicht abgeschlossen). ' : '') +
        (r.encryptionStatus !== 'plaintext' && r.memberCount > r.passwordWrapCount ? 'Nicht alle Mitglieder aktiviert.' : ''));
      console.log('');
    }

    const totals = report.reduce((acc, r) => {
      acc.plaintextWeeks += r.plaintextWeeks;
      acc.encryptedWeeks += r.encryptedWeeks;
      if (r.encryptionStatus === 'plaintext') acc.plaintextHouseholds++;
      else if (r.encryptionStatus === 'activating') acc.activatingHouseholds++;
      else acc.activeHouseholds++;
      return acc;
    }, { plaintextWeeks: 0, encryptedWeeks: 0, plaintextHouseholds: 0, activatingHouseholds: 0, activeHouseholds: 0 });

    console.log('Zusammenfassung:');
    console.log(`  Haushalte: ${totals.plaintextHouseholds} plaintext, ${totals.activatingHouseholds} activating, ${totals.activeHouseholds} active`);
    console.log(`  Wochen insgesamt: ${totals.encryptedWeeks} verschluesselt, ${totals.plaintextWeeks} noch im Klartext`);
  } finally {
    await client.end();
  }
}

main().catch(err => {
  console.error('Unerwarteter Fehler:', err.message);
  process.exit(1);
});
