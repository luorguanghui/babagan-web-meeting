CREATE TABLE meetings (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  password_hash TEXT,
  status TEXT NOT NULL CHECK (status IN ('created', 'active', 'grace', 'ended', 'expired')),
  share_identity TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK (expires_at >= created_at),
  empty_since INTEGER,
  ended_at INTEGER,
  version INTEGER NOT NULL CHECK (version >= 0)
);

CREATE UNIQUE INDEX one_non_terminal_meeting
ON meetings ((1)) WHERE status IN ('created', 'active', 'grace');

CREATE TABLE host_sessions (
  id TEXT PRIMARY KEY,
  meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK (expires_at >= created_at),
  revoked_at INTEGER
);

CREATE INDEX host_sessions_meeting_id ON host_sessions (meeting_id);

CREATE TABLE participant_sessions (
  identity TEXT PRIMARY KEY,
  meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  nickname TEXT NOT NULL CHECK (length(nickname) BETWEEN 1 AND 40),
  token_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE INDEX participant_sessions_meeting_id ON participant_sessions (meeting_id);

CREATE TABLE join_reservations (
  identity TEXT PRIMARY KEY,
  meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  nickname TEXT NOT NULL CHECK (length(nickname) BETWEEN 1 AND 40),
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK (expires_at >= issued_at)
);

CREATE INDEX reservation_expiry
ON join_reservations (meeting_id, expires_at);

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  meeting_id TEXT REFERENCES meetings(id) ON DELETE SET NULL,
  subject_id TEXT,
  occurred_at INTEGER NOT NULL,
  metadata_json TEXT NOT NULL
);

CREATE INDEX audit_events_meeting_id ON audit_events (meeting_id, occurred_at);

CREATE TABLE processed_webhooks (
  event_id TEXT NOT NULL,
  processed_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX one_processed_webhook
ON processed_webhooks (event_id);
