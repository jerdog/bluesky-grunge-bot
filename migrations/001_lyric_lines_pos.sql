-- Line ordering within a song, so replies can quote a contiguous passage rather
-- than one line. See schema.sql for what it means and why gaps matter.
--
-- Existing rows get NULL, which is handled rather than backfilled: a line with no
-- known position degrades to a single-line quote. Real positions arrive on the next
-- corpus rebuild, because the lines *around* a match were never stored at all — no
-- backfill could invent them.
ALTER TABLE lyric_lines ADD COLUMN pos INTEGER;
