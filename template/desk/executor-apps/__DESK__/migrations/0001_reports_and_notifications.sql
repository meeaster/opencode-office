CREATE TABLE reports (
  id TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX reports_created ON reports (created_at);

-- seq orders the outbox: readers ask for rows after the last seq they saw.
CREATE TABLE notifications (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  report_id TEXT REFERENCES reports (id),
  created_at INTEGER NOT NULL,
  read_at INTEGER
);
