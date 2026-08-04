# bluesky-grunge-bot

A Bluesky bot that lives on Cloudflare and replies to posts with a **contextually-fitting lyric snippet from a
1990s grunge song** — and posts original grunge lines on a schedule.

When someone @mentions the bot, it reads their post, finds the lyric line that best fits the vibe using
**Cloudflare Workers AI + Vectorize** semantic search, then quotes that line **together with the lines
leading up to it** — so the reply reads as a passage that lands, not a fragment — credited as
`— Band, "Song"`. No external AI keys required; everything runs on the Cloudflare stack.

## How it works

```
@mention ─▶ embed post ─▶ Vectorize top-25 ─▶ rerank to 4 ─▶ drop recently-used
         ─▶ LLM picks ─▶ grow to a passage ─▶ reply w/ credit
   cron  ─▶ pick a corpus line ─▶ grow to a passage ─▶ original post w/ credit
   cron  ─▶ build/refresh corpus: MusicBrainz tracks ─▶ lyrics API ─▶ positioned lines ─▶ Vectorize + D1
```

- **Workers AI** — `@cf/qwen/qwen3-embedding-0.6b` for embeddings,
  `@cf/baai/bge-reranker-base` to re-score candidates, and `@cf/google/gemma-4-26b-a4b-it` to choose the
  best-fitting line. The final pick is requested as a **structured JSON output** constraining just the choice
  index, with a text-parsing fallback for models that don't support (or silently ignore) `response_format`.

Model notes: the embedding model is the cheapest 1024-dim option (matching the Vectorize index, so it can be
swapped for `@cf/baai/bge-m3` with no reindex); `bge-reranker-base` is currently the only reranker on Workers
AI; and the text model only has to pick 1 of N short candidates, so a mid-tier model is the sweet spot —
bigger agentic/coding models cost more for no benefit here. All three ids are `wrangler.jsonc` vars.

Retrieval is deliberately two-stage. Vector search alone compares embeddings computed independently, so it
returns lines that are *topically* near the post; the cross-encoder reads the post and each candidate
*together* and is much better at judging which line actually lands. Reranking costs a fraction of an LLM call,
so widening Vectorize recall to 25 and letting the reranker discard the near-misses improves quality while
keeping the LLM prompt short.

- **Vectorize** — semantic index over short candidate lyric lines.
- **D1** — band/song metadata, the lyric-line corpus, and a fetch cache.
- **KV** — Bluesky session tokens, the notification cursor, and dedupe sets.
- **Cron Triggers** — reply polling, scheduled posts, weekly corpus refresh.

### Passages, not fragments

One line usually isn't enough. The matcher still picks a single best line, but the post quotes the
**contiguous run of lines leading up to it**, growing backwards until it hits `PASSAGE_MAX_LINES` (8) or runs
out of characters. Growing backwards is deliberate: the chosen line stays last, so the quote builds toward it
instead of burying it. When the match has nothing before it, the passage extends forward instead.

Lines are stored with their position in the song, and **a passage never crosses a gap**. Extraction drops
some lines (repeated choruses, over-long ones), which leaves holes in the numbering — a hole means the two
sides aren't adjacent in the song, so joining them would produce a quote that was never sung. The builder
stops at the hole instead.

Set `PASSAGE_MAX_LINES` to 1 from the dashboard for the old one-line behaviour, no redeploy needed.

### About lyrics & copyright

Full song lyrics are copyrighted, and the major lyrics sites forbid scraping in their terms. This project is
deliberately conservative:

- It fetches from **ToS-permissible lyrics APIs** — [LRCLIB](https://lrclib.net) (primary) and
  [lyrics.ovh](https://lyrics.ovh) (fallback) — rather than scraping HTML.
- It stores **individual short lines** internally to power matching, plus the lines around them so a quote
  can be contiguous, and only ever **posts a short attributed snippet** — at most `PASSAGE_MAX_LINES` (8)
  lines and `SNIPPET_MAX_CHARS` (260) characters, capped again at Bluesky's 300-grapheme limit.
- It never re-posts full lyrics. Review each source's terms before deploying, and keep snippets short.

## Dashboard

Visit `https://<your-worker>.workers.dev/dashboard?key=<MANUAL_TRIGGER_KEY>` once — a session cookie is set so
subsequent visits don't need the key.

It gives you:

- **Overview** — totals for posts/replies/originals, 👍/👎 counts and approval rate, average rerank score,
  **LLM picks** (what share of replies the model chose, rather than falling back to the reranker's top
  line — a fallback reply reads fine, so this is the only way to see the pick stage failing), runs and
  failures in the last 24h, corpus size with a passage-ready badge, and a live/dry-run badge.
- **Tuning** — every value in the settings `SPEC` (`matchTopK`, `rerankTopN`, `snippetMaxChars`,
  `passageMaxLines`, `lineMaxChars`), stored in KV and overriding `wrangler.jsonc` **without a redeploy**;
  clear a field to fall back to the deployed default. `lineMaxChars` is the exception — it only affects
  corpus harvesting, so it does nothing until the corpus is rebuilt.
- **Recent runs** — every cron firing and manual trigger with duration, status, and per-run stats, so a failed
  poll is visible instead of buried in logs. Filterable by job and by outcome; the job list offers only kinds
  that actually have runs, and an unfinished run counts as neither succeeded nor failed.
- **Bands by reception** — which bands' lines actually land, ranked by net votes.
- **Posts & replies** — every post the bot composed (including dry-run ones), searchable and filterable by
  kind and vote, showing the source line, both match scores, the LLM's stated reason, the post it replied to,
  and a direct **open ↗** link to the live post on bsky.app. Paginated 25/page, with filters preserved across
  pages.

### Reply to a specific post on demand

The dashboard has a **Reply to a post** panel: paste a `bsky.app` post URL (or an
`at://` URI) and it runs the same pipeline a mention would — match, rerank, pick,
reply — without waiting for someone to @mention the bot. Useful for testing the
reply path, and for answering a post the bot was never tagged in.

It honours `DRY_RUN`: with dry run on it composes, records and shows you the reply
without publishing. The panel says which mode it is in before you click.

Same thing over the API:

```bash
curl -s -X POST "$URL/api/reply-to?key=$KEY" \
  -H 'content-type: application/json' \
  -d '{"url":"https://bsky.app/profile/someone.bsky.social/post/3k2a…"}'
```

The bot answers a given post once. Asking again returns
`{"replied": false, "reason": "already-answered"}` rather than publishing a second
reply — pass `"force": true` (or tick **reply again** in the panel) when a repeat is
what you actually want.

Replying to a post that is itself a reply threads under the original root, not
under the post you pasted.

### Why a given post gets a given line

The pipeline is deterministic: the same post text produces the same embedding, the
same Vectorize hits and the same rerank order, so the same line comes back. That's
wanted for replies — each mention is a different post, and the bot answers each once.

What isn't wanted is the bot repeating itself across *similar* posts, so a line used
in a recent post is filtered out of the shortlist before the model picks (the same
30-day rule original posts follow). Ask the same post twice and you'll get a
different line the second time, because the first one has been retired.

If every shortlisted line is recent, the filter steps aside rather than dropping the
reply — a repeat beats silence.

### 👍 / 👎 feedback actually changes behaviour

Votes aren't just recorded. **A 👎 removes that lyric line from future use** — it's filtered out of Vectorize
results for replies, skipped when choosing original posts, and excluded from passage
context, so a retired line can't come back as part of someone else's quote. So downvoting a line that landed badly
permanently retires it, and the corpus quietly improves as you rate. 👍 is currently signal-only (it surfaces
in the band leaderboard and approval rate).

Because dry-run posts are recorded too, you can seed the corpus, run `/run/poll` and `/run/post` with
`DRY_RUN=true`, and rate the output on the dashboard **before** anything reaches Bluesky.

## Project layout

```
src/index.ts          Worker entry: cron router, dashboard, JSON API, manual routes
src/bluesky.ts        Auth (session cached in KV, auto-refresh), post/reply with richtext facets, notifications
src/ai.ts             Workers AI: embeddings, cross-encoder rerank, best-line selection
src/match.ts          embed post → Vectorize → rerank → AI pick → attributed snippet
src/replies.ts        Notification handling, safety filter, reply composition
src/originalPost.ts   Scheduled original posts with recent-use dedupe
src/analytics.ts      Post/run recording, votes, dashboard queries, bsky permalinks
src/dashboard.ts      Server-rendered dashboard HTML (inline CSS/JS, no build step)
src/settings.ts       Runtime-tunable settings (KV overrides over wrangler.jsonc vars)
src/lyrics/fetch.ts   LRCLIB + lyrics.ovh clients, short-line extraction, D1-cached
src/lyrics/corpus.ts  Corpus build/refresh (MusicBrainz → lyrics → Vectorize + D1)
src/state.ts          KV + D1 helpers
data/bands.json       Curated 1990s grunge band list (metadata only — no lyrics)
schema.sql            D1 schema (fresh databases)
migrations/           ADD COLUMN steps for databases that already exist
.github/workflows/    CI: typecheck, vitest, migration harness (no secrets needed)
```

## Setup

Requires Node 18+ and a Cloudflare account with Workers AI, Vectorize, D1, and KV.

Deployment goes through **`./scripts/cf.sh`**, which pins every wrangler command to
one specific Cloudflare account. If you have several accounts, `wrangler login` is
ambiguous — it uses whichever OAuth session happens to be cached. Setting
`CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` makes wrangler ignore that cache,
and the script prints the resolved account (and asks for confirmation) before
anything mutating.

### 1. Create the Bluesky bot account

Create a dedicated account for the bot, then generate an **App Password**
(Settings -> Privacy and Security -> App Passwords). Use the app password, never
the account password.

### 2. Fill in `.dev.vars`

```bash
cp .dev.vars.example .dev.vars   # then fill it in
```

One file holds both the Worker secrets and the Cloudflare deploy credentials.
Create the API token at <https://dash.cloudflare.com/profile/api-tokens> with
**Edit** on Workers Scripts, Workers KV, D1 and Vectorize, plus **Read** on
Workers AI. Values may be 1Password references (`op://vault/item/field`), resolved
with `op read` at runtime so no token sits on disk.

Every `.dev.vars*` file is git-ignored except the example.

Multiple accounts get one file each, selected with `-p`:

```bash
cp .dev.vars.example .dev.vars.personal
./scripts/cf.sh -p personal whoami
```

Note that `wrangler dev` injects everything in `.dev.vars` into the Worker's `env`,
so the `CLOUDFLARE_*` values are visible to local dev code. They are not present in
production — deployed secrets come only from `wrangler secret put`.

### 3. Provision, configure, deploy

```bash
npm install
./scripts/cf.sh whoami       # verify the token and see the account's resources
./scripts/cf.sh provision    # create KV + D1 + Vectorize, write ids into wrangler.jsonc
./scripts/cf.sh schema       # apply migrations + schema.sql to the remote D1
./scripts/cf.sh secrets      # set BLUESKY_HANDLE / BLUESKY_APP_PASSWORD / MANUAL_TRIGGER_KEY
./scripts/cf.sh deploy       # typecheck + test, then deploy
./scripts/cf.sh seed         # build the corpus and embed it
```

`wrangler.jsonc` ships with `database_id` and the KV `id` set to a placeholder —
`provision` creates the resources in your account and writes the real ids in. They
aren't secret, so commit the result. Until you've run it, `wrangler dev` and
`deploy` will start but won't find those two bindings. Every command takes `-p PROFILE` to choose an account and
`-y` to skip confirmations; `./scripts/cf.sh run <anything>` passes an arbitrary
wrangler command through with the account still pinned.

One thing to decide before that first `deploy`: `DRY_RUN` is `"false"` in
`wrangler.jsonc`, so the bot starts posting for real as soon as the crons fire. Set
it to `"true"` for the first deploy if you'd rather watch `./scripts/cf.sh tail`
and the dashboard before it speaks in public.

### 4. CI

`.github/workflows/ci.yml` runs `typecheck`, the vitest suite, and the migration
harness on every push and pull request. It needs no secrets — nothing in those
three commands reaches Cloudflare or Bluesky. Deploys stay a local operation, so
that `cf.sh` can pin and confirm the target account interactively.

#### Upgrading an existing deployment

`schema` applies `migrations/` before `schema.sql`, so an existing database picks up
new columns and index changes in place — nothing is dropped and votes are preserved.
Applied migrations are tracked in a `schema_migrations` ledger, so re-running is a
no-op. Passages also need the corpus rebuilt, because the lines *around* a match were
never stored before:

```bash
./scripts/cf.sh schema           # adds the line-position columns
./scripts/cf.sh seed --force     # re-fetch; --force bypasses the 30-day fetch cache
```

Without `--force` the rebuild is a no-op — the cache records that a song was fetched,
not how it was parsed. Until it runs, replies quote a single line exactly as before.

**Check it worked.** The dashboard header shows a `passage-ready` badge; below 100%
it reads e.g. `62% passage-ready`, meaning that share of the corpus still has no
stored position and can only ever be quoted one line at a time. `/health` reports
the same as `corpus.positioned` / `corpus.lines`.

If it is short of 100%, don't re-seed — `seed --force` picks its tracks from
MusicBrainz, whose results aren't stable between runs, so it re-fetches an arbitrary
subset and may never revisit the songs that need it. Use the targeted repair, which
asks D1 exactly which songs still lack positions:

```bash
./scripts/cf.sh backfill
```

It loops until nothing is left, and stops early if a pass makes no progress (a song
whose lyrics source no longer answers stays single-line rather than looping forever).

`DRY_RUN` in `wrangler.jsonc` controls whether the bot actually posts. Only the
exact string `"false"` goes live — any other value (including a typo or an empty
one) keeps it composing and logging instead, so a mistake fails quiet rather than
loud. Watch a full cycle with `./scripts/cf.sh tail` before flipping it.

While it is live, the poll cron replies to real @mentions on whatever interval
`triggers.crons` specifies (currently every 3 minutes) and the daily cron publishes
a real post. To pause it without a redeploy, remove the crons
in the Cloudflare dashboard; to stop it properly, set `DRY_RUN` back to `"true"`
and redeploy.

## Local development

```bash
cp .dev.vars.example .dev.vars   # fill in your values (git-ignored)
npm run dev
```

Manual routes (all require `?key=<MANUAL_TRIGGER_KEY>`):

| Route | Does |
| --- | --- |
| `GET /health` | Status + corpus line count + dry-run flag (no auth) |
| `GET /dashboard` | Analytics, post list, voting, tuning |
| `GET /run/build-corpus[&maxBands=&tracksPerBand=&force=1]` | Fetch tracks + lyric lines into D1 |
| `GET /run/embed` | Embed pending lines into Vectorize |
| `GET /run/refresh` | Corpus refresh + embed, as the weekly cron runs it |
| `GET /run/backfill-positions[&limit=]` | Give positions to lines that predate them |
| `GET /run/poll` | Poll notifications and reply to mentions |
| `GET /run/post` | Publish one original post |
| `POST /api/vote` | `{ id, vote: -1 \| 0 \| 1 }` |
| `GET\|POST /api/settings` | Read or update tuning values |
| `GET /api/posts[?q=&limit=&offset=]` | Post list as JSON |
| `GET /api/summary` | Summary metrics as JSON |
| `POST /api/reply-to` | `{ url, force? }` — reply to a specific post now |

## Scripts

```bash
npm test          # vitest unit tests
npm run test:migrations  # migration runner against real SQLite
npm run typecheck # tsc --noEmit
npm run dev       # wrangler dev (local, no account needed)
npm run deploy    # ./scripts/cf.sh deploy
npm run cf -- help     # all account-pinned commands
npm run cf -- migrate  # apply pending schema migrations only
npm run cf -- backfill # repair lines that have no stored position
```

## Operations

Everything below is visible from the dashboard — you shouldn't need to query D1 to
know whether the bot is healthy.

| Symptom | What it means | Fix |
| --- | --- | --- |
| Replies are single lines | Those corpus lines have no stored position, so they can't be grown into a passage. The reply looks identical to one that legitimately had no room. | `./scripts/cf.sh backfill` — check the **passage-ready** badge |
| `LLM picks` well below 100% | The model isn't returning a usable choice, so replies fall back to the reranker's top line. They still read fine, which is why this needs a number. | Try `AI_TEXT_MODEL=@cf/meta/llama-3.1-8b-instruct-fp8-fast` |
| Same line for similar posts | Shouldn't happen — recently-used lines are filtered out. If it does, the corpus is small or heavily downvoted. | Widen `matchTopK`, or seed more bands |
| A run shows failed | `Recent runs` carries the error text | — |
| A run of kind `unknown-cron` | A schedule fires that no action claims — that job is not running | Align `wrangler.jsonc` and `ACTIONS`; `npm test` catches it |
| Poll duration approaching the cron interval | Overlapping polls can double-reply | Lengthen the interval |

Schema changes need `./scripts/cf.sh schema` (migrations then `schema.sql`); it is
safe to re-run and tracks what it has applied.

## Configuration

Tune in `wrangler.jsonc` without code changes:

- **`triggers.crons`** — poll interval, post times, corpus-refresh schedule. Original posts go out twice a
  day (15:00 and 21:00 UTC — late morning and mid-afternoon in US timezones). One action can own several
  schedules; change them in `wrangler.jsonc` **and** `ACTIONS`, which `crons.test.ts` keeps in step. Idle polls
  cost almost nothing (no KV writes, no AI), so the limit isn't resources: cron runs
  are not serialized, and a poll that outlives its interval races a second one onto
  the same mentions. Keep the interval longer than a busy poll takes — `*/5` is a
  comfortable floor, every minute is not.
- **`DRY_RUN`** — `"true"` (default) logs instead of posting.
- **`AI_TEXT_MODEL` / `AI_EMBED_MODEL` / `AI_RERANK_MODEL`** — Workers AI model ids (keep embed dims in sync
  with the Vectorize index — currently 1024).
- **`MATCH_TOP_K`** — Vectorize recall width (candidates fed to the reranker).
- **`RERANK_TOP_N`** — how many reranked lines the LLM chooses from.
- **`SNIPPET_MAX_CHARS`** — max length of the whole quote (kept short for copyright safety).
- **`PASSAGE_MAX_LINES`** — max lines one quote may span; `1` restores single-line quotes.
- **`LINE_MAX_CHARS`** — longest individual line kept when harvesting. Corpus-build only: changing it does
  nothing until you re-run `seed --force`.

Add or remove bands in `data/bands.json` (metadata only) and re-run `build-corpus`.
