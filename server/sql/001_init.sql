CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  first_name TEXT NOT NULL DEFAULT '',
  last_name TEXT NOT NULL DEFAULT '',
  wwid TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL UNIQUE,
  phone TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL,
  is_assistant BOOLEAN NOT NULL DEFAULT FALSE,
  can_access_marketer BOOLEAN NOT NULL DEFAULT FALSE,
  can_access_admin BOOLEAN NOT NULL DEFAULT FALSE,
  can_access_manager BOOLEAN NOT NULL DEFAULT FALSE,
  manager_title TEXT NOT NULL DEFAULT '',
  manager_only BOOLEAN NOT NULL DEFAULT FALSE,
  department_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL DEFAULT 'active',
  is_locked BOOLEAN NOT NULL DEFAULT FALSE,
  password_hash TEXT NOT NULL,
  force_password_reset BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  active_role TEXT NOT NULL,
  manager_on_duty BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_sessions_revoked_at ON sessions(revoked_at);

CREATE TABLE IF NOT EXISTS snapshot_published_current (
  id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
  version INTEGER NOT NULL CHECK (version > 0),
  published_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  published_by_user_id TEXT NOT NULL REFERENCES users(id),
  payload JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS snapshot_draft (
  id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
  updated_at TIMESTAMPTZ NOT NULL,
  updated_by_user_id TEXT NOT NULL REFERENCES users(id),
  payload JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS snapshot_history (
  version INTEGER PRIMARY KEY CHECK (version > 0),
  published_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  published_by_user_id TEXT NOT NULL REFERENCES users(id),
  payload JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS bookings (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  snapshot_version INTEGER NOT NULL CHECK (snapshot_version > 0),
  revision INTEGER NOT NULL DEFAULT 1,
  working_by_user_id TEXT NULL,
  completed_by_user_id TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  row_data JSONB NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_bookings_status ON bookings(status);
CREATE INDEX IF NOT EXISTS idx_bookings_updated_at ON bookings(updated_at);

CREATE TABLE IF NOT EXISTS booking_events (
  id TEXT PRIMARY KEY,
  booking_id TEXT NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  actor_user_id TEXT NULL,
  actor_name TEXT NOT NULL DEFAULT '',
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_booking_events_booking_id ON booking_events(booking_id);
CREATE INDEX IF NOT EXISTS idx_booking_events_created_at ON booking_events(created_at);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  at TIMESTAMPTZ NOT NULL,
  action TEXT NOT NULL,
  actor_user_id TEXT NOT NULL DEFAULT '',
  actor_name TEXT NOT NULL DEFAULT '',
  target_type TEXT NOT NULL DEFAULT '',
  target_id TEXT NOT NULL DEFAULT '',
  details JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_audit_log_at ON audit_log(at DESC);

ALTER TABLE users ADD COLUMN IF NOT EXISTS force_password_reset BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS department_ids JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS manager_title TEXT NOT NULL DEFAULT '';
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS manager_on_duty BOOLEAN NOT NULL DEFAULT FALSE;
