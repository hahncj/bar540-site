-- The two kegerator taps. Exactly two rows; the site edits them in place rather than adding/removing.
-- status: 'pouring' or 'empty'. An empty tap keeps its last beer so the page can say what kicked.
-- level_pct: how much is left in the keg (0-100), NULL when unknown. Set by hand for now; a flow
--   meter or keg scale can write it later.
-- tapped_on: ISO date (YYYY-MM-DD) the current keg went on, optional.
CREATE TABLE taps (
  id INTEGER PRIMARY KEY CHECK (id IN (1, 2)),
  status TEXT NOT NULL DEFAULT 'empty' CHECK (status IN ('pouring', 'empty')),
  beer TEXT,
  brewery TEXT,
  style TEXT,
  abv REAL,
  level_pct INTEGER CHECK (level_pct BETWEEN 0 AND 100),
  tapped_on TEXT,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO taps (id, status, beer, brewery, style, abv) VALUES
  (1, 'pouring', 'Blue Moon', 'Blue Moon Brewing Company', 'Belgian-style wheat ale', 5.4),
  (2, 'empty', NULL, NULL, NULL, NULL);
