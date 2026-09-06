-- ============================================================================
-- 009_weeks_encryption.sql
--
-- ENTWURF / VORLAGE für A3CH — MORROW, AP1.2 (Wochenplaner-Termine-Verschluesselung)
-- Nicht ungeprüft übernehmen: A3CH prüft vor dem Einspielen, ob die Dateinummer
-- 009 zum Umsetzungszeitpunkt noch frei ist (Stand Entwurf 2026-09-06).
--
-- Begleitdokument: projects/wochenplaner-termine-verschluesselung/ap1.2-datenmodell.md
-- (ERD, Design-Entscheidungen inkl. verworfener Alternativen, Rollout-/Migrations-
-- konzept, API-Envelope-Spezifikation für weeks.data, offene Punkte).
--
-- Setzt additiv auf 001_init.sql .. 008_recipes.sql auf. Aendert zwei bestehende
-- Elemente: weeks.data verliert NOT NULL, und ZWEI Funktionen werden neu
-- angelegt statt per CREATE OR REPLACE aktualisiert, da sich ihr Rueckgabetyp
-- aendert (CREATE OR REPLACE reicht dafuer laut Postgres nicht aus):
-- auth_lookup_by_email und (Nachtrag, zweite Fassung) auth_lookup_recovery_wrap.
-- Alle anderen Elemente sind reine Neuanlagen. Laeuft ueber den bestehenden
-- migrate()-Mechanismus (Owner-/Migrator-Rolle, BEGIN...COMMIT je Datei).
--
-- WICHTIG (siehe Begleitdokument Abschnitt 4.1): Diese Migration legt nur das
-- Schema an. Der eigentliche Verschluesselungsschritt bestehender Klartext-
-- Wochen ist NICHT Teil dieser Datei und kann serverseitig prinzipiell nicht
-- ausgefuehrt werden (der Haushalts-Schluessel liegt nie serverseitig vor) --
-- das ist ein clientseitiger Sweep-Vorgang, siehe Begleitdokument Abschnitt 4.2.
--
-- NACHTRAG (2026-09-06, zweite Fassung, nach A3CHs AP2.1-Umsetzung): zwei neue
-- Spalten auf household_key_wraps (recovery_verifier_salt/recovery_verifier_hash,
-- Abschnitt 2.2a -- schliesst A3CHs Lueckenfund zum "Passwort vergessen"-Flow)
-- sowie eine dokumentarische COMMENT-Ergaenzung zu households.template_data
-- (Abschnitt 2.1a, bestaetigt A3CHs bereits produktiv umgesetzten JSON-Envelope,
-- kein DDL-Wechsel).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. households.encryption_status -- Zustandsautomat fuer den Rollout je
--    Haushalt (Begleitdokument Abschnitt 2.5/4.2). Rein additiv, nullable waere
--    hier falsch: JEDER Haushalt hat einen wohldefinierten Zustand, daher
--    NOT NULL mit Default 'plaintext' (heutiger De-facto-Zustand aller
--    Bestandshaushalte).
-- ----------------------------------------------------------------------------
ALTER TABLE households
  ADD COLUMN IF NOT EXISTS encryption_status text NOT NULL DEFAULT 'plaintext';

ALTER TABLE households
  ADD CONSTRAINT households_encryption_status_valid
    CHECK (encryption_status IN ('plaintext', 'activating', 'active'));

COMMENT ON COLUMN households.encryption_status IS
  'Rollout-Zustand der Verschluesselung dieses Haushalts. plaintext: weeks.data '
  'ausschliesslich Klartext (heutiger Bestand). activating: Haushalts-Schluessel '
  'existiert, aber noch nicht jedes aktive Mitglied hat einen echten password-'
  'Wrap (siehe household_key_wraps). active: jedes aktive Mitglied hat einen '
  'password-Wrap; weeks-Zeilen duerfen ab hier verschluesselt geschrieben '
  'werden. Uebergaenge ausschliesslich vorwaerts, kein Rueckfall auf plaintext '
  'nach active (siehe ap1.2-datenmodell.md Abschnitt 4.3).';

-- KORREKTUR (gefunden waehrend AP2.1-Umsetzung/Docker-Testlauf, A3CH): 005_admin_foundation.sql
-- Abschnitt 3 hat wochenplan_app das TABELLEN-weite UPDATE auf households vollstaendig entzogen
-- und durch ein Spalten-Grant nur auf (name, template_data, migrated_from_instance, migrated_at)
-- ersetzt (siehe dortige ausfuehrliche Begruendung zu Tabellen- vs. Spalten-ACLs). Diese Migration
-- fuegt mit encryption_status eine NEUE Spalte hinzu, die genau demselben, bereits erprobten
-- Update-Zweck dient (App-seitig beim Verschluesselungs-Bootstrap gesetzt, siehe /api/auth/
-- register in server.js) -- ohne dieses explizite Spalten-Grant schlaegt jedes UPDATE, das
-- encryption_status setzt, mit "permission denied for table households" fehl (live verifiziert).
GRANT UPDATE (encryption_status) ON households TO wochenplan_app;

-- ----------------------------------------------------------------------------
-- 1b. households.template_data -- KEINE Strukturaenderung. Nachtrag
--     (ap1.2-datenmodell.md Abschnitt 2.1a): A3CH hat bereits produktiv einen
--     JSON-Envelope in dieser bestehenden, nullable jsonb-Spalte umgesetzt
--     (Format: {__enc:true, nonce, ciphertext, keyVersion}) statt eigenmaechtig
--     neue Spalten zu entwerfen. Bewusst KEIN additives bytea-Spaltenpaar wie
--     bei weeks.data (Abschnitt 2.1) -- template_data ist ein Singleton-Feld je
--     Haushalt (kein Bulk-Volumen, kein Migrations-Uebergangszustand ueber
--     viele Zeilen), daher faellt hier weder der Base64-Overhead noch der
--     Vorteil eines expliziten CHECK-Constraints praktisch ins Gewicht. Diese
--     Migration bestaetigt das Format nur dokumentarisch, aendert kein DDL.
-- ----------------------------------------------------------------------------
COMMENT ON COLUMN households.template_data IS
  'NULL: keine Vorlage gesetzt. Objekt OHNE Top-Level-Schluessel __enc: Legacy-'
  'Klartext-Vorlage (Bestandsformat vor Verschluesselungsumstellung). Objekt MIT '
  '__enc:true: Ciphertext-Envelope {__enc:true, nonce, ciphertext, keyVersion} '
  '(base64-kodierte AEAD-Bytes) -- ausschliesslich clientseitig entschluesselbar. '
  'A3CH: beim Schreiben einer Klartext-Vorlage serverseitig zurueckweisen, falls '
  'das eingehende JSON bereits einen Top-Level-Schluessel __enc enthaelt '
  '(Schutz vor Zustands-Verwechslung, kein Krypto-Constraint noetig, siehe '
  'ap1.2-datenmodell.md Abschnitt 2.1a).';

-- ----------------------------------------------------------------------------
-- 2. weeks: additive Parallel-Spalten statt Umbau der Bestandsspalte
--    (ap1.2-datenmodell.md Abschnitt 2.1). data bleibt fuer Legacy-Klartext-
--    Zeilen bestehen, verliert aber NOT NULL, da eine verschluesselte Zeile
--    NULL hier stehen hat. XOR-CHECK verhindert jeden inkonsistenten
--    Zwischenzustand (weder halb-geschriebene Ciphertext-Zeilen noch
--    gleichzeitig Klartext+Ciphertext).
-- ----------------------------------------------------------------------------
ALTER TABLE weeks
  ALTER COLUMN data DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS data_ciphertext bytea,
  ADD COLUMN IF NOT EXISTS data_nonce      bytea,
  ADD COLUMN IF NOT EXISTS key_version     smallint;

ALTER TABLE weeks
  ADD CONSTRAINT weeks_plaintext_xor_ciphertext
    CHECK (
      (data IS NOT NULL AND data_ciphertext IS NULL AND data_nonce IS NULL AND key_version IS NULL)
      OR
      (data IS NULL AND data_ciphertext IS NOT NULL AND data_nonce IS NOT NULL AND key_version IS NOT NULL)
    );

COMMENT ON COLUMN weeks.data IS
  'Legacy-Klartext-Wochendokument. NULL sobald diese Zeile clientseitig '
  'verschluesselt und ueber PUT /api/weeks/:monday zurueckgeschrieben wurde '
  '(data_ciphertext dann NOT NULL, siehe weeks_plaintext_xor_ciphertext).';
COMMENT ON COLUMN weeks.data_ciphertext IS
  'AEAD-Ciphertext (XChaCha20-Poly1305 oder AES-256-GCM, siehe AP1.1) des '
  'vollstaendigen Wochendokuments. Ausschliesslich clientseitig entschluesselbar '
  '-- der Server transportiert diese Bytes ausschliesslich, ohne sie jemals zu '
  'interpretieren.';
COMMENT ON COLUMN weeks.data_nonce IS
  'AEAD-Nonce zu data_ciphertext. Muss je Verschluesselungsvorgang eindeutig '
  'sein (clientseitig frisch erzeugt), niemals wiederverwendet werden.';
COMMENT ON COLUMN weeks.key_version IS
  'Welche Generation des Haushalts-Schluessels (siehe household_key_wraps.'
  'key_version) diese Zeile verschluesselt hat. Aktuell immer 1 (keine Rotation '
  'implementiert) -- Vorbereitung fuer kuenftige Krypto-Migrationen, kein DB-'
  'Constraint gegen eine zentrale Schluessel-Registry, da eine solche aktuell '
  'nicht existiert (siehe ap1.2-datenmodell.md Abschnitt 6.1 im Begleitdokument, '
  'dort als offener Erweiterungspunkt vermerkt).';

-- ----------------------------------------------------------------------------
-- 3. household_key_wraps -- der Haushalts-Schluessel selbst existiert NIE als
--    eigene Datenbankzeile; gespeichert werden ausschliesslich die Wraps
--    (ap1.2-datenmodell.md Abschnitt 2.2).
--
--    Drei wrap_type-Faelle:
--      'password'      -- mit dem aus dem aktuellen Passwort abgeleiteten
--                         Schluessel gewrappt. Genau eine aktive Zeile je
--                         Nutzer (user_id gesetzt, invite_code NULL).
--      'recovery_code' -- mit dem aus dem einmalig angezeigten Wieder-
--                         herstellungscode abgeleiteten Schluessel gewrappt.
--                         NUTZERENTSCHEIDUNG (2026-09-06): EIN gemeinsamer Code
--                         je HAUSHALT, nicht je Nutzer (user_id UND invite_code
--                         beide NULL -- die Zeile ist ausschliesslich ueber
--                         household_id adressiert). Siehe Begleitdokument
--                         Abschnitt 2.2 fuer die damit verbundene bewusste
--                         Sicherheitskonsequenz (geteiltes Geheimnis fuer den
--                         gesamten Haushalt).
--      'pending'       -- Uebergangs-Wrap fuer zwei Faelle: neu eingeladenes
--                         Mitglied vor eigener Registrierung (invite_code
--                         gesetzt, user_id NULL) oder Bestandsmitglied ohne
--                         eigenen Wrap waehrend des Verschluesselungs-Rollouts
--                         (user_id gesetzt, invite_code NULL). Wird beim
--                         jeweils ersten eigenen Login durch einen regulaeren
--                         password-Wrap ersetzt (revoked_at gesetzt statt
--                         geloescht, Nachvollziehbarkeit).
--
--    KRITISCH (ap1.2-datenmodell.md Abschnitt 2.3): Das fuer 'pending'-Zeilen
--    verwendete Aktivierungsgeheimnis wird HIER NIRGENDS gespeichert -- weder
--    im Klartext noch gehasht. Es existiert ausschliesslich clientseitig
--    (z. B. als URL-Fragment, das Browser nie an den Server senden). Ein
--    falsches Geheimnis fuehrt beim clientseitigen AEAD-Unwrap-Versuch
--    automatisch zu einem Authentifizierungsfehler -- keine serverseitige
--    Verifikation noetig oder vorgesehen.
-- ----------------------------------------------------------------------------
CREATE TABLE household_key_wraps (
  id              bigserial   PRIMARY KEY,
  household_id    bigint      NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  user_id         bigint      REFERENCES users(id) ON DELETE CASCADE,
  invite_code     text        REFERENCES invites(code) ON DELETE CASCADE,
  wrap_type       text        NOT NULL,
  key_version     smallint    NOT NULL DEFAULT 1,
  wrapped_key     bytea       NOT NULL,
  wrap_nonce      bytea       NOT NULL,
  kdf_salt        bytea       NOT NULL,
  kdf_algo        text        NOT NULL DEFAULT 'argon2id',
  kdf_time_cost   integer     NOT NULL,
  kdf_memory_cost integer     NOT NULL,
  kdf_parallelism integer     NOT NULL,
  -- Nachtrag (Recovery-Verifier, ap1.2-datenmodell.md Abschnitt 2.2a): NUR bei
  -- wrap_type='recovery_code' gesetzt, siehe household_key_wraps_verifier_shape
  -- unten. Ein zweiter, unabhaengiger Argon2id-Output desselben Wiederherstel-
  -- lungscodes (eigenes Salt, gleiche Kostenparameter wie kdf_time_cost/
  -- kdf_memory_cost/kdf_parallelism oben) -- ermoeglicht dem Server, die Kenntnis
  -- des Codes zu pruefen, OHNE wrap_key oder den Haushalts-Schluessel je zu
  -- sehen (Domain-Separation ueber getrenntes Salt, nicht ueber denselben KDF-
  -- Output). recovery_verifier_hash ist der SHA-256-Digest des vom Client
  -- gesendeten rohen verifier-Werts -- serverseitig gehasht, exakt wie
  -- users.password_hash, NIE roh gespeichert und NIE an den Client zurueckgegeben.
  recovery_verifier_salt bytea,
  recovery_verifier_hash bytea,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz,
  revoked_at      timestamptz
);

ALTER TABLE household_key_wraps
  ADD CONSTRAINT household_key_wraps_type_valid
    CHECK (wrap_type IN ('password', 'recovery_code', 'pending')),
  ADD CONSTRAINT household_key_wraps_subject_shape
    -- pending: genau EINS von user_id/invite_code (XOR ueber Boolean-<>).
    -- password: immer user_id gesetzt, invite_code NULL (der Nutzer existiert
    -- in diesem Fall bereits).
    -- recovery_code: WEDER user_id NOCH invite_code gesetzt -- haushaltsweiter
    -- Wrap (Nutzerentscheidung 2026-09-06), adressiert ausschliesslich ueber
    -- household_id, siehe ap1.2-datenmodell.md Abschnitt 2.2.
    CHECK (
      (wrap_type = 'pending' AND ((user_id IS NOT NULL) <> (invite_code IS NOT NULL)))
      OR
      (wrap_type = 'password' AND user_id IS NOT NULL AND invite_code IS NULL)
      OR
      (wrap_type = 'recovery_code' AND user_id IS NULL AND invite_code IS NULL)
    );

-- Nachtrag (ap1.2-datenmodell.md Abschnitt 2.2a): Recovery-Verifier-Spalten sind
-- GENAU dann gesetzt, wenn wrap_type='recovery_code' ist -- fuer password/pending
-- ergibt ein Verifier keinen Sinn (dort entscheidet bcrypt bzw. das clientseitige
-- Aktivierungsgeheimnis ueber Autorisierung, kein serverseitig prufbarer Wert noetig).
ALTER TABLE household_key_wraps
  ADD CONSTRAINT household_key_wraps_verifier_shape
    CHECK (
      (wrap_type = 'recovery_code'
        AND recovery_verifier_salt IS NOT NULL AND recovery_verifier_hash IS NOT NULL)
      OR
      (wrap_type <> 'recovery_code'
        AND recovery_verifier_salt IS NULL AND recovery_verifier_hash IS NULL)
    );

-- Je Nutzer und Zweck maximal eine AKTIVE Zeile (password/pending-fuer-
-- Bestandsmitglied laufen ueber user_id).
CREATE UNIQUE INDEX household_key_wraps_member_active_uidx
  ON household_key_wraps (user_id, wrap_type)
  WHERE revoked_at IS NULL AND user_id IS NOT NULL;

-- Je Invite-Code maximal eine AKTIVE pending-Zeile (neu eingeladenes Mitglied
-- vor eigener Registrierung).
CREATE UNIQUE INDEX household_key_wraps_invite_pending_uidx
  ON household_key_wraps (invite_code)
  WHERE revoked_at IS NULL AND invite_code IS NOT NULL;

-- Je Haushalt maximal EINE aktive recovery_code-Zeile (haushaltsweiter Code,
-- Nutzerentscheidung 2026-09-06) -- unabhaengig von user_id/invite_code, die
-- fuer diesen wrap_type ohnehin immer beide NULL sind.
CREATE UNIQUE INDEX household_key_wraps_household_recovery_uidx
  ON household_key_wraps (household_id)
  WHERE revoked_at IS NULL AND wrap_type = 'recovery_code';

CREATE INDEX household_key_wraps_household_idx ON household_key_wraps (household_id);

COMMENT ON TABLE household_key_wraps IS
  'Verpackte (AEAD-verschluesselte) Kopien des Haushalts-Schluessels je Nutzer '
  'und Zweck. Der Haushalts-Schluessel selbst wird NIE als eigene Zeile '
  'gespeichert und erreicht den Server nie im Klartext (auch nicht kurzzeitig) '
  '-- siehe ap1.2-datenmodell.md.';
COMMENT ON COLUMN household_key_wraps.kdf_time_cost IS
  'Argon2id-Parameter zum Zeitpunkt DIESES Wraps, nicht als globale Konstante '
  '-- Kryptoagilitaet: aeltere Wraps bleiben mit ihren urspruenglichen Parametern '
  'entschluesselbar, auch wenn kuenftige Wraps verschaerfte Parameter verwenden.';
COMMENT ON COLUMN household_key_wraps.expires_at IS
  'Nur fuer wrap_type=''pending'' relevant -- Housekeeping/Ablauf fuer nicht '
  'abgeschlossene Einladungen bzw. Bestandsmitglieder-Aktivierungen. NULL bei '
  'password/recovery_code (kein Ablauf).';
COMMENT ON COLUMN household_key_wraps.recovery_verifier_salt IS
  'NUR wrap_type=''recovery_code''. Salt fuer den zweiten, von wrap_key '
  'unabhaengigen Argon2id-Output desselben Wiederherstellungscodes '
  '(ap1.2-datenmodell.md Abschnitt 2.2a). Unkritisch, darf an den Client '
  'zurueckgegeben werden (wie kdf_salt auch).';
COMMENT ON COLUMN household_key_wraps.recovery_verifier_hash IS
  'NUR wrap_type=''recovery_code''. SHA-256-Digest des vom Client gesendeten '
  'rohen verifier-Werts -- ausschliesslich fuer den serverinternen, '
  'zeitkonstanten Vergleich beim Passwort-Reset (Abschnitt 7a). DARF NIEMALS '
  'in eine Client-Antwort (auch nicht GET /api/auth/recover) uebernommen werden.';

-- ----------------------------------------------------------------------------
-- 4. RLS auf household_key_wraps -- analog recipes/weeks (003_rls_policies.sql,
--    008_recipes.sql): household-weite Isolation reicht aus, die Einschraenkung
--    "nur die eigene Wrap-Zeile" erfolgt app-seitig ueber WHERE user_id=$self,
--    exakt wie bei weeks.updated_by (siehe ap1.2-datenmodell.md Abschnitt 2.4).
-- ----------------------------------------------------------------------------
ALTER TABLE household_key_wraps ENABLE ROW LEVEL SECURITY;
CREATE POLICY household_isolation ON household_key_wraps
  USING       (household_id = current_setting('app.current_household_id', true)::bigint)
  WITH CHECK  (household_id = current_setting('app.current_household_id', true)::bigint);

-- Bewusst KEIN FORCE ROW LEVEL SECURITY, gleiche Begruendung wie im Bestand:
-- Migrator-/Owner-Rolle bleibt unrestriktiert, wochenplan_app ist nicht
-- Eigentuemerin und unterliegt RLS automatisch auch ohne FORCE.

GRANT SELECT, INSERT, UPDATE, DELETE ON household_key_wraps TO wochenplan_app;
GRANT USAGE, SELECT ON SEQUENCE household_key_wraps_id_seq TO wochenplan_app;

-- ----------------------------------------------------------------------------
-- 5. auth_lookup_by_email neu anlegen (Rueckgabetyp aendert sich -- CREATE OR
--    REPLACE reicht dafuer laut Postgres nicht aus, DROP zuerst noetig).
--    Erweitert um den password-Wrap des gefundenen Nutzers per LEFT JOIN --
--    bewusst LEFT JOIN, nicht JOIN, damit Login fuer Haushalte in Zustand
--    'plaintext'/'activating' (noch kein password-Wrap fuer dieses Mitglied)
--    weiterhin funktioniert; die Wrap-Felder sind dann einfach NULL, das
--    Frontend erkennt daran "kein Krypto-Envelope aktiv fuer diesen Login".
--
--    Gleiche Haertung wie im Original (003_rls_policies.sql Abschnitt 4):
--    SECURITY DEFINER, search_path fest gepinnt, REVOKE ALL + gezieltes
--    GRANT EXECUTE ausschliesslich an wochenplan_app.
-- ----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS auth_lookup_by_email(text);

CREATE FUNCTION auth_lookup_by_email(p_email text)
RETURNS TABLE (
  id                bigint,
  name              text,
  email             text,
  role              text,
  password_hash     text,
  household_id      bigint,
  household_name    text,
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
-- 6. auth_lookup_recovery_wrap -- fuer den "Passwort vergessen"-Fluss: liefert
--    NUR den recovery_code-Wrap (kein password_hash, keine sonstigen
--    Kontodaten) zu einer E-Mail, ganz ohne Sitzungskontext. Gleiche
--    Haertung wie oben.
--
--    NUTZERENTSCHEIDUNG (2026-09-06): recovery_code ist haushaltsweit, nicht
--    an user_id gebunden (siehe household_key_wraps_subject_shape oben). Der
--    Lookup ermittelt daher zunaechst ueber die E-Mail das household_id des
--    anfragenden Nutzers und liefert dann den EINEN gemeinsamen Wrap dieses
--    Haushalts -- unabhaengig davon, welches Mitglied den Code eingibt.
--
--    NACHTRAG (ap1.2-datenmodell.md Abschnitt 2.2a/7a, schliesst A3CHs
--    AP2.1-Lueckenfund): liefert jetzt zusaetzlich recovery_verifier_salt UND
--    recovery_verifier_hash. WICHTIG FUER A3CH: recovery_verifier_salt darf an
--    den Client zurueckgegeben werden (z. B. in GET /api/auth/recover), aber
--    recovery_verifier_hash ist AUSSCHLIESSLICH fuer den serverinternen
--    Vergleich in POST /api/auth/password-reset bestimmt und darf NIE in eine
--    HTTP-Antwort an den Browser uebernommen werden -- Rueckgabetyp aendert
--    sich, daher DROP FUNCTION vor Neuanlage noetig (wie bei
--    auth_lookup_by_email oben).
-- ----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS auth_lookup_recovery_wrap(text);

CREATE FUNCTION auth_lookup_recovery_wrap(p_email text)
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
   WHERE lower(u.email) = lower(p_email)
$$;

REVOKE ALL ON FUNCTION auth_lookup_recovery_wrap(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_lookup_recovery_wrap(text) TO wochenplan_app;

-- ----------------------------------------------------------------------------
-- 7. invite_key_wrap_lookup -- fuer den Einladungs-Akzeptier-Flow: liefert den
--    pending-Wrap zu einem Invite-Code, ganz ohne Sitzungskontext (invites hat
--    laut 003_rls_policies.sql Abschnitt 3 bewusst KEINE RLS -- diese Funktion
--    ergaenzt dasselbe Prinzip fuer den zugehoerigen Wrap). Prueft Ablauf/
--    Nutzung des Invites selbst NICHT hier (bleibt Aufgabe des bestehenden
--    Invite-Accept-Handlers in server.js) -- reine Datenzulieferung.
-- ----------------------------------------------------------------------------
CREATE FUNCTION invite_key_wrap_lookup(p_invite_code text)
RETURNS TABLE (
  household_id    bigint,
  key_version     smallint,
  wrapped_key     bytea,
  wrap_nonce      bytea,
  kdf_salt        bytea,
  kdf_algo        text,
  kdf_time_cost   integer,
  kdf_memory_cost integer,
  kdf_parallelism integer
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT w.household_id,
         w.key_version, w.wrapped_key, w.wrap_nonce, w.kdf_salt,
         w.kdf_algo, w.kdf_time_cost, w.kdf_memory_cost, w.kdf_parallelism
    FROM household_key_wraps w
    JOIN invites i ON i.code = w.invite_code
   WHERE w.invite_code = p_invite_code
     AND w.wrap_type = 'pending'
     AND w.revoked_at IS NULL
     AND i.used_at IS NULL
     AND i.expires_at > now()
$$;

REVOKE ALL ON FUNCTION invite_key_wrap_lookup(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION invite_key_wrap_lookup(text) TO wochenplan_app;

-- ----------------------------------------------------------------------------
-- Explizit NICHT Teil dieser Migration (siehe ap1.2-datenmodell.md):
--   - Verschluesselung bestehender Klartext-weeks-Zeilen (clientseitiger
--     Sweep, kein DDL, kein serverseitiges Skript moeglich -- Abschnitt 4.1).
--   - Response-Envelope-Umstellung von GET/PUT/DELETE /api/weeks(/:monday)
--     (Abschnitt 6.1, AP2.1 A3CH).
--   - Umstellung der drei gezielten Schreibpfade (assign-recipe/
--     add-ingredient-to-list/set-meal-cell) auf vollen Lese-Aendern-Schreiben-
--     Zyklus fuer encryption_status='active'-Haushalte (Abschnitt 6.3, AP2.2).
--   - PUT /api/account/password-Endpunkt (Re-Wrap-Ablauf, Abschnitt 7).
--   - Bootstrap-/Aktivierungs-UX fuer Bestandsmitglieder ohne eigenen Wrap
--     (Abschnitt 4.2 Schritt 2, offener Klaerungsbedarf siehe Begleitdokument
--     Abschnitt 8).
--   - Finaler Cleanup-Schritt (data zusaetzlich zu data_ciphertext loeschen,
--     falls eine Karenzzeit gewuenscht wird -- Abschnitt 4.3/9 Punkt 3, mit
--     ZANDOR abzustimmen VOR AP2.1-Start).
--   - NEU: POST /api/auth/password-reset-Endpunkt (Passwort-Reset via
--     Wiederherstellungscode, Abschnitt 7a) -- diese Migration legt nur die
--     dafuer noetigen Spalten/Funktionsfelder an (recovery_verifier_salt/
--     recovery_verifier_hash, erweiterte auth_lookup_recovery_wrap), der
--     Endpunkt selbst inkl. Rate-Limiting ist A3CH-Implementierung.
-- ============================================================================
