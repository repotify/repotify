-- Repotify analytics (Cloudflare D1). No IP addresses, user agents or free text are stored.
CREATE TABLE IF NOT EXISTS events (
  event_id TEXT PRIMARY KEY,
  install_id TEXT NOT NULL,
  day TEXT NOT NULL,
  type TEXT NOT NULL,
  agent TEXT,
  version TEXT,
  catalog_version TEXT,
  project_type TEXT,
  stacks TEXT,
  needs TEXT,
  items TEXT,
  item TEXT,
  vote TEXT,
  ts TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_install_day ON events (install_id, day);

CREATE TABLE IF NOT EXISTS event_items (
  event_id TEXT NOT NULL,
  item TEXT NOT NULL,
  type TEXT NOT NULL,
  PRIMARY KEY (event_id, item)
);
CREATE INDEX IF NOT EXISTS event_items_item ON event_items (item, type);

-- One vote per install and item; the latest vote wins.
CREATE TABLE IF NOT EXISTS votes (
  install_id TEXT NOT NULL,
  item TEXT NOT NULL,
  vote TEXT NOT NULL,
  ts TEXT NOT NULL,
  PRIMARY KEY (install_id, item)
);
