import {
  isFiltered,
  isRunFiltered,
  postFilterToQuery,
  type PostFilter,
  type PostRow,
  type RunFilter,
  type RunRow,
  type Summary,
} from "./analytics";
import { bskyUrl } from "./bluesky";
import type { CorpusSize } from "./state";
import { SETTING_KEYS, SPEC, type SettingKey, type Settings } from "./settings";

// Server-rendered dashboard. Inline CSS/JS keeps it a single Worker response with
// no build step and no external requests.

const ESC: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/**
 * Escape text for safe interpolation into HTML. Single pass — this runs hundreds
 * of times per render, so five chained replaces meant five scans and five
 * allocations per value.
 */
export function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ESC[c]);
}

export function timeAgo(unixSeconds: number | null | undefined, now: number): string {
  if (!unixSeconds) return "—";
  const d = Math.max(0, now - unixSeconds);
  if (d < 60) return `${d}s ago`;
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86_400) return `${Math.floor(d / 3600)}h ago`;
  return `${Math.floor(d / 86_400)}d ago`;
}

const fmtScore = (n: number | null) => (n == null ? "—" : n.toFixed(3));

export interface Page {
  /** 1-based current page. */
  current: number;
  size: number;
  /** Total rows matching the active filter. */
  total: number;
}

export interface DashboardData {
  summary: Summary;
  posts: PostRow[];
  runs: RunRow[];
  runFilter: RunFilter;
  /** Kinds present in the data, so the filter can't offer one with no rows. */
  runKinds: string[];
  settings: Settings;
  overridden: SettingKey[];
  bands: Array<{ band: string; posts: number; up: number; down: number }>;
  /** The same validated filter used for the queries — no second string-typed copy. */
  filter: PostFilter;
  page: Page;
  now: number;
  /** Corpus size — a property of the lyric store, not of post/run analytics. */
  corpus: CorpusSize;
  /** Only what the view renders, so the template can't reach for bindings. */
  dryRun: boolean;
  textModel: string;
}

// ---- small building blocks ---------------------------------------------------

/** Empty-state row whose colspan is derived from the header list, not hand-kept. */
const emptyRow = (cols: number, msg: string) =>
  `<tr><td colspan="${cols}" class="empty">${msg}</td></tr>`;

const headRow = (cols: readonly string[]) =>
  `<thead><tr>${cols.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead>`;

/** A <select> built from data, so option values aren't spelled twice. */
function select(name: string, current: string, opts: Array<[string, string]>): string {
  const options = opts
    .map(
      ([value, label]) =>
        `<option value="${esc(value)}"${value === current ? " selected" : ""}>${esc(label)}</option>`,
    )
    .join("");
  return `<select name="${esc(name)}">${options}</select>`;
}

/**
 * Hidden inputs carrying the post filter through a runs-filter submit.
 * Both filters share one query string, so a GET form would otherwise drop
 * whichever set of params it doesn't render.
 */
function preserved(f: PostFilter): string {
  return [...postFilterToQuery(f)]
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
    .join("");
}

/** The current URL minus the run-filter params — same reason as `preserved`. */
function clearRuns(f: PostFilter): string {
  const q = postFilterToQuery(f);
  return q.toString() ? `/dashboard?${q}` : "/dashboard";
}

function card(value: string, label: string, title?: string): string {
  const tip = title ? ` title="${esc(title)}"` : "";
  return `<div class="card"${tip}><div class="n">${value}</div><div class="l">${esc(label)}</div></div>`;
}

/** Tuning input, with label/hint/bounds all taken from the settings SPEC. */
function field(key: SettingKey, value: number, modified: boolean): string {
  const { label, hint, min, max } = SPEC[key];
  const mod = modified ? ' <span class="mod">(modified)</span>' : "";
  return `<div class="field">
    <label for="${key}">${esc(label)}${mod}</label>
    <input id="${key}" name="${key}" type="number" min="${min}" max="${max}" value="${value}">
    <div class="hint">${min}–${max} · ${esc(hint)}</div>
  </div>`;
}

/** Build a /dashboard query string preserving filters while changing the page. */
export function pageHref(filter: PostFilter, page: number): string {
  const q = postFilterToQuery(filter);
  if (page > 1) q.set("page", String(page));
  const s = q.toString();
  return s ? `/dashboard?${s}` : "/dashboard";
}

function pager(d: DashboardData): string {
  const { current, size, total } = d.page;
  if (total === 0) return "";
  const pages = Math.max(1, Math.ceil(total / size));

  const from = (current - 1) * size + 1;
  const to = Math.min(current * size, total);
  const link = (page: number, label: string, disabled: boolean) =>
    disabled
      ? `<span class="pg disabled">${label}</span>`
      : `<a class="pg" href="${esc(pageHref(d.filter, page))}">${label}</a>`;

  return `<div class="pager">
    <span class="sub">${from.toLocaleString()}–${to.toLocaleString()} of ${total.toLocaleString()}</span>
    <span style="flex:1"></span>
    ${link(1, "« First", current <= 1)}
    ${link(current - 1, "‹ Prev", current <= 1)}
    <span class="sub">Page ${current} / ${pages}</span>
    ${link(current + 1, "Next ›", current >= pages)}
    ${link(pages, "Last »", current >= pages)}
  </div>`;
}

const RUN_COLS = ["When", "Kind", "Trigger", "Status", "Duration", "Stats"] as const;
const BAND_COLS = ["Band", "Posts", "👍", "👎"] as const;
const POST_COLS = [
  "When", "Kind", "Posted", "In reply to", "Source", "Scores", "Rate", "Link",
] as const;

function runRow(r: RunRow, now: number): string {
  const status =
    r.ok == null
      ? '<span class="pill">running</span>'
      : r.ok
        ? '<span class="pill ok">ok</span>'
        : '<span class="pill fail">failed</span>';
  // Duration derived from the two timestamps rather than stored a third time.
  const duration = r.finished_at == null ? "—" : `${r.finished_at - r.started_at}s`;
  return `<tr>
    <td class="sub">${esc(timeAgo(r.started_at, now))}</td>
    <td><span class="pill">${esc(r.kind)}</span></td>
    <td class="sub">${esc(r.trigger)}</td>
    <td>${status}</td>
    <td class="mono">${duration}</td>
    <td class="mono sub">${esc(r.error ?? r.stats ?? "—")}</td>
  </tr>`;
}

function postRow(p: PostRow, now: number): string {
  const url = bskyUrl(p.uri);
  const replyUrl = bskyUrl(p.reply_to_uri);
  return `<tr>
    <td class="sub" title="${esc(new Date(p.created_at * 1000).toISOString())}">
      ${esc(timeAgo(p.created_at, now))}${p.dry_run ? '<br><span class="pill">dry</span>' : ""}
    </td>
    <td><span class="pill ${p.kind}">${esc(p.kind)}</span></td>
    <td style="max-width:320px"><div class="quote">${esc(p.text)}</div>
      ${p.pick_reason ? `<div class="sub" style="margin-top:5px">“${esc(p.pick_reason)}”</div>` : ""}
    </td>
    <td style="max-width:240px">${
      p.reply_to_handle
        ? `<div class="sub">@${esc(p.reply_to_handle)}</div>
           <div class="quote sub">${esc((p.reply_to_text ?? "").slice(0, 160))}</div>
           ${replyUrl ? `<a class="sub" href="${esc(replyUrl)}" target="_blank" rel="noopener">view thread ↗</a>` : ""}`
        : '<span class="sub">—</span>'
    }</td>
    <td class="sub">${p.band_name ? esc(p.band_name) : "—"}${
      p.song_title ? `<br><em>${esc(p.song_title)}</em>` : ""
    }</td>
    <td class="mono sub">vec ${fmtScore(p.vector_score)}<br>rr&nbsp;&nbsp;${fmtScore(p.rerank_score)}</td>
    <td>
      <div class="vote" data-id="${p.id}">
        <button data-vote="1" class="${p.vote === 1 ? "on-up" : ""}" title="Upvote">👍</button>
        <button data-vote="-1" class="${p.vote === -1 ? "on-down" : ""}" title="Downvote — stops this line being reused">👎</button>
      </div>
    </td>
    <td>${
      url ? `<a href="${esc(url)}" target="_blank" rel="noopener">open ↗</a>` : '<span class="sub">—</span>'
    }</td>
  </tr>`;
}

// ---- page --------------------------------------------------------------------


/**
 * The page's stylesheet and its browser script, hoisted out of `renderDashboard`.
 * Neither changes when the page structure does, and inline they buried the actual
 * section layout between an 80-line and a 90-line blob.
 *
 * SCRIPT is a template literal because it interpolates the server's ESC table —
 * see the note where that happens.
 */
const STYLES = `<style>
  :root {
    --bg:#0f1115; --panel:#171a21; --line:#262b36; --fg:#e6e8ee; --muted:#9aa3b2;
    --accent:#c9752f; --up:#3ddc84; --down:#ff5c5c; --chip:#222734;
  }
  @media (prefers-color-scheme: light) {
    :root { --bg:#f6f7f9; --panel:#fff; --line:#e3e6ec; --fg:#161a20; --muted:#5c6675;
            --chip:#eef1f6; }
  }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--fg);
    font:14px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; }
  a { color:var(--accent); }
  header { padding:20px 24px; border-bottom:1px solid var(--line);
    display:flex; align-items:center; gap:12px; flex-wrap:wrap; }
  h1 { font-size:17px; margin:0; letter-spacing:-.01em; }
  h2 { font-size:13px; text-transform:uppercase; letter-spacing:.08em;
    color:var(--muted); margin:0 0 10px; }
  main { padding:24px; max-width:1200px; margin:0 auto; display:grid; gap:24px; }
  .badge { font-size:11px; padding:3px 9px; border-radius:999px; background:var(--chip);
    color:var(--muted); font-weight:600; }
  .badge.warn { background:#4a2c00; color:#ffc06e; cursor:help; }
  .badge.live { background:#3ddc8422; color:var(--up); }
  .badge.dry  { background:#ffb62e22; color:#ffb62e; }
  .cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(140px,1fr)); gap:12px; }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:14px; }
  .card .n { font-size:24px; font-weight:650; letter-spacing:-.02em; }
  .card .l { font-size:11px; color:var(--muted); text-transform:uppercase; letter-spacing:.06em; }
  .panel { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:18px; }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th { text-align:left; font-size:11px; text-transform:uppercase; letter-spacing:.06em;
    color:var(--muted); font-weight:600; padding:8px 10px; border-bottom:1px solid var(--line); }
  td { padding:10px; border-bottom:1px solid var(--line); vertical-align:top; }
  tr:last-child td { border-bottom:0; }
  .scroll { overflow-x:auto; }
  .mono { font-variant-numeric:tabular-nums;
    font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; }
  .quote { white-space:pre-wrap; }
  .sub { color:var(--muted); font-size:12px; }
  .pill { display:inline-block; font-size:11px; padding:2px 7px; border-radius:5px;
    background:var(--chip); color:var(--muted); }
  .pill.reply { background:#4a9eff22; color:#4a9eff; }
  .pill.original { background:#c9752f22; color:var(--accent); }
  .pill.ok { background:#3ddc8422; color:var(--up); }
  .pill.fail { background:#ff5c5c22; color:var(--down); }
  .vote { display:flex; gap:6px; }
  .vote button { background:var(--chip); border:1px solid var(--line); color:var(--muted);
    border-radius:7px; padding:5px 9px; cursor:pointer; font-size:14px; line-height:1; }
  .vote button:hover { border-color:var(--muted); }
  .vote button.on-up   { background:#3ddc8433; border-color:var(--up); color:var(--up); }
  .vote button.on-down { background:#ff5c5c33; border-color:var(--down); color:var(--down); }
  form.filters { display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
  input,select { background:var(--bg); color:var(--fg); border:1px solid var(--line);
    border-radius:7px; padding:7px 9px; font:inherit; }
  button.primary { background:var(--accent); color:#fff; border:0; border-radius:7px;
    padding:8px 14px; font:inherit; font-weight:600; cursor:pointer; }
  .settings-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(210px,1fr));
    gap:14px; align-items:end; }
  .field label { display:block; font-size:12px; color:var(--muted); margin-bottom:5px; }
  .field input { width:100%; }
  .field .hint { font-size:11px; color:var(--muted); margin-top:4px; }
  .mod { color:var(--accent); font-weight:600; }
  .up { color:var(--up); }
  .down { color:var(--down); }
  .reply-form { display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
  .reply-form input[type=url] { flex:1; min-width:280px; }
  #reply-out { margin-top:14px; font-size:13px; display:none; }
  #reply-out.show { display:block; }
  #reply-out .box { background:var(--bg); border:1px solid var(--line);
    border-radius:8px; padding:12px; margin-top:8px; white-space:pre-wrap; }
  .pager { display:flex; gap:10px; align-items:center; margin-top:14px; flex-wrap:wrap; }
  .pg { font-size:12px; padding:6px 11px; border-radius:7px; border:1px solid var(--line);
    background:var(--chip); color:var(--fg); text-decoration:none; }
  .pg:hover { border-color:var(--muted); }
  .pg.disabled { opacity:.4; }
  #toast { position:fixed; bottom:20px; left:50%; transform:translateX(-50%);
    background:var(--panel); border:1px solid var(--line); border-radius:8px;
    padding:10px 16px; opacity:0; transition:opacity .2s; pointer-events:none; }
  #toast.show { opacity:1; }
  .empty { color:var(--muted); text-align:center; padding:28px; }
</style>`;

const SCRIPT = `<script>
// The escape table is emitted from the server's ESC rather than re-declared, so
// adding an entity there covers the browser too. This escaper guards the reply-to
// panel, which renders attacker-controlled post text.
const ESC = ${JSON.stringify(ESC)};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

const toast = (msg) => {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 1800);
};

document.querySelectorAll('.vote button').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const row = btn.closest('.vote');
    const id = row.dataset.id;
    // Clicking an active vote clears it.
    const want = btn.classList.contains('on-up') || btn.classList.contains('on-down')
      ? 0 : Number(btn.dataset.vote);
    try {
      const res = await fetch('/api/vote', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: Number(id), vote: want }),
      });
      if (!res.ok) throw new Error(await res.text());
      row.querySelectorAll('button').forEach((b) => b.classList.remove('on-up','on-down'));
      if (want === 1) row.querySelector('[data-vote="1"]').classList.add('on-up');
      if (want === -1) row.querySelector('[data-vote="-1"]').classList.add('on-down');
      toast(want === 0 ? 'Vote cleared' : want === 1 ? '👍 Saved' : '👎 Saved — line won\\'t be reused');
    } catch (e) { toast('Failed: ' + e.message); }
  });
});

document.getElementById('reply-to').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const form = ev.target;
  const btn = form.querySelector('button');
  const out = document.getElementById('reply-out');
  const url = form.url.value.trim();
  btn.disabled = true; btn.textContent = 'Working…';
  out.className = 'show';
  out.innerHTML = '<span class="sub">Resolving post and matching a lyric…</span>';
  try {
    const res = await fetch('/api/reply-to', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url, force: document.getElementById('reply-force').checked }),
    });
    const j = await res.json();
    if (!res.ok || !j.ok) throw new Error(j.error || ('HTTP ' + res.status));

    if (!j.replied) {
      const why = { empty: 'the post had no usable text',
                    unsafe: 'the post tripped the safety filter',
                    'no-match': 'no lyric line matched (is the corpus embedded?)',
                    'already-answered': 'the bot has already replied to this post' }[j.reason] || j.reason;
      // "already answered" is the one refusal with a deliberate override, so say so
      // here rather than leaving the reader to find the checkbox above.
      const again = j.reason === 'already-answered'
        ? ' Tick <em>reply again</em> to post a second reply anyway.'
        : '';
      out.innerHTML = '<strong>No reply sent</strong> — ' + esc(why) + again +
        '<div class="box sub">@' + esc(j.target.author) + ': ' + esc(j.target.text) + '</div>';
    } else {
      out.innerHTML = '<strong>' + (j.dryRun ? 'Composed (dry run — not published)' : 'Replied') +
        '</strong> · ' + esc(j.band) + ', “' + esc(j.song) + '”' +
        '<div class="box">' + esc(j.snippet) + '</div>' +
        '<div class="sub" style="margin-top:8px">in reply to @' + esc(j.target.author) +
        ': ' + esc(j.target.text) + '</div>' +
        (j.url ? '<div style="margin-top:8px"><a href="' + esc(j.url) +
          '" target="_blank" rel="noopener">open reply ↗</a></div>' : '');
      toast(j.dryRun ? 'Composed (dry run)' : 'Reply published');
    }
  } catch (e) {
    out.innerHTML = '<strong style="color:var(--down)">Failed</strong> — ' + esc(e.message);
  } finally {
    btn.disabled = false; btn.textContent = 'Compose reply';
  }
});

document.getElementById('settings').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const body = Object.fromEntries(new FormData(ev.target).entries());
  try {
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(await res.text());
    const json = await res.json();
    // Built from whatever came back, so a new SPEC entry shows up without an edit.
    toast('Tuning saved — ' + Object.entries(json.settings).map(([k, v]) => k + '=' + v).join(', '));
  } catch (e) { toast('Failed: ' + e.message); }
});
</script>`;

/**
 * Share of replies where the model actually chose, rather than the reranker's top
 * line being used because nothing usable came back.
 *
 * Worth a tile because a fallback reply reads perfectly fine — you cannot tell from
 * the post that the pick stage did nothing, so without this the LLM could be dead
 * and the only symptom would be slightly worse replies.
 */
function pickHealth(s: Summary): string {
  if (s.replies === 0) return "—";
  return `${Math.round(((s.replies - s.fallbackPicks) / s.replies) * 100)}%`;
}

/**
 * How much of the corpus can produce a passage rather than a lone line.
 *
 * A line harvested before positions existed has `pos = NULL` and will always be
 * quoted alone, however the tuning is set — and there is no way to tell that from
 * the reply itself, which just looks like a short one. Shown as a warning below
 * 100% so the fix (`cf.sh backfill`) is discoverable from the symptom. Not
 * `seed --force` — that re-fetches an arbitrary MusicBrainz subset and may never
 * revisit the songs that need it, which is why the backfill exists.
 */
function passageBadge(c: CorpusSize): string {
  if (c.lines === 0) return "";
  const pct = Math.round((c.positioned / c.lines) * 100);
  if (pct >= 100) return `<span class="badge">passage-ready</span>`;
  return (
    `<span class="badge warn" title="Lines without a stored position can only be quoted ` +
    `one at a time. Fix: ./scripts/cf.sh backfill">${pct}% passage-ready</span>`
  );
}

export function renderDashboard(d: DashboardData): string {
  const s = d.summary;
  const rated = s.upvotes + s.downvotes;
  const approval = rated > 0 ? Math.round((s.upvotes / rated) * 100) : null;
  const filtered = isFiltered(d.filter);
  const voteParam = d.filter.vote === undefined ? "" : String(d.filter.vote);

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>bluesky-grunge-bot · dashboard</title>
${STYLES}
</head><body>
<header>
  <h1>🎸 bluesky-grunge-bot</h1>
  <span class="badge ${d.dryRun ? "dry" : "live"}">${d.dryRun ? "DRY RUN" : "LIVE"}</span>
  <span class="badge">${d.corpus.lines.toLocaleString()} lyric lines</span>
  ${passageBadge(d.corpus)}
  <span class="badge">last post ${esc(timeAgo(s.lastPostAt, d.now))}</span>
  <span style="flex:1"></span>
  <span class="sub mono">${esc(d.textModel)}</span>
</header>
<main>

  <section>
    <h2>Overview</h2>
    <div class="cards">
      ${card(s.totalPosts.toLocaleString(), "total posts")}
      ${card(s.replies.toLocaleString(), "replies")}
      ${card(s.originals.toLocaleString(), "originals")}
      ${card(`<span class="up">${s.upvotes}</span> / <span class="down">${s.downvotes}</span>`, "👍 / 👎")}
      ${card(approval === null ? "—" : approval + "%", "approval")}
      ${card(fmtScore(s.avgRerank), "avg rerank")}
      ${card(
        pickHealth(s),
        "LLM picks",
        "Share of replies where the model chose the line, rather than falling back " +
          "to the reranker's top. Replies recorded before 2026-07 read low: a " +
          "successful structured pick was mislabelled as a fallback, and the old " +
          "rows cannot be told apart after the fact.",
      )}
      ${card(s.runs24h.toLocaleString(), "runs 24h")}
      ${card(s.failures24h > 0 ? `<span class="down">${s.failures24h}</span>` : "0", "failures 24h")}
    </div>
  </section>

  <section class="panel">
    <h2>Tuning</h2>
    <form class="settings-grid" id="settings">
      ${SETTING_KEYS.map((k) => field(k, d.settings[k], d.overridden.includes(k))).join("")}
      <div><button class="primary" type="submit">Save tuning</button></div>
    </form>
    <p class="sub" style="margin:12px 0 0">
      Saved values live in KV and override <code>wrangler.jsonc</code> without a redeploy.
      Clear a field to fall back to the deployed default.
      ${d.overridden.length ? `<br><span class="mod">Overridden:</span> ${d.overridden.map(esc).join(", ")}` : ""}
      <br>Raising <strong>topN</strong> gives the model more room to pick for wit; lowering it favours literal relevance.
    </p>
  </section>

  <section class="panel">
    <h2>Recent runs</h2>
    <form class="filters" method="get">
      ${preserved(d.filter)}
      ${select("runKind", d.runFilter.kind ?? "", [
        ["", "All jobs"],
        ...d.runKinds.map((k) => [k, k] as [string, string]),
      ])}
      ${select("run", d.runFilter.ok === undefined ? "" : d.runFilter.ok ? "ok" : "failed", [
        ["", "Any outcome"],
        ["ok", "Succeeded"],
        ["failed", "Failed"],
      ])}
      <button class="primary" type="submit">Filter</button>
      ${
        isRunFiltered(d.runFilter)
          ? `<a class="sub" href="${esc(clearRuns(d.filter))}">clear</a>`
          : ""
      }
    </form>
    <div class="scroll">
      <table>
        ${headRow(RUN_COLS)}
        <tbody>
        ${
          d.runs.length === 0
            ? emptyRow(RUN_COLS.length, "No runs recorded yet.")
            : d.runs.map((r) => runRow(r, d.now)).join("")
        }
        </tbody>
      </table>
    </div>
  </section>

  ${
    d.bands.length
      ? `<section class="panel">
    <h2>Bands by reception</h2>
    <div class="scroll"><table>
      ${headRow(BAND_COLS)}
      <tbody>${d.bands
        .map(
          (b) =>
            `<tr><td>${esc(b.band)}</td><td class="mono">${b.posts}</td>
             <td class="mono up">${b.up}</td><td class="mono down">${b.down}</td></tr>`,
        )
        .join("")}</tbody>
    </table></div>
  </section>`
      : ""
  }

  <section class="panel">
    <h2>Reply to a post</h2>
    <form class="reply-form" id="reply-to">
      <input type="url" name="url" required
             placeholder="https://bsky.app/profile/someone.bsky.social/post/3k2a…">
      <button class="primary" type="submit">Compose reply</button>
    </form>
    <label class="sub" style="display:block;margin-top:8px">
      <input type="checkbox" id="reply-force"> reply again even if this post was already answered
    </label>
    <p class="sub" style="margin:10px 0 0">
      Runs the same pipeline a mention would: match → rerank → pick → reply.
      ${
        d.dryRun
          ? "<strong>DRY RUN is on</strong> — this composes and records the reply without publishing it."
          : "<strong>LIVE</strong> — this will publish a real reply to that post."
      }
    </p>
    <div id="reply-out"></div>
  </section>

  <section class="panel">
    <h2>Posts &amp; replies</h2>
    <form class="filters" method="get" action="/dashboard">
      <input type="search" name="q" placeholder="Search text, band, song, handle…"
             value="${esc(d.filter.search ?? "")}">
      ${select("kind", d.filter.kind ?? "", [
        ["", "All kinds"],
        ["reply", "Replies"],
        ["original", "Originals"],
      ])}
      ${select("vote", voteParam, [
        ["", "All votes"],
        ["1", "👍 Upvoted"],
        ["-1", "👎 Downvoted"],
        ["0", "Unrated"],
      ])}
      <button class="primary" type="submit">Filter</button>
    </form>
    <div class="scroll" style="margin-top:14px">
      <table>
        ${headRow(POST_COLS)}
        <tbody>
        ${
          d.posts.length === 0
            ? emptyRow(
                POST_COLS.length,
                filtered
                  ? "No posts match this filter."
                  : "No posts yet. Run <code>/run/poll</code> or <code>/run/post</code> to generate some.",
              )
            : d.posts.map((p) => postRow(p, d.now)).join("")
        }
        </tbody>
      </table>
    </div>
    ${pager(d)}
  </section>
</main>
<div id="toast"></div>
${SCRIPT}
</body></html>`;
}
