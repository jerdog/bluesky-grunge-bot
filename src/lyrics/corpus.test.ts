import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { backfillPositions, lineId } from "./corpus";
import type { Env } from "./../env";

describe("lineId", () => {
  /**
   * GOLDEN VALUE — do not "update to match" a new output.
   *
   * Line ids are persisted: they key the Vectorize index, `posts.line_id` (which
   * is what makes a 👎 retire a line), and the `recent:<id>` KV flags. If this
   * assertion fails, the id derivation changed and every one of those references
   * is orphaned. Fix the code, not the expectation.
   */
  it("is pinned to a stable hash", () => {
    expect(lineId("Example Band", "Sample Song", "a synthetic line")).toBe("d2b8b02b-29");
  });

  it("is deterministic for the same inputs", () => {
    expect(lineId("Band", "Song", "a synthetic line")).toBe(
      lineId("Band", "Song", "a synthetic line"),
    );
  });

  it("is case-insensitive", () => {
    expect(lineId("BAND", "SONG", "LINE")).toBe(lineId("band", "song", "line"));
  });

  it("differs for different lines", () => {
    expect(lineId("Band", "Song", "line one")).not.toBe(lineId("Band", "Song", "line two"));
  });

  it("does not collide when a separator-spanning shift would ambiguate", () => {
    // A space separator would make these identical; the NUL separator keeps them apart.
    expect(lineId("A B", "C", "x")).not.toBe(lineId("A", "B C", "x"));
  });
});

describe("backfillPositions", () => {
  // Synthetic lines — not real lyrics.
  const LYRICS = "we drove around all night\nthe radio was static\nyou said you were leaving";

  function makeEnv(over: { songs?: unknown[]; lyrics?: string | null } = {}) {
    const batches: unknown[][] = [];
    const deleted: number[] = [];
    // D1 allows first()/all()/run() with or without a preceding bind(), so the stub
    // has to answer at both levels — countUnpositionedSongs takes no parameters.
    const prepare = vi.fn((sql: string) => {
      const stmt = (args: unknown[] = []) => ({
        bind: (...next: unknown[]) => stmt(next),
        all: async () => ({
          results: over.songs ?? [{ song_id: 1, band_name: "B", song_title: "S" }],
        }),
        first: async () => ({ n: 0 }),
        run: async () => {
          if (sql.includes("DELETE")) deleted.push(args[0] as number);
          return { meta: { changes: 2 } };
        },
      });
      return stmt();
    });
    const env = {
      DB: { prepare, batch: async (s: unknown[]) => batches.push(s) },
      STATE: { get: async () => null },
      LINE_MAX_CHARS: "150",
    } as unknown as Env;
    return { env, batches, deleted, prepare };
  }

  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ plainLyrics: LYRICS }))),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it("re-fetches the exact songs that lack positions and writes them back", async () => {
    const { env, batches } = makeEnv();
    const stats = await backfillPositions(env, 1_700_000_000, { limit: 5 });

    expect(stats.songsProcessed).toBe(1);
    expect(stats.linesPositioned).toBe(3);
    // Every written line carries a position.
    const written = batches.flat().length;
    expect(written).toBeGreaterThanOrEqual(3);
  });

  it("deletes by exclusion, in the same batch as the inserts", async () => {
    // The delete names what to keep, so it cannot be issued without the evidence
    // that makes it safe; and it rides in the inserts' batch because "still
    // position-less" is only true once those have landed.
    const { env, batches, prepare } = makeEnv();
    await backfillPositions(env, 1_700_000_000, { limit: 5 });

    const del = prepare.mock.calls.map((c) => c[0] as string).find((q) => q.includes("DELETE"));
    expect(del).toContain("json_each");
    expect(del).toContain("pos IS NULL");
    expect(batches).toHaveLength(1); // one round trip, inserts + delete together
  });

  it("refuses to delete a song's lines when nothing came back", async () => {
    const { dropUnpositionedLines } = await import("./../state");
    const env = { DB: { prepare: () => ({ bind: () => ({}) }) } } as unknown as Env;
    expect(() => dropUnpositionedLines(env, 1, [])).toThrow(/refusing/);
  });

  it("leaves a song alone when the fetch fails, rather than deleting its lines", async () => {
    // A transient API failure must not be read as "these lines no longer exist".
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));
    const { env, deleted, batches } = makeEnv();
    const stats = await backfillPositions(env, 1_700_000_000, { limit: 5 });

    expect(stats.songsProcessed).toBe(0);
    expect(deleted).toEqual([]);
    expect(batches).toEqual([]);
  });

  it("reports nothing to do on an empty queue", async () => {
    const { env } = makeEnv({ songs: [] });
    const stats = await backfillPositions(env, 1_700_000_000);
    expect(stats).toMatchObject({ songsProcessed: 0, linesPositioned: 0, remainingSongs: 0 });
  });
});
