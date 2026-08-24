-- ============================================================================
-- 003_rls_policies.sql
--
-- ENTWURF / VORLAGE für A3CH — MORROW, AP1.2 (Wochenplaner-Mandantenfähigkeit)
-- Nicht ungeprüft übernehmen: Dateiname/Ablageort im App-Repo
-- (apps/wochenplaner/app/migrations/) entscheidet A3CH.
--
-- Setzt auf 002_multi_tenant_foundation.sql auf (Rolle 'wochenplan_app'
-- existiert bereits, ist NICHT Tabelleneigentümerin). Läuft über den
-- bestehenden migrate()-Mechanismus, ausgeführt durch die Migrator-/
-- Owner-Rolle (dieselbe Rolle, die auch 001/002 ausgeführt hat).
--
-- WICHTIG (Reihenfolge im Betrieb, siehe Begleitdokument
-- ap1.2-rls-konzept.md Abschnitt 9 "Für A3CH"): Diese Migration allein
-- ändert NICHTS am Laufzeitverhalten, solange server.js weiterhin über die
-- Owner-Rolle verbindet (Owner-Bypass, siehe 002-Datei). Sie wird erst
-- wirksam, sobald der Laufzeit-Pool auf 'wochenplan_app' umgestellt ist
-- (AP2.2) UND der SET-Kontext (set_config, siehe unten) von jeder Anfrage
-- gesetzt wird. Bis dahin ist das Anwenden dieser Migration risikoarm
-- (RLS ist aktiv, aber die einzige verbindende Rolle bis AP2.2 ist weiterhin
-- der Owner und damit von RLS ausgenommen).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. users, weeks: klassischer household_id-Fremdschlüssel, EINE Policy pro
--    Tabelle für ALLE Befehle (SELECT/INSERT/UPDATE/DELETE) ausreichend, weil
--    der Sitzungskontext in allen Schreibpfaden bereits VOR dem jeweiligen
--    INSERT/UPDATE gesetzt ist (siehe ap1.2-rls-konzept.md Abschnitt 5/6).
-- ----------------------------------------------------------------------------
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
CREATE POLICY household_isolation ON users
  USING       (household_id = current_setting('app.current_household_id', true)::bigint)
  WITH CHECK  (household_id = current_setting('app.current_household_id', true)::bigint);

ALTER TABLE weeks ENABLE ROW LEVEL SECURITY;
CREATE POLICY household_isolation ON weeks
  USING       (household_id = current_setting('app.current_household_id', true)::bigint)
  WITH CHECK  (household_id = current_setting('app.current_household_id', true)::bigint);

-- Bewusst KEIN FORCE ROW LEVEL SECURITY: die Migrator-/Owner-Rolle bleibt
-- unrestriktiert (Tabelleneigentümerin, für migrate() und die Konsolidierungs-
-- Vorlage ap1.1-konsolidierungs-vorlage.sql weiterhin ohne RLS-Einschränkung
-- nötig, siehe ap1.2-rls-konzept.md Abschnitt 8). wochenplan_app ist NICHT
-- Eigentümerin, daher greift RLS für sie auch ohne FORCE automatisch.

-- ----------------------------------------------------------------------------
-- 2. households: id IST der Mandantenschlüssel. ANDERS als users/weeks braucht
--    diese Tabelle getrennte Policies je Befehl, weil die Neuanlage (INSERT)
--    strukturell VOR jeder Kenntnis der neuen id passiert (Henne-Ei-Problem
--    bei der Registrierung, siehe ap1.2-rls-konzept.md Abschnitt 6). Eine
--    einzelne FOR-ALL-Policy mit USING (id = current_setting(...)) würde ohne
--    explizites WITH CHECK automatisch dieselbe Bedingung auch für INSERT
--    verwenden (Postgres-Default) und jede Haushalts-Neuanlage blockieren.
-- ----------------------------------------------------------------------------
ALTER TABLE households ENABLE ROW LEVEL SECURITY;

CREATE POLICY household_isolation_select ON households
  FOR SELECT
  USING (id = current_setting('app.current_household_id', true)::bigint);

CREATE POLICY household_isolation_update ON households
  FOR UPDATE
  USING       (id = current_setting('app.current_household_id', true)::bigint)
  WITH CHECK  (id = current_setting('app.current_household_id', true)::bigint);

CREATE POLICY household_isolation_delete ON households
  FOR DELETE
  USING (id = current_setting('app.current_household_id', true)::bigint);

-- Neuanlage bewusst permissiv: WITH CHECK (true) erlaubt jedes INSERT.
-- Das erzeugt KEINEN Cross-Tenant-Lesezugriff (ein INSERT legt nur eine neue,
-- bislang niemandem zugeordnete Zeile an, kein Bestandsdatensatz wird
-- offengelegt) und entspricht dem heutigen, bereits öffentlich erreichbaren
-- Registrierungsverhalten (ALLOW_REGISTRATION + Rate-Limit auf Anwendungs-
-- ebene bleiben die eigentliche Zugriffskontrolle für "wer darf einen neuen
-- Haushalt anlegen").
CREATE POLICY household_creation ON households
  FOR INSERT
  WITH CHECK (true);

-- ----------------------------------------------------------------------------
-- 3. invites, session: BEWUSST KEINE RLS (Ausnahme, siehe
--    ap1.2-rls-konzept.md Abschnitt 7 bzw. isolationsstrategie-ap0.1.md
--    Abschnitt 8.4). invites bleibt token-/code-basiert app-seitig gefiltert
--    (Einladungscode = Berechtigungsnachweis, kein Sitzungskontext zum
--    Einlösezeitpunkt vorhanden). session hat keine household_id-Spalte.
--    Kein ALTER TABLE ... ENABLE ROW LEVEL SECURITY für diese beiden Tabellen.
-- ----------------------------------------------------------------------------

-- ----------------------------------------------------------------------------
-- 4. Login-Sonderfall: SECURITY DEFINER-Funktion für den Credential-Lookup
--    per E-Mail VOR Etablierung eines Sitzungskontexts.
--
--    users_email_uidx ist ein GLOBALER UNIQUE-Index (ap1.1-datenmodell-
--    migration.md Abschnitt 4.1) — der Login-Lookup muss also zwangsläufig
--    haushaltsübergreifend nach der E-Mail suchen können, BEVOR bekannt ist,
--    zu welchem Haushalt der Nutzer gehört. Mit aktiver RLS auf 'users' und
--    'households' würde die bisherige Klartext-Query
--      SELECT ... FROM users u JOIN households h ON h.id=u.household_id
--       WHERE lower(u.email)=$1
--    über die eingeschränkte Rolle 'wochenplan_app' IMMER 0 Zeilen liefern
--    (current_setting('app.current_household_id', true) ist zu diesem
--    Zeitpunkt NULL → household_id = NULL ist stets unbekannt/false) — Login
--    wäre für alle Nutzer gebrochen. Das ist in isolationsstrategie-ap0.1.md
--    Abschnitt 8.5 NICHT behandelt (dort nur die Registrierung) — neu
--    identifizierte Lücke, siehe ap1.2-rls-konzept.md Abschnitt 6.
--
--    Lösung: eine schmale, parametrisierte SECURITY DEFINER-Funktion, die
--    mit den Rechten der Migrator-/Owner-Rolle (Tabelleneigentümerin, RLS-
--    Bypass) läuft, aber ausschließlich genau diese eine Abfrage kapselt.
--    wochenplan_app erhält NUR EXECUTE auf diese Funktion, KEINEN generellen
--    Lese-Bypass auf die Tabellen selbst.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION auth_lookup_by_email(p_email text)
RETURNS TABLE (
  id             bigint,
  name           text,
  email          text,
  role           text,
  password_hash  text,
  household_id   bigint,
  household_name text
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT u.id, u.name, u.email, u.role, u.password_hash, u.household_id, h.name
    FROM users u
    JOIN households h ON h.id = u.household_id
   WHERE lower(u.email) = lower(p_email)
$$;

-- search_path fest auf pg_catalog, public gepinnt (Standard-Härtung für
-- SECURITY DEFINER-Funktionen: verhindert, dass ein aufrufender Client über
-- einen manipulierten search_path eine gleichnamige Schattenfunktion/-tabelle
-- unterschieben könnte).

REVOKE ALL ON FUNCTION auth_lookup_by_email(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_lookup_by_email(text) TO wochenplan_app;

-- Eigentümerschaft der Funktion liegt automatisch bei der ausführenden
-- Migrator-/Owner-Rolle (führt diese Migration aus) — dadurch bypassed die
-- Funktion RLS beim Ausführen, ohne dass wochenplan_app selbst
-- Eigentümerin irgendeiner Tabelle wird oder BYPASSRLS erhält.

-- ----------------------------------------------------------------------------
-- Explizit NICHT Teil dieser Migration (Umsetzung folgt in AP2.2):
--   Umstellung des Laufzeit-Pools in server.js auf wochenplan_app;
--   Aufteilung in migratorPool (nur migrate()) / appPool (Laufzeitverkehr);
--   withTenantClient-Helfer und Umstellung der betroffenen Endpunkte;
--   Login-Handler auf auth_lookup_by_email() umstellen;
--   Registrierungs-Handler um set_config(...)-Aufruf nach Haushalts-
--   bestimmung ergänzen (siehe ap1.2-rls-konzept.md Abschnitt 5).
-- ----------------------------------------------------------------------------
