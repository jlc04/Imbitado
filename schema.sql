-- EleganteRSVP — Cloudflare D1 schema

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  event_date TEXT,
  event_time TEXT,
  venue_name TEXT,
  venue_address TEXT,
  theme_json TEXT NOT NULL DEFAULT '{}',
  questions_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'draft',      -- 'draft' | 'published'
  owner_email TEXT,
  google_sheet_id TEXT,                       -- optional, for Sheets sync
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS responses (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id),
  answers_json TEXT NOT NULL,
  submitted_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_responses_event ON responses(event_id);

-- People allowed to view (not edit) a given event's dashboard
CREATE TABLE IF NOT EXISTS dashboard_access (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id),
  email TEXT NOT NULL,
  added_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_access_event ON dashboard_access(event_id);
