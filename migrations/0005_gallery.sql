-- "From the Counter" photos, shown in the scrolling strip under the hero logo.
-- photo_url: /photos/<key> for uploads (stored in R2, deleted with the row), or a static
--   /img/gallery/... path for the original four photos that used to be embedded in index.html.
-- caption: short handwritten-style label under the photo, optional.
CREATE TABLE gallery_photos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  photo_url TEXT NOT NULL,
  caption TEXT,
  added_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Inserted in reverse: the strip shows newest (highest id) first.
INSERT INTO gallery_photos (photo_url, caption) VALUES
  ('/img/gallery/spooky.jpg', 'the cellar gets spooky'),
  ('/img/gallery/pour.jpg', 'tonight''s pour'),
  ('/img/gallery/porch.jpg', 'two for the porch'),
  ('/img/gallery/julep.jpg', 'dressed up julep');
