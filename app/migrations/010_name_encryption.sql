-- ============================================================================
-- 010_name_encryption.sql
--
-- ENTWURF / VORLAGE für A3CH — MORROW, AP6.1 (Wochenplaner-Verschluesselung
-- von users.name/households.name)
-- Nicht ungeprueft uebernehmen: A3CH prueft vor dem Einspielen, ob die
-- Dateinummer 010 zum Umsetzungszeitpunkt noch frei ist (Stand Entwurf
-- 2026-09-08).
--
-- Begleitdokument: projects/wochenplaner-termine-verschluesselung/
-- ap6.1-datenmodell.md (Design-Entscheidungen inkl. verworfener
-- Alternativen, Rollout-/Sweep-Konzept, betroffene Endpunkte fuer A3CH).
--
-- Setzt additiv auf 001_init.sql .. 009_weeks_encryption.sql auf. Aendert
-- ZWEI bestehende Spalten (households.name, users.name: Typ text -> jsonb,
-- siehe Abschnitt 1/2 unten) und legt EINE Funktion neu an statt per
-- CREATE OR REPLACE zu aktualisieren, da sich ihr Rueckgabetyp aendert
-- (Postgres verlangt dafuer DROP+CREATE): auth_lookup_by_email. Laeuft ueber
-- den bestehenden migrate()-Mechanismus (Owner-/Migrator-Rolle,
-- BEGIN...COMMIT je Datei).
--
-- WICHTIG (siehe Begleitdokument Abschnitt 3): Diese Migration legt nur das
-- Schema an. Der eigentliche Verschluesselungsschritt bestehender Klartext-
-- Namen ist NICHT Teil dieser Datei und kann serverseitig prinzipiell nicht
-- ausgefuehrt werden (der Haushalts-Schluessel liegt nie serverseitig vor)
-- -- das ist ein clientseitiger Sweep-Vorgang, analog AP2.5 (siehe
-- Begleitdokument Abschnitt 3.2).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. households.name: Typ-Umbau text -> jsonb, IN-PLACE (keine neue Spalte).
--
--    Zielformat identisch zum bereits produktiven Muster von
--    households.template_data (009_weeks_encryption.sql Abschnitt 1b):
--      - jsonb-Wert vom Typ 'string' (z. B. "Familie Mustermann")
--        -> Legacy-Klartext (Bestandsformat vor dieser Migration).
--      - jsonb-Wert vom Typ 'object' MIT Top-Level-Schluessel __enc:true
--        -> Ciphertext-Envelope {__enc:true, nonce, ciphertext, keyVersion}
--        (base64-kodierte AEAD-Bytes, verschluesselt mit dem
--        Haushalts-Schluessel) -- ausschliesslich clientseitig
--        entschluesselbar.
--
--    Warum Typ-Umbau in derselben Spalte statt additiver Parallelspalten
--    (weeks.data-Muster aus 009 Abschnitt 2): households.name (wie
--    users.name unten) ist ein Singleton-Skalarfeld -- eine Zeile pro
--    Haushalt, kein Bulk-Volumen ueber viele Zeilen wie bei weeks.data.
--    Damit entfaellt dieselbe Abwaegung, die 009 Abschnitt 1b bereits fuer
--    template_data getroffen hat (Base64-Overhead/expliziter CHECK lohnen
--    sich nur bei hohem Zeilenvolumen). Siehe Begleitdokument Abschnitt 2.1
--    fuer die vollstaendige Abwaegung inkl. verworfener Alternativen.
--
--    USING to_jsonb(name) konvertiert jede bestehende Klartext-Zeile
--    ATOMAR innerhalb dieser einen ALTER-Anweisung in einen gueltigen
--    jsonb-String-Skalar -- kein Zwischenzustand, keine zweite Migration
--    noetig, jede Zeile ist unmittelbar nach COMMIT dieser Datei in einem
--    wohldefinierten Zustand (Legacy-Klartext-als-jsonb-String). NOT NULL
--    bleibt automatisch erhalten (ALTER COLUMN TYPE aendert bestehende
--    Constraints auf derselben Spalte nicht).
--
--    Bewusst KEIN neues CHECK-Constraint (analog 009 Abschnitt 1b: "kein
--    Krypto-Constraint noetig"). Die jsonb-Typisierung selbst eliminiert
--    bereits die Mehrdeutigkeit, die bei einer reinen text-Spalte mit
--    eingebettetem JSON-String bestuende (ein Nutzername, der zufaellig wie
--    '{"__enc":true}' aussieht, wird durch to_jsonb() als jsonb-STRING
--    gespeichert, jsonb_typeof() liefert 'string', niemals 'object' -- keine
--    Kollision mit einem echten Envelope moeglich). Siehe Begleitdokument
--    Abschnitt 2.1 fuer die ausfuehrliche Begruendung.
-- ----------------------------------------------------------------------------
ALTER TABLE households
  ALTER COLUMN name TYPE jsonb USING to_jsonb(name);

COMMENT ON COLUMN households.name IS
  'jsonb-Wert vom Typ string: Legacy-Klartext-Haushaltsname (Bestandsformat '
  'vor der Verschluesselungsumstellung AP6.1/AP6.2). jsonb-Wert vom Typ '
  'object MIT Top-Level-Schluessel __enc:true: Ciphertext-Envelope '
  '{__enc:true, nonce, ciphertext, keyVersion} (base64-kodierte AEAD-Bytes), '
  'verschluesselt mit dem Haushalts-Schluessel -- ausschliesslich '
  'clientseitig entschluesselbar. Immer NOT NULL, niemals beide Formen '
  'gleichzeitig (die jsonb-Typisierung selbst verhindert das). A3CH: beim '
  'Schreiben IMMER ueber JSON.stringify()/to_jsonb()-aequivalente '
  'Parametrisierung, niemals einen rohen String direkt als jsonb-Parameter '
  'senden (Postgres interpretiert einen unquotierten String sonst als '
  'ungueltiges JSON und lehnt den INSERT/UPDATE ab).';

-- Kein neues GRANT noetig: 005_admin_foundation.sql Abschnitt 3 vergibt
-- bereits "GRANT UPDATE (name, template_data, migrated_from_instance,
-- migrated_at) ON households TO wochenplan_app" -- das Grant bezieht sich
-- auf den Spaltennamen, nicht den Spaltentyp, und bleibt nach diesem
-- Typ-Umbau unveraendert wirksam.

-- ----------------------------------------------------------------------------
-- 2. users.name: identischer Typ-Umbau text -> jsonb, gleiche Begruendung
--    wie Abschnitt 1. Verschluesselt ebenfalls mit dem Haushalts-Schluessel
--    (NICHT passwortabgeleitet) -- Nutzerentscheidung/ZANDOR-Vorgabe: jedes
--    Haushaltsmitglied soll nach dem eigenen Unlock automatisch auch die
--    Namen der anderen Mitglieder lesen koennen (Mitgliederliste,
--    GET /api/household/members), ohne zusaetzlichen Schluesselaustausch --
--    exakt dieselbe Eigenschaft, die household_key_wraps bereits fuer
--    weeks.data/template_data sicherstellt.
--
--    KEIN Tabellen-weites Grant-Problem hier: users hat (anders als
--    households) noch keine Spalten-Haertung -- 002_multi_tenant_foundation.
--    sql Abschnitt 2 vergibt ein Tabellen-weites "GRANT SELECT, INSERT,
--    UPDATE, DELETE ON households, users, weeks, invites, session", das
--    users.name bereits vollstaendig abdeckt. Kein neues GRANT noetig.
-- ----------------------------------------------------------------------------
ALTER TABLE users
  ALTER COLUMN name TYPE jsonb USING to_jsonb(name);

COMMENT ON COLUMN users.name IS
  'jsonb-Wert vom Typ string: Legacy-Klartext-Anzeigename (Bestandsformat '
  'vor der Verschluesselungsumstellung AP6.1/AP6.2). jsonb-Wert vom Typ '
  'object MIT Top-Level-Schluessel __enc:true: Ciphertext-Envelope '
  '{__enc:true, nonce, ciphertext, keyVersion}, verschluesselt mit dem '
  'HAUSHALTS-Schluessel (nicht passwortabgeleitet) -- damit koennen alle '
  'Haushaltsmitglieder nach ihrem eigenen Unlock automatisch auch die Namen '
  'der anderen Mitglieder lesen (GET /api/household/members), ohne '
  'zusaetzlichen Schluesselaustausch. Ausschliesslich clientseitig '
  'entschluesselbar. Immer NOT NULL. A3CH: siehe Hinweis zu '
  'JSON.stringify()/to_jsonb() bei households.name oben, gilt hier '
  'identisch.';

-- ----------------------------------------------------------------------------
-- 3. Rollout-Zustand: KEINE neue Spalte -- households.encryption_status
--    (009_weeks_encryption.sql Abschnitt 1) bleibt unveraendert die einzige
--    Zustandsspalte. Siehe Begleitdokument Abschnitt 3 fuer die vollstaendige
--    Begruendung, hier nur der Kern:
--
--    - encryption_status ist weiterhin die VORBEDINGUNG ("existiert ein
--      Haushalts-Schluessel, den ein Client zum Verschluesseln von name
--      ueberhaupt verwenden kann?") -- 'plaintext' bedeutet: kein
--      Haushalts-Schluessel vorhanden, name KANN in diesem Zustand nicht
--      verschluesselt geschrieben werden (kein Schluessel da).
--    - OB eine konkrete name-Zeile bereits verschluesselt ist, ist dagegen
--      SELBSTBESCHREIBEND ueber die jsonb-Form selbst (jsonb_typeof(name) =
--      'string' vs. 'object' mit __enc:true) -- exakt dasselbe Prinzip wie
--      bei template_data (009 Abschnitt 1b), das ebenfalls ohne eigene
--      Statusspalte auskommt.
--    - Eine dritte, granularere Statusspalte (z. B. "sind Namen in diesem
--      Haushalt bereits gesweept?") waere redundante Buchfuehrung: der
--      Zustand laesst sich jederzeit exakt und ohne Rennbedingungsrisiko per
--      SELECT ermitteln (siehe Sweep-Status-Query im Begleitdokument
--      Abschnitt 3.2, analog zu GET /api/weeks/sweep-status aus AP2.5).
-- ----------------------------------------------------------------------------

-- ----------------------------------------------------------------------------
-- 4. auth_lookup_by_email neu anlegen (Rueckgabetyp aendert sich: name/
--    household_name von text auf jsonb -- CREATE OR REPLACE reicht dafuer
--    laut Postgres nicht aus, DROP zuerst noetig, wie schon bei den beiden
--    vorherigen Fassungen dieser Funktion in 005/009). Inhaltlich sonst
--    UNVERAENDERT gegenueber der 009-Fassung (alle Wrap-Felder bleiben
--    erhalten) -- einzige Aenderung sind die beiden jsonb-Rueckgabespalten.
-- ----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS auth_lookup_by_email(text);

CREATE FUNCTION auth_lookup_by_email(p_email text)
RETURNS TABLE (
  id                bigint,
  name              jsonb,
  email             text,
  role              text,
  password_hash     text,
  household_id      bigint,
  household_name    jsonb,
  encryption_status text,
  wrap_key_version  smallint,
  wrapped_key       bytea,
  wrap_nonce        bytea,
  kdf_salt          bytea,
  kdf_algo          text,
  kdf_time_cost     integer,
  kdf_memory_cost   integer,
  kdf_parallelism   integer
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT u.id, u.name, u.email, u.role, u.password_hash, u.household_id, h.name,
         h.encryption_status,
         w.key_version, w.wrapped_key, w.wrap_nonce, w.kdf_salt,
         w.kdf_algo, w.kdf_time_cost, w.kdf_memory_cost, w.kdf_parallelism
    FROM users u
    JOIN households h ON h.id = u.household_id
    LEFT JOIN household_key_wraps w
           ON w.user_id = u.id
          AND w.wrap_type = 'password'
          AND w.revoked_at IS NULL
   WHERE lower(u.email) = lower(p_email)
$$;

REVOKE ALL ON FUNCTION auth_lookup_by_email(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_lookup_by_email(text) TO wochenplan_app;

-- ----------------------------------------------------------------------------
-- Explizit NICHT Teil dieser Migration (siehe Begleitdokument Abschnitt 4
-- "Fuer A3CH"):
--   - Verschluesselung bestehender Klartext-Namen (clientseitiger Sweep,
--     kein DDL, kein serverseitiges Skript moeglich -- gleicher Grund wie
--     bei weeks.data, Abschnitt 3.1/3.2 des Begleitdokuments).
--   - Anpassung von POST /api/auth/register (households.name/users.name-
--     INSERT), POST /api/auth/login (Response-Passthrough der jetzt
--     potenziell verschluesselten name/household_name-Felder), GET /api/me,
--     GET /api/household/members, GET /api/weeks (updatedBy) sowie der
--     beiden Bestandsskripte scripts/create-tenant.mjs/import-tenant.mjs --
--     grobe Liste im Begleitdokument Abschnitt 4, keine Implementierung hier.
--   - Verschiebung der #householdName-Anzeige in app.js:3406 in den
--     Erfolgspfad NACH Unlock (bereits vor dieser Migration als bekannter
--     Umbaupunkt vermerkt, jetzt zusaetzlich fuer users.name relevant, siehe
--     Begleitdokument Abschnitt 4).
-- ============================================================================
