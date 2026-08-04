import { isDryRun, nowSeconds, type Env } from "./env";
import { FALLBACK_REASON } from "./ai";

// Recording and querying of runs, posts, and feedback for the dashboard.
// This module owns the `posts` and `runs` tables; nothing else should embed their
// schema in SQL (see DOWNVOTED_LINE_IDS_SQL for the one predicate others need).

/**
 * The single definition of "this lyric line was panned". Exported as a SQL
 * fragment so the line source in state.ts can filter in-query, while
 * `getDownvotedLineIds` serves the Vectorize path that can't express it — one
 * rule, two required forms, defined together so a new rule can't land in only one.
 */
export const DOWNVOTED_LINE_IDS_SQL =
  `SELECT line_id FROM posts WHERE vote = -1 AND line_id IS NOT NULL`;

/**
 * Run an analytics write for its effect only, never for its failure.
 *
 * "Analytics must never break the work" is the rule; making it a wrapper makes it
 * structural, so a new write inherits it instead of having to remember a
 * try/catch. `recordPost` is why this matters most: it runs *after* the post is
 * already published, so a D1 hiccup there would throw out of the reply loop,
 * leave the mention unmarked and the cursor unadvanced, and the next poll would
 * reply to it a second time — a visible duplicate caused by bookkeeping.
 *
 * `setVote` deliberately does NOT use this: it reports success back to a person
 * clicking a button, so its failure has to be visible.
 */
async function bestEffort<T>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    console.error(`analytics ${label} failed (ignored):`, err);
    return fallback;
  }
}

export type PostKind = "reply" | "original";
export type Vote = -1 | 0 | 1;

export const isVote = (v: unknown): v is Vote => v === -1 || v === 0 || v === 1;

export interface RecordPostInput {
  uri?: string;
  cid?: string;
  kind: PostKind;
  text: string;
  lineId?: string;
  bandName?: string;
  songTitle?: string;
  vectorScore?: number;
  rerankScore?: number;
  pickReason?: string;
  textModel?: string;
  replyToUri?: string;
  replyToHandle?: string;
  replyToText?: string;
}

export interface PostRow {
  id: number;
  uri: string | null;
  cid: string | null;
  kind: PostKind;
  text: string;
  line_id: string | null;
  band_name: string | null;
  song_title: string | null;
  vector_score: number | null;
  rerank_score: number | null;
  pick_reason: string | null;
  text_model: string | null;
  reply_to_uri: string | null;
  reply_to_handle: string | null;
  reply_to_text: string | null;
  dry_run: number;
  created_at: number;
  vote: number;
  voted_at: number | null;
}

export interface RunRow {
  id: number;
  kind: string;
  trigger: string;
  started_at: number;
  /** Null while running. Duration is derived from the two timestamps. */
  finished_at: number | null;
  ok: number | null;
  stats: string | null;
  error: string | null;
}

// ---- writes ------------------------------------------------------------------

/**
 * Insert one composed post, ignoring a repeat of the same uri.
 * `dry_run` and `created_at` are derived in recordPost, not asked of callers.
 *
 * `idx_posts_uri` is a PARTIAL unique index (`WHERE uri IS NOT NULL`, so dry runs
 * — which have no uri — can all be recorded). SQLite only matches a conflict
 * target to a partial index when the index's predicate is repeated here; without
 * the WHERE clause it raises "ON CONFLICT clause does not match any PRIMARY KEY
 * or UNIQUE constraint". Exported so a test can run it against the real schema.
 */
export const RECORD_POST_SQL = `INSERT INTO posts (
       uri, cid, kind, text, line_id, band_name, song_title,
       vector_score, rerank_score, pick_reason, text_model,
       reply_to_uri, reply_to_handle, reply_to_text, dry_run, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(uri) WHERE uri IS NOT NULL DO NOTHING`;

export async function recordPost(env: Env, p: RecordPostInput): Promise<void> {
  await bestEffort(
    "recordPost",
    () =>
      env.DB.prepare(RECORD_POST_SQL)
        .bind(
          ...[
            p.uri, p.cid, p.kind, p.text, p.lineId, p.bandName, p.songTitle,
            p.vectorScore, p.rerankScore, p.pickReason, p.textModel,
            p.replyToUri, p.replyToHandle, p.replyToText,
          ].map((v) => v ?? null),
          isDryRun(env) ? 1 : 0,
          nowSeconds(),
        )
        .run(),
    undefined,
  );
}

async function startRun(env: Env, kind: string, trigger: Trigger): Promise<number | null> {
  return bestEffort(
    "startRun",
    async () => {
      const res = await env.DB.prepare(
        `INSERT INTO runs (kind, trigger, started_at) VALUES (?, ?, ?) RETURNING id`,
      )
        .bind(kind, trigger, nowSeconds())
        .first<{ id: number }>();
      return res?.id ?? null;
    },
    null,
  );
}

async function finishRun(
  env: Env,
  id: number | null,
  ok: boolean,
  stats?: unknown,
  error?: string,
): Promise<void> {
  if (id == null) return;
  await bestEffort(
    "finishRun",
    () =>
      env.DB.prepare(`UPDATE runs SET finished_at = ?, ok = ?, stats = ?, error = ? WHERE id = ?`)
        .bind(
          nowSeconds(),
          ok ? 1 : 0,
          stats === undefined ? null : JSON.stringify(stats),
          error ?? null,
          id,
        )
        .run(),
    undefined,
  );
}

export type Trigger = "cron" | "manual";

/**
 * Run `fn` with a run record around it: one place that owns opening the row,
 * timing, logging, and closing it on both success and failure. Both the cron and
 * the manual HTTP path go through this so run accounting can't drift between them.
 * Re-throws so callers can shape their own response.
 */
export async function withRun<T>(
  env: Env,
  kind: string,
  trigger: Trigger,
  fn: () => Promise<T>,
): Promise<T> {
  const id = await startRun(env, kind, trigger);
  try {
    const result = await fn();
    console.log(`${trigger}:${kind}`, JSON.stringify(result ?? null));
    await finishRun(env, id, true, result);
    return result;
  } catch (err) {
    console.error(`${trigger}:${kind} failed`, err);
    await finishRun(env, id, false, undefined, String(err));
    throw err;
  }
}

/** Record a 👍 (1), 👎 (-1) or clear (0). Returns true if a row was updated. */
export async function setVote(env: Env, postId: number, vote: Vote): Promise<boolean> {
  const res = await env.DB.prepare(`UPDATE posts SET vote = ?, voted_at = ? WHERE id = ?`)
    .bind(vote, vote === 0 ? null : nowSeconds(), postId)
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

// ---- reads -------------------------------------------------------------------

export interface Summary {
  totalPosts: number;
  replies: number;
  originals: number;
  upvotes: number;
  downvotes: number;
  avgRerank: number | null;
  /** Replies where the LLM produced nothing usable and the reranker's top won. */
  fallbackPicks: number;
  lastPostAt: number | null;
  runs24h: number;
  failures24h: number;
}

export async function getSummary(env: Env, now: number): Promise<Summary> {
  // Two independent reads — issued concurrently rather than in series.
  const [p, r] = await Promise.all([
    env.DB.prepare(
      `SELECT
         COUNT(*)                                          AS total,
         SUM(CASE WHEN kind = 'reply' THEN 1 ELSE 0 END)   AS replies,
         SUM(CASE WHEN kind = 'original' THEN 1 ELSE 0 END) AS originals,
         SUM(CASE WHEN vote = 1 THEN 1 ELSE 0 END)         AS up,
         SUM(CASE WHEN vote = -1 THEN 1 ELSE 0 END)        AS down,
         AVG(rerank_score)                                 AS avg_rerank,
         MAX(created_at)                                   AS last_at,
         -- Replies whose line came from the reranker because the model gave no
         -- usable answer. A high share means the pick stage is not working; it is
         -- otherwise invisible, since a fallback reply still reads fine.
         SUM(CASE WHEN kind = 'reply' AND pick_reason = ? THEN 1 ELSE 0 END) AS fallbacks
       FROM posts`,
    )
      .bind(FALLBACK_REASON)
      .first<Record<string, number | null>>(),
    env.DB.prepare(
      `SELECT COUNT(*) AS n, SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END) AS failed
       FROM runs WHERE started_at >= ?`,
    )
      .bind(now - 86_400)
      .first<{ n: number; failed: number | null }>(),
  ]);

  return {
    totalPosts: p?.total ?? 0,
    replies: p?.replies ?? 0,
    originals: p?.originals ?? 0,
    upvotes: p?.up ?? 0,
    downvotes: p?.down ?? 0,
    avgRerank: p?.avg_rerank ?? null,
    fallbackPicks: p?.fallbacks ?? 0,
    lastPostAt: p?.last_at ?? null,
    runs24h: r?.n ?? 0,
    failures24h: r?.failed ?? 0,
  };
}

export interface PostFilter {
  kind?: PostKind;
  vote?: Vote;
  search?: string;
  limit?: number;
  offset?: number;
}

/**
 * Parse and validate the filter query params. Shared by the dashboard and
 * /api/posts so a new filter reaches both views at once — the same reason
 * `postsWhere` is shared between listing and counting.
 */
export function parsePostFilter(url: URL): PostFilter {
  const kind = url.searchParams.get("kind");
  const vote = Number.parseInt(url.searchParams.get("vote") ?? "", 10);
  return {
    kind: kind === "reply" || kind === "original" ? kind : undefined,
    vote: isVote(vote) ? vote : undefined,
    search: url.searchParams.get("q") || undefined,
  };
}

/** Inverse of parsePostFilter — the two together keep param names in one place. */
export function postFilterToQuery(f: PostFilter): URLSearchParams {
  const q = new URLSearchParams();
  if (f.search) q.set("q", f.search);
  if (f.kind) q.set("kind", f.kind);
  // Explicit undefined check: vote 0 ("unrated") is a real filter.
  if (f.vote !== undefined) q.set("vote", String(f.vote));
  return q;
}

/** True when any filter is actually applied (note: vote 0 is a real filter). */
export function isFiltered(f: PostFilter): boolean {
  return f.kind !== undefined || f.vote !== undefined || f.search !== undefined;
}

/** Build the shared WHERE clause so listing and counting can't drift apart. */
function postsWhere(f: PostFilter): { clause: string; binds: unknown[] } {
  const where: string[] = [];
  const binds: unknown[] = [];

  if (f.kind) {
    where.push("kind = ?");
    binds.push(f.kind);
  }
  if (f.vote !== undefined) {
    where.push("vote = ?");
    binds.push(f.vote);
  }
  if (f.search) {
    where.push("(text LIKE ? OR band_name LIKE ? OR song_title LIKE ? OR reply_to_handle LIKE ?)");
    const like = `%${f.search}%`;
    binds.push(like, like, like, like);
  }

  return { clause: where.length ? `WHERE ${where.join(" AND ")}` : "", binds };
}

export async function listPosts(env: Env, f: PostFilter = {}): Promise<PostRow[]> {
  const { clause, binds } = postsWhere(f);
  const limit = Math.min(Math.max(f.limit ?? 50, 1), 200);
  const offset = Math.max(f.offset ?? 0, 0);

  const res = await env.DB.prepare(
    `SELECT * FROM posts ${clause} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
  )
    .bind(...binds, limit, offset)
    .all<PostRow>();
  return res.results ?? [];
}

/** Total rows matching the same filter, for pagination. */
export async function countPosts(env: Env, f: PostFilter = {}): Promise<number> {
  const { clause, binds } = postsWhere(f);
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM posts ${clause}`)
    .bind(...binds)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export interface RunFilter {
  /** An ACTIONS name, or any manual `/run/<x>`; free-form because both feed it. */
  kind?: string;
  /** true = succeeded, false = failed. Unfinished runs have ok NULL and are neither. */
  ok?: boolean;
}

export function parseRunFilter(url: URL): RunFilter {
  const status = url.searchParams.get("run");
  return {
    kind: url.searchParams.get("runKind") || undefined,
    ok: status === "ok" ? true : status === "failed" ? false : undefined,
  };
}

/** Inverse of parseRunFilter — the pair keeps the param names in one place. */
export function runFilterToQuery(f: RunFilter): URLSearchParams {
  const q = new URLSearchParams();
  if (f.kind) q.set("runKind", f.kind);
  if (f.ok !== undefined) q.set("run", f.ok ? "ok" : "failed");
  return q;
}

export const isRunFiltered = (f: RunFilter): boolean =>
  f.kind !== undefined || f.ok !== undefined;

export async function listRuns(env: Env, limit = 20, filter: RunFilter = {}): Promise<RunRow[]> {
  const where: string[] = [];
  const binds: unknown[] = [];
  if (filter.kind) {
    where.push("kind = ?");
    binds.push(filter.kind);
  }
  if (filter.ok !== undefined) {
    // `ok IS NOT NULL` matters: a run still in flight is neither a success nor a
    // failure, and counting it as failed would make every in-progress poll look bad.
    where.push("ok IS NOT NULL AND ok = ?");
    binds.push(filter.ok ? 1 : 0);
  }
  const res = await env.DB.prepare(
    `SELECT * FROM runs
     ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY started_at DESC, id DESC LIMIT ?`,
  )
    .bind(...binds, Math.min(Math.max(limit, 1), 100))
    .all<RunRow>();
  return res.results ?? [];
}

/** Distinct run kinds actually present, so the filter offers only real options. */
export async function runKinds(env: Env): Promise<string[]> {
  const res = await env.DB.prepare(
    `SELECT DISTINCT kind FROM runs ORDER BY kind`,
  ).all<{ kind: string }>();
  return (res.results ?? []).map((r) => r.kind);
}

/**
 * Lyric lines that produced a downvoted post. Matching excludes these so a 👎
 * actually changes future behaviour instead of just being recorded.
 */
export async function getDownvotedLineIds(env: Env): Promise<Set<string>> {
  // A failure here un-retires downvoted lines for this run rather than dropping
  // the reply — degraded, not broken, and the fallback says so.
  return bestEffort(
    "getDownvotedLineIds",
    async () => {
      const res = await env.DB.prepare(DOWNVOTED_LINE_IDS_SQL).all<{ line_id: string }>();
      return new Set((res.results ?? []).map((r) => r.line_id));
    },
    new Set<string>(),
  );
}

/** Per-band vote tallies — which bands land and which don't. */
export async function bandLeaderboard(
  env: Env,
  limit = 10,
): Promise<Array<{ band: string; posts: number; up: number; down: number }>> {
  const res = await env.DB.prepare(
    `SELECT band_name AS band,
            COUNT(*) AS posts,
            SUM(CASE WHEN vote = 1 THEN 1 ELSE 0 END) AS up,
            SUM(CASE WHEN vote = -1 THEN 1 ELSE 0 END) AS down
     FROM posts WHERE band_name IS NOT NULL
     GROUP BY band_name
     ORDER BY (SUM(CASE WHEN vote = 1 THEN 1 ELSE 0 END) - SUM(CASE WHEN vote = -1 THEN 1 ELSE 0 END)) DESC,
              COUNT(*) DESC
     LIMIT ?`,
  )
    .bind(limit)
    .all<{ band: string; posts: number; up: number; down: number }>();
  return res.results ?? [];
}

