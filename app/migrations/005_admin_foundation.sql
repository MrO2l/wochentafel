-- ============================================================================
-- 005_admin_foundation.sql
--
-- ENTWURF / VORLAGE für A3CH — MORROW, AP1.1 (Wochenplaner-Admin-Bereich)
-- Nicht ungeprüft übernehmen: Ausführung/Regressionscheck auf der
-- Test-Instanz ist Gegenstand von AP1.2. Siehe Begleitdokument
-- projects/wochenplaner-admin/ap1.1-datenmodell.md für Begründungen aller
-- unten getroffenen Design-Entscheidungen.
--
-- Setzt additiv auf 001_init.sql–004_tenant_context_audit.sql auf. Ändert
-- keinen bestehenden Spaltentyp und kein bestehendes Constraint aus
-- 001–004 (nur ergänzende ALTER TABLE ADD COLUMN / ADD CONSTRAINT sowie
-- ein DROP+CREATE einer bereits bestehenden, additiv erweiterten
-- SECURITY-DEFINER-Funktion, siehe Abschnitt 5). Läuft über den
-- bestehenden migrate()-Mechanismus (BEGIN…COMMIT je Datei, Ausführung
-- durch die Migrator-/Owner-Rolle — dieselbe Rolle wie bei 001–004).
--
-- Zweck (siehe plan.md „Entscheidungen (2026-08-24)“, F2/F3/F5):
--   1. `admin_account`-Tabelle (Ein-Account-Modell, F2).
--   2. Statusfeld-Design auf `households` mit Grund-Code (F5) inkl.
--      Soft-Delete-Semantik (F3).
--   3. Vier schmale SECURITY-DEFINER-Funktionen als einziger Schreibpfad
--      auf die neuen Statusspalten (Übersicht + drei Statuswechsel) —
--      notwendig, weil `households` seit 003_rls_policies.sql RLS-Policies
--      hat, die `wochenplan_app` strikt auf die eigene household_id
--      beschränken (siehe ap1.1-datenmodell.md Abschnitt 3 für die
--      vollständige Herleitung).
--   4. Erweiterung von `auth_lookup_by_email()` (003) um einen
--      Status-Filter, damit auch NEUE Login-Versuche eines deaktivierten/
--      gelöschten Haushalts sofort abgewiesen werden (nicht nur bereits
--      laufende Sessions — das bleibt AP4.1).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. admin_account (Ein-Account-Modell, F2 — keine Rollen-Spalte, keine
--    Verwaltungs-Endpunkte in diesem Plan)
-- ----------------------------------------------------------------------------
CREATE TABLE admin_account (
  id            bigserial   PRIMARY KEY,
  username      text        NOT NULL,
  password_hash text        NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX admin_account_username_uidx ON admin_account (lower(username));

-- Erzwingt das per F2 entschiedene Ein-Account-Modell zusätzlich auf
-- DB-Ebene (nicht nur per Konvention im CLI-Skript create-admin.mjs,
-- AP2.1): der konstante Ausdruck (true) kann pro Tabelle nur einmal in
-- einem Unique-Index vorkommen, ab der zweiten Zeile schlägt der INSERT
-- fehl. Bewusst reversibel (einfaches DROP INDEX), falls eine spätere,
-- eigenständige Planrevision F2 aufhebt und mehrere Admin-Accounts
-- einführt — siehe ap1.1-datenmodell.md Abschnitt 2.2 für die Abwägung.
CREATE UNIQUE INDEX admin_account_singleton_uidx ON admin_account ((true));

COMMENT ON TABLE admin_account IS
  'Ein-Account-Admin-Modell (F2, plan.md "Entscheidungen (2026-08-24)"). '
  'Initiale Anlage ausschliesslich per CLI-Skript (AP2.1, analog '
  'create-tenant.mjs), keine Self-Service-Registrierung, kein CRUD-Endpunkt.';

-- Least Privilege: wochenplan_app darf lesen (Login-Prüfung) und genau
-- einmal per CLI-Skript einfügen (analog create-tenant.mjs, das ebenfalls
-- über wochenplan_app statt über die Owner-Rolle läuft, siehe
-- ap2.3-mandanten-anlage.md Abschnitt 1.2). UPDATE/DELETE sind in diesem
-- Plan durch keinen Pfad vorgesehen (kein Passwort-Reset-/Verwaltungs-
-- Endpunkt, F2) und werden daher jetzt schon entzogen statt präventiv
-- offen zu lassen — analog dem bereits in 004_tenant_context_audit.sql
-- etablierten Muster (dort: REVOKE SELECT/UPDATE/DELETE, nur INSERT
-- nötig). Die ALTER DEFAULT PRIVILEGES-Klausel aus 002 hat beim CREATE
-- TABLE oben automatisch SELECT/INSERT/UPDATE/DELETE vergeben; hier
-- gezielt auf SELECT/INSERT reduziert.
REVOKE UPDATE, DELETE ON admin_account FROM wochenplan_app;
GRANT USAGE, SELECT ON SEQUENCE admin_account_id_seq TO wochenplan_app;

-- ----------------------------------------------------------------------------
-- 2. Statusfeld-Design auf households (F5) — additiv, nullable/DEFAULT,
--    kein bestehender Anwendungscode betroffen (server.js verwendet
--    ausschliesslich explizite Spaltenlisten, kein SELECT/INSERT *,
--    gleiches Argument wie in 002_multi_tenant_foundation.sql Abschnitt 1).
--
--    Typisierung TEXT + CHECK statt nativem Postgres-ENUM: konsistent mit
--    dem bestehenden Schema-Stil (users.role ist ebenfalls "text NOT NULL
--    DEFAULT 'member'", kein ENUM-Typ irgendwo in 001–004) UND technisch
--    zwingend, weil ALTER TYPE ... ADD VALUE nicht innerhalb einer
--    Transaktion nutzbar ist (ein neu hinzugefuegter Enum-Wert ist in
--    derselben Transaktion, die ihn anlegt, noch nicht verwendbar) — der
--    bestehende migrate()-Mechanismus wrappt aber jede Migrationsdatei in
--    genau eine BEGIN…COMMIT-Transaktion (siehe Kopfkommentare 002/003).
--    Ein künftiger dritter status_reason-Wert (z. B. für eine andere
--    Billing-Sperrart) liesse sich mit TEXT+CHECK per einfachem
--    ADD CONSTRAINT in einer additiven Folgemigration ergänzen; mit ENUM
--    wäre das in diesem Migrationsmodell nicht ohne Sonderbehandlung
--    möglich. Siehe ap1.1-datenmodell.md Abschnitt 2.1.
-- ----------------------------------------------------------------------------
ALTER TABLE households
  ADD COLUMN IF NOT EXISTS status             text        NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS status_reason      text,
  ADD COLUMN IF NOT EXISTS status_changed_at  timestamptz,
  ADD COLUMN IF NOT EXISTS status_changed_by  bigint      REFERENCES admin_account(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS deleted_at         timestamptz;

ALTER TABLE households
  ADD CONSTRAINT households_status_check
    CHECK (status IN ('active', 'deactivated', 'deleted')),
  ADD CONSTRAINT households_status_reason_check
    CHECK (status_reason IN ('admin_manual', 'non_payment')),
  ADD CONSTRAINT households_status_reason_consistency_check
    CHECK ( (status = 'active' AND status_reason IS NULL)
         OR (status <> 'active' AND status_reason IS NOT NULL) ),
  ADD CONSTRAINT households_deleted_at_consistency_check
    CHECK ( (status = 'deleted' AND deleted_at IS NOT NULL)
         OR (status <> 'deleted' AND deleted_at IS NULL) );

COMMENT ON COLUMN households.status IS
  'active | deactivated | deleted (F5). Einziger sanktionierter Schreibpfad: '
  'die Funktionen admin_deactivate_household/admin_reactivate_household/'
  'admin_soft_delete_household unten (siehe Abschnitt 4) — wochenplan_app '
  'hat auf diese Spalte per Column-Grant KEIN direktes UPDATE-Recht mehr '
  '(Abschnitt 3).';
COMMENT ON COLUMN households.status_reason IS
  'admin_manual | non_payment, NULL genau dann wenn status=''active''. '
  '"admin_manual" wird von den in diesem Plan gebauten Endpunkten gesetzt; '
  '"non_payment" ist fuer eine kuenftige, hier NICHT gebaute '
  'Billing-Automatisierung reserviert (siehe plan.md F5).';
COMMENT ON COLUMN households.status_changed_at IS
  'Zeitpunkt der letzten Statusaenderung, NULL solange nie geaendert.';
COMMENT ON COLUMN households.status_changed_by IS
  'admin_account.id, das die letzte Statusaenderung ausgeloest hat. '
  'ON DELETE SET NULL (gleiches Muster wie weeks.updated_by in 001_init.sql) '
  '-- der Haushalt bzw. sein Audit-Trail bleibt bestehen, auch wenn der '
  'zugehoerige Admin-Account je entfernt wuerde.';
COMMENT ON COLUMN households.deleted_at IS
  'Zeitpunkt des Soft-Delete (F3), NULL solange nicht geloescht. Basis fuer '
  'die Aufbewahrungsfrist einer kuenftigen Hard-Purge (AP3.4, siehe '
  'Referenzabfrage am Ende dieser Datei) -- die Fristlaenge (Empfehlung: '
  '30 Tage, vom Nutzer nicht final bestaetigt, siehe plan.md F3) ist '
  'bewusst NICHT in dieser Spalte oder einem Constraint hinterlegt, '
  'sondern bleibt ein Parameter des AP3.4-Purge-Jobs.';

-- ----------------------------------------------------------------------------
-- 3. Column-Grant-Haertung: wochenplan_app verliert das direkte UPDATE-
--    Recht auf genau die fuenf neuen Statusspalten. Alle anderen Spalten
--    von households (name, template_data, migrated_from_instance,
--    migrated_at) bleiben weiterhin per UPDATE beschreibbar.
--
--    Zweck: Statuswechsel duerfen ausschliesslich ueber die vier
--    SECURITY-DEFINER-Funktionen in Abschnitt 4 erfolgen, die die
--    Reason/Status-Kombination zentral festlegen (kein per Aufrufer frei
--    waehlbarer status_reason-Wert, siehe Abschnitt 4). Selbst ein
--    App-Code-Fehler oder eine SQL-Injection ueber einen regulaeren, mit
--    wochenplan_app verbundenen Endpunkt koennte damit die Statusspalten
--    NICHT direkt per UPDATE households SET status=... manipulieren --
--    zusaetzliche Verteidigungsebene ueber das ohnehin geplante
--    Defense-in-Depth aus AP4.1 hinaus. SELECT bleibt unveraendert erlaubt
--    (AP4.1 muss den Status pro Request lesen koennen, siehe Abschnitt 6).
--
--    KORREKTUR gegenueber dem urspruenglichen MORROW-Entwurf (gefunden und
--    behoben in AP1.2, A3CH): Die urspruengliche Fassung dieser Migration
--    schrieb "REVOKE UPDATE (status, ...) ON households FROM wochenplan_app"
--    -- also einen reinen Spalten-REVOKE. Das ist bei Postgres WIRKUNGSLOS,
--    wenn (wie hier) bereits ein TABELLEN-weites UPDATE-Grant existiert:
--    002_multi_tenant_foundation.sql vergibt per
--    "GRANT SELECT, INSERT, UPDATE, DELETE ON households, ... TO
--    wochenplan_app" ein Tabellen-Grant, das implizit alle Spalten
--    abdeckt. Tabellen- und Spalten-Privilegien sind in Postgres
--    UNABHAENGIGE, ADDITIVE ACL-Eintraege (pg_class.relacl vs.
--    pg_attribute.attacl) -- ein Spalten-REVOKE entfernt nur einen
--    zuvor separat vergebenen Spalten-Grant, laesst aber ein bereits
--    bestehendes Tabellen-Grant unberuehrt. Live gegen eine Test-Instanz
--    verifiziert (AP1.2): mit der urspruenglichen Fassung konnte
--    wochenplan_app "UPDATE households SET status='deleted',
--    status_reason='admin_manual' WHERE id=..." weiterhin erfolgreich
--    direkt ausfuehren -- die in Abschnitt 2.4 von ap1.1-datenmodell.md
--    behauptete Verteidigungsebene ("Selbst ein App-Code-Fehler ... koennte
--    die Statusspalten NICHT direkt manipulieren") war dadurch NICHT
--    wirksam. Korrektes Muster (unten): zuerst das Tabellen-Grant fuer
--    UPDATE vollstaendig entziehen, danach ein neues, echtes Spalten-Grant
--    ausschliesslich auf die weiterhin gewuenschten Spalten vergeben.
--    Erneut gegen eine Test-Instanz verifiziert: mit dieser Fassung schlaegt
--    derselbe direkte UPDATE-Versuch auf die Statusspalten mit
--    "permission denied for table households" fehl, waehrend
--    PUT /api/template (UPDATE households SET template_data=...) weiterhin
--    funktioniert.
-- ----------------------------------------------------------------------------
REVOKE UPDATE ON households FROM wochenplan_app;
GRANT UPDATE (name, template_data, migrated_from_instance, migrated_at)
  ON households TO wochenplan_app;

-- ----------------------------------------------------------------------------
-- 3a. Indizes
--     - households_status_idx: deckt sowohl reine Status-Filter (Admin-
--       Uebersicht, z. B. "alle deaktivierten Haushalte") als auch
--       Status+Grund-Filter (kuenftige Billing-Automatisierung, z. B.
--       "alle non_payment-Haushalte") ab -- (status, status_reason) ist
--       linksbuendig auch fuer reine status-Abfragen nutzbar. Fuer den
--       Defense-in-Depth-Check in requireAuth (AP4.1) selbst ist KEIN
--       zusaetzlicher Index noetig: die Abfrage ist ein Einzelzeilen-Read
--       ueber den Primaerschluessel (SELECT status FROM households WHERE
--       id=$1), bereits durch den PK optimal bedient (siehe
--       ap1.1-datenmodell.md Abschnitt 5).
--     - households_deleted_purge_idx: partieller Index, ausschliesslich
--       fuer den kuenftigen, optionalen AP3.4-Purge-Job (Kandidaten fuer
--       Hard-Purge schnell finden, ohne alle Haushalte zu scannen).
-- ----------------------------------------------------------------------------
CREATE INDEX households_status_idx ON households (status, status_reason);

CREATE INDEX households_deleted_purge_idx ON households (deleted_at)
  WHERE status = 'deleted';

-- ----------------------------------------------------------------------------
-- 4. SECURITY-DEFINER-Funktionen: einziger sanktionierter Zugriffspfad auf
--    ALLE Haushalte unabhaengig vom eigenen Sitzungskontext.
--
--    Warum ueberhaupt noetig (Kernbefund, siehe ap1.1-datenmodell.md
--    Abschnitt 3): 003_rls_policies.sql hat auf households bereits RLS
--    aktiviert, mit Policies, die JEDE direkte Abfrage ueber
--    wochenplan_app strikt auf "id = current_setting('app.current_'
--    'household_id', true)::bigint" beschraenken -- also auf genau einen,
--    den eigenen Haushalt. Ein Admin-Bereich braucht aber zwangslaeufig
--    haushaltsuebergreifenden Lese- UND Schreibzugriff. Gleiches Muster
--    wie bereits fuer auth_lookup_by_email() (003) und
--    set_tenant_context_audited() (004) etabliert: eine schmale, mit den
--    Rechten der Migrator-/Owner-Rolle laufende Funktion (RLS-Bypass,
--    weil Tabelleneigentuemerin), wochenplan_app erhaelt NUR EXECUTE
--    darauf, KEINEN generellen Lese-/Schreib-Bypass auf die Tabelle
--    selbst. Alle vier Funktionen sind bewusst je auf GENAU EINE
--    Zustandsaenderung zugeschnitten (statt einer generischen
--    admin_set_household_status(status, reason)-Funktion mit vom
--    Aufrufer frei waehlbaren Parametern): der erlaubte status_reason-Wert
--    ist im Funktionskoerper fest verdrahtet, nicht vom Aufrufer
--    beeinflussbar -- kleinere Angriffsflaeche, keine erneute
--    Wertebereichspruefung noetig (das CHECK-Constraint deckt das zwar
--    ohnehin ab, aber so ist gar nicht erst ein falscher Wert erreichbar).
-- ----------------------------------------------------------------------------

-- 4.1 Uebersicht (F1-Feldliste: Haushalts-ID, created_at, Mitgliederzahl,
--     Status inkl. Grund-Code -- kein Klarname, keine E-Mail). Liefert
--     bewusst ALLE Haushalte inkl. status='deleted', damit soft-geloeschte
--     Haushalte im Admin-Bereich sichtbar/reaktivierbar bleiben (siehe
--     ap1.1-datenmodell.md Abschnitt 3, letzter Absatz).
CREATE FUNCTION admin_list_households()
RETURNS TABLE (
  household_id bigint,
  created_at   timestamptz,
  member_count bigint,
  status       text,
  status_reason text
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT h.id,
         h.created_at,
         (SELECT count(*) FROM users u WHERE u.household_id = h.id)::bigint,
         h.status,
         h.status_reason
    FROM households h
   ORDER BY h.created_at DESC
$$;

-- 4.2 Deaktivieren (AP3.2). status_reason ist fest 'admin_manual' -- der
--     Wert 'non_payment' bleibt ausschliesslich einer kuenftigen, hier
--     nicht gebauten Billing-Funktion vorbehalten (plan.md F5).
CREATE FUNCTION admin_deactivate_household(p_household_id bigint, p_admin_id bigint)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  UPDATE households
     SET status = 'deactivated',
         status_reason = 'admin_manual',
         status_changed_at = now(),
         status_changed_by = p_admin_id
   WHERE id = p_household_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'household % not found', p_household_id USING ERRCODE = 'no_data_found';
  END IF;
END;
$$;

-- 4.3 Reaktivieren (AP3.2). Funktional bewusst nicht auf
--     status='deactivated' als Vorbedingung beschraenkt -- sie setzt aus
--     JEDEM Nicht-active-Status (deactivated ODER deleted) zurueck auf
--     active und loescht deleted_at mit. Grund: AP3.4 im Plan verlangt
--     explizit, dass ein Haushalt vor der Hard-Purge-Frist "technisch
--     wiederherstellbar (Statuswechsel zurueck auf active)" bleibt, ohne
--     dass dafuer ein eigener Restore-Endpunkt noetig waere -- die
--     zugrundeliegende DB-Faehigkeit muss dafuer vorhanden sein, auch wenn
--     AP3.2 sie am Ende evtl. nur ueber den regulaeren
--     .../reactivate-Endpunkt fuer deactivated-Haushalte exponiert. OFFENE
--     PRODUKTENTSCHEIDUNG fuer A3CH/ANORAK (siehe Begleitdokument, Abschnitt
--     "Offene Punkte"): soll der AP3.2-HTTP-Endpunkt einen Restore aus
--     status='deleted' ebenfalls zulassen, oder dafuer 409/403 liefern und
--     einen Restore nur per direktem DB-Zugriff erlauben? Diese Funktion
--     unterstuetzt technisch beides; die Eingrenzung waere reine
--     Anwendungslogik im Endpunkt, keine Aenderung an dieser Funktion.
CREATE FUNCTION admin_reactivate_household(p_household_id bigint, p_admin_id bigint)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  UPDATE households
     SET status = 'active',
         status_reason = NULL,
         status_changed_at = now(),
         status_changed_by = p_admin_id,
         deleted_at = NULL
   WHERE id = p_household_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'household % not found', p_household_id USING ERRCODE = 'no_data_found';
  END IF;
END;
$$;

-- 4.4 Soft-Delete (AP3.3, F3). Keine sofortige DELETE-Anweisung -- setzt
--     ausschliesslich Status/Zeitstempel. status_reason ist ebenfalls fest
--     'admin_manual' (Konsistenz mit dem NOT-NULL-CHECK aus Abschnitt 2 fuer
--     jeden Nicht-active-Status).
CREATE FUNCTION admin_soft_delete_household(p_household_id bigint, p_admin_id bigint)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  UPDATE households
     SET status = 'deleted',
         status_reason = 'admin_manual',
         status_changed_at = now(),
         status_changed_by = p_admin_id,
         deleted_at = now()
   WHERE id = p_household_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'household % not found', p_household_id USING ERRCODE = 'no_data_found';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION admin_list_households() FROM PUBLIC;
REVOKE ALL ON FUNCTION admin_deactivate_household(bigint, bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION admin_reactivate_household(bigint, bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION admin_soft_delete_household(bigint, bigint) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION admin_list_households()                   TO wochenplan_app;
GRANT EXECUTE ON FUNCTION admin_deactivate_household(bigint, bigint) TO wochenplan_app;
GRANT EXECUTE ON FUNCTION admin_reactivate_household(bigint, bigint) TO wochenplan_app;
GRANT EXECUTE ON FUNCTION admin_soft_delete_household(bigint, bigint) TO wochenplan_app;

-- p_admin_id wird NICHT innerhalb dieser Funktionen gegen admin_account
-- geprueft -- das uebernimmt bereits der Fremdschluessel
-- households.status_changed_by REFERENCES admin_account(id) automatisch
-- (ein ungueltiger p_admin_id-Wert laesst das UPDATE mit einem
-- Fremdschluessel-Verletzungsfehler fehlschlagen, kein stiller
-- Fehlerfall). Wie A3CH die aufrufende admin_account.id ermittelt
-- (voraussichtlich req.session.adminId nach erfolgreichem Admin-Login,
-- AP2.1) ist Teil der Implementierung, nicht dieses Datenmodell-Entwurfs.

-- ----------------------------------------------------------------------------
-- 5. auth_lookup_by_email() (003_rls_policies.sql) um Status-Filter
--    erweitert -- schliesst eine sonst offene Luecke: ohne diesen Filter
--    koennte sich ein Nutzer eines deaktivierten/geloeschten Haushalts
--    weiterhin NEU einloggen (AP4.1 deckt nur bereits laufende Sessions
--    ab, nicht neue Login-Versuche nach der Statusaenderung). Mit dem
--    Filter liefert die Funktion fuer einen inaktiven Haushalt schlicht 0
--    Zeilen -- der bestehende Login-Handler in server.js behandelt das
--    bereits identisch zu "falsches Passwort" (generische 401-Antwort,
--    kein Code-Diff in server.js noetig). Das ist zugleich die sicherere
--    Variante gegenueber einer expliziten "Konto deaktiviert"-Fehlermeldung
--    (keine Status-Enumeration ueber die Login-Fehlermeldung).
--
--    CREATE OR REPLACE FUNCTION ist hier NICHT ausreichend, weil sich nur
--    die WHERE-Klausel aendert, nicht die Signatur -- trotzdem als
--    DROP+CREATE geschrieben, damit diese Datei unabhaengig von einer
--    genauen Kenntnis der 003-Definition sicher anwendbar ist; Rechte
--    muessen nach DROP zwingend neu vergeben werden (Grants gehen beim
--    DROP verloren).
-- ----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS auth_lookup_by_email(text);

CREATE FUNCTION auth_lookup_by_email(p_email text)
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
     AND h.status = 'active'
$$;

REVOKE ALL ON FUNCTION auth_lookup_by_email(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_lookup_by_email(text) TO wochenplan_app;

-- ----------------------------------------------------------------------------
-- 6. Referenzabfragen (nicht Teil dieser Migration, keine Ausfuehrung
--    hier -- analog dem "Alert-Abfrage (Referenz)"-Muster am Ende von
--    004_tenant_context_audit.sql)
-- ----------------------------------------------------------------------------
--
-- 6.1 AP4.1 -- Defense-in-Depth-Statuspruefung in requireAuth, pro Request,
--     ueber den bestehenden withTenantClient-Helfer (PK-Read, kein neuer
--     Index noetig, RLS erlaubt id=eigener Kontext bereits):
--
--   SELECT status FROM households WHERE id = $1;
--
-- 6.2 AP4.1 -- Session-Invalidierung bei Deaktivieren/Loeschen. `session`
--     traegt bewusst keine RLS (003, Abschnitt 3) und keine household_id-
--     Spalte -- der Haushaltsbezug steckt im JSON der sess-Spalte
--     (connect-pg-simple, Spaltentyp `json`, siehe 001_init.sql).
--     req.session.householdId wird als Top-Level-Schluessel gesetzt
--     (server.js, /api/auth/login und /api/auth/register) -- der Zugriff
--     per ->> ist daher direkt moeglich, auch auf einer `json`- statt
--     `jsonb`-Spalte:
--
--   DELETE FROM session WHERE (sess->>'householdId')::bigint = $1;
--
--     Optionaler Ausdrucksindex, NICHT Teil dieser Migration -- diese
--     Abfrage laeuft selten (nur bei Deaktivieren/Loeschen, nicht pro
--     Request), bei der heutigen Haushaltszahl (marktanalyse.md: niedriger
--     zwei- bis dreistelliger Bereich) ist ein Sequential Scan ueber
--     `session` voraussichtlich unkritisch. Falls A3CH/ART3MIS spaeter
--     Bedarf sehen:
--
--   CREATE INDEX session_household_idx
--     ON session (((sess->>'householdId')::bigint));
--
--     Vor Anlage empirisch pruefen (nicht blind uebernehmen): CAST-Fehler
--     bei Indexanlage nur, falls eine vorhandene Zeile einen
--     nicht-numerischen householdId-Wert enthaelt (fehlender Schluessel
--     ist unproblematisch, ->> liefert dann SQL NULL). Sobald AP2.1
--     Admin-Sessions einfuehrt (ohne householdId-Schluessel), liefert der
--     Ausdruck fuer diese Zeilen ebenfalls NULL, kein Fehler.
--
-- 6.3 AP3.4 (optional, nicht blockierend) -- Hard-Purge-Kandidaten. Die
--     Aufbewahrungsfrist ist ABSICHTLICH als Platzhalter/Parameter ($1)
--     gehalten, nicht als hartcodiertes Intervall -- JOHNSON-Empfehlung 30
--     Tage (plan.md F3) ist vom Nutzer nicht explizit als Zahl bestaetigt
--     und bei Bedarf jederzeit anpassbar. Empfehlung: als benannte
--     Konstante/ENV-Variable im AP3.4-Job (z. B. HOUSEHOLD_RETENTION_DAYS),
--     analog dem bestehenden Stil in server.js (Cookie-maxAge, Rate-Limit-
--     Schwellenwerte sind dort ebenfalls einfache JS-Konstanten, keine
--     DB-Konfigurationstabelle) -- eine eigene Settings-Tabelle fuer einen
--     einzelnen, von genau einem Job genutzten Wert waere hier
--     ueberdimensioniert.
--
--   SELECT id FROM households
--    WHERE status = 'deleted'
--      AND deleted_at < now() - ($1::text || ' days')::interval;
--     -- $1 = HOUSEHOLD_RETENTION_DAYS aus AP3.4-Job/ENV, Empfehlung: 30
--
--     households_deleted_purge_idx (Abschnitt 3a) bedient diese Abfrage
--     bereits.
-- ============================================================================
