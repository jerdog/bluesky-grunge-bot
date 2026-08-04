-- Splits "can be quoted as the headline of a post" from "can pad a passage".
-- Existing rows default to 1, preserving exactly the behaviour they had before
-- context-only lines existed.
ALTER TABLE lyric_lines ADD COLUMN candidate INTEGER NOT NULL DEFAULT 1;
