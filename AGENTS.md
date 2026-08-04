# AGENTS.md

Guidance for AI agents (and humans) working in this repository.

## What this is

A Bluesky bot running on **Cloudflare Workers** that:

1. Replies to posts that **@mention it** with a contextually-fitting **1990s grunge lyric snippet**.
2. Publishes **original posts** built from those lyrics on a schedule.

The contextual match runs entirely on the Cloudflare stack — no external LLM key. See `README.md` for setup/deploy.

## This bot posts for real once deployed

`wrangler.jsonc` ships with `DRY_RUN` set to `"false"`, so the first successful deploy starts posting to
whatever Bluesky account the secrets point at. **Anything you change in the reply or post path affects
public posts on the next deploy.** There is no staging environment. Set `DRY_RUN` to `"true"` for the first
deploy if you want to watch the logs before it speaks.

Consequences worth holding onto:

- A bug here is visible to strangers, and a duplicate or repeated reply is the most likely shape it takes.
- `wrangler.jsonc` `triggers.crons` currently polls every 3 minutes. The bot answers each mention once —
  idempotency depends on the KV `handled:` flags and the notification cursor, so treat those as load-bearing.
- To make it stop: set `DRY_RUN` to `"true"` and redeploy, or remove the crons in the Cloudflare dashboard
  for an immediate halt with no deploy.
- Prefer testing through the dashboard's **Reply to a post** panel, but note it publishes for real now.

## Golden rule: lyrics & copyright

This is the most important constraint in the project. **Do not weaken it without explicit user instruction.**

- Full song lyrics are copyrighted; major lyrics sites forbid scraping. This project fetches from
  **ToS-permissible APIs only** — LRCLIB (primary) and lyrics.ovh (fallback) — never HTML scraping.
- Only **short, attributed snippets** are ever posted (`SNIPPET_MAX_CHARS`, default 260; hard-capped again at
  Bluesky's 300-grapheme limit), always credited with an em-dash, band, and song.
- A post may quote a **contiguous passage** of up to `PASSAGE_MAX_LINES` (default 8) lines, not just one.
  This was a deliberate widening, requested for reply quality — a single line often lands without context.
  It is bounded by three limits at once: line count, `SNIPPET_MAX_CHARS`, and the platform's 300 graphemes.
  **Don't raise those bounds without being asked.** Setting `PASSAGE_MAX_LINES` to 1 restores the old
  one-line behaviour from the dashboard, with no redeploy.
- Because passages need adjacency, D1 now stores **more of each song** than the matchable lines alone
  (context-only rows, `candidate = 0`). That's a real change in what's held at rest — it is still internal,
  still never re-posted wholesale, and Vectorize still only indexes candidates.
- Lyric lines are stored internally (D1 + Vectorize) **only to power matching** — never re-post full lyrics.
- **Never commit lyric text to the repo.** `data/bands.json` holds band *names* only; all lyric content is
  fetched at runtime into D1/Vectorize (which are not in git). Do not hardcode lyrics in source, tests, or
  fixtures — tests use synthetic invented lines.

## Architecture

Single TypeScript Worker, cron-driven. Two entry points in `src/index.ts`:

- `scheduled(event)` — routes by `event.cron` to: notification poll, original post, corpus refresh.
- `fetch(request)` — `/health` plus guarded `/run/*` manual triggers (require `?key=<MANUAL_TRIGGER_KEY>`).

Cloudflare bindings (see `wrangler.jsonc` / `src/env.ts`):

| Binding | Purpose |
| --- | --- |
| `AI` | Workers AI — embeddings + best-line selection |
| `LYRICS_INDEX` | Vectorize — semantic search over lyric lines |
| `DB` | D1 — bands, songs, lyric_lines, fetch_cache (`schema.sql`) |
| `STATE` | KV — Bluesky session, notification cursor, dedupe sets |

### Data flow

```
reply:   @mention -> embed post -> Vectorize topK -> rerank to topN -> LLM picks a line
                  -> composeQuote (expand to passage + attribute) -> reply
post:    cron -> random corpus line (recent-use dedupe) -> composeQuote -> original post
corpus:  cron -> MusicBrainz track titles -> lyrics API -> positioned lines -> embed -> Vectorize + D1
```

Retrieval is two-stage on purpose: wide vector recall (`MATCH_TOP_K`), then a cross-encoder
(`AI_RERANK_MODEL`) narrows to `RERANK_TOP_N` before the LLM makes the final call. The reranker is ~20x
cheaper than an LLM call and better at relevance, so widen recall rather than trusting vector search alone.

Both `rerank()` and `pickBestLyric()` **degrade instead of throwing** — reranker failure falls back to vector
order, and an unparseable LLM response falls back to the top candidate. Preserve that: a bad model response
should cost reply quality, never drop the reply.

### Gemma 4 + structured output: read before touching `pickBestLyric`

The pick is requested with **Workers AI structured output** (`response_format: json_schema`), but the schema
deliberately constrains **only the integer `choice`, via an enum of the actual candidate indices**. This is not
an oversight — Gemma 4 (26B-A4B included) has a model-level repetition bias that grammar-constrained decoding
amplifies into runaway loops, and the reported trigger is a **free-text string field in the schema**. Adding
`reason` (or any free string) back into the schema re-introduces that hazard. `reason` is explanatory only; it
is still requested in the prompt and picked up by `parseChoice` on the prose path.

**`pick_reason` distinguishes two states that must never share a string.** `NO_REASON_GIVEN` means the
model chose and simply wasn't asked why — `choiceSchema` has no `reason` field on purpose, so *every*
successful structured pick arrives without one. `FALLBACK_REASON` means nothing usable came back and the
reranker's top line was used. Collapsing them (`parsed.reason || FALLBACK_REASON`) reported working picks
as failures and made the dashboard's one diagnostic actively misleading. The `LLM picks` tile counts the
difference; rows written before that fix read low and cannot be corrected after the fact.

**`parseChoice` scans balanced braces, not a regex.** `/\{[^{}]*\}/` stops at the first inner brace, so a
model answer whose reason contained one — `{"choice":2,"reason":"the {vibe} fits"}` — yielded the fragment
`{vibe}`, failed to parse, and discarded a correct pick. It is also string-aware, so a brace inside a
quoted value doesn't open a span, and it recurses into wrapper objects.

Known Gemma 4 behaviours the code already absorbs — don't "fix" these by removing the fallbacks:
- **Schema silently ignored** when thinking is off → prose fallback (`parseChoice`).
- **JSON wrapped in markdown fences** → `parseChoice` extracts it (tested).
- **Thinking traces** → `parseChoice` strips `<think>` blocks and takes the *last* committed JSON object;
  `readChoice` handles the object / string / top-level response shapes.
- **`response_format` rejected outright** → one retry without it, so the model id stays swappable.

**Thinking mode cannot be disabled through the Workers AI binding.** It's driven by a `<|think|>` chat-template
token, and there is no API parameter; Cloudflare applies the template. Google's documented mitigation is to ask
for a shorter trace, which is why the system prompt ends with "Decide immediately." `repetition_penalty` and a
bounded `max_tokens` are the other guards.

If `wrangler tail` shows slow or looping picks in production, the escape hatch is config-only: set
`AI_TEXT_MODEL` to `@cf/meta/llama-3.1-8b-instruct-fp8-fast` (non-reasoning, no documented structured-output
pathology, slightly cheaper).

## Module map

| File | Responsibility |
| --- | --- |
| `src/index.ts` | `ACTIONS` registry (cron + `/run/*`), dashboard, JSON API, auth gate |
| `src/env.ts` | `Env` interface + `isDryRun`/`botHandle`/`nowSeconds`. Deliberately **no** tunable accessors |
| `src/bluesky.ts` | Auth (session cached in KV, auto-refresh on 401), `publish`, `listMentions`, `parseBskyUrl`/`bskyUrl` |
| `src/ai.ts` | `embed`/`embedMany`, `rerank`, `pickBestLyric` (+ `parseChoice`) |
| `src/match.ts` | `matchLyric` (embed -> query -> rerank -> pick), `composeQuote`, `buildPassage`, `formatSnippet` |
| `src/analytics.ts` | `recordPost`/`withRun`, `setVote`, dashboard queries, `bestEffort` |
| `src/dashboard.ts` | `renderDashboard` — server-rendered HTML, inline CSS/JS |
| `src/settings.ts` | `loadSettings`/`saveSettings` — KV overrides over env defaults |
| `src/replies.ts` | `handleMentions`, `replyToPost` (shared by poller + manual route), safety filter |
| `src/originalPost.ts` | `publishOriginal` w/ recent-use dedupe |
| `src/lyrics/fetch.ts` | LRCLIB + lyrics.ovh clients, `extractLines`, D1-cached |
| `src/lyrics/corpus.ts` | `buildCorpus`, `backfillPositions`, `embedPending`, `lineId` |
| `migrations/*.sql` | Schema changes for deployed databases; tracked in a ledger (see its README) |
| `src/state.ts` | KV session/cursor/dedupe + corpus-table D1 helpers |
| `data/bands.json` | Curated 1990s grunge band list (names only). Seed **input**, not a live filter — removing a name needs `/run/prune`, since `buildCorpus` only ever adds |
| `scripts/cf.sh` | Account-pinned wrangler wrapper (provision / schema / migrate / secrets / deploy / seed / backfill) |

## Test map

Most suites test the module beside them and need no explanation. These do not — each
asserts something that spans files, so it can be broken by an edit that never opens
it. If one fails, the invariant is the thing to read, not the assertion.

| Suite | Guards | Broken by |
| --- | --- | --- |
| `crons.test.ts` | `wrangler.jsonc` `triggers.crons` == the schedules `ACTIONS` claims | Changing a cron in one file. The poll silently stopped running for days this way |
| `schema.test.ts` | Every exported SQL string parses against the real `schema.sql` | Valid JS emitting invalid SQL — the mocked-D1 suites cannot see it |
| `scripts/test-migrations.sh` | Fresh / pre-passage / pre-ledger / re-run databases converge on one schema, using the **real** `run_migrations` sourced out of `cf.sh` | A migration that isn't idempotent; a `cf.sh` helper that stops being defined |
| `env.test.ts` | `DRY_RUN` goes live only for the exact string `"false"` | Loosening the comparison — this is the switch between logging and posting publicly |
| `index.test.ts` | The auth gate fails closed; `/run/<junk>` 404s before opening a run row | Reordering validation past `withRun` |
| `analytics.test.ts` | Every analytics write swallows its own failure | Removing `bestEffort` from a write — `recordPost` throwing costs a duplicate public reply |

The rest (`ai`, `match`, `replies`, `dashboard`, `settings`, `bluesky`, `corpus`,
`fetch`, `rerank`) are ordinary unit tests over their own module.

## Commands

```bash
npm install
npm test          # vitest run (one-shot; do NOT rely on the vitest UI server)
npm run test:migrations  # runs cf.sh's real migration runner against real SQLite
npm run typecheck # tsc --noEmit — must stay clean
npm run dev       # wrangler dev (local D1/Vectorize/KV)
npm run deploy    # ./scripts/cf.sh deploy
```

**Never invoke `wrangler` directly for anything that touches a remote account.** The
user has multiple Cloudflare accounts, so a bare `wrangler deploy` can hit the wrong
one via a cached OAuth session. Go through `./scripts/cf.sh`, which requires an
explicit API token + account id and confirms the target first. Real tokens live in
`.dev.vars` (git-ignored, one file per account as `.dev.vars.<profile>`) — never
read, echo, or commit them.

Always run `npm test` and `npm run typecheck` before committing; both must pass.

## Conventions

- **Runtime deps are precious.** The only production dependency is `@atproto/api`. Everything else is dev
  tooling (wrangler, vitest, types). Don't add runtime deps without a strong reason — Workers bundle size and
  cold-start matter, and more deps means more audit surface.
- **The `undici` override in `package.json` is load-bearing — don't delete it as cruft.** `miniflare` (via
  `wrangler`) pins `undici` to an *exact* version rather than a range, so when an advisory lands there is no
  version Dependabot is allowed to bump to: it opens nothing and the alerts just pile up. That is exactly what
  happened at `undici` 7.28.0 — one high and four medium alerts, zero PRs. `"overrides": { "undici": "^7.29.0" }`
  is the only lever that moves it. The caret is deliberate, so future 7.x patches flow in instead of the pin
  going stale. None of this reaches production: `undici` is dev-only (`"dev": true` in the lockfile), the Worker
  uses workerd's built-in global `fetch`, and the vitest suite runs a plain `node` environment, so only
  `npm run dev` ever loads it. Drop the override once miniflare itself pins `>=7.29.0` — and re-check
  `npm ls undici` when you do.
- **`DRY_RUN` is the one switch between logging and posting publicly, and it fails safe**: only the exact
  string `"false"` goes live, so a typo or a missing var keeps the bot quiet (pinned by a test in
  `env.test.ts`). It is currently `"false"` — see "This bot is live" above. Never make tests or examples
  post: they must construct their own env, not inherit the deployed value.
- **The match is deterministic, so variety has to be enforced.** Embedding, Vectorize recall and the
  reranker all return the same thing for the same post text; `temperature` on a constrained 1-of-N pick
  barely moves it. Without the recent-use filter a reply is a pure function of the post, so every similar
  mention gets the identical words — and re-running one post always returns the same line. `matchLyric`
  filters the **shortlist** (a handful of KV reads), not the full recall set (up to 50), and keeps the whole
  shortlist if every line is recent: a repeat beats no reply. Both quote paths now mark what they used.
- **Idempotency is required.** Overlapping crons and retries must never double-reply or double-post. Use the
  KV dedupe helpers (`isHandled`/`markHandled`, `wasRecentlyPosted`/`markRecentlyPosted`) and the notification
  cursor. When adding flows, key new work in KV/D1 similarly.
- **Config over code.** Model ids and cron cadences live in `wrangler.jsonc` vars so they change without a code
  edit. Keep the embedding model's dimensions in sync with the Vectorize index (currently 1024).
- **Tunables live in `settings.ts`'s `SPEC` table.** `matchTopK`, `rerankTopN`, and `snippetMaxChars` are
  dashboard-editable: the env var is the default and a KV entry overrides it. `SPEC` is the single source of
  truth — the `Settings` type, clamp bounds, env parsing, and the dashboard form fields are all derived from
  it, so a new tunable is one `SPEC` entry plus a `wrangler.jsonc` var. `env.ts` deliberately does **not**
  export accessors for these; read them via `loadSettings(env)` / `resolveSettings(env)`. Resolve **once per
  run** and thread them down (see `handleMentions`), not per item.
- **`pos IS NULL` means "cannot be quoted as a passage", and it is invisible from the reply.** A line
  harvested before positions existed produces a single-line quote no matter how `PASSAGE_MAX_LINES` is set,
  and the output looks identical to a passage that legitimately had no room. The dashboard shows a
  `% passage-ready` badge for exactly this reason — diagnose "why is it still one line?" there before
  touching `buildPassage`. The fix is `cf.sh backfill`, **not** `seed --force`: seeding picks tracks from
  MusicBrainz, whose result set isn't stable between runs, so it re-fetches an arbitrary subset and may
  never revisit the song you care about. `backfillPositions` asks D1 which songs still have position-less
  lines and re-fetches exactly those, so it converges. It deletes lines the source no longer returns — but
  only when the fetch succeeded, since treating a transient API failure as "these lines are gone" would
  delete a whole song.
- **A gap in `pos` means "not adjacent", and must never be bridged.** `extractLines` advances `pos` for
  every sung line but drops some of them (repeats, over-long ones), so stored positions have holes.
  `buildPassage` stops at the first missing position. Bridging a hole would stitch two distant lines into a
  quote that was never sung — the one bug in this feature that puts words in a band's mouth, so the gap
  check is load-bearing, not defensive. `extractLines` must keep advancing `pos` before its filters.
- **De-duplication in `extractLines` is a correctness constraint, not a nicety.** `lineId` hashes
  (band, song, line), so keeping a repeated chorus line twice would collide on the primary key.
- **Passages grow backwards.** The quote should land on the line the matcher chose; filling the budget
  forwards would bury it mid-quote. Forward growth is a fallback for a match with no lead-in.
- **Schema changes need a `migrations/*.sql` file as well as a `schema.sql` edit.** `schema.sql` is all
  `CREATE TABLE IF NOT EXISTS`, so it cannot alter a deployed table. Applied files are tracked in a
  `schema_migrations` ledger, so a migration can be any SQL; a fresh database is *baselined* rather than
  migrated. Migrations run **before** `schema.sql`, since `schema.sql` indexes what they add. Never edit or
  renumber an applied file — the ledger keys on the filename. See `migrations/README.md`.
- **SQL built in shell needs `${SQ}` for its quotes, and `scripts/test-migrations.sh` to prove it.** The
  `'"'"'` idiom escapes a quote inside a *single*-quoted string; these SQL strings are double-quoted, where
  the same sequence silently yields `'"table"'`. That shipped: it made the fresh-database check match
  nothing and turned `strftime('%s','now')` into NULL. Nothing else in the repo can catch it — vitest mocks
  D1 and `bash -n` only checks syntax — so the test sources the **real** `run_migrations` out of `cf.sh` and
  runs it against real SQLite. It asserts a fresh, a pre-passage, a pre-ledger and a re-run database all
  converge on one schema. `cf.sh deploy` gates on it.
- **`cf.sh` returns early when sourced, so the harness gets the real functions.** It used to `sed` individual
  functions out, which broke the moment one of them called a helper that wasn't on the list — and broke
  *silently*, because `d1_query`'s `|| true` turned `command not found` into an empty answer, so every
  migration took the error-tolerant branch and the suite reported success while testing nothing. The harness
  now asserts each function it needs is actually defined. Keep the sourced-vs-executed guard at the bottom of
  `cf.sh` intact.
- **`formatSnippet` and `fetchLines` take `maxChars` as a required argument.** No default — a default would
  silently disable the copyright cap for any caller that forgot it.
- **Analytics must never break the work.** Every write in `analytics.ts` goes through `bestEffort()` — the
  rule is structural, so a new write inherits it instead of having to remember a `try/catch`. This matters
  most for `recordPost`, which runs *after* the post is published: if it threw, the mention would never be
  marked handled and the next poll would reply a second time, so bookkeeping would cause a visible
  duplicate. `setVote` is the deliberate exception — it reports success to a person clicking a button.
- **One reply path.** `replyToPost()` is the single compose-and-record chain; the notification poller and the
  manual `/api/reply-to` route both go through it, and `resolvePostTarget()` turns a pasted URL into the same
  `MentionNotification` shape the poller produces. Don't fork a second path for manual replies — the safety
  filter, **dedupe**, snippet cap, DRY_RUN gate and analytics recording all live on this one. Dedupe used to
  sit in the poller instead, so the manual route had none and re-answering a post published a duplicate;
  `force: true` now makes a deliberate repeat an explicit request rather than an accident.
- **A 👎 is functional, not decorative.** Line eligibility is enforced at the source: `getRandomLyricLines`
  and `getPassageContext` exclude downvoted lines **in SQL**, so any future line consumer inherits the
  filter. `matchLyric` also filters its Vectorize results — that one is unavoidable, since Vectorize can't
  express the predicate. A downvoted line is excluded as *context* too, not just as the headline: "a 👎
  retires the line" is a simpler promise to keep than one with an exception in it.
- **The cron strings are duplicated across `wrangler.jsonc` and `ACTIONS`, and `crons.test.ts` asserts they
  agree.** Nothing at runtime notices a mismatch — `jobForCron` returns undefined and `scheduled()` returns —
  so the job silently stops while the Worker still reports healthy. That is not hypothetical: the poll
  interval was changed in `wrangler.jsonc` alone and the bot stopped replying to every mention. If you change
  a schedule, change both. An action may own several (`crons: string[]`) — the original post runs twice a
  day — so adding a firing time does not mean adding a registry entry. A schedule nothing claims records a
  failed run under the kind `unknown-cron`, so the drift is visible on the dashboard rather than only in logs.
- **`ACTIONS` in `index.ts` is the one registry of what this Worker can be asked to do.** Cron entries carry
  a `cron`; actions taking query params take a `URL`. Both go through `withRun`, so run accounting can't
  drift. `/run/<name>` is validated against the registry **before** `withRun` opens a row — an unchecked
  name would write a `runs` record with a caller-supplied `kind`.
- **`bluesky.ts` owns the at:// ↔ bsky.app mapping**, in both directions (`parseBskyUrl`, `bskyUrl`). The
  record-path format is a platform concern; the dashboard and API consume `bskyUrl` rather than splitting a
  URI by hand.
- **The dashboard's browser `<script>` is where the type system stops helping.** It re-declared its own
  escaper and its own permalink parser once already. The server's `ESC` table is interpolated into the page
  (`${JSON.stringify(ESC)}`) so there is one definition, and `/api/reply-to` returns a resolved `url`.
  Anything the browser needs should be computed server-side or emitted from the server's own constant.
- **Escape everything rendered.** Post text and handles are attacker-controlled (anyone can @mention the bot).
  All dashboard interpolation goes through `esc()`.
- **`songWrite` is why the seeder and the repair job can't drift.** `buildCorpus` and `backfillPositions`
  both write a song's lines through it, because they must produce byte-identical rows — see the `lineId`
  contract below. Copies of that mapping is how the repair would start inserting duplicates instead of
  updating in place.
- **`lineId` is a persisted-data contract.** Its output keys the Vectorize index, `posts.line_id` (which is what
  makes a thumbs-down retire a line), and the `recent:<id>` KV flags. Changing the hash orphans all of them, so
  it is pinned by a **golden test** in `src/lyrics/corpus.test.ts` — fix the code, never the expectation. The
  separator must stay a unicode **escape**, never a literal control byte: a raw NUL makes the file binary to
  grep and diff (this already happened once).
- **One agent per invocation.** `getAgent` memoizes on a `WeakMap<Env, ...>` because `resumeSession` is a network
  call that also writes KV; without it a 25-mention poll paid 26 round trips. Don't call the SDK's session
  methods outside `bluesky.ts`.
- **`bluesky.ts` owns the platform.** `POST_MAX_GRAPHEMES` and the DRY_RUN send gate live there. `publish()` is
  the single send choke point — `post`/`reply` are one-line aliases, so anything added to the send path (rate
  limiting, retries, metrics) is added once.
- **Resolve per-run state once, then thread it down.** Settings, the downvote set, and the warm
  fetch-cache key set (`getFreshFetchKeys`) are each resolved once per run. Asked per item, the cache check
  alone was 2 round trips x every song — roughly 1,264 on the full band list, paid in full even on a run
  with nothing to do. If you add a per-item lookup, hoist it.
- **D1 writes in loops go through `env.DB.batch()`.** A corpus build inserts thousands of lines; one statement
  per round trip does not fit a cron invocation. D1 caps bound parameters at 100 per statement, so prefer
  `batch()` over multi-row `VALUES`, and `json_each(?)` over an `IN (?,?,...)` list.
- **Secrets** (`BLUESKY_HANDLE`, `BLUESKY_APP_PASSWORD`, `MANUAL_TRIGGER_KEY`) come from `wrangler secret` /
  `.dev.vars` (git-ignored). Never commit them or add them to `wrangler.jsonc`.
- **Tests** live beside source as `*.test.ts`, use `vitest`, mock all bindings, and use synthetic lyric text.

## Poll frequency and what it costs

Changing `triggers.crons` for the poll is cheap, but only because idle polls were made
cheap on purpose — keep them that way.

**AI cost does not scale with frequency.** Polling more often doesn't create more
replies; the same mentions get answered sooner. Neurons track mention volume, so the
marginal cost of a tighter schedule is entirely the fixed per-poll overhead.

**One idle poll costs:** 3 KV reads (settings, cursor, session), **0 KV writes**,
2 D1 rows written (`startRun`/`finishRun`), 1 Workers request, 1 Bluesky
`listNotifications`, and **0 Neurons**.

Those 0 writes are load-bearing and easy to regress. Two writes used to happen on
every poll however quiet:
- `persistSession` fires on *resume*, not just rotation, so the session was rewritten
  every time. `createAgent` now compares against what KV already holds.
- Bluesky returns a cursor on every call, so `setNotifCursor` wrote every poll.
  `handleMentions` now writes only when it actually moved.

Both are pinned by tests in `replies.test.ts`. If you add per-poll state, ask whether
it needs writing when nothing changed — the Workers **Free** plan caps KV at
**1,000 writes/day**, and at a 2-minute cron that is 720 polls, so even one stray
write per poll consumes 72% of the daily budget on an idle bot.

The failure mode if that cap is hit is genuinely bad, which is why this is worth
care: `markHandled` throws, so mentions already replied to are never marked, the
cursor never advances, and the next poll **replies to them again** — publicly.

Rough headroom per cadence (idle, with the writes removed):

| Cron | Polls/day | D1 rows written/day | Free-plan headroom | Paid cost |
| --- | --- | --- | --- | --- |
| `*/10` | 144 | 288 | 0.3% of 100k | $0 |
| `*/5` | 288 | 576 | 0.6% | $0 |
| `*/2` | 720 | 1,440 | 1.4% | $0 |
| `* * * * *` | 1,440 | 2,880 | 2.9% | $0 |

**Resource cost is not what limits the cadence — poll duration is.** Cron invocations
are not serialized. If a poll outlives its own interval the next one starts alongside
it, reads the same un-advanced cursor, and sees the same mentions. Both runs then race
on `isHandled`, and KV is eventually consistent, so the loser can read a stale miss and
answer a mention that was already answered — publicly.

A poll's duration is roughly `mentions x (embed + vectorize + rerank + LLM pick +
reply)`, and the loop is deliberately serial (see the trade-offs section), so the LLM
call dominates at a few seconds each. Ten mentions is plausibly a minute.

Note what does *not* help: marking mentions handled inside the loop instead of
batching at the end. `marks.push(markHandled(...))` already **calls** `markHandled`
immediately — only the `await` is deferred, so the KV write is in flight either way.
Awaiting per iteration just adds latency to the loop, making the poll longer and
overlap *more* likely. Closing the window properly needs the cursor advanced up front
or a real lock, and a lock costs the per-poll KV write that was just removed.

So: keep the interval comfortably longer than a busy poll takes. The deployed value is
`*/3`, which needs roughly 30+ mentions in one poll before duration approaches the
interval. `* * * * *` has no such margin. Watch poll durations in the dashboard's
**Recent runs** panel — that, not cost, is the signal to back off.

## Known trade-offs, deliberately left alone

Flagged so they read as decisions rather than oversights. Each is a behaviour change, so none should be
made without asking.

- **A dry run still writes state.** `DRY_RUN` gates the network send in `publish()`, but `markHandled`,
  `markRecentlyPosted` and the notification cursor all still commit. So a dry run is not repeatable, and
  `/run/post` under `DRY_RUN` retires a line for 30 days without ever posting it. Making dry runs
  side-effect-free is the right shape ("nothing is committed" as a property of the state layer, not a habit
  at each write) but it changes what idempotency means for the poller — decide before doing it.
- **The reply loop is serialized.** `handleMentions` hoists and batches everything around the loop, but
  awaits `replyToPost` one mention at a time, each costing an embed + Vectorize query + rerank + LLM call +
  D1 + a Bluesky write. `listMentions` pulls up to 50. A bounded pool (~4) would cut the wall clock a lot;
  it was left alone because Bluesky write rate limits, not CPU, are the real ceiling and exceeding them is
  worse than being slow.
- **`PollStats` collapses every skip reason into one number.** `replyToPost` distinguishes `empty` /
  `unsafe` / `no-match` and the manual route surfaces it, but the poller reports only scanned/answered — so
  "40 scanned, 0 answered" doesn't say whether the corpus is unembedded or the safety filter is over-firing.
  `runs.stats` is free-form JSON and could carry the histogram.
- **The safety denylist is hardcoded** in `replies.ts`, including a literal `"slur"` placeholder token that
  matches innocuous text. It is the one policy still in code rather than in `SPEC`/KV, and the one an
  operator would most plausibly need to change urgently.
- **`char_len` and `bands.active` are written but never read.** Dropping them is a migration for no
  functional gain; noted so nobody assumes they're load-bearing.
- **The dashboard does not degrade if D1 is down** — it surfaces the error rather than rendering zeroes.
  That is intentional for a reporting page (`/health` degrades to a `-1` line count instead), and pinned by
  a test in `index.test.ts`.

## Git / workflow

- Default working branch for agent tasks: `claude/bluesky-grunge-bot`. `main` holds the source of
  truth.
- Do **not** open a PR unless explicitly asked.
- **Never force-push, and never amend a commit that has been pushed.** The user pulls from these branches
  and commits alongside. An amended commit does not replace the one they already have — the two become
  siblings, and the merge that reunites them can keep the *old* side. That happened: a typecheck error was
  fixed by amend + force-push, and the merge resurrected it, so the same broken build reached `main` twice.
  Fix forward with an ordinary commit.
- **Verify a fix against the remote, not the working tree.** `git show origin/main:<path>` is the check that
  matters; a clean local tree says nothing about what the user will pull.
- Changing the repo's **default branch** is a GitHub *setting* — not doable via the available tools; it needs a
  manual toggle in Settings -> Branches.

## Good first checks when starting a task

1. `npm install && npm run typecheck && npm test` — confirm a green baseline.
2. Read `README.md` (setup) and this file (constraints).
3. If touching matching/posting, re-read the **copyright** section above before writing any code.
