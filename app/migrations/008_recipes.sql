-- ============================================================================
-- 008_recipes.sql
--
-- ENTWURF / VORLAGE für A3CH — MORROW, AP1.1 (Wochenplaner-Rezeptkarten)
-- Nicht ungeprüft übernehmen: A3CH prüft vor dem Einspielen, ob die
-- Dateinummer 008 zum Zeitpunkt der Umsetzung noch frei ist (Stand
-- Entwurf 2026-08-29: 001–007 bereits vergeben).
--
-- Begleitdokument: projects/wochenplaner-rezeptkarten/ap1.1-datenmodell.md
-- (ERD, Design-Entscheidungen inkl. verworfener Alternativen, Snapshot-
-- Format-Spezifikation für weeks.data, offene Punkte).
--
-- Setzt additiv auf 001_init.sql–007_admin_status_guards.sql auf. Ändert
-- kein bestehendes Schema-Element — reine CREATE-TABLE-Migration plus RLS
-- und Grants für die eingeschränkte Laufzeit-Rolle wochenplan_app (aus
-- 002_multi_tenant_foundation.sql). Läuft über den bestehenden
-- migrate()-Mechanismus (Owner-/Migrator-Rolle, BEGIN…COMMIT je Datei).
--
-- Enthält AUSDRÜCKLICH KEINE Änderung an weeks.data selbst: Die Verknüpfung
-- Grid-Zelle↔Rezept ist eine reine JSONB-Strukturerweiterung innerhalb der
-- bestehenden cleanWeek()/cleanMeals()/cleanTokens()-Validierung in
-- server.js (neuer Token-Typ 't':'recipe') — kein Migrations-DDL nötig,
-- siehe ap1.1-datenmodell.md Abschnitt 4. Der harte Wipe der bestehenden
-- Freitext-Zellen der "Essen & Kochen"-Zeile (F1) ist Teil von AP1.2
-- (A3CH), ebenfalls kein DDL-Bestandteil dieser Datei.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. recipes: Rezeptkarten als wiederverwendbare, household-gebundene
--    Stammdaten. Eigene Tabelle statt weiterer JSONB-Erweiterung in
--    weeks.data, weil Rezepte wochenübergreifend wiederverwendet werden
--    (Stammdaten-Charakter), siehe ap1.1-datenmodell.md Abschnitt 2.1.
--
--    ingredients als jsonb statt normalisierte Kindtabelle: Zutaten haben
--    keine eigenständige Identität außerhalb ihres Rezepts, keine
--    rezeptübergreifende Abfrage ist gefordert — jsonb passt zum in dieser
--    App bereits etablierten Idiom "strukturierte Liste als jsonb-Spalte,
--    von einer cleanX()-Funktion in server.js validiert" (motto/notes/
--    goals/highlights/calls in weeks.data folgen demselben Muster). Siehe
--    ap1.1-datenmodell.md Abschnitt 2.2 für die verworfene Alternative
--    (normalisierte recipe_ingredients-Tabelle).
--
--    image_path bewusst NUR ein flacher Dateiname (CHECK unten), KEIN Pfad
--    mit Verzeichnistrennzeichen — verhindert Pfadtraversal bereits auf
--    Schema-Ebene, unabhängig von der App-seitigen Validierung (AP2.1/
--    AP5.1). Der tatsächliche Storage-Ort (Verzeichnis/Volume) ist NICHT
--    Teil dieses Schemas — offener Punkt für AP2.1/ART3MIS, siehe
--    Begleitdokument Abschnitt 6.
-- ----------------------------------------------------------------------------
CREATE TABLE recipes (
  id            bigserial   PRIMARY KEY,
  household_id  bigint      NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  title         text        NOT NULL,
  base_servings integer     NOT NULL,
  instructions  text        NOT NULL DEFAULT '',
  ingredients   jsonb       NOT NULL DEFAULT '[]'::jsonb,
  image_path    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  created_by    bigint      REFERENCES users(id) ON DELETE SET NULL,
  updated_by    bigint      REFERENCES users(id) ON DELETE SET NULL
);

ALTER TABLE recipes
  ADD CONSTRAINT recipes_base_servings_range
    CHECK (base_servings BETWEEN 1 AND 20),          -- F3: Pflichtfeld, 1-20
  ADD CONSTRAINT recipes_title_length
    CHECK (char_length(title) BETWEEN 1 AND 200),
  ADD CONSTRAINT recipes_instructions_length
    CHECK (char_length(instructions) <= 20000),
  ADD CONSTRAINT recipes_ingredients_is_array
    CHECK (jsonb_typeof(ingredients) = 'array'),
  ADD CONSTRAINT recipes_image_path_flat_filename
    -- Nur Dateiname (Buchstaben/Ziffern/._-), kein '/', kein '..', keine
    -- Laufwerksangabe -- verhindert Pfadtraversal unabhaengig von der
    -- App-Validierung. AP2.1 generiert den gespeicherten Namen serverseitig
    -- (z. B. household_id + Rezept-id + uuid + Endung), NICHT aus dem vom
    -- Client hochgeladenen Originaldateinamen.
    --
    -- ZANDOR-Review (AP5.1, Fund 3): das urspruengliche Muster schloss '/'
    -- aus, verbot aber nicht den Sonderfall, dass der gesamte Wert nur aus
    -- Punkten besteht ('.' oder '..') -- diese Konstellation waere fuer
    -- sich genommen kein absoluter/verzeichnisuebergreifender Pfad, aber
    -- unerwuenscht als Dateiname. Der negative Lookahead (?!\.{1,2}$)
    -- schliesst genau diese beiden Werte explizit aus. Da image_path
    -- ausschliesslich serverseitig ueber generateImageFilename()
    -- (UUID-basiert) gesetzt wird, aktuell nicht ausnutzbar -- reine
    -- Defense-in-Depth-Haertung, siehe server.js FLAT_FILENAME_RE
    -- (identisches Muster, zweite unabhaengige Pruefung beim Ausliefern).
    --
    -- Direkt in dieser Datei (statt additiver Folgemigration) korrigiert:
    -- 008_recipes.sql ist zum Zeitpunkt dieses Fixes noch nicht committet
    -- (git-Status: untracked) und lief bislang ausschliesslich auf
    -- isolierten, kurzlebigen Docker-Testinstanzen -- keine produktive oder
    -- sonst geteilte Instanz hat diese Migration bereits eingespielt. Damit
    -- gilt das etablierte additive Migrationsmuster der App hier nicht:
    -- eine noch unveroeffentlichte Entwurfsmigration darf vor ihrem ersten
    -- Commit/Rollout noch angepasst werden, statt eine 009-Folgemigration
    -- fuer eine reine Haertung eines Fund vor Erstauslieferung zu erzeugen.
    CHECK (image_path IS NULL OR image_path ~ '^(?!\.{1,2}$)[A-Za-z0-9_.-]{1,255}$');

COMMENT ON TABLE recipes IS
  'Wiederverwendbare Rezeptkarten je Haushalt (Stammdaten). Zutatenliste '
  'bezieht sich auf base_servings; Zuweisungen in weeks.data speichern '
  'einen unabhaengigen Snapshot (F6), siehe ap1.1-datenmodell.md.';
COMMENT ON COLUMN recipes.base_servings IS
  'Referenz-Personenzahl, auf die sich ingredients bezieht (F3: 1-20, Pflicht).';
COMMENT ON COLUMN recipes.ingredients IS
  'jsonb-Array [{amount:number|null, unit:text, name:text}, ...], bezogen '
  'auf base_servings. Validierung (Laenge/Anzahl) app-seitig in server.js '
  '(cleanX()-Muster analog cleanGoals()/cleanCalls()), siehe Begleitdokument.';
COMMENT ON COLUMN recipes.image_path IS
  'Nur Dateiname (kein Pfad), kein Blob in der DB. Storage-Ort/Volume: '
  'offener Punkt AP2.1/ART3MIS. Format-/Groessenlimit (F4) wird beim '
  'Upload app-seitig durchgesetzt, nicht hier im Schema.';

CREATE INDEX recipes_household_title_idx ON recipes (household_id, title);

-- ----------------------------------------------------------------------------
-- 2. RLS: household-gebunden, analog users/weeks (003_rls_policies.sql) —
--    EINE Policy fuer alle Befehle ausreichend, weil household_id bei jedem
--    Schreibpfad bereits vor dem INSERT/UPDATE bekannt ist (angemeldete
--    Haushalts-Session, kein Henne-Ei-Problem wie bei households selbst).
-- ----------------------------------------------------------------------------
ALTER TABLE recipes ENABLE ROW LEVEL SECURITY;
CREATE POLICY household_isolation ON recipes
  USING       (household_id = current_setting('app.current_household_id', true)::bigint)
  WITH CHECK  (household_id = current_setting('app.current_household_id', true)::bigint);

-- Bewusst KEIN FORCE ROW LEVEL SECURITY, gleiche Begruendung wie in
-- 003_rls_policies.sql: Migrator-/Owner-Rolle bleibt unrestriktiert (fuer
-- migrate() und etwaige kuenftige Konsolidierungs-/Exportwerkzeuge analog
-- export-tenant.mjs/import-tenant.mjs), wochenplan_app ist nicht
-- Eigentuemerin und unterliegt RLS automatisch auch ohne FORCE.

-- ----------------------------------------------------------------------------
-- 3. Rechte fuer wochenplan_app. Durch die bereits in
--    002_multi_tenant_foundation.sql gesetzten ALTER DEFAULT PRIVILEGES
--    greifen diese Rechte fuer eine neue, von derselben Migrator-/
--    Owner-Rolle angelegte Tabelle bereits automatisch -- trotzdem explizit
--    wiederholt (gleiches Vorgehen wie in 006_admin_audit_log.sql/
--    007_admin_status_guards.sql begruendet): diese Datei bleibt dadurch
--    unabhaengig von einer genauen Kenntnis des Vorzustands sicher anwendbar.
-- ----------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON recipes TO wochenplan_app;
GRANT USAGE, SELECT ON SEQUENCE recipes_id_seq TO wochenplan_app;

-- ----------------------------------------------------------------------------
-- Explizit NICHT Teil dieser Migration:
--   - Aenderung an weeks.data / cleanWeek() / cleanMeals() / cleanTokens()
--     (neuer Token-Typ 't':'recipe' fuer die Snapshot-Zuweisung) -- reine
--     App-Validierungslogik in server.js, kein DDL. Spezifikation siehe
--     ap1.1-datenmodell.md Abschnitt 4. Umsetzung: AP3.1 (A3CH).
--   - Harter Wipe der bestehenden Freitext-Zellen der "Essen & Kochen"-Zeile
--     (F1) -- Teil von AP1.2 (A3CH), kein Schema-Bestandteil.
--   - Bild-Upload-Endpunkt, Speicherpfad-Konvention, Volume/Backup -- AP2.1
--     (A3CH) bzw. AP-ART3MIS (Infrastruktur-Bedarf), siehe Begleitdokument.
-- ============================================================================
