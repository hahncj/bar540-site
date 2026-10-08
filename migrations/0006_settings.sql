-- Small site-wide settings, one row per key. Values are text; the Worker knows each key's meaning.
-- bar_status: 'open' or 'closed', the neon sign in the hero. updated_at is when it was last flipped, so an
--   open sign reads as closed once BAR_AUTO_CLOSE_HOURS (worker.js) have passed without anyone flipping it.
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO settings (key, value) VALUES ('bar_status', 'closed');
