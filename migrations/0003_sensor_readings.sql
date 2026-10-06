-- Kegerator sensor readings: one row per measurement, kept as history so trends can be charted later.
-- sensor: what was measured ('fridge_temp_f', 'tap1_level_pct', 'tap2_level_pct'; see SENSORS in worker.js).
-- recorded_at: UTC, 'YYYY-MM-DD HH:MM:SS'. Readings older than 90 days are pruned on write.
-- Until real sensors are installed, readings are entered by hand from the site.
CREATE TABLE sensor_readings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sensor TEXT NOT NULL,
  value REAL NOT NULL,
  recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX sensor_readings_by_sensor ON sensor_readings (sensor, id);

-- Placeholder readings (not measured) so the display has something to show until the first real update.
INSERT INTO sensor_readings (sensor, value) VALUES
  ('fridge_temp_f', 37.5),
  ('tap1_level_pct', 65);
UPDATE taps SET level_pct = 65 WHERE id = 1;
