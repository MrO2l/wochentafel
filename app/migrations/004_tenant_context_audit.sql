-- ============================================================================
-- 004_tenant_context_audit.sql
--
-- AP3.3 (Ressourcen-Grundschutz, ART3MIS) -- Monitoring/Alerting-Grundlage fuer
-- auffaellige household_id-Zugriffsmuster, siehe projects/wochenplaner-
-- mandantenfaehigkeit/ap3.3-ressourcen-grundschutz.md Abschnitt 3.
--
-- Additiv, setzt auf 002/003 auf. Aendert kein bestehendes Schema-Element.
-- Laeuft ueber den bestehenden migrate()-Mechanismus in server.js (Owner-/
-- Migrator-Rolle).
--
-- Zweck: pg_stat_statements erfasst Abfrage-FORMEN (mit $1/$2-Platzhaltern),
-- aber keine tatsaechlichen Parameterwerte -- damit laesst sich "wie oft lief
-- diese Art Abfrage" beobachten, aber nicht "welche household_id-Werte hat
-- eine konkrete DB-Verbindung tatsaechlich gesehen". Fuer genau diese Frage
-- (das im Plan geforderte Alert-Kriterium) legt diese Migration ein minimales
-- Audit-Log an: jeder Aufruf der Tenant-Kontext-Funktion (bisher: rohes
-- set_config in server.js) schreibt zusaetzlich eine Zeile mit der jeweils
-- gesetzten household_id und der Backend-PID der Verbindung. server.js ruft
-- ab dieser Migration set_tenant_context_audited() statt set_config() direkt
-- auf (ein zentraler Aufrufpunkt, setTenantContext() -- keine Aenderung an
-- den ca. elf einzelnen Endpunkten noetig).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. pg_stat_statements aktivieren (ergaenzend, s. o. -- Abfrage-Formen/
--    Aufrufhaeufigkeiten, kein Ersatz fuer das Audit-Log unten).
--    Voraussetzung: shared_preload_libraries=pg_stat_statements ist beim
--    Postgres-Start gesetzt (docker-compose.yml, db-Service, `command:`) --
--    ohne das schlaegt CREATE EXTENSION fehl. Wird von der Owner-/
--    Migrator-Rolle als Superuser des offiziellen Postgres-Images ausgefuehrt.
-- ----------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;

-- ----------------------------------------------------------------------------
-- 2. Audit-Tabelle fuer Tenant-Kontext-Wechsel
--    Bewusst KEIN Fremdschluessel auf households(id): eine geloeschte
--    household_id soll im Audit-Log nachvollziehbar bleiben (Historie), nicht
--    kaskadierend verschwinden oder das Loeschen eines Haushalts blockieren.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tenant_context_audit (
  id             bigserial PRIMARY KEY,
  backend_pid    integer     NOT NULL,
  household_id   bigint      NOT NULL,
  set_at         timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS tenant_context_audit_pid_time_idx
  ON tenant_context_audit (backend_pid, set_at DESC);

-- Retention: dieses Log waechst mit jeder Transaktion (~ein Eintrag je
-- Tenant-Kontext-Wechsel). Empfehlung: per Cron/pg_cron woechentlich Zeilen
-- aelter als 30 Tage loeschen -- absichtlich NICHT Teil dieser Migration
-- (kein pg_cron in diesem Stack installiert), siehe Betriebs-Hinweis im
-- Hauptdokument (Abschnitt 3.4).

-- Least Privilege: wochenplan_app darf ausschliesslich schreiben (INSERT),
-- nicht lesen/aendern/loeschen -- ein kompromittierter App-Kontext koennte
-- damit zwar zusaetzliche (falsche) Zeilen einfuegen, aber weder die eigene
-- Spur verwischen noch fremde Eintraege einsehen. ALTER DEFAULT PRIVILEGES
-- aus 002_multi_tenant_foundation.sql hat beim CREATE TABLE oben automatisch
-- SELECT/INSERT/UPDATE/DELETE vergeben -- hier bewusst auf INSERT reduziert.
REVOKE SELECT, UPDATE, DELETE ON tenant_context_audit FROM wochenplan_app;
GRANT INSERT ON tenant_context_audit TO wochenplan_app;
GRANT USAGE ON SEQUENCE tenant_context_audit_id_seq TO wochenplan_app;

-- ----------------------------------------------------------------------------
-- 3. Audited-Set-Config-Funktion
--    SECURITY DEFINER (laeuft mit den Rechten der Owner-/Migrator-Rolle, die
--    die Funktion angelegt hat), damit wochenplan_app in die Audit-Tabelle
--    schreiben kann, ohne selbst SELECT/UPDATE/DELETE-Rechte darauf zu
--    brauchen -- gleiches, bereits etabliertes Muster wie
--    auth_lookup_by_email() aus 003_rls_policies.sql. search_path wird aus
--    demselben Grund wie dort fest auf 'public' gesetzt (Haertungshinweis aus
--    AP1.2/AP4.1 gilt hier identisch).
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_tenant_context_audited(p_household_id text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM set_config('app.current_household_id', p_household_id, true);
  INSERT INTO tenant_context_audit(backend_pid, household_id)
    VALUES (pg_backend_pid(), p_household_id::bigint);
END;
$$;

REVOKE ALL ON FUNCTION set_tenant_context_audited(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION set_tenant_context_audited(text) TO wochenplan_app;

-- ----------------------------------------------------------------------------
-- Alert-Abfrage (Referenz -- Beispielimplementierung, siehe Hauptdokument
-- Abschnitt 3 fuer Schwellenwert-Begruendung und Betriebs-Einbindung):
--
--   SELECT backend_pid,
--          count(DISTINCT household_id) AS distinct_households,
--          count(*)                     AS context_switches,
--          min(set_at) AS window_start, max(set_at) AS window_end
--     FROM tenant_context_audit
--    WHERE set_at > now() - interval '2 minutes'
--    GROUP BY backend_pid
--   HAVING count(DISTINCT household_id) > 6
--    ORDER BY distinct_households DESC;
--
-- Wichtige Einschraenkung (siehe Hauptdokument Abschnitt 3.2): backend_pid
-- identifiziert eine gepoolte DB-Verbindung, NICHT eine App-Session/einen
-- Nutzer -- appPool.max=10 Verbindungen werden reihum von allen Mandanten
-- geteilt. Der Schwellenwert 6 ist bewusst deutlich oberhalb der bei
-- heutiger Kundenzahl (marktanalyse.md: niedriger zwei- bis dreistelliger
-- Bereich, abendlastige Nutzung) plausiblen Pool-Rotation gewaehlt.
-- ============================================================================
