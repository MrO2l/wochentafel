-- ============================================================================
-- 011_email_blind_index.sql
--
-- MORROW, AP6.3 (Wochenplaner-Verschluesselung, E-Mail-Blindindex fuer
-- Auth-Lookups). Ersetzt den Klartext-Vergleich auf users.email bei Login/
-- Registrierung/Recovery/Passwort-Reset durch einen serverseitig berechneten
-- HMAC-SHA256-Blindindex (users.email_lookup) und verschluesselt users.email
-- selbst nach dem Envelope-Muster aus 010_name_encryption.sql.
--
-- Begleitdokument: projects/wochenplaner-termine-verschluesselung/
-- ap6.3-datenmodell.md (Design-Entscheidungen inkl. verworfener
-- Alternativen, Backfill-Konzept, Rotationskonzept fuer EMAIL_HMAC_KEY,
-- betroffene Endpunkte fuer A3CH). DORT AUCH: der wichtigste Befund dieses
-- Dokuments -- diese Migration und der Backfill-Schritt (AP6.4) sind KEINE
-- unabhaengig voneinander deploybaren Schritte, siehe Begleitdokument
-- Abschnitt 3.1.
--
-- Setzt additiv auf 001_init.sql .. 010_name_encryption.sql auf. Aendert DREI
-- bestehende Elemente: (1) users.email verliert den bestehenden funktionalen
-- Unique-Index auf lower(email) UND wechselt den Typ von text auf jsonb
-- (Envelope-Muster analog users.name/households.name aus 010); (2) zwei
-- Funktionen werden neu angelegt statt per CREATE OR REPLACE aktualisiert,
-- da sich sowohl Parametertyp (text -> bytea) als auch bei
-- auth_lookup_by_email zusaetzlich der Rueckgabetyp der email-Spalte
-- (text -> jsonb) aendert (Postgres verlangt dafuer DROP+CREATE, wie schon
-- bei allen vorherigen Fassungen dieser Funktionen in 005/009/010):
-- auth_lookup_by_email und auth_lookup_recovery_wrap.
--
-- WICHTIG (siehe Begleitdokument Abschnitt 1.2): EMAIL_HMAC_KEY wird NIRGENDS
-- in dieser Migration referenziert oder in der Datenbank abgelegt -- der HMAC
-- wird ausschliesslich anwendungsseitig (Node.js, server.js) berechnet. Diese
-- Migration legt nur das Schema an; users.email_lookup bleibt fuer JEDEN
-- Bestandsnutzer NULL, bis der Backfill-Schritt (AP6.4, serverseitig moeglich
-- -- anders als bei weeks.data/name, siehe Begleitdokument Abschnitt 3) ihn
-- befuellt.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. users.email_lookup -- neue, zunaechst durchgaengig NULL-wertige Spalte
--    fuer den HMAC-SHA256-Blindindex (Begleitdokument Abschnitt 1.1). Bewusst
--    OHNE NOT NULL: waehrend der Backfill-Uebergangsphase (Begleitdokument
--    Abschnitt 3) haben Bestandsnutzer legitim NULL hier, bis der Backfill
--    sie befuellt hat. Kein neues GRANT noetig -- 002_multi_tenant_
--    foundation.sql Abschnitt 2 vergibt bereits ein TABELLEN-weites
--    "GRANT SELECT, INSERT, UPDATE, DELETE ON households, users, weeks,
--    invites, session TO wochenplan_app" OHNE users-spezifische
--    Spalten-Haertung (anders als bei households, siehe
--    005_admin_foundation.sql Abschnitt 3) -- das Tabellen-Grant deckt jede
--    neue Spalte auf users automatisch mit ab, exakt dieselbe Begruendung
--    wie bereits fuer users.name in 010_name_encryption.sql Abschnitt 2
--    dokumentiert.
-- ----------------------------------------------------------------------------
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS email_lookup bytea;

COMMENT ON COLUMN users.email_lookup IS
  'HMAC-SHA256(lower(trim(email)), EMAIL_HMAC_KEY) -- ausschliesslich '
  'serverseitig mit einem eigenstaendigen Prozess-Secret (EMAIL_HMAC_KEY, '
  'Umgebungsvariable, NIE in der Datenbank abgelegt) berechnet, analog zum '
  'bestehenden SESSION_SECRET-Precedent in server.js. Dient ausschliesslich '
  'dem Auth-Lookup (auth_lookup_by_email/auth_lookup_recovery_wrap) und '
  'ersetzt den fruoheren funktionalen Index auf lower(email). NULL bei noch '
  'nicht per Backfill migrierten Bestandsnutzern (Begleitdokument '
  'ap6.3-datenmodell.md Abschnitt 3) -- bei JEDER Neuregistrierung ab '
  'Rollout MUSS dieser Wert sofort gesetzt werden, niemals NULL bleiben '
  '(sonst greift die Unique-Constraint unten fuer diesen Nutzer nicht). '
  'Bekannte, vom Nutzer akzeptierte Einschraenkung: schuetzt gegen '
  'DB-Diebstahl/Backup-Leck/SQL-Injection, NICHT gegen einen Angreifer mit '
  'aktiver Codeausfuehrung auf dem laufenden Server (der Server sieht die '
  'Klartext-E-Mail kurzzeitig bei jedem Auth-Request, um den HMAC zu '
  'berechnen -- strukturell dieselbe Exposition wie bei bcrypt/password_hash).';

-- ----------------------------------------------------------------------------
-- 2. Alten funktionalen Unique-Index VOR dem Typ-Umbau entfernen -- Postgres
--    lehnt "ALTER COLUMN ... TYPE" ab, solange ein Index von einem Ausdruck
--    auf der betroffenen Spalte abhaengt ("cannot alter type of a column
--    used by an index expression"). users_email_uidx (001_init.sql Zeile 18)
--    wird durch den neuen Unique-Index auf email_lookup (Abschnitt 4 unten)
--    ersetzt -- NICHT 1:1 aequivalent waehrend der Backfill-Uebergangsphase
--    (siehe Begleitdokument Abschnitt 1.3 fuer die bewusst in Kauf genommene
--    Konsequenz: waehrend dieser Phase erzwingt die DB selbst KEINE
--    E-Mail-Eindeutigkeit fuer noch nicht befuellte Bestandszeilen mehr --
--    das ist unkritisch, da fuer Bestandszeilen ohnehin schon vor dieser
--    Migration Eindeutigkeit galt und der Uebergang nur bereits bestehende,
--    bereits eindeutige Zeilen betrifft; NEUE Registrierungen sind ab
--    Rollout durch die neue Unique-Constraint sofort wieder vollstaendig
--    abgesichert, da sie email_lookup immer sofort gesetzt bekommen).
-- ----------------------------------------------------------------------------
DROP INDEX IF EXISTS users_email_uidx;

-- ----------------------------------------------------------------------------
-- 3. users.email: Typ-Umbau text -> jsonb, IN-PLACE (keine neue Spalte) --
--    identisches Muster wie users.name/households.name in
--    010_name_encryption.sql Abschnitt 1/2 (dort ausfuehrlich begruendet,
--    hier nicht wiederholt). Zielformat identisch: jsonb-Wert vom Typ
--    'string' = Legacy-Klartext bzw. Uebergangszustand, jsonb-Wert vom Typ
--    'object' mit __enc:true = Ciphertext-Envelope {__enc:true, nonce,
--    ciphertext, keyVersion}, verschluesselt mit dem Haushalts-Schluessel
--    (Begleitdokument Abschnitt 2 fuer die Abgrenzung dieses Envelopes vom
--    HMAC-Blindindex -- zwei UNABHAENGIGE Mechanismen auf demselben
--    fachlichen Wert).
--
--    USING to_jsonb(email) konvertiert jede bestehende Klartext-Zeile ATOMAR
--    innerhalb dieser einen ALTER-Anweisung, NOT NULL bleibt automatisch
--    erhalten (ALTER COLUMN TYPE aendert bestehende Constraints auf
--    derselben Spalte nicht).
-- ----------------------------------------------------------------------------
ALTER TABLE users
  ALTER COLUMN email TYPE jsonb USING to_jsonb(email);

COMMENT ON COLUMN users.email IS
  'jsonb-Wert vom Typ string: Legacy-Klartext- bzw. Uebergangs-E-Mail '
  '(Bestandsformat vor der Verschluesselungsumstellung AP6.3/AP6.4). '
  'jsonb-Wert vom Typ object MIT Top-Level-Schluessel __enc:true: '
  'Ciphertext-Envelope {__enc:true, nonce, ciphertext, keyVersion}, '
  'verschluesselt mit dem HAUSHALTS-Schluessel (analog users.name, '
  '010_name_encryption.sql) -- ausschliesslich clientseitig entschluesselbar, '
  'ausschliesslich fuer die Anzeige nach Unlock. Fuer Auth-Lookups NICHT '
  'relevant und NIEMALS gelesen -- siehe email_lookup oben, der einzige fuer '
  'Login/Registrierung/Recovery/Passwort-Reset verwendete Wert. Immer '
  'NOT NULL. A3CH: siehe Hinweis zu JSON.stringify()/to_jsonb() bei '
  'households.name/users.name (010_name_encryption.sql), gilt hier '
  'identisch -- niemals einen rohen String direkt als jsonb-Parameter senden.';

-- ----------------------------------------------------------------------------
-- 4. Neuer Unique-Index auf email_lookup -- ersetzt users_email_uidx
--    (Abschnitt 2). Bewusst KEIN partieller Index (WHERE email_lookup IS NOT
--    NULL) -- unnoetig: Postgres behandelt in einem UNIQUE INDEX mehrere
--    NULL-Werte grundsaetzlich als NICHT gleich (kein Konflikt zwischen
--    beliebig vielen NULL-Zeilen), die Eindeutigkeitspruefung greift also
--    automatisch erst, sobald ein echter (Nicht-NULL) HMAC-Wert eingetragen
--    wird -- exakt das gewuenschte Verhalten waehrend der Backfill-
--    Uebergangsphase, ganz ohne Sondersyntax.
-- ----------------------------------------------------------------------------
CREATE UNIQUE INDEX users_email_lookup_uidx ON users (email_lookup);

-- ----------------------------------------------------------------------------
-- 5. auth_lookup_by_email neu anlegen (Parametertyp text -> bytea UND
--    Rueckgabetyp der email-Spalte text -> jsonb aendern sich -- CREATE OR
--    REPLACE reicht dafuer laut Postgres nicht aus, DROP zuerst noetig, wie
--    schon bei den drei vorherigen Fassungen dieser Funktion in 005/009/010).
--    Einzige inhaltliche Aenderung gegenueber der 010-Fassung: WHERE-Klausel
--    matcht jetzt ueber email_lookup statt ueber lower(email) = lower(p_email)
--    -- der Server berechnet den HMAC bereits VOR diesem Aufruf aus dem
--    eingehenden Klartext (server.js) und uebergibt ausschliesslich den
--    HMAC-Wert, nie die Klartext-E-Mail selbst, an diese Funktion.
--
--    Fuer NULL-wertiges email_lookup (noch nicht per Backfill migrierte
--    Bestandsnutzer) liefert "u.email_lookup = p_email_lookup" laut
--    Standard-SQL-NULL-Semantik korrekt 0 Zeilen -- kein Sonderfall in
--    dieser Funktion noetig. WICHTIG (Begleitdokument Abschnitt 3.1): genau
--    deshalb MUSS der Backfill vollstaendig abgeschlossen sein, BEVOR diese
--    Funktionsfassung produktiv Login-Traffic bedient, sonst koennen noch
--    nicht befuellte Bestandsnutzer sich nicht mehr einloggen.
-- ----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS auth_lookup_by_email(text);

CREATE FUNCTION auth_lookup_by_email(p_email_lookup bytea)
RETURNS TABLE (
  id                bigint,
  name              jsonb,
  email             jsonb,
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
   WHERE u.email_lookup = p_email_lookup
$$;

REVOKE ALL ON FUNCTION auth_lookup_by_email(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_lookup_by_email(bytea) TO wochenplan_app;

-- ----------------------------------------------------------------------------
-- 6. auth_lookup_recovery_wrap neu anlegen -- Parametertyp text -> bytea
--    (Rueckgabetyp bleibt unveraendert, keine email/name-Spalten im Ergebnis).
--    Gleiche Begruendung/NULL-Semantik wie Abschnitt 5. Inhaltlich sonst
--    identisch zur 009-Fassung (haushaltsweiter recovery_code-Wrap,
--    Verifier-Felder) -- nur die WHERE-Klausel wechselt von
--    lower(u.email) = lower(p_email) auf u.email_lookup = p_email_lookup.
-- ----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS auth_lookup_recovery_wrap(text);

CREATE FUNCTION auth_lookup_recovery_wrap(p_email_lookup bytea)
RETURNS TABLE (
  user_id                 bigint,
  household_id            bigint,
  key_version             smallint,
  wrapped_key             bytea,
  wrap_nonce              bytea,
  kdf_salt                bytea,
  kdf_algo                text,
  kdf_time_cost           integer,
  kdf_memory_cost         integer,
  kdf_parallelism         integer,
  recovery_verifier_salt  bytea,
  recovery_verifier_hash  bytea
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT u.id, u.household_id,
         w.key_version, w.wrapped_key, w.wrap_nonce, w.kdf_salt,
         w.kdf_algo, w.kdf_time_cost, w.kdf_memory_cost, w.kdf_parallelism,
         w.recovery_verifier_salt, w.recovery_verifier_hash
    FROM users u
    JOIN household_key_wraps w
      ON w.household_id = u.household_id
     AND w.wrap_type = 'recovery_code'
     AND w.revoked_at IS NULL
   WHERE u.email_lookup = p_email_lookup
$$;

REVOKE ALL ON FUNCTION auth_lookup_recovery_wrap(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_lookup_recovery_wrap(bytea) TO wochenplan_app;

-- ----------------------------------------------------------------------------
-- Explizit NICHT Teil dieser Migration (siehe Begleitdokument
-- ap6.3-datenmodell.md Abschnitt 4 "Fuer A3CH"):
--   - Berechnung/Befuellung von email_lookup fuer Bestandsnutzer (Backfill,
--     Abschnitt 3 -- MUSS abgeschlossen sein, bevor die neuen Funktions-
--     fassungen oben produktiv Login-Traffic bedienen, siehe Abschnitt 5/6).
--   - Anpassung von POST /api/auth/register (INSERT muss email_lookup jetzt
--     IMMER mitliefern, email jsonb-konform per JSON.stringify()/
--     nameJsonbParam()-aequivalent), POST /api/auth/login, POST /api/auth/
--     recover, POST /api/auth/password-reset (alle vier berechnen den HMAC
--     serverseitig aus der eingehenden Klartext-E-Mail und uebergeben NUR
--     den HMAC an die beiden Funktionen oben), GET /api/me, GET /api/
--     household/members (email-Passthrough kann jetzt ein Envelope-Objekt
--     sein, gleiche Vorgabe wie bei name/householdName aus AP6.2: Anzeige
--     erst nach Unlock) sowie scripts/create-tenant.mjs/import-tenant.mjs
--     (muessen ebenfalls email_lookup mitliefern) -- grobe Liste im
--     Begleitdokument, keine Implementierung hier.
--   - EMAIL_HMAC_KEY als neues Prozess-Secret produktiv einrichten
--     (Infrastruktur-Bedarf, siehe Begleitdokument Abschnitt 5 -- an
--     ART3MIS/A3CH, analog SESSION_SECRET).
--   - Clientseitiger Sweep von email zu einem echten Ciphertext-Envelope
--     (analog dem Name-Sweep aus AP6.2) -- von der Auth-Lookup-Umstellung
--     dieser Migration UNABHAENGIG, siehe Begleitdokument Abschnitt 2.
-- ============================================================================
