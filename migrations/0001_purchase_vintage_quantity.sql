-- Baseline (created by hand before migrations were tracked):
--   CREATE TABLE bottles (id INTEGER PRIMARY KEY AUTOINCREMENT,
--     category TEXT NOT NULL CHECK (category IN ('whiskey','wine','beer')),
--     name TEXT NOT NULL, maker TEXT, notes TEXT, abv REAL, photo_url TEXT,
--     added_at TEXT DEFAULT CURRENT_TIMESTAMP);

-- purchased_on: ISO date (YYYY-MM-DD), optional.
-- vintage: year, optional; the form only offers it for wine.
-- quantity: how many of this bottle are on hand; existing rows become 1.
ALTER TABLE bottles ADD COLUMN purchased_on TEXT;
ALTER TABLE bottles ADD COLUMN vintage INTEGER;
ALTER TABLE bottles ADD COLUMN quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity >= 1);
