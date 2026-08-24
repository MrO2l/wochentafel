-- Haushalte = Mandanten. Jede Familie ist ein Haushalt, Daten sind strikt getrennt.
CREATE TABLE households (
  id            bigserial PRIMARY KEY,
  name          text        NOT NULL,
  template_data jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id            bigserial PRIMARY KEY,
  household_id  bigint      NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  email         text        NOT NULL,
  name          text        NOT NULL,
  password_hash text        NOT NULL,
  role          text        NOT NULL DEFAULT 'member',
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_uidx    ON users (lower(email));
CREATE INDEX        users_household_idx ON users (household_id);

-- Eine Zeile pro Haushalt und Woche. Der Wochenplan liegt als strukturiertes
-- JSONB (keine rohen HTML-Fragmente), damit sich später auch auswerten laesst,
-- wie oft ein bestimmtes Piktogramm vorkommt.
CREATE TABLE weeks (
  id           bigserial PRIMARY KEY,
  household_id bigint      NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  week_start   date        NOT NULL,
  data         jsonb       NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  updated_by   bigint      REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (household_id, week_start)
);
CREATE INDEX weeks_household_idx ON weeks (household_id, week_start DESC);

CREATE TABLE invites (
  code         text PRIMARY KEY,
  household_id bigint      NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  created_by   bigint      REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  used_at      timestamptz,
  used_by      bigint      REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX invites_household_idx ON invites (household_id);

-- Sitzungsspeicher fuer connect-pg-simple
CREATE TABLE session (
  sid    varchar   NOT NULL COLLATE "default" PRIMARY KEY,
  sess   json      NOT NULL,
  expire timestamp(6) NOT NULL
);
CREATE INDEX session_expire_idx ON session (expire);
