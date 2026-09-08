/* ============================================================================
 * lib/email-lookup.mjs
 *
 * AP6.4 (Wochenplaner-Termine-Verschluesselung, MORROW AP6.3-Datenmodell,
 * migrations/011_email_blind_index.sql, Begleitdokument ap6.3-datenmodell.md):
 * einzige, zentrale Stelle, die den E-Mail-Blindindex (users.email_lookup)
 * berechnet und den Boot-/Skript-Backfill dafuer durchfuehrt. server.js
 * (Auth-Endpunkte + Boot-Backfill), scripts/backfill-email-lookup.mjs und
 * scripts/create-tenant.mjs importieren diese eine Implementierung, statt die
 * HMAC-Berechnung/Normalisierung an mehreren Stellen zu duplizieren -- eine
 * abweichende Normalisierung an nur EINER dieser Stellen wuerde dort leise
 * unauffindbare Nutzer erzeugen (der berechnete HMAC passt dann nie zum in
 * der DB gespeicherten Wert).
 *
 * EMAIL_HMAC_KEY wird hier bewusst NICHT selbst aus process.env gelesen,
 * sondern von jedem Aufrufer explizit uebergeben -- haelt dieses Modul frei
 * von Umgebungsvariablen-Zugriff/Prozess-Exit-Verhalten. Jeder Aufrufer
 * prueft/meldet ein fehlendes Secret selbst, mit einer fuer den jeweiligen
 * Kontext passenden Fehlermeldung (server.js bricht den Start ab, ein
 * CLI-Skript druckt eine Nutzungshilfe).
 * ============================================================================ */

import crypto from 'node:crypto';

// Identische Normalisierung wie in Migration 011 dokumentiert (Spaltenkommentar
// users.email_lookup): lower(trim(email)). Zentral hier statt an jeder
// Aufrufstelle einzeln nachgebaut.
export function normalizeEmail(rawEmail) {
  return String(rawEmail || '').trim().toLowerCase();
}

// HMAC-SHA256(normalizedEmail, EMAIL_HMAC_KEY) -- rein serverseitig, NIE in
// der Datenbank abgelegt (siehe Migration 011, Spaltenkommentar). Erwartet
// eine BEREITS normalisierte E-Mail (siehe normalizeEmail() oben) -- ruft
// diese hier bewusst nicht selbst auf, damit ein Aufrufer, der die
// normalisierte E-Mail ohnehin schon fuer einen anderen Zweck braucht (z. B.
// die email-Spalte selbst), sie nicht doppelt normalisieren muss.
export function computeEmailLookup(emailHmacKey, normalizedEmail) {
  return crypto.createHmac('sha256', emailHmacKey).update(normalizedEmail).digest();
}

/* ------------------------------------------------------------------ *
 * Backfill (AP6.4, Begleitdokument Abschnitt 3): fuellt users.email_lookup
 * fuer jeden Bestandsnutzer, bei dem die Spalte noch NULL ist. Serverseitig
 * moeglich, WEIL zu diesem Zeitpunkt users.email noch als Klartext-jsonb-
 * String vorliegt (vor jedem clientseitigen Envelope-Sweep, siehe
 * Begleitdokument Abschnitt 3.1) -- kein Haushalts-Schluessel noetig.
 *
 * query: vom Aufrufer bereitgestellte Funktion (sql, params) => {rows} --
 * server.js uebergibt migratorPool.query (siehe dortiger Kommentar, WARUM
 * migratorPool statt appPool: die RLS-Policy auf users, 003_rls_policies.sql,
 * laesst ueber die eingeschraenkte Laufzeit-Rolle OHNE gesetzten
 * Sitzungskontext keine einzige Zeile sichtbar/aktualisierbar -- fuer einen
 * haushaltsUEBERGREIFENDEN Bulk-Backfill ist daher zwingend die Owner-/
 * Migrator-Rolle (RLS-Bypass) noetig, analog migrate()/ensureAppRolePassword()
 * bzw. dem bestehenden Owner-Rollen-Praezedenzfall in export-tenant.mjs).
 * scripts/backfill-email-lookup.mjs verbindet aus demselben Grund ueber
 * DATABASE_URL (Owner-Rolle), nicht DATABASE_URL_APP.
 *
 * Sicherheitsvorgabe (Begleitdokument Abschnitt 3.3, woertlich umgesetzt):
 * pro Zeile EIGENES try/catch, NUR user_id + generische Fehlerkategorie
 * geloggt (nie err.message/err.detail -- koennte den fehlerhaften Wert
 * zitieren), die Klartext-E-Mail-Variable verlaesst den Schleifenrumpf einer
 * einzelnen Iteration NIE (kein Sammel-Array), --dry-run gibt ausschliesslich
 * Zaehlwerte aus.
 * ------------------------------------------------------------------ */
export async function runEmailLookupBackfill({ query, emailHmacKey, dryRun = false, log = console }) {
  const { rows } = await query('SELECT id, email FROM users WHERE email_lookup IS NULL', []);
  let updated = 0, skipped = 0, failed = 0;

  for (const row of rows) {
    try {
      // users.email ist nach Migration 011 jsonb -- node-postgres liefert den Wert bereits
      // geparst. Ein jsonb-STRING kommt hier als JS-string an (Klartext-Uebergangszustand,
      // Regelfall beim Backfill). Ein jsonb-OBJEKT (bereits ein Ciphertext-Envelope, __enc:true)
      // kann NICHT serverseitig entschluesselt werden (kein Zugriff auf den Haushalts-Schluessel)
      // -- sollte laut Begleitdokument praktisch nie vorkommen (Backfill laeuft vor jedem
      // clientseitigen Sweep), aber als Sicherheitsnetz hier sauber uebersprungen statt eine
      // falsche/kaputte email_lookup zu schreiben.
      if (typeof row.email !== 'string') {
        skipped++;
        log.warn?.(`Email-Lookup-Backfill uebersprungen fuer user_id=${row.id}: email liegt nicht ` +
          'als Klartext-String vor (bereits verschluesselte Anzeige-Kopie?) -- manuelle Pruefung noetig.');
        continue;
      }
      const normalized = normalizeEmail(row.email); // lokale Variable, verlaesst diese Iteration nie
      const lookup = computeEmailLookup(emailHmacKey, normalized);
      if (!dryRun) {
        await query('UPDATE users SET email_lookup=$1 WHERE id=$2', [lookup, row.id]);
      }
      updated++;
    } catch (err) {
      failed++;
      // Bewusst NUR user_id + Fehlercode/-name (Postgres-Fehlercode wie '23505' bei einer
      // unerwarteten Kollision, oder generischer Fehlername) -- niemals err.message/err.detail,
      // die bei manchen Postgres-Fehlern den betroffenen Wert im Klartext zitieren koennten.
      log.error?.(`Email-Lookup-Backfill fehlgeschlagen fuer user_id=${row.id}: ${err.code || err.name || 'unbekannter Fehler'}`);
    }
  }

  const summary = { total: rows.length, updated, skipped, failed };
  log.log?.(
    `${dryRun ? '[dry-run] ' : ''}Email-Lookup-Backfill: ${rows.length} betroffene Zeile(n), ` +
    `${updated} ${dryRun ? 'wuerden aktualisiert' : 'aktualisiert'}, ${skipped} uebersprungen ` +
    `(kein Klartext-String), ${failed} Fehler.`);
  return summary;
}
