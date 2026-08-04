-- Index corrections. Idempotent, and possible only because migrations are tracked
-- in a ledger rather than inferred from an "already applied" error string.

-- countLyricLines filters on `candidate` alone, so `candidate` has to lead or the
-- count degrades to a full scan of the corpus. It runs on /health, which is the one
-- route with no auth gate. (candidate, embedded) still serves the embed-queue
-- lookup as an exact seek, so this is strictly better for both queries.
DROP INDEX IF EXISTS idx_lyric_lines_embedded;
CREATE INDEX IF NOT EXISTS idx_lyric_lines_embedded ON lyric_lines(candidate, embedded);

-- bandLeaderboard groups by band_name but aggregates `vote`; without it in the
-- index, SQLite fetches one table row per post to read it.
DROP INDEX IF EXISTS idx_posts_band;
CREATE INDEX IF NOT EXISTS idx_posts_band ON posts(band_name, vote);

-- Indexes no query uses. Each one taxes writes on a hot path for nothing:
--   idx_posts_line   — the only line_id read is DOWNVOTED_LINE_IDS_SQL, already
--                      covered by idx_posts_vote_line(vote, line_id)
--   idx_runs_kind    — nothing filters runs by kind
--   idx_lyric_lines_song — redundant left prefix of idx_lyric_lines_pos(song_id, pos)
DROP INDEX IF EXISTS idx_posts_line;
DROP INDEX IF EXISTS idx_runs_kind;
DROP INDEX IF EXISTS idx_lyric_lines_song;
