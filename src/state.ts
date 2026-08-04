import type { Env } from "./env";
import { DOWNVOTED_LINE_IDS_SQL } from "./analytics";

// ---- KV-backed state ---------------------------------------------------------

const K_SESSION = "bsky:session";
const K_CURSOR = "bsky:notif_cursor";

/**
 * How long a dedupe flag lives. Shared by reply-dedupe and original-post
 * repeat-avoidance because they answer the same question: how long before this
 * item may resurface.
 */
const DEDUPE_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

export interface StoredSession {
  accessJwt: string;
  refreshJwt: string;
  did: string;
  handle: string;
}

export async function loadSession(env: Env): Promise<StoredSession | null> {
  return env.STATE.get<StoredSession>(K_SESSION, "json");
}

export async function saveSession(env: Env, s: StoredSession): Promise<void> {
  await env.STATE.put(K_SESSION, JSON.stringify(s));
}

export async function clearSession(env: Env): Promise<void> {
  await env.STATE.delete(K_SESSION);
}

export async function getNotifCursor(env: Env): Promise<string | undefined> {
  return (await env.STATE.get(K_CURSOR)) ?? undefined;
}

export async function setNotifCursor(env: Env, cursor: string): Promise<void> {
  await env.STATE.put(K_CURSOR, cursor);
}

/** A namespaced set of expiring KV flags — one shape for both dedupe uses. */
function kvFlag(prefix: string) {
  const key = (id: string) => `${prefix}:${id}`;
  return {
    async has(env: Env, id: string): Promise<boolean> {
      return (await env.STATE.get(key(id))) !== null;
    },
    async set(env: Env, id: string): Promise<void> {
      await env.STATE.put(key(id), "1", { expirationTtl: DEDUPE_TTL_SECONDS });
    },
  };
}

const handledNotifications = kvFlag("handled");
const recentlyPostedLines = kvFlag("recent");

/** Dedupe replies: has this notification already been answered? */
export const isHandled = (env: Env, uri: string) => handledNotifications.has(env, uri);
export const markHandled = (env: Env, uri: string) => handledNotifications.set(env, uri);

/** Avoid repeating the same line in original posts too often. */
export const wasRecentlyPosted = (env: Env, lineId: string) => recentlyPostedLines.has(env, lineId);
export const markRecentlyPosted = (env: Env, lineId: string) =>
  recentlyPostedLines.set(env, lineId);

// ---- D1 helpers --------------------------------------------------------------

export interface LyricLineRow {
  id: string;
  song_id: number;
  band_name: string;
  song_title: string;
  line: string;
  char_len: number;
  embedded: number;
  pos: number | null;
  candidate: number;
}

/** Upsert and return the id in one round trip (see also analytics.startRun). */
export async function upsertBand(env: Env, name: string, mbid?: string): Promise<number> {
  const row = await env.DB.prepare(
    `INSERT INTO bands (name, mbid) VALUES (?, ?)
     ON CONFLICT(name) DO UPDATE SET mbid = COALESCE(excluded.mbid, bands.mbid)
     RETURNING id`,
  )
    .bind(name, mbid ?? null)
    .first<{ id: number }>();
  return row!.id;
}

export async function upsertSong(
  env: Env,
  bandId: number,
  title: string,
  source: string,
  fetchedAt: number,
): Promise<number> {
  const row = await env.DB.prepare(
    `INSERT INTO songs (band_id, title, source, fetched_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(band_id, title) DO UPDATE SET source = excluded.source, fetched_at = excluded.fetched_at
     RETURNING id`,
  )
    .bind(bandId, title, source, fetchedAt)
    .first<{ id: number }>();
  return row!.id;
}

/**
 * A prepared insert for one lyric line. Returns the statement rather than running
 * it so callers can hand many to `env.DB.batch()` in a single round trip.
 * `char_len` is derived here so call sites don't carry it.
 *
 * Conflicts update `pos`/`candidate` instead of doing nothing, so a rebuild
 * backfills ordering onto rows that predate it without disturbing `embedded` —
 * re-embedding a line whose text hasn't changed would be pure waste.
 */
export const LYRIC_LINE_INSERT_SQL = `INSERT INTO lyric_lines
     (id, song_id, band_name, song_title, line, char_len, embedded, pos, candidate)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)
     ON CONFLICT(id) DO UPDATE SET pos = excluded.pos, candidate = excluded.candidate`;

export function lyricLineInsert(
  env: Env,
  row: Pick<LyricLineRow, "id" | "song_id" | "band_name" | "song_title" | "line"> & {
    pos: number;
    candidate: boolean;
  },
): D1PreparedStatement {
  return env.DB.prepare(LYRIC_LINE_INSERT_SQL).bind(
    row.id,
    row.song_id,
    row.band_name,
    row.song_title,
    row.line,
    row.line.length,
    row.pos,
    row.candidate ? 1 : 0,
  );
}

/**
 * The other half of "is this line usable", beside DOWNVOTED_LINE_IDS_SQL. Shared
 * for the same reason: a new query that reads lyric_lines should inherit the rule
 * rather than have to remember it, or it will start matching on two-word
 * interjections. Deliberately NOT applied by `getPassageContext` — a context-only
 * line is exactly what passages are padded with.
 */
export const CANDIDATE_LINE_SQL = `candidate = 1`;

/**
 * "This line doesn't know where it sits in the song", so it can never be grown
 * into a passage. Shared for the same reason as the two predicates above, and one
 * sharper: `getUnpositionedSongs` selects on it and `dropUnpositionedLines`
 * deletes on it, so a divergence between those two removes rows the backfill never
 * meant to touch. `countUnpositionedSongs` (the backfill's convergence signal) and
 * `countLyricLines` (the dashboard's passage-ready badge) are complements of this
 * one rule and must stay so.
 */
export const UNPOSITIONED_LINE_SQL = `pos IS NULL`;

/** Lines awaiting a vector. Context-only lines are never embedded or matched. */
export async function getUnembeddedLines(env: Env, limit: number): Promise<LyricLineRow[]> {
  const res = await env.DB.prepare(
    `SELECT * FROM lyric_lines WHERE embedded = 0 AND ${CANDIDATE_LINE_SQL} LIMIT ?`,
  )
    .bind(limit)
    .all<LyricLineRow>();
  return res.results ?? [];
}

export interface UnpositionedSong {
  song_id: number;
  band_name: string;
  song_title: string;
}

/**
 * Songs that still have lines with no known position.
 *
 * Re-seeding can't reliably reach these: track titles come from MusicBrainz, whose
 * result set isn't stable between runs, so a plain `seed --force` re-fetches an
 * arbitrary subset and may never revisit the song you care about. These rows name
 * the exact (band, title) pairs to ask for, so the backfill converges.
 */
export async function getUnpositionedSongs(
  env: Env,
  limit: number,
): Promise<UnpositionedSong[]> {
  const res = await env.DB.prepare(
    `SELECT song_id, band_name, song_title
       FROM lyric_lines WHERE ${UNPOSITIONED_LINE_SQL}
      GROUP BY song_id ORDER BY song_id LIMIT ?`,
  )
    .bind(limit)
    .all<UnpositionedSong>();
  return res.results ?? [];
}

export async function countUnpositionedSongs(env: Env): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(DISTINCT song_id) AS n FROM lyric_lines WHERE ${UNPOSITIONED_LINE_SQL}`,
  ).first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * Statement dropping a song's lines that the source no longer returns.
 *
 * A line the re-fetch didn't produce can still be matched from Vectorize but can
 * never be given a position, so it would be retried forever and the backfill would
 * never converge.
 *
 * The signature carries its own safety rather than delegating it to a caller: it
 * takes the ids that came back and deletes by exclusion, and it throws on an empty
 * list. A previous version took only `songId` and relied on a doc comment saying
 * "callers MUST only invoke this when the re-fetch returned lines" — under which a
 * transient API failure deletes an entire song. That guard is now unconstructible
 * to get wrong.
 *
 * Returned as a statement so it joins the same `batch()` as the inserts: "still
 * position-less" is only true once those have landed.
 */
export function dropUnpositionedLines(
  env: Env,
  songId: number,
  keepIds: string[],
): D1PreparedStatement {
  if (keepIds.length === 0) {
    throw new Error("dropUnpositionedLines: refusing to delete a whole song's lines");
  }
  return env.DB
    .prepare(
      `DELETE FROM lyric_lines
        WHERE song_id = ? AND ${UNPOSITIONED_LINE_SQL}
          AND id NOT IN (SELECT value FROM json_each(?))`,
    )
    .bind(songId, JSON.stringify(keepIds));
}

/**
 * Every band the corpus actually holds lines for — which is not the same set as
 * `data/bands.json`. That file is the *input* to a corpus build; removing a name
 * from it stops future harvesting and does nothing to what was already ingested.
 */
export async function getCorpusBandNames(env: Env): Promise<string[]> {
  const res = await env.DB.prepare(`SELECT DISTINCT band_name FROM lyric_lines`).all<{
    band_name: string;
  }>();
  return (res.results ?? []).map((r) => r.band_name);
}

/** A band's line ids, which are also its Vectorize vector ids. */
export async function getLineIdsForBand(env: Env, band: string): Promise<string[]> {
  const res = await env.DB.prepare(`SELECT id FROM lyric_lines WHERE band_name = ?`)
    .bind(band)
    .all<{ id: string }>();
  return (res.results ?? []).map((r) => r.id);
}

/**
 * Erase a band from D1: its lines, its songs, its `bands` row, and its fetch-cache
 * stamps.
 *
 * The cache stamps matter as much as the rows. `buildCorpus` skips any song whose
 * key is still fresh, so a band deleted but left cached would silently re-ingest
 * *nothing* if it were added back inside the 30-day TTL — the confusing inverse of
 * the bug this function exists to fix.
 *
 * `posts` deliberately keeps its rows. It is the analytics record of what the bot
 * actually said, and rewriting history to match a config change would be a lie.
 */
export const DELETE_BAND_LINES_SQL = `DELETE FROM lyric_lines WHERE band_name = ?`;
export const DELETE_BAND_SONGS_SQL = `DELETE FROM songs WHERE band_id IN (SELECT id FROM bands WHERE name = ?)`;
export const DELETE_BAND_ROW_SQL = `DELETE FROM bands WHERE name = ?`;
/**
 * Cache keys are `source:artist:title`, all lower-cased, so the band is the
 * middle segment. Anchoring on both colons keeps a band name from matching a
 * song title that happens to contain it.
 */
export const DELETE_BAND_CACHE_SQL = `DELETE FROM fetch_cache WHERE cache_key LIKE '%:' || ? || ':%' ESCAPE '\\'`;

/** Escape LIKE metacharacters, which a band name would otherwise smuggle in. */
export const likeLiteral = (s: string): string => s.replace(/[\\%_]/g, (c) => `\\${c}`);

export async function deleteBand(env: Env, band: string): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(DELETE_BAND_LINES_SQL).bind(band),
    env.DB.prepare(DELETE_BAND_SONGS_SQL).bind(band),
    env.DB.prepare(DELETE_BAND_ROW_SQL).bind(band),
    env.DB.prepare(DELETE_BAND_CACHE_SQL).bind(likeLiteral(band.toLowerCase())),
  ]);
}

export interface PassageContext {
  /** Position of the matched line itself, or null if this row predates ordering. */
  matchPos: number | null;
  lines: Array<{ line: string; pos: number }>;
}

/**
 * The matched line plus its neighbours in the same song, for building a passage.
 *
 * One query, resolved by joining the table to itself on the match's id: the window
 * is a range scan over (song_id, pos). Downvoted lines are excluded here, at the
 * source, so a retired line can't reappear as someone else's context — the same
 * rule `getRandomLyricLines` applies, for the same reason.
 *
 * Returns `matchPos: null` for a line stored before positions existed; the caller
 * degrades to quoting that line alone.
 */
export const PASSAGE_CONTEXT_SQL = `SELECT n.line AS line, n.pos AS pos, m.pos AS match_pos
       FROM lyric_lines m
       JOIN lyric_lines n ON n.song_id = m.song_id
      WHERE m.id = ?
        AND m.pos IS NOT NULL
        AND n.pos BETWEEN m.pos - ? AND m.pos + ?
        AND n.id NOT IN (${DOWNVOTED_LINE_IDS_SQL})
      ORDER BY n.pos`;

export async function getPassageContext(
  env: Env,
  lineId: string,
  window: number,
): Promise<PassageContext> {
  const res = await env.DB.prepare(PASSAGE_CONTEXT_SQL)
    .bind(lineId, window, window)
    .all<{ line: string; pos: number; match_pos: number }>();

  const rows = res.results ?? [];
  return {
    matchPos: rows[0]?.match_pos ?? null,
    lines: rows.map((r) => ({ line: r.line, pos: r.pos })),
  };
}

/**
 * Flag lines as embedded. Uses json_each rather than an `IN (?,?,...)` list so the
 * batch size isn't capped by D1's 100-bound-parameter limit.
 */
export async function markLinesEmbedded(env: Env, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await env.DB.prepare(
    `UPDATE lyric_lines SET embedded = 1 WHERE id IN (SELECT value FROM json_each(?))`,
  )
    .bind(JSON.stringify(ids))
    .run();
}

/**
 * Random eligible lines for original posts.
 *
 * Eligibility is enforced here rather than by each caller: lines whose posts were
 * downvoted are excluded in SQL (predicate owned by analytics.ts), so any future
 * line consumer inherits the filter for free.
 *
 * Picks by range-scanning from a random point in the primary key instead of
 * `ORDER BY RANDOM()`, which would read and sort every row. Line ids are FNV-1a
 * hex, so they're uniformly distributed across the key space; the scan wraps when
 * it lands near the end.
 */
export async function getRandomLyricLines(env: Env, limit = 16): Promise<LyricLineRow[]> {
  const n = Math.max(1, limit);
  const sql = (cmp: string) =>
    `SELECT * FROM lyric_lines
     WHERE embedded = 1 AND ${CANDIDATE_LINE_SQL} AND id ${cmp} ? AND id NOT IN (${DOWNVOTED_LINE_IDS_SQL})
     ORDER BY id LIMIT ?`;

  // Random 8-hex-digit cursor, matching the id prefix format.
  const cursor = Math.floor(Math.random() * 0x100000000)
    .toString(16)
    .padStart(8, "0");

  const first = await env.DB.prepare(sql(">")).bind(cursor, n).all<LyricLineRow>();
  const rows = first.results ?? [];
  if (rows.length >= n) return rows;

  // Near the end of the key space — wrap around to pick up the remainder.
  const rest = await env.DB.prepare(sql("<=")).bind(cursor, n - rows.length).all<LyricLineRow>();
  return [...rows, ...(rest.results ?? [])];
}

export interface CorpusSize {
  /** Matchable lines. Candidates only — context-only rows would inflate this. */
  lines: number;
  /**
   * How many of those know their position in the song. A line without one can
   * only ever be quoted alone, so this is the share of the corpus that can
   * actually produce a passage. Rows harvested before positions existed sit at 0
   * until `cf.sh backfill` re-fetches their song.
   */
  positioned: number;
}

/** Both counts in one query — the dashboard and /health each want them together. */
export async function countLyricLines(env: Env): Promise<CorpusSize> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS lines, COUNT(pos) AS positioned
       FROM lyric_lines WHERE ${CANDIDATE_LINE_SQL}`,
  ).first<CorpusSize>();
  return { lines: row?.lines ?? 0, positioned: row?.positioned ?? 0 };
}

/**
 * Every cache key still inside its TTL, as one query.
 *
 * A corpus build asks about (2 sources x N songs) keys — 1,264 at the current band
 * list. Asked one at a time that is 1,264 serial round trips, paid in full even on a
 * fully-warm cache where the answer is "nothing to do". Resolving the set once per
 * run and threading it down follows the same rule as settings.
 */
export async function getFreshFetchKeys(
  env: Env,
  ttlSeconds: number,
  now: number,
): Promise<Set<string>> {
  const res = await env.DB.prepare(`SELECT cache_key FROM fetch_cache WHERE fetched_at >= ?`)
    .bind(now - ttlSeconds)
    .all<{ cache_key: string }>();
  return new Set((res.results ?? []).map((r) => r.cache_key));
}

const FETCH_CACHE_UPSERT_SQL = `INSERT INTO fetch_cache (cache_key, status, fetched_at)
     VALUES (?, ?, ?)
     ON CONFLICT(cache_key) DO UPDATE SET status = excluded.status, fetched_at = excluded.fetched_at`;

/** Prepared cache stamp, so a song's stamps can join the same batch as its lines. */
export function fetchCachedInsert(
  env: Env,
  cacheKey: string,
  status: "hit" | "miss",
  now: number,
): D1PreparedStatement {
  return env.DB.prepare(FETCH_CACHE_UPSERT_SQL).bind(cacheKey, status, now);
}
