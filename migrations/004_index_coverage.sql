-- Two indexes that stopped covering the queries they were built for. Verified with
-- EXPLAIN QUERY PLAN against schema.sql, before and after.

-- (candidate, embedded) lost its covering property when countLyricLines started
-- also selecting COUNT(pos) for the passage-ready badge — `pos` isn't in the index,
-- so the count went back to one table lookup per candidate line, on the unauthed
-- /health route. Adding `id` additionally lets getRandomLyricLines do the range
-- scan its comment describes: previously the planner took this index for the seek
-- and then sorted every matching row (USE TEMP B-TREE FOR ORDER BY) to satisfy
-- ORDER BY id, which is exactly the full sort that design exists to avoid.
--   count  -> USING INDEX          becomes USING COVERING INDEX
--   random -> + USE TEMP B-TREE    becomes a plain (candidate, embedded, id>?) seek
--   embed queue is unchanged: still an exact two-column seek.
DROP INDEX IF EXISTS idx_lyric_lines_embedded;
CREATE INDEX IF NOT EXISTS idx_lyric_lines_embedded
  ON lyric_lines(candidate, embedded, id, pos);

-- getSummary reads `ok` for every run in the last 24h; with started_at alone that
-- is a table lookup per run, on every dashboard render, and it grows with poll
-- frequency. `posts` already got this treatment and `runs` never did. The DESC
-- prefix still serves listRuns' ordering.
DROP INDEX IF EXISTS idx_runs_started;
CREATE INDEX IF NOT EXISTS idx_runs_started ON runs(started_at DESC, ok);
