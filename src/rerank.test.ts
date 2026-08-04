import { describe, it, expect, vi } from "vitest";
import { rerank, type Candidate } from "./ai";
import type { Env } from "./env";

// Synthetic lines — not real lyrics.
const CANDIDATES: Candidate[] = [
  { id: "a", line: "the parking lot was empty when we left", band: "B1", song: "S1" },
  { id: "b", line: "we drove around all summer with the windows down", band: "B2", song: "S2" },
  { id: "c", line: "nobody told me it would end like this", band: "B3", song: "S3" },
];

function envWith(run: unknown): Env {
  return {
    AI: { run },
    AI_RERANK_MODEL: "@cf/baai/bge-reranker-base",
  } as unknown as Env;
}

describe("rerank", () => {
  it("maps response indices back to candidates and orders best-first", async () => {
    // Model says index 2 is best, then index 0.
    const run = vi.fn().mockResolvedValue({
      response: [
        { id: 2, score: 0.91 },
        { id: 0, score: 0.42 },
      ],
    });

    const out = await rerank(envWith(run), "how did it end?", CANDIDATES, 2);

    expect(out.map((c) => c.id)).toEqual(["c", "a"]);
    expect(out[0].rerankScore).toBeCloseTo(0.91);
    expect(out[0].line).toBe("nobody told me it would end like this");
  });

  it("sorts defensively when the model returns out-of-order scores", async () => {
    const run = vi.fn().mockResolvedValue({
      response: [
        { id: 0, score: 0.1 },
        { id: 1, score: 0.99 },
      ],
    });
    const out = await rerank(envWith(run), "summer drive", CANDIDATES, 2);
    expect(out.map((c) => c.id)).toEqual(["b", "a"]);
  });

  it("passes the query, contexts and top_k to the configured model", async () => {
    const run = vi.fn().mockResolvedValue({ response: [{ id: 0, score: 1 }] });
    await rerank(envWith(run), "a post", CANDIDATES, 2);

    expect(run).toHaveBeenCalledWith("@cf/baai/bge-reranker-base", {
      query: "a post",
      contexts: CANDIDATES.map((c) => ({ text: c.line })),
      top_k: 2,
    });
  });

  it("truncates to topN", async () => {
    const run = vi.fn().mockResolvedValue({
      response: [
        { id: 0, score: 0.9 },
        { id: 1, score: 0.8 },
        { id: 2, score: 0.7 },
      ],
    });
    const out = await rerank(envWith(run), "q", CANDIDATES, 2);
    expect(out).toHaveLength(2);
  });

  it("ignores out-of-range indices from the model", async () => {
    const run = vi.fn().mockResolvedValue({
      response: [
        { id: 99, score: 0.99 },
        { id: 1, score: 0.5 },
      ],
    });
    const out = await rerank(envWith(run), "q", CANDIDATES, 3);
    expect(out.map((c) => c.id)).toEqual(["b"]);
  });

  it("falls back to input order when the model throws", async () => {
    const run = vi.fn().mockRejectedValue(new Error("model unavailable"));
    const out = await rerank(envWith(run), "q", CANDIDATES, 2);
    expect(out.map((c) => c.id)).toEqual(["a", "b"]);
    expect(out[0].rerankScore).toBe(0);
  });

  it("falls back when the response is empty or malformed", async () => {
    const out = await rerank(envWith(vi.fn().mockResolvedValue({})), "q", CANDIDATES, 2);
    expect(out.map((c) => c.id)).toEqual(["a", "b"]);
  });

  it("short-circuits trivial inputs without calling the model", async () => {
    const run = vi.fn();
    expect(await rerank(envWith(run), "q", [], 4)).toEqual([]);
    const one = await rerank(envWith(run), "q", [CANDIDATES[0]], 4);
    expect(one.map((c) => c.id)).toEqual(["a"]);
    expect(run).not.toHaveBeenCalled();
  });
});
