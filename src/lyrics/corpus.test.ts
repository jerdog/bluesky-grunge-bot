import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  backfillPositions,
  lineId,
  pruneRemovedBands,
  VECTORIZE_DELETE_MAX_IDS,
} from "./corpus";
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

describe("pruneRemovedBands", () => {
  /**
   * `data/bands.json` is the real seed list, so a band that is genuinely in it
   * ("Nirvana") must survive and one that never was ("Deleted Band") must go.
   * Asserting against the real file keeps the test honest about what the list
   * means, rather than proving a stub filters a stub.
   */
  function makeEnv(corpus: Record<string, string[]>) {
    const sqls: string[] = [];
    const deletedVectors: string[][] = [];
    let band = "";

    const prepare = vi.fn((sql: string) => {
      sqls.push(sql);
      const stmt = () => ({
        bind: (...next: unknown[]) => {
          if (sql.includes("SELECT id FROM lyric_lines")) band = next[0] as string;
          return stmt();
        },
        all: async () => ({
          results: sql.includes("DISTINCT band_name")
            ? Object.keys(corpus).map((b) => ({ band_name: b }))
            : (corpus[band] ?? []).map((id) => ({ id })),
        }),
        first: async () => null,
        run: async () => ({ meta: { changes: 0 } }),
      });
      return stmt();
    });

    const env = {
      DB: { prepare, batch: async () => [] },
      LYRICS_INDEX: { deleteByIds: vi.fn(async (ids: string[]) => deletedVectors.push(ids)) },
    } as unknown as Env;
    return { env, sqls, deletedVectors };
  }

  it("removes only the bands the seed list no longer names", async () => {
    const { env, deletedVectors } = makeEnv({
      Nirvana: ["keep1", "keep2"],
      "Deleted Band": ["gone1", "gone2"],
    });

    const stats = await pruneRemovedBands(env);

    expect(stats.bandsRemoved).toEqual(["Deleted Band"]);
    expect(stats.linesRemoved).toBe(2);
    expect(deletedVectors.flat()).toEqual(["gone1", "gone2"]);
  });

  /**
   * The whole point of the action. matchLyric reads band/song/line from vector
   * metadata and never from D1, so a prune that only deleted rows would leave
   * replies quoting the removed band exactly as before.
   */
  it("deletes the vectors, not just the rows", async () => {
    const { env, deletedVectors, sqls } = makeEnv({ "Deleted Band": ["v1"] });
    await pruneRemovedBands(env);

    expect(deletedVectors).toEqual([["v1"]]);
    expect(sqls.some((s) => s.includes("DELETE FROM lyric_lines"))).toBe(true);
  });

  it("clears the fetch cache too, so re-adding the band re-ingests it", async () => {
    // Without this, buildCorpus skips every still-fresh cache key and a re-added
    // band quietly harvests nothing until the 30-day TTL lapses.
    const { env, sqls } = makeEnv({ "Deleted Band": ["v1"] });
    await pruneRemovedBands(env);

    expect(sqls.some((s) => s.includes("DELETE FROM fetch_cache"))).toBe(true);
  });

  it("chunks large deletes rather than sending one unbounded call", async () => {
    const ids = Array.from({ length: 1250 }, (_, i) => `id${i}`);
    const { env, deletedVectors } = makeEnv({ "Deleted Band": ids });

    const stats = await pruneRemovedBands(env, 500);

    expect(deletedVectors.map((c) => c.length)).toEqual([500, 500, 250]);
    expect(stats.vectorsRemoved).toBe(1250);
  });

  /**
   * The chunk size is a service limit, not a preference. Vectorize rejects a
   * `deleteByIds` payload over 100 ids outright — `VECTOR_DELETE_ERROR
   * (code = 40007)` — and it fails the whole call rather than truncating. The
   * first version of this action chunked at 500 on the assumption the cap was
   * 1000, so every prune of a band with 100+ lines 500'd. Assert the default
   * against the limit itself, so raising one without the other cannot pass.
   */
  it("never sends more ids per call than Vectorize accepts", async () => {
    expect(VECTORIZE_DELETE_MAX_IDS).toBeLessThanOrEqual(100);

    const ids = Array.from({ length: 116 }, (_, i) => `id${i}`);
    const { env, deletedVectors } = makeEnv({ "Deleted Band": ids });

    // No explicit chunk size — this is exactly what /run/prune calls.
    const stats = await pruneRemovedBands(env);

    expect(Math.max(...deletedVectors.map((c) => c.length))).toBeLessThanOrEqual(
      VECTORIZE_DELETE_MAX_IDS,
    );
    expect(stats.vectorsRemoved).toBe(116);
  });

  it("does nothing when the corpus already matches the seed list", async () => {
    const { env, deletedVectors } = makeEnv({ Nirvana: ["a"], "Pearl Jam": ["b"] });
    const stats = await pruneRemovedBands(env);

    expect(stats).toEqual({ bandsRemoved: [], linesRemoved: 0, vectorsRemoved: 0 });
    expect(deletedVectors).toEqual([]);
  });
});
