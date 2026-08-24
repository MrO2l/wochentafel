-- ============================================================================
-- 002_multi_tenant_foundation.sql
--
-- ENTWURF / VORLAGE für A3CH — MORROW, AP1.1 (Wochenplaner-Mandantenfähigkeit)
-- Nicht ungeprüft übernehmen: Dateiname/Ablageort im App-Repo
-- (apps/wochenplaner/app/migrations/) sowie das Setzen
-- des Passworts für wochenplan_app entscheidet A3CH/ART3MIS.
--
-- Setzt additiv auf 001_init.sql auf. Ändert keine bestehende Spalte, keinen
-- bestehenden Typ, kein bestehendes Constraint — läuft unverändert über den
-- bestehenden migrate()-Mechanismus in server.js (BEGIN…COMMIT je Datei,
-- Ausführung durch die heutige Owner-/Migrator-Rolle).
--
-- Zweck:
--   1. Provenienz-Metadaten für konsolidierte Bestandsdaten (nullable,
--      additiv) — Grundlage für die Konsolidierungs-Vorlage
--      (ap1.1-konsolidierungs-vorlage.sql).
--   2. Eingeschränkte Laufzeit-Rolle 'wochenplan_app' anlegen — reine
--      Grundlage für AP1.2 (RLS-Policies, Owner-Bypass-Vermeidung gemäß
--      isolationsstrategie-ap0.1.md Abschnitt 8.1). Legt AUSDRÜCKLICH NOCH
--      KEINE RLS-Policies und KEIN ENABLE ROW LEVEL SECURITY an — das ist
--      Gegenstand von AP1.2, nicht dieser Migration.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Provenienz-Metadaten (optional, nullable, additiv)
--    Für organisch auf der Shared-DB angelegte Haushalte bleiben beide
--    Spalten NULL. server.js verwendet ausschließlich explizite Spaltenlisten
--    (kein SELECT/INSERT *, geprüft) — diese Spalten sind daher für den
--    bestehenden Anwendungscode unsichtbar und risikofrei additiv.
-- ----------------------------------------------------------------------------
ALTER TABLE households
  ADD COLUMN IF NOT EXISTS migrated_from_instance text,
  ADD COLUMN IF NOT EXISTS migrated_at             timestamptz;

COMMENT ON COLUMN households.migrated_from_instance IS
  'Bezeichner der urspruenglichen Ein-Kunde-Instanz, falls dieser Haushalt im '
  'Zuge der Konsolidierung (AP1.1) aus einer separaten Alt-Instanz uebernommen '
  'wurde. NULL bei organisch auf der Shared-DB angelegten Haushalten.';
COMMENT ON COLUMN households.migrated_at IS
  'Zeitpunkt der Konsolidierung in die Shared-DB, falls zutreffend. NULL bei '
  'organisch angelegten Haushalten.';

-- ----------------------------------------------------------------------------
-- 2. Eingeschränkte Laufzeit-Rolle 'wochenplan_app' (Grundlage für AP1.2)
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'wochenplan_app') THEN
    CREATE ROLE wochenplan_app
      LOGIN
      NOSUPERUSER
      NOCREATEDB
      NOCREATEROLE
      NOREPLICATION
      NOBYPASSRLS
      NOINHERIT;
    -- Bewusst KEINE PASSWORD-Klausel: das Passwort ist ein Secret und gehört
    -- nicht in eine versionierte SQL-Datei. Siehe Begleitdokument
    -- ap1.1-datenmodell-migration.md, Abschnitt "Infrastruktur-Bedarf" —
    -- ART3MIS/A3CH setzen es außerhalb dieser Migration per
    -- ALTER ROLE wochenplan_app WITH PASSWORD '<aus Secret/ENV>';
  END IF;
END
$$;

-- Schema-Zugriff
GRANT USAGE ON SCHEMA public TO wochenplan_app;

-- Fachliche Tabellen inkl. Sessionspeicher (connect-pg-simple läuft künftig
-- ebenfalls über diese Rolle, sobald AP2.2 den Laufzeit-Pool umstellt).
GRANT SELECT, INSERT, UPDATE, DELETE
  ON households, users, weeks, invites, session
  TO wochenplan_app;

-- bigserial-Spalten brauchen nextval()-Rechte auf die zugehörigen Sequenzen.
GRANT USAGE, SELECT ON SEQUENCE households_id_seq, users_id_seq, weeks_id_seq
  TO wochenplan_app;

-- schema_migrations bewusst NICHT freigegeben — Migrationsbuchführung bleibt
-- exklusiv der Migrator-/Owner-Rolle vorbehalten (führt migrate() aus).

-- Vorsorge für künftige additive Tabellen/Sequenzen (z. B. spätere AP1.2/AP3.x
-- Migrationen durch dieselbe Migrator-Rolle), damit wochenplan_app nicht bei
-- jeder neuen Tabelle erneut manuell berechtigt werden muss.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO wochenplan_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO wochenplan_app;

-- ----------------------------------------------------------------------------
-- Explizit NICHT Teil dieser Migration (folgt in AP1.2, siehe
-- isolationsstrategie-ap0.1.md Abschnitt 8.3 und ap1.1-datenmodell-
-- migration.md):
--   ALTER TABLE households/users/weeks ENABLE ROW LEVEL SECURITY;
--   CREATE POLICY household_isolation ON ...
--   Umstellung des Laufzeit-Pools in server.js auf wochenplan_app;
--   SET LOCAL app.current_household_id — Transaktionshelfer (withTenantClient);
--   ALTER TABLE ... OWNER TO — bewusst NICHT ausgeführt: wochenplan_app bleibt
--     Nicht-Eigentümerin, sonst Owner-Bypass sobald RLS in AP1.2 aktiviert wird.
-- ----------------------------------------------------------------------------
