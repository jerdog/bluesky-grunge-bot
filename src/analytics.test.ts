import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  countPosts,
  getDownvotedLineIds,
  isFiltered,
  isVote,
  listPosts,
  listRuns,
  parsePostFilter,
  parseRunFilter,
  recordPost,
  runFilterToQuery,
  setVote,
  withRun,
} from "./analytics";
import type { Env } from "./env";

// Minimal D1 stub that records the SQL and bindings it was given.
function dbStub(result: unknown, meta: { changes?: number } = {}) {
  const calls: Array<{ sql: string; binds: unknown[] }> = [];
  const DB = {
    prepare(sql: string) {
      const entry = { sql, binds: [] as unknown[] };
      calls.push(entry);
      const stmt = {
        bind(...binds: unknown[]) {
          entry.binds = binds;
          return stmt;
        },
        all: async () => ({ results: result }),
        first: async () => (Array.isArray(result) ? result[0] : result),
        run: async () => ({ meta }),
      };
      return stmt;
    },
  };
  return { env: { DB } as unknown as Env, calls };
}

describe("isVote", () => {
  it("accepts only -1, 0 and 1", () => {
    expect(isVote(-1)).toBe(true);
    expect(isVote(0)).toBe(true);
    expect(isVote(1)).toBe(true);
    expect(isVote(5)).toBe(false);
    expect(isVote("1")).toBe(false);
    expect(isVote(Number.NaN)).toBe(false);
    expect(isVote(undefined)).toBe(false);
  });
});

describe("setVote", () => {
  it("stores the vote and a timestamp", async () => {
    const { env, calls } = dbStub(null, { changes: 1 });
    expect(await setVote(env, 42, 1)).toBe(true);
    const [vote, votedAt, id] = calls[0].binds;
    expect(vote).toBe(1);
    expect(typeof votedAt).toBe("number");
    expect(id).toBe(42);
  });

  it("clears voted_at when the vote is reset to 0", async () => {
    const { env, calls } = dbStub(null, { changes: 1 });
    await setVote(env, 42, 0);
    expect(calls[0].binds).toEqual([0, null, 42]);
  });

  it("reports false when no row matched", async () => {
    const { env } = dbStub(null, { changes: 0 });
    expect(await setVote(env, 999, -1)).toBe(false);
  });
});

describe("getDownvotedLineIds", () => {
  it("returns a set of line ids", async () => {
    const { env } = dbStub([{ line_id: "a" }, { line_id: "b" }]);
    const s = await getDownvotedLineIds(env);
    expect(s.has("a")).toBe(true);
    expect(s.has("b")).toBe(true);
    expect(s.size).toBe(2);
  });

  it("returns an empty set when the query fails (never blocks matching)", async () => {
    const env = {
      DB: {
        prepare() {
          throw new Error("no such table");
        },
      },
    } as unknown as Env;
    expect((await getDownvotedLineIds(env)).size).toBe(0);
  });
});

describe("listPosts", () => {
  it("builds filters and clamps the limit", async () => {
    const { env, calls } = dbStub([]);
    await listPosts(env, { kind: "reply", vote: -1, search: "summer", limit: 9999 });
    expect(calls[0].sql).toContain("kind = ?");
    expect(calls[0].sql).toContain("vote = ?");
    expect(calls[0].sql).toContain("LIKE ?");
    // kind, vote, 4x search LIKE, then limit (clamped to 200) + offset
    expect(calls[0].binds).toEqual(["reply", -1, "%summer%", "%summer%", "%summer%", "%summer%", 200, 0]);
  });

  it("omits the WHERE clause when unfiltered", async () => {
    const { env, calls } = dbStub([]);
    await listPosts(env);
    expect(calls[0].sql).not.toContain("WHERE");
    expect(calls[0].binds).toEqual([50, 0]);
  });

  it("applies limit and offset for paging", async () => {
    const { env, calls } = dbStub([]);
    await listPosts(env, { limit: 25, offset: 50 });
    expect(calls[0].binds).toEqual([25, 50]);
  });

  it("floors a negative offset", async () => {
    const { env, calls } = dbStub([]);
    await listPosts(env, { limit: 25, offset: -10 });
    expect(calls[0].binds).toEqual([25, 0]);
  });
});

describe("countPosts", () => {
  it("counts with the same filter bindings as listPosts, without paging binds", async () => {
    const { env, calls } = dbStub({ n: 137 });
    const n = await countPosts(env, { kind: "reply", search: "summer" });
    expect(n).toBe(137);
    expect(calls[0].sql).toContain("COUNT(*)");
    expect(calls[0].sql).toContain("kind = ?");
    expect(calls[0].binds).toEqual(["reply", "%summer%", "%summer%", "%summer%", "%summer%"]);
  });

  it("returns 0 when the row is missing", async () => {
    const { env } = dbStub(null);
    expect(await countPosts(env)).toBe(0);
  });

  it("shares the WHERE clause with listPosts so they cannot drift", async () => {
    const filter = { kind: "original" as const, vote: 1 as const, search: "x" };
    const a = dbStub([]);
    await listPosts(a.env, filter);
    const b = dbStub({ n: 0 });
    await countPosts(b.env, filter);

    expect(a.calls[0].sql).toContain("WHERE");
    // Same filter binds, in the same order; list just appends limit/offset.
    expect(a.calls[0].binds.slice(0, b.calls[0].binds.length)).toEqual(b.calls[0].binds);
  });
});

describe("parsePostFilter", () => {
  const parse = (qs: string) => parsePostFilter(new URL(`https://x/dashboard${qs}`));

  it("reads valid kind, vote and search", () => {
    expect(parse("?kind=reply&vote=-1&q=summer")).toEqual({
      kind: "reply",
      vote: -1,
      search: "summer",
    });
  });

  it("keeps vote=0 (unrated is a real filter, not falsy-empty)", () => {
    expect(parse("?vote=0").vote).toBe(0);
  });

  it("drops invalid values instead of passing them to SQL", () => {
    expect(parse("?kind=bogus&vote=9&q=")).toEqual({
      kind: undefined,
      vote: undefined,
      search: undefined,
    });
  });
});

describe("isFiltered", () => {
  it("is false only when nothing is applied", () => {
    expect(isFiltered({})).toBe(false);
    expect(isFiltered({ vote: 0 })).toBe(true); // unrated counts as filtered
    expect(isFiltered({ kind: "reply" })).toBe(true);
    expect(isFiltered({ search: "x" })).toBe(true);
  });
});

describe("vote-driven exclusion", () => {
  it("downvoted line ids are what matching filters on", async () => {
    // Guards the contract between analytics and match.ts.
    const { env } = dbStub([{ line_id: "panned-line" }]);
    const excluded = await getDownvotedLineIds(env);
    const vectorMatches = [{ id: "panned-line" }, { id: "good-line" }];
    const kept = vectorMatches.filter((m) => !excluded.has(m.id));
    expect(kept.map((k) => k.id)).toEqual(["good-line"]);
  });
});

describe("analytics never breaks the work", () => {
  // These tests inject failures on purpose, and bestEffort logs each one. Silence
  // it so a passing run doesn't print a wall of stack traces that reads as broken.
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  const broken = {
    DB: {
      prepare: () => {
        throw new Error("D1 down");
      },
    },
    DRY_RUN: "true",
  } as unknown as Env;

  it("swallows a recordPost failure", async () => {
    // recordPost runs *after* the reply is published. If it threw, the mention
    // would never be marked handled and the next poll would reply a second time —
    // bookkeeping causing a visible duplicate.
    await expect(
      recordPost(broken, { kind: "reply", text: "x" }),
    ).resolves.toBeUndefined();
  });

  it("swallows a getDownvotedLineIds failure and degrades to no exclusions", async () => {
    await expect(getDownvotedLineIds(broken)).resolves.toEqual(new Set());
  });

  it("still runs the work, and reports it, when run bookkeeping is down", async () => {
    const result = await withRun(broken, "poll", "cron", async () => "did the work");
    expect(result).toBe("did the work");
  });

  it("propagates the work's own failure rather than hiding it", async () => {
    await expect(
      withRun(broken, "poll", "cron", async () => {
        throw new Error("the actual job failed");
      }),
    ).rejects.toThrow("the actual job failed");
  });
});

describe("run filtering", () => {
  it("round-trips through parse and toQuery", () => {
    for (const f of [{}, { kind: "poll" }, { ok: true }, { kind: "post", ok: false }]) {
      const url = new URL(`https://x/dashboard?${runFilterToQuery(f)}`);
      expect(parseRunFilter(url)).toEqual(f);
    }
  });

  it("ignores an unknown outcome rather than filtering everything out", () => {
    expect(parseRunFilter(new URL("https://x/dashboard?run=maybe"))).toEqual({
      kind: undefined,
      ok: undefined,
    });
  });

  it("treats an unfinished run as neither succeeded nor failed", async () => {
    // ok is NULL until finishRun lands. Without the IS NOT NULL guard, SQLite's
    // NULL = 0 comparison would be neither true nor false — but the guard also
    // documents that an in-flight poll is not a failure.
    const calls: Array<{ sql: string; binds: unknown[] }> = [];
    const env = {
      DB: {
        prepare: (sql: string) => ({
          bind: (...binds: unknown[]) => ({ all: async () => (calls.push({ sql, binds }), { results: [] }) }),
        }),
      },
    } as unknown as Env;

    await listRuns(env, 20, { ok: false });
    expect(calls[0].sql).toContain("ok IS NOT NULL AND ok = ?");
    expect(calls[0].binds).toEqual([0, 20]);
  });

  it("applies no WHERE clause when unfiltered", async () => {
    const calls: string[] = [];
    const env = {
      DB: {
        prepare: (sql: string) => ({
          bind: () => ({ all: async () => (calls.push(sql), { results: [] }) }),
        }),
      },
    } as unknown as Env;
    await listRuns(env, 20);
    expect(calls[0]).not.toContain("WHERE");
  });
});
