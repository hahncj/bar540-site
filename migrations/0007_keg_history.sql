-- Kicked kegs, for the "Past Pours" list and the kegs-kicked count. A row is written when a pouring
-- tap is marked tapped out or gets a different beer (see PUT /api/taps/:id in worker.js).
-- tapped_on: the date the keg went on (YYYY-MM-DD), if it was known.
-- kicked_at: UTC 'YYYY-MM-DD HH:MM:SS' when it came off.
CREATE TABLE keg_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tap_id INTEGER NOT NULL,
  beer TEXT NOT NULL,
  brewery TEXT,
  style TEXT,
  abv REAL,
  tapped_on TEXT,
  kicked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
