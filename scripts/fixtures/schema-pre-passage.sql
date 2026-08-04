-- D1 schema for the grunge lyrics Bluesky bot.
-- Stores band/song metadata, short candidate lyric lines (for internal matching only),
-- and a fetch cache so we don't re-hit lyrics APIs. Only short snippets are ever posted.

CREATE TABLE IF NOT EXISTS bands (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL UNIQUE,
  mbid          TEXT,                         -- optional MusicBrainz artist id
  active        INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS songs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  band_id       INTEGER NOT NULL REFERENCES bands(id) ON DELETE CASCADE,
  title         TEXT NOT NULL,
  source        TEXT,                         -- 'lrclib' | 'lyrics.ovh' | ...
  fetched_at    INTEGER,                      -- unix seconds
  UNIQUE (band_id, title)
);

-- One short candidate line per row. Kept internal; used to build the Vectorize index.
CREATE TABLE IF NOT EXISTS lyric_lines (
  id            TEXT PRIMARY KEY,             -- stable hash id, also the Vectorize vector id
  song_id       INTEGER NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
  band_name     TEXT NOT NULL,
  song_title    TEXT NOT NULL,
  line          TEXT NOT NULL,                -- a single short line (<= SNIPPET_MAX_CHARS)
  char_len      INTEGER NOT NULL,
  embedded      INTEGER NOT NULL DEFAULT 0    -- 1 once upserted into Vectorize
);

CREATE INDEX IF NOT EXISTS idx_lyric_lines_song ON lyric_lines(song_id);
CREATE INDEX IF NOT EXISTS idx_lyric_lines_embedded ON lyric_lines(embedded);

-- Cache of raw API responses keyed by "source:artist:title" so refreshes are cheap
-- and rate-limit friendly. Cleared/expired by fetched_at.
CREATE TABLE IF NOT EXISTS fetch_cache (
  cache_key     TEXT PRIMARY KEY,
  status        TEXT NOT NULL,                -- 'hit' | 'miss'
  fetched_at    INTEGER NOT NULL
);

-- ---------------------------------------------------------------------------
-- Analytics / dashboard
-- ---------------------------------------------------------------------------

-- Every post and reply the bot composes, including dry-run ones (dry_run = 1),
-- so the dashboard can show what *would* have gone out before you go live.
CREATE TABLE IF NOT EXISTS posts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  uri           TEXT,                         -- at:// uri; NULL for dry runs
  cid           TEXT,
  kind          TEXT NOT NULL,                -- 'reply' | 'original'
  text          TEXT NOT NULL,                -- exactly what was posted
  line_id       TEXT,                         -- lyric_lines.id that produced it
  band_name     TEXT,
  song_title    TEXT,
  vector_score  REAL,                         -- Vectorize similarity
  rerank_score  REAL,                         -- cross-encoder relevance
  pick_reason   TEXT,                         -- why the LLM chose this line
  text_model    TEXT,
  -- Reply context
  reply_to_uri  TEXT,
  reply_to_handle TEXT,
  reply_to_text TEXT,
  dry_run       INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,             -- unix seconds
  -- Feedback: -1 downvote, 0 unrated, 1 upvote
  vote          INTEGER NOT NULL DEFAULT 0,
  voted_at      INTEGER
);

-- Matches the dashboard's ORDER BY created_at DESC, id DESC (the id tiebreaker is
-- part of the index so paging doesn't force a sort).
CREATE INDEX IF NOT EXISTS idx_posts_created ON posts(created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_posts_kind ON posts(kind);
-- Covering index for the downvote-exclusion lookup, which runs on every poll and
-- every original post: the projected line_id is served from the index itself.
CREATE INDEX IF NOT EXISTS idx_posts_vote_line ON posts(vote, line_id);
CREATE INDEX IF NOT EXISTS idx_posts_line ON posts(line_id);
-- Supports the band leaderboard's GROUP BY.
CREATE INDEX IF NOT EXISTS idx_posts_band ON posts(band_name);
CREATE UNIQUE INDEX IF NOT EXISTS idx_posts_uri ON posts(uri) WHERE uri IS NOT NULL;

-- One row per cron firing or manual trigger, for run analytics.
-- Duration is derived from (finished_at - started_at); not stored separately.
CREATE TABLE IF NOT EXISTS runs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  kind          TEXT NOT NULL,                -- 'poll' | 'post' | 'refresh' | manual action
  trigger       TEXT NOT NULL,                -- 'cron' | 'manual'
  started_at    INTEGER NOT NULL,
  finished_at   INTEGER,
  ok            INTEGER,                      -- 1 success, 0 failure
  stats         TEXT,                         -- JSON blob of per-run counters
  error         TEXT
);

CREATE INDEX IF NOT EXISTS idx_runs_started ON runs(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_runs_kind ON runs(kind);
