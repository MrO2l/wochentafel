-- ============================================================================
-- 006_admin_audit_log.sql
--
-- A3CH, Wochenplaner-Admin-Bereich -- Fund 2 aus ZANDORs Sicherheitsreview
-- (AP2.2, MITTEL): schmales, INSERT-only Audit-Log fuer den Admin-Bereich,
-- analog zum bereits etablierten Muster 004_tenant_context_audit.sql.
--
-- HINWEIS ZUR HERKUNFT (Transparenz, siehe Rueckmeldung an ANORAK): Anders
-- als 005_admin_foundation.sql ist dieses Datenmodell NICHT von MORROW
-- entworfen worden -- ANORAKs Auftrag hat die Feldliste bereits konkret
-- vorgegeben (analog tenant_context_audit, mindestens: Admin-Login-Erfolg/
-- -Fehlschlag mit Zeitstempel+IP, jede Statusaenderung mit admin_id/
-- household_id/altem+neuem Status/Zeitstempel). A3CH hat diese Vorgabe zu
-- konkretem DDL ausgearbeitet, keine eigenstaendige Schema-Neugestaltung.
--
-- Setzt additiv auf 001_init.sql–005_admin_foundation.sql auf. Aendert kein
-- bestehendes Schema-Element ausser den drei Statuswechsel-Funktionen aus
-- 005 (CREATE OR REPLACE FUNCTION mit UNVERAENDERTER Signatur/Rueckgabetyp
-- -- das erhaelt bestehende GRANTs, siehe Abschnitt 3 unten). Laeuft ueber
-- den bestehenden migrate()-Mechanismus (Owner-/Migrator-Rolle).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Audit-Tabelle
--    Bewusst KEIN Fremdschluessel auf households(id) (gleiches Muster wie
--    tenant_context_audit): eine soft- oder (kuenftig, AP3.4) hard-geloeschte
--    household_id soll im Audit-Log nachvollziehbar bleiben, nicht
--    kaskadierend verschwinden. admin_id dagegen referenziert admin_account
--    (ON DELETE SET NULL, gleiches Muster wie households.status_changed_by
--    aus 005) -- F2 sieht zwar aktuell keinen Loeschpfad fuer den einen
--    Admin-Account vor, aber Defense-in-Depth statt stillschweigender
--    Annahme.
--    ip_address als text (nicht inet): req.ip kann je nach Proxy-Konfiguration
--    ungewoehnliche Formate liefern (z. B. "::ffff:127.0.0.1") -- ein
--    fehlerhafter TRUST_PROXY-Wert soll den Login-Pfad nicht per
--    Typkonvertierungsfehler zum Absturz bringen. Konsistent mit dem
--    bestehenden Schema-Stil (TEXT statt spezialisierter Typen, siehe
--    ap1.1-datenmodell.md Abschnitt 2.1).
-- ----------------------------------------------------------------------------
CREATE TABLE admin_audit_log (
  id            bigserial   PRIMARY KEY,
  event_type    text        NOT NULL,
  admin_id      bigint      REFERENCES admin_account(id) ON DELETE SET NULL,
  household_id  bigint,
  old_status    text,
  new_status    text,
  ip_address    text,
  detail        text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE admin_audit_log
  ADD CONSTRAINT admin_audit_log_event_type_check
    CHECK (event_type IN (
      'admin_login_success', 'admin_login_failure',
      'household_deactivated', 'household_reactivated', 'household_deleted'
    ));

COMMENT ON TABLE admin_audit_log IS
  'INSERT-only Audit-Log fuer den Admin-Bereich (ZANDOR AP2.2, Fund 2). '
  'Login-Ereignisse werden direkt aus server.js eingefuegt (admin_audit_log '
  'traegt keine RLS, wochenplan_app hat ein direktes INSERT-Grant, siehe '
  'Abschnitt 2). Statuswechsel-Ereignisse werden dagegen INNERHALB der '
  'SECURITY-DEFINER-Funktionen aus 005_admin_foundation.sql eingefuegt '
  '(Abschnitt 3) -- dadurch ist der Audit-Eintrag atomar mit der '
  'Statusaenderung selbst: schlaegt der INSERT hier fehl, rollt die ganze '
  'Funktion (inkl. UPDATE households) zurueck, statt eine Statusaenderung '
  'ohne zugehoerigen Audit-Eintrag stehen zu lassen.';

CREATE INDEX admin_audit_log_created_idx ON admin_audit_log (created_at DESC);
CREATE INDEX admin_audit_log_household_idx ON admin_audit_log (household_id, created_at DESC)
  WHERE household_id IS NOT NULL;

-- ----------------------------------------------------------------------------
-- 2. Rechte: wochenplan_app darf ausschliesslich INSERT (gleiches Muster wie
--    tenant_context_audit, 004) -- weder lesen noch aendern noch loeschen,
--    damit ein kompromittierter App-Kontext zwar (falsche) Zeilen einfuegen,
--    aber weder die eigene Spur verwischen noch fremde Eintraege einsehen
--    kann. Fuer den Admin-Bereich selbst existiert in diesem Plan bewusst
--    (noch) kein Log-Anzeige-Endpunkt -- siehe Rueckmeldung an ANORAK
--    ("zusaetzliche Idee") fuer einen moeglichen kuenftigen
--    Audit-Log-Viewer.
-- ----------------------------------------------------------------------------
REVOKE SELECT, UPDATE, DELETE ON admin_audit_log FROM wochenplan_app;
GRANT INSERT ON admin_audit_log TO wochenplan_app;
GRANT USAGE, SELECT ON SEQUENCE admin_audit_log_id_seq TO wochenplan_app;

-- ----------------------------------------------------------------------------
-- 3. Statuswechsel-Funktionen aus 005_admin_foundation.sql um einen
--    Audit-Log-Eintrag erweitert -- CREATE OR REPLACE FUNCTION mit
--    IDENTISCHER Signatur (bigint, bigint) und Rueckgabetyp (void): anders
--    als beim DROP+CREATE-Vorgehen fuer auth_lookup_by_email() in 005
--    bleiben hier die bestehenden GRANT EXECUTE-Eintraege fuer
--    wochenplan_app beim CREATE OR REPLACE erhalten (Postgres ersetzt nur
--    den Funktionskoerper, das Funktionsobjekt inkl. ACL bleibt bestehen).
--    Die GRANT/REVOKE-Anweisungen am Ende dieses Abschnitts sind daher
--    strenggenommen redundant -- trotzdem explizit wiederholt, damit diese
--    Datei wie 005 unabhaengig von einer genauen Kenntnis des Vorzustands
--    sicher anwendbar bleibt.
--
--    Jede Funktion liest den bisherigen Status per SELECT ... FOR UPDATE
--    (Zeilensperre gegen einen gleichzeitigen zweiten Statuswechsel auf
--    denselben Haushalt, z. B. zwei parallele Admin-Requests) VOR dem
--    UPDATE aus und schreibt alter+neuer Status in denselben Audit-Eintrag.
-- ----------------------------------------------------------------------------
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

  UPDATE households
     SET status = 'deactivated',
         status_reason = 'admin_manual',
         status_changed_at = now(),
         status_changed_by = p_admin_id
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
-- 4. Login-Ereignisse (admin_login_success/admin_login_failure) werden NICHT
--    hier, sondern direkt in server.js (POST /api/admin/auth/login) per
--    einfachem INSERT ueber appPool eingefuegt -- anders als bei den
--    Statuswechsel-Funktionen oben gibt es hier keinen bereits bestehenden
--    SECURITY-DEFINER-Aufrufpfad, in den sich ein Audit-Eintrag atomar
--    einbetten liesse (der Login-Lookup selbst laeuft als einfache Abfrage
--    auf admin_account, siehe Kommentar dort in server.js). Kein Nachteil,
--    da admin_audit_log KEINE RLS traegt (Abschnitt 1) -- ein direktes
--    INSERT ueber wochenplan_app ist bereits per Grant (Abschnitt 2) erlaubt.
-- ============================================================================
