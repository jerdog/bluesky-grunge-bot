import { describe, it, expect } from "vitest";
import { esc, timeAgo, renderDashboard, pageHref } from "./dashboard";
import type { PostRow, RunRow, Summary } from "./analytics";

describe("esc", () => {
  it("escapes HTML-significant characters", () => {
    expect(esc('<script>alert("x")</script>')).toBe(
      "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;",
    );
    expect(esc("a & b")).toBe("a &amp; b");
    expect(esc("it's")).toBe("it&#39;s");
  });

  it("renders null/undefined as empty", () => {
    expect(esc(null)).toBe("");
    expect(esc(undefined)).toBe("");
  });
});

describe("timeAgo", () => {
  const now = 1_000_000;
  it("formats relative times", () => {
    expect(timeAgo(now - 5, now)).toBe("5s ago");
    expect(timeAgo(now - 120, now)).toBe("2m ago");
    expect(timeAgo(now - 7200, now)).toBe("2h ago");
    expect(timeAgo(now - 172_800, now)).toBe("2d ago");
  });
  it("handles missing timestamps", () => {
    expect(timeAgo(null, now)).toBe("—");
  });
});

const summary: Summary = {
  totalPosts: 3,
  replies: 2,
  originals: 1,
  upvotes: 2,
  downvotes: 1,
  avgRerank: 0.812,
  lastPostAt: 999_000,
  runs24h: 5,
  failures24h: 1,
  fallbackPicks: 0,
};

function post(over: Partial<PostRow> = {}): PostRow {
  return {
    id: 1,
    uri: "at://did:plc:abc/app.bsky.feed.post/3k2a",
    cid: "cid1",
    kind: "reply",
    text: "a synthetic line\n— Example Band, “Sample Song”",
    line_id: "line-1",
    band_name: "Example Band",
    song_title: "Sample Song",
    vector_score: 0.78,
    rerank_score: 0.95,
    pick_reason: "matches the mood",
    text_model: "@cf/google/gemma-4-26b-a4b-it",
    reply_to_uri: "at://did:plc:xyz/app.bsky.feed.post/9zz",
    reply_to_handle: "someone.bsky.social",
    reply_to_text: "what's a good summer song?",
    dry_run: 0,
    created_at: 999_000,
    vote: 0,
    voted_at: null,
    ...over,
  };
}

const run: RunRow = {
  id: 1,
  kind: "poll",
  trigger: "cron",
  started_at: 998_000,
  finished_at: 998_002,
  ok: 1,
  stats: '{"scanned":3,"answered":2}',
  error: null,
};

const TEXT_MODEL = "@cf/google/gemma-4-26b-a4b-it";

function render(over: Partial<Parameters<typeof renderDashboard>[0]> = {}) {
  return renderDashboard({
    summary,
    posts: [post()],
    runs: [run],
    runFilter: {},
    runKinds: ["poll", "post", "refresh"],
    settings: {
      matchTopK: 25,
      rerankTopN: 4,
      snippetMaxChars: 260,
      passageMaxLines: 6,
      lineMaxChars: 150,
    },
    overridden: ["rerankTopN"],
    bands: [{ band: "Example Band", posts: 3, up: 2, down: 1 }],
    filter: {},
    page: { current: 1, size: 25, total: 1 },
    now: 1_000_000,
    corpus: { lines: 12_640, positioned: 12_640 },
    dryRun: false,
    textModel: TEXT_MODEL,
    ...over,
  });
}

describe("renderDashboard", () => {
  it("warns when part of the corpus can't produce a passage, and says how much", () => {
    // A pos-less line is quoted alone no matter how the tuning is set, and the
    // reply gives no hint why — so the dashboard has to say it.
    const partial = render({ corpus: { lines: 1000, positioned: 250 } });
    expect(partial).toContain("25% passage-ready");
    expect(partial).toContain("cf.sh backfill");
    expect(render()).toContain(">passage-ready<"); // fully positioned: no percentage
  });

  it("shows what share of replies the model actually picked", () => {
    // A fallback reply reads fine, so a dead pick stage is otherwise invisible.
    expect(render()).toContain("100%");
    expect(
      render({ summary: { ...summary, replies: 4, fallbackPicks: 3 } }),
    ).toContain("25%");
    expect(render({ summary: { ...summary, replies: 0 } })).toContain("LLM picks");
  });

  it("renders summary metrics", () => {
    const html = render();
    expect(html).toContain("12,640");        // corpus lines
    expect(html).toContain("0.812");         // avg rerank
    expect(html).toContain("67%");           // approval: 2 up / 3 rated
  });

  it("shows the live/dry-run badge from env", () => {
    expect(render()).toContain(">LIVE<");
    const dry = render({ dryRun: true });
    expect(dry).toContain(">DRY RUN<");
  });

  it("links posts to bsky.app and the parent thread", () => {
    const html = render();
    expect(html).toContain("https://bsky.app/profile/did:plc:abc/post/3k2a");
    expect(html).toContain("https://bsky.app/profile/did:plc:xyz/post/9zz");
  });

  it("marks the current vote state on the buttons", () => {
    const up = render({ posts: [post({ vote: 1 })] });
    expect(up).toMatch(/data-vote="1"\s+class="on-up"/);
    expect(up).not.toMatch(/data-vote="-1"\s+class="on-down"/);

    const down = render({ posts: [post({ vote: -1 })] });
    expect(down).toMatch(/data-vote="-1"\s+class="on-down"/);
    expect(down).not.toMatch(/data-vote="1"\s+class="on-up"/);

    // Unrated: both buttons render with an empty class.
    const unrated = render({ posts: [post({ vote: 0 })] });
    expect(unrated).toMatch(/data-vote="1"\s+class=""/);
    expect(unrated).toMatch(/data-vote="-1"\s+class=""/);
  });

  it("flags overridden tuning values", () => {
    expect(render()).toContain("(modified)");
  });

  it("renders current tuning values into the form", () => {
    const html = render();
    expect(html).toMatch(/id="rerankTopN"[^>]*value="4"/);
    expect(html).toMatch(/id="matchTopK"[^>]*value="25"/);
  });

  it("drives field bounds and hints from the settings SPEC, not hardcoded copy", () => {
    const html = render();
    // rerankTopN is 1–20 in SPEC — the input constraints and hint must agree.
    expect(html).toMatch(/id="rerankTopN"[^>]*min="1"[^>]*max="20"/);
    expect(html).toContain("1–20 · lines the LLM picks from");
    expect(html).toMatch(/id="matchTopK"[^>]*min="1"[^>]*max="50"/);
    expect(html).toContain("40–280 · total quote length posted");
    expect(html).toMatch(/id="passageMaxLines"[^>]*min="1"[^>]*max="12"/);
  });

  it("escapes untrusted post content", () => {
    const html = render({
      posts: [post({ reply_to_text: '<img src=x onerror=alert(1)>', reply_to_handle: "a<b" })],
    });
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x");
    expect(html).toContain("a&lt;b");
  });

  it("filters recent runs by job and outcome, keeping the post filter intact", () => {
    const html = render({
      runFilter: { kind: "poll", ok: false },
      filter: { search: "summer" },
    });
    // Both filters share one query string, so the runs form has to carry the
    // post filter forward or submitting it would silently drop the search.
    expect(html).toMatch(/name="runKind"[\s\S]*?<option value="poll" selected/);
    expect(html).toMatch(/name="run"[\s\S]*?<option value="failed" selected/);
    expect(html).toContain('<input type="hidden" name="q" value="summer">');
    expect(html).toContain(">clear<");
  });

  it("offers only job kinds that actually have runs", () => {
    const html = render({ runKinds: ["poll"] });
    expect(html).toContain('<option value="poll"');
    expect(html).not.toContain('<option value="refresh"');
  });

  it("shows empty states", () => {
    const html = render({ posts: [], runs: [], page: { current: 1, size: 25, total: 0 } });
    expect(html).toContain("No posts yet");
    expect(html).toContain("No runs recorded yet");
  });

  it("marks dry-run rows", () => {
    expect(render({ posts: [post({ dry_run: 1, uri: null })] })).toContain(">dry<");
  });

  it("distinguishes an empty corpus from an empty filter result", () => {
    expect(render({ posts: [], page: { current: 1, size: 25, total: 0 } })).toContain("No posts yet");
    expect(
      render({ posts: [], filter: { search: "zzz" }, page: { current: 1, size: 25, total: 0 } }),
    ).toContain("No posts match this filter");
  });
});

describe("reply-to panel", () => {
  it("renders the form and posts to /api/reply-to", () => {
    const html = render();
    expect(html).toContain('id="reply-to"');
    expect(html).toContain("Reply to a post");
    expect(html).toContain("/api/reply-to");
  });

  it("offers the force override, since the bot answers a post only once", () => {
    // A refusal the operator cannot act on is a dead end; the checkbox is the
    // documented way to ask for a deliberate repeat.
    const html = render();
    expect(html).toContain('id="reply-force"');
    expect(html).toContain("reply again");
    expect(html).toContain("already replied to this post");
  });

  it("warns that a live reply is real, and that a dry run is not", () => {
    expect(render({ dryRun: false })).toContain("will publish a real reply");
    expect(render({ dryRun: true })).toContain("without publishing it");
  });
});

describe("pageHref", () => {
  it("omits page=1 and empty filters", () => {
    expect(pageHref({}, 1)).toBe("/dashboard");
  });

  it("preserves active filters across pages", () => {
    expect(pageHref({ search: "summer", kind: "reply", vote: -1 }, 3)).toBe(
      "/dashboard?q=summer&kind=reply&vote=-1&page=3",
    );
  });

  it("keeps vote=0 in the link (unrated is a real filter, not falsy-empty)", () => {
    expect(pageHref({ vote: 0 }, 2)).toBe("/dashboard?vote=0&page=2");
  });

  it("encodes search terms", () => {
    expect(pageHref({ search: "a & b" }, 2)).toBe("/dashboard?q=a+%26+b&page=2");
  });
});

describe("pagination controls", () => {
  const many = Array.from({ length: 25 }, (_, i) => post({ id: i + 1 }));

  it("hides the pager when there are no rows", () => {
    // Scoped to the rendered element — ".pager" also appears in the stylesheet.
    expect(render({ posts: [], page: { current: 1, size: 25, total: 0 } })).not.toContain(
      '<div class="pager">',
    );
    expect(render({ posts: many, page: { current: 1, size: 25, total: 60 } })).toContain(
      '<div class="pager">',
    );
  });

  it("shows the row range and page count", () => {
    const html = render({ posts: many, page: { current: 2, size: 25, total: 120 } });
    expect(html).toContain("26–50 of 120");
    expect(html).toContain("Page 2 / 5");
  });

  it("disables Prev/First on the first page and links Next", () => {
    const html = render({ posts: many, page: { current: 1, size: 25, total: 120 } });
    expect(html).toMatch(/<span class="pg disabled">‹ Prev<\/span>/);
    expect(html).toMatch(/<span class="pg disabled">« First<\/span>/);
    expect(html).toContain('href="/dashboard?page=2"');
  });

  it("disables Next/Last on the final page and links Prev", () => {
    const html = render({ posts: many, page: { current: 5, size: 25, total: 120 } });
    expect(html).toMatch(/<span class="pg disabled">Next ›<\/span>/);
    expect(html).toMatch(/<span class="pg disabled">Last »<\/span>/);
    expect(html).toContain('href="/dashboard?page=4"');
  });

  it("carries filters into pager links", () => {
    const html = render({
      posts: many,
      filter: { kind: "reply" },
      page: { current: 1, size: 25, total: 60 },
    });
    expect(html).toContain("kind=reply&amp;page=2");
  });

  it("clamps the last-page link to the real page count", () => {
    const html = render({ posts: many, page: { current: 1, size: 25, total: 51 } });
    expect(html).toContain("Page 1 / 3");
    expect(html).toContain('href="/dashboard?page=3"');
  });
});
