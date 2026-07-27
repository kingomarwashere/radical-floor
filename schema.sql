-- The Floor — message archive + room registry
-- Live message state lives inside each Room Durable Object's SQLite;
-- this D1 is the durable cross-room archive + the registry of known rooms.

CREATE TABLE IF NOT EXISTS rooms (
  id          TEXT PRIMARY KEY,          -- 'square' | 'p_<proposalId>'
  kind        TEXT NOT NULL,             -- 'square' | 'proposal'
  topic       TEXT,                      -- human label (proposal text snippet)
  ref_id      TEXT,                      -- proposal id for proposal rooms
  created_at  INTEGER NOT NULL,
  last_active INTEGER NOT NULL,
  msg_count   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_rooms_active ON rooms(last_active DESC);

CREATE TABLE IF NOT EXISTS messages (
  id        TEXT PRIMARY KEY,
  room_id   TEXT NOT NULL,
  user_id   TEXT NOT NULL,
  name      TEXT NOT NULL,
  avatar    TEXT,
  body      TEXT NOT NULL,
  ts        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_room ON messages(room_id, ts DESC);
