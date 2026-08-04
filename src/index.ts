import { botHandle, isDryRun, nowSeconds, type Env } from "./env";
import { handleMentions, replyToPost } from "./replies";
import { publishOriginal } from "./originalPost";
import { backfillPositions, buildCorpus, embedPending, pruneRemovedBands } from "./lyrics/corpus";
import { countLyricLines } from "./state";
import { bskyUrl, resolvePostTarget } from "./bluesky";
import { loadSettings } from "./settings";
import {
  bandLeaderboard,
  countPosts,
  getDownvotedLineIds,
  getSummary,
  isFiltered,
  isVote,
  listPosts,
  listRuns,
  parsePostFilter,
  parseRunFilter,
  runKinds,
  setVote,
  withRun,
} from "./analytics";
import { resolveSettings, saveSettings } from "./settings";
import { renderDashboard } from "./dashboard";

// Session cookie for the dashboard, established by ?key=<MANUAL_TRIGGER_KEY>.
const COOKIE = "bgb_auth";
const PAGE_SIZE = 25;

/**
 * Everything this Worker can be asked to do, cron or HTTP. One table: `/run/<name>`
 * resolves against it, and a cron fires the entry whose `cron` matches. Actions
 * that take query params are here too rather than in a second switch, so there is
 * no shape of work that can drift out of the registry — and `/run/<name>` can be
 * validated against it before any run row is opened.
 */
interface Action {
  /**
   * Schedules that fire this action; must match wrangler.jsonc triggers.crons,
   * which `crons.test.ts` asserts. A list because one job can run at several times
   * of day — the original post does — and a single string would have forced a
   * duplicate registry entry per firing.
   */
  crons?: string[];
  run: (env: Env, url: URL) => Promise<unknown>;
}

const ACTIONS = {
  poll: { crons: ["*/3 * * * *"], run: (env) => handleMentions(env) },
  // Twice a day. Times are UTC: 15:00 is late morning and 21:00 mid-afternoon in
  // US timezones (10:00/16:00 CDT, 11:00/17:00 EDT, 08:00/14:00 PDT). Adjust both
  // here and in wrangler.jsonc — they are matched by exact string.
  post: {
    crons: ["0 15 * * *", "0 21 * * *"],
    run: async (env) => ({ lineId: await publishOriginal(env) }),
  },
  refresh: {
    crons: ["0 4 * * 1"],
    run: async (env) => ({
      ...(await buildCorpus(env, nowSeconds())),
      embedded: await embedPending(env),
    }),
  },
  "build-corpus": {
    run: (env, url) =>
      buildCorpus(env, nowSeconds(), {
        maxBands: intParam(url, "maxBands"),
        tracksPerBand: intParam(url, "tracksPerBand"),
        force: url.searchParams.get("force") === "1",
      }),
  },
  embed: { run: async (env) => ({ embedded: await embedPending(env) }) },
  // Deletes bands no longer in data/bands.json from D1 *and* Vectorize. Manual
  // only, and deliberately not part of `refresh`: it is the one destructive
  // action here, and a weekly cron that silently drops a band because an edit
  // was mid-flight is not a trade worth making. Run it after editing the seed
  // list; `build-corpus` alone will not remove anything.
  prune: { run: (env) => pruneRemovedBands(env) },
  // Repairs lines harvested before positions existed; re-run while remainingSongs > 0.
  "backfill-positions": {
    run: (env, url) => backfillPositions(env, nowSeconds(), { limit: intParam(url, "limit") }),
  },
} as const satisfies Record<string, Action>;

type ActionName = keyof typeof ACTIONS;

const isAction = (s: string): s is ActionName => s in ACTIONS;

/**
 * `as const satisfies` is what keeps ActionName a union of the real names, but it
 * also narrows each `run` to its own return type — so a union key isn't callable
 * without widening back to the common shape here.
 */
const actionFor = (name: ActionName): Action => ACTIONS[name];

/** Every schedule ACTIONS claims. Asserted against wrangler.jsonc in crons.test.ts. */
export const ACTION_CRONS: string[] = (Object.keys(ACTIONS) as ActionName[]).flatMap(
  (k) => actionFor(k).crons ?? [],
);

const jobForCron = (cron: string): ActionName | undefined =>
  (Object.keys(ACTIONS) as ActionName[]).find((k) => actionFor(k).crons?.includes(cron));

export default {
  // ---- Scheduled (cron) entry ------------------------------------------------
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    // Cron carries no request; ACTIONS.run takes a URL only for the HTTP path.
    const url = new URL("https://cron.invalid/");
    const kind = jobForCron(event.cron);
    if (!kind) {
      // A schedule wrangler fires but ACTIONS doesn't claim. This is a deploy-time
      // mistake, not a runtime condition — it means that job silently stops running.
      // Recorded as a failed run so it surfaces on the dashboard instead of only in
      // logs; `crons.test.ts` is what should catch it first.
      console.error("cron: unknown schedule", event.cron);
      ctx.waitUntil(
        withRun(env, "unknown-cron", "cron", () => {
          throw new Error(`no ACTION claims the schedule "${event.cron}"`);
        }).catch(() => {}),
      );
      return;
    }
    // withRun records the outcome; swallow here so a failure doesn't reject scheduled().
    ctx.waitUntil(withRun(env, kind, "cron", () => actionFor(kind).run(env, url)).catch(() => {}));
  },

  // ---- HTTP entry: dashboard, API, health, guarded manual triggers -----------
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      const corpus = await countLyricLines(env).catch(() => ({ lines: -1, positioned: -1 }));
      return json({ ok: true, dryRun: isDryRun(env), corpus });
    }

    // One gate: resolve how (or whether) this request authenticated, once.
    const auth = authenticate(request, url, env);

    if (url.pathname === "/") {
      const key = url.searchParams.get("key");
      return redirect(key ? `/dashboard?key=${encodeURIComponent(key)}` : "/dashboard");
    }

    if (url.pathname === "/dashboard") {
      if (!auth) return unauthorizedPage();
      return withSession(await dashboard(env, url), auth, env);
    }

    if (url.pathname.startsWith("/api/")) {
      if (!auth) return json({ error: "unauthorized" }, 401);
      return api(url.pathname.slice("/api/".length), request, url, env);
    }

    if (url.pathname.startsWith("/run/")) {
      if (!auth) return json({ error: "unauthorized" }, 401);
      const action = url.pathname.slice("/run/".length);
      // Validate before withRun opens a row: an unchecked name would write a runs
      // record with an arbitrary caller-supplied `kind`.
      if (!isAction(action)) return json({ error: `unknown action: ${action}` }, 404);
      try {
        const result = await withRun(env, action, "manual", () => actionFor(action).run(env, url));
        return json({ ok: true, action, dryRun: isDryRun(env), result });
      } catch (err) {
        return json({ ok: false, action, error: String(err) }, 500);
      }
    }

    return json({ error: "not found" }, 404);
  },
};

// ---- dashboard ---------------------------------------------------------------

async function dashboard(env: Env, url: URL): Promise<Response> {
  const now = nowSeconds();
  const filter = parsePostFilter(url);
  const runFilter = parseRunFilter(url);
  const page = Math.max(1, intParam(url, "page") ?? 1);

  const [summary, posts, runs, resolved, bands, corpus, kinds, filtered] = await Promise.all([
    getSummary(env, now),
    listPosts(env, { ...filter, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE }),
    listRuns(env, 20, runFilter),
    resolveSettings(env),
    bandLeaderboard(env, 10),
    countLyricLines(env),
    runKinds(env),
    // Unfiltered, the total is exactly what getSummary already counted — no need
    // for a second full scan of `posts`. Filtered, it belongs in this batch rather
    // than serialized behind it.
    isFiltered(filter) ? countPosts(env, filter) : Promise.resolve(null),
  ]);
  const total = filtered ?? summary.totalPosts;

  const html = renderDashboard({
    summary,
    posts,
    runs,
    runFilter,
    runKinds: kinds,
    settings: resolved.settings,
    overridden: resolved.overridden,
    bands,
    filter,
    page: { current: page, size: PAGE_SIZE, total },
    now,
    corpus,
    dryRun: isDryRun(env),
    textModel: env.AI_TEXT_MODEL,
  });

  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

// ---- JSON API ----------------------------------------------------------------

async function api(action: string, request: Request, url: URL, env: Env): Promise<Response> {
  if (action === "vote") {
    if (request.method !== "POST") return json({ error: "POST required" }, 405);
    const body = (await request.json().catch(() => null)) as { id?: unknown; vote?: unknown } | null;
    const id = Number(body?.id);
    const vote = Number(body?.vote);
    if (!Number.isInteger(id) || !isVote(vote)) {
      return json({ error: "expected { id: number, vote: -1 | 0 | 1 }" }, 400);
    }
    const updated = await setVote(env, id, vote);
    return updated ? json({ ok: true, id, vote }) : json({ error: "post not found" }, 404);
  }

  if (action === "settings") {
    if (request.method === "GET") return json(await resolveSettings(env));
    if (request.method !== "POST") return json({ error: "POST required" }, 405);
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return json({ error: "invalid JSON body" }, 400);
    return json({ ok: true, ...(await saveSettings(env, body)) });
  }

  if (action === "posts") {
    // Same parser as the dashboard, so both views honour the same filters.
    const posts = await listPosts(env, {
      ...parsePostFilter(url),
      limit: intParam(url, "limit") ?? 50,
      offset: intParam(url, "offset") ?? 0,
    });
    return json({ posts });
  }

  // Reply to a specific post on demand, instead of waiting for a mention.
  // Goes through the same path as the poller, and honours DRY_RUN.
  if (action === "reply-to") {
    if (request.method !== "POST") return json({ error: "POST required" }, 405);
    const body = (await request.json().catch(() => null)) as {
      url?: unknown;
      force?: unknown;
    } | null;
    const target = typeof body?.url === "string" ? body.url.trim() : "";
    if (!target) return json({ error: "expected { url: string }" }, 400);

    try {
      const [post, settings, exclude] = await Promise.all([
        resolvePostTarget(env, target),
        loadSettings(env),
        getDownvotedLineIds(env),
      ]);
      // `force: true` re-answers a post the bot has already replied to. Off by
      // default so a double-paste doesn't publish a duplicate.
      const outcome = await replyToPost(env, post, settings, exclude, botHandle(env), {
        force: body?.force === true,
      });
      return json({
        ok: true,
        dryRun: isDryRun(env),
        target: { uri: post.uri, author: post.authorHandle, text: post.text },
        // Resolved here so the browser never re-derives a permalink from the at:// uri.
        url: bskyUrl(outcome.uri),
        ...outcome,
      });
    } catch (err) {
      return json({ ok: false, error: String(err instanceof Error ? err.message : err) }, 400);
    }
  }

  if (action === "summary") return json(await getSummary(env, nowSeconds()));

  return json({ error: `unknown api action: ${action}` }, 404);
}

// ---- auth / helpers ----------------------------------------------------------

type Auth = "key" | "cookie";

/**
 * How this request authenticated, or null. `?key=` is the handoff; the cookie it
 * sets keeps dashboard links and fetches working afterwards.
 */
function authenticate(request: Request, url: URL, env: Env): Auth | null {
  const key = env.MANUAL_TRIGGER_KEY;
  if (!key) return null; // fail closed if the secret isn't configured
  if (url.searchParams.get("key") === key) return "key";
  const cookie = request.headers.get("cookie") ?? "";
  return cookie.split(/;\s*/).some((c) => c === `${COOKIE}=${key}`) ? "cookie" : null;
}

/** Issue the session cookie for requests that authenticated via ?key=. */
function withSession(res: Response, auth: Auth, env: Env): Response {
  if (auth !== "key") return res;
  const out = new Response(res.body, res);
  // SameSite=Strict also serves as CSRF protection for the POST endpoints.
  out.headers.append(
    "set-cookie",
    `${COOKIE}=${env.MANUAL_TRIGGER_KEY}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000`,
  );
  return out;
}

function unauthorizedPage(): Response {
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>Unauthorized</title>
     <body style="font:14px system-ui;max-width:34rem;margin:15vh auto;padding:0 1rem">
     <h1 style="font-size:18px">🔒 Unauthorized</h1>
     <p>Append <code>?key=&lt;MANUAL_TRIGGER_KEY&gt;</code> to this URL to sign in.
     A session cookie is set so you only need to do it once.</p></body>`,
    { status: 401, headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { location } });
}

function intParam(url: URL, name: string): number | undefined {
  const v = url.searchParams.get(name);
  if (v == null) return undefined;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : undefined;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
