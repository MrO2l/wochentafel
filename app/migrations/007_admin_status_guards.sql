-- ============================================================================
-- 007_admin_status_guards.sql
--
-- A3CH, Wochenplaner-Admin-Bereich -- Fix fuer ZANDORs Fund A1 aus dem
-- AP5.1-Abschluss-Review (nicht-blockierend, vom Nutzer aber zur Behebung
-- gewuenscht).
--
-- Befund: admin_deactivate_household() (005/006) setzte status='deactivated',
-- liess deleted_at aber unangetastet. Angewendet auf einen bereits
-- status='deleted'-Haushalt verletzte das Ergebnis
-- households_deleted_at_consistency_check (status='deleted' <=> deleted_at
-- IS NOT NULL, siehe 005 Abschnitt 2.3) -- Postgres brach mit
-- 'check_violation' (SQLSTATE 23514) ab, server.js liess das mangels
-- gezielter Behandlung im generischen 500-Handler landen statt einer
-- sauberen 4xx-Antwort.
--
-- Verwandtes Problem (dieselbe Ursachenklasse: keine der drei
-- Statuswechsel-Funktionen prueft, ob der Zielstatus bereits erreicht ist):
-- ein wiederholter admin_soft_delete_household()-Aufruf auf einem bereits
-- geloeschten Haushalt setzte deleted_at erneut auf now() -- verlaengerte
-- damit STILLSCHWEIGEND die F3-Aufbewahrungsfrist, ohne dass ein
-- tatsaechlicher Statuswechsel stattfand.
--
-- Fix (ZANDORs Empfehlung, beide Teile):
--   1. admin_deactivate_household() setzt deleted_at=NULL, analog zu
--      admin_reactivate_household() -- eine Deaktivierung eines
--      bislang gelöschten Haushalts ist damit constraint-konform moeglich
--      (Uebergang deleted -> deactivated, technisch dieselbe Legitimation
--      wie der bereits bestehende Uebergang deleted -> active in
--      admin_reactivate_household()).
--   2. State-Transition-Guard in ALLEN DREI Funktionen: ist der Haushalt
--      bereits im Zielstatus, wird die Funktion NICHT stillschweigend
--      erneut ausgefuehrt (kein erneutes now() auf status_changed_at/
--      deleted_at, kein zusaetzlicher Audit-Log-Eintrag), sondern bricht
--      mit einem eigenen, klar unterscheidbaren SQLSTATE ('ADM01') ab.
--      server.js (siehe dortige Aenderung) mappt genau diesen Code auf
--      HTTP 409 Conflict -- unterscheidbar sowohl vom 404 (Haushalt
--      existiert nicht, SQLSTATE 'no_data_found'/P0002, unveraendert) als
--      auch vom generischen 500 (unerwarteter Fehler).
--
--      SQLSTATE 'ADM01': fuenfstelliger, selbst gewaehlter Code (Postgres
--      validiert bei RAISE ... USING ERRCODE nur das Format, keine
--      Registrierung). Klassen-Praefix 'AD' kollidiert nicht mit einer der
--      vom SQL-Standard/Postgres bereits vergebenen Fehlerklassen (u. a.
--      00,01,02,03,08,09,0A,0B,0F,0L,0P,0Z,20-28,2B,2D,2F,34,38,39,3B,3D,
--      3F,40,42,44,53,54,55,57,58,72,F0,HV,P0,XX) -- bewusst NICHT die
--      generische 'P0001' (raise_exception) verwendet, damit server.js den
--      Konfliktfall gezielt und eindeutig von einem sonstigen
--      RAISE EXCEPTION unterscheiden kann.
--
-- Additiv, setzt auf 001_init.sql–006_admin_audit_log.sql auf. Aendert kein
-- bestehendes Schema-Element ausser den drei Statuswechsel-Funktionen
-- (CREATE OR REPLACE FUNCTION, identische Signatur/Rueckgabetyp wie in 005/
-- 006 -- bestehende GRANTs bleiben erhalten, siehe Begruendung in 006
-- Abschnitt 3). Laeuft ueber den bestehenden migrate()-Mechanismus.
-- ============================================================================

CREATE OR REPLACE FUNCTION admin_deactivate_household(p_household_id bigint, p_admin_id bigint)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_old_status text;
BEGIN
  SELECT status INTO v_old_status FROM households WHERE id = p_household_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'household % not found', p_household_id USING ERRCODE = 'no_data_found';
  END IF;

  -- State-Transition-Guard (Fund A1, Teil 2): bereits deaktiviert -> Konflikt
  -- statt stillschweigendem No-Op-Update (das ohnehin nur status_changed_at/
  -- _by unveraendert lassend "erneuert" haette, ohne fachlichen Mehrwert).
  IF v_old_status = 'deactivated' THEN
    RAISE EXCEPTION 'household % is already deactivated', p_household_id USING ERRCODE = 'ADM01';
  END IF;

  UPDATE households
     SET status = 'deactivated',
         status_reason = 'admin_manual',
         status_changed_at = now(),
         status_changed_by = p_admin_id,
         -- Fund A1, Teil 1: deleted_at explizit zuruecksetzen, sonst
         -- verletzt eine Deaktivierung aus status='deleted' heraus den
         -- households_deleted_at_consistency_check (status='deleted' <=>
         -- deleted_at IS NOT NULL). Analog zu admin_reactivate_household(),
         -- das denselben Uebergang (deleted -> active) bereits unterstuetzt.
         deleted_at = NULL
   WHERE id = p_household_id;

  INSERT INTO admin_audit_log(event_type, admin_id, household_id, old_status, new_status)
    VALUES ('household_deactivated', p_admin_id, p_household_id, v_old_status, 'deactivated');
END;
$$;

CREATE OR REPLACE FUNCTION admin_reactivate_household(p_household_id bigint, p_admin_id bigint)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_old_status text;
BEGIN
  SELECT status INTO v_old_status FROM households WHERE id = p_household_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'household % not found', p_household_id USING ERRCODE = 'no_data_found';
  END IF;

  IF v_old_status = 'active' THEN
    RAISE EXCEPTION 'household % is already active', p_household_id USING ERRCODE = 'ADM01';
  END IF;

  UPDATE households
     SET status = 'active',
         status_reason = NULL,
         status_changed_at = now(),
         status_changed_by = p_admin_id,
         deleted_at = NULL
   WHERE id = p_household_id;

  INSERT INTO admin_audit_log(event_type, admin_id, household_id, old_status, new_status)
    VALUES ('household_reactivated', p_admin_id, p_household_id, v_old_status, 'active');
END;
$$;

CREATE OR REPLACE FUNCTION admin_soft_delete_household(p_household_id bigint, p_admin_id bigint)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_old_status text;
BEGIN
  SELECT status INTO v_old_status FROM households WHERE id = p_household_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'household % not found', p_household_id USING ERRCODE = 'no_data_found';
  END IF;

  -- State-Transition-Guard (Fund A1, Kernfall): ohne diesen Guard wuerde ein
  -- wiederholter Aufruf auf einem bereits geloeschten Haushalt deleted_at
  -- erneut auf now() setzen -- stillschweigende Verlaengerung der
  -- F3-Aufbewahrungsfrist ohne echten Statuswechsel. Stattdessen: Konflikt,
  -- deleted_at bleibt unveraendert.
  IF v_old_status = 'deleted' THEN
    RAISE EXCEPTION 'household % is already deleted', p_household_id USING ERRCODE = 'ADM01';
  END IF;

  UPDATE households
     SET status = 'deleted',
         status_reason = 'admin_manual',
         status_changed_at = now(),
         status_changed_by = p_admin_id,
         deleted_at = now()
   WHERE id = p_household_id;

  INSERT INTO admin_audit_log(event_type, admin_id, household_id, old_status, new_status)
    VALUES ('household_deleted', p_admin_id, p_household_id, v_old_status, 'deleted');
END;
$$;

REVOKE ALL ON FUNCTION admin_deactivate_household(bigint, bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION admin_reactivate_household(bigint, bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION admin_soft_delete_household(bigint, bigint) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION admin_deactivate_household(bigint, bigint) TO wochenplan_app;
GRANT EXECUTE ON FUNCTION admin_reactivate_household(bigint, bigint) TO wochenplan_app;
GRANT EXECUTE ON FUNCTION admin_soft_delete_household(bigint, bigint) TO wochenplan_app;

-- ----------------------------------------------------------------------------
-- Bewusst NICHT Teil dieses Fixes: ein Guard fuer den Fall "Deaktivierung
-- eines bereits geloeschten Haushalts" (deleted -> deactivated) wird HIER
-- NICHT blockiert, sondern -- wie in Fund A1, Teil 1 vorgesehen -- technisch
-- ermoeglicht (deleted_at wird zurueckgesetzt). Das ist keine Ausweitung
-- gegenueber dem bereits bestehenden, unveraendert uebernommenen Verhalten
-- von admin_reactivate_household() (das denselben deleted-Ausgangsstatus
-- ebenfalls akzeptiert, siehe 005/006) -- lediglich konsistent auf die
-- zweite Statuswechsel-Funktion uebertragen, die einen Nicht-active-
-- Zielstatus setzt.
-- ============================================================================
