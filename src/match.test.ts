import { describe, it, expect, vi } from "vitest";
import { buildPassage, expandToPassage, formatSnippet, matchLyric, snippetBudget } from "./match";
import type { Env } from "./env";

describe("formatSnippet", () => {
  it("appends band + song attribution", () => {
    // Synthetic line — not real lyrics.
    const s = formatSnippet(
      { text: "we drove around all night", band: "Example Band", song: "Sample Song" },
      150,
    );
    expect(s).toContain("we drove around all night");
    expect(s).toContain("— Example Band");
    expect(s).toContain("“Sample Song”");
  });

  it("stays within the 300-grapheme Bluesky limit and truncates long lines", () => {
    const long = "a ".repeat(200).trim();
    const s = formatSnippet({ text: long, band: "B", song: "S" }, 300);
    expect([...s].length).toBeLessThanOrEqual(300);
    expect(s).toContain("…");
  });

  it("applies the tunable copyright cap when it is tighter than the post limit", () => {
    const long = "a ".repeat(200).trim();
    const s = formatSnippet({ text: long, band: "B", song: "S" }, 50);
    // The line itself is capped at 50; attribution is added on top.
    expect(s.split("\n")[0].length).toBeLessThanOrEqual(50);
    expect(s).toContain("…");
  });
});

describe("buildPassage", () => {
  // Synthetic lines — not real lyrics. Contiguous positions 0..4.
  const song = [
    { pos: 0, line: "we drove around all night" },
    { pos: 1, line: "the radio was static" },
    { pos: 2, line: "you said you were leaving" },
    { pos: 3, line: "and I let you" },
    { pos: 4, line: "the porch light stayed on" },
  ];

  const build = (matchPos: number, budget: number, maxLines = 6) =>
    buildPassage(song, matchPos, { budget, maxLines });

  it("grows backwards from the match, so the quote lands on the chosen line", () => {
    const out = build(3, 200);
    expect(out.split("\n").at(-1)).toBe("and I let you");
    expect(out).toContain("we drove around all night");
    // Budget was ample, but pos 4 is not taken — it would bury the chosen line.
    expect(out).not.toContain("the porch light stayed on");
  });

  it("extends forwards only when the match has no lead-in to take", () => {
    const out = build(0, 200).split("\n");
    expect(out[0]).toBe("we drove around all night"); // nothing before pos 0
    expect(out).toHaveLength(5); // so it filled forwards instead of quoting one line
  });

  it("never exceeds the budget, counting the newlines it adds", () => {
    for (const budget of [26, 40, 60, 100]) {
      const out = build(3, budget);
      expect([...out].length).toBeLessThanOrEqual(budget);
      expect(out).toContain("and I let you"); // the match survives every budget
    }
  });

  it("honours maxLines even when the budget would allow more", () => {
    expect(build(4, 500, 2).split("\n")).toHaveLength(2);
    expect(build(4, 500, 1)).toBe("the porch light stayed on");
  });

  it("stops at a gap rather than splicing non-adjacent lines together", () => {
    // pos 2 is missing: the extractor dropped a repeat there, so 1 and 3 are not
    // adjacent in the song and quoting them as a run would invent a lyric.
    const gapped = song.filter((l) => l.pos !== 2);
    const out = buildPassage(gapped, 3, { budget: 500, maxLines: 6 });
    expect(out).toBe("and I let you\nthe porch light stayed on");
    expect(out).not.toContain("the radio was static");
  });

  it("returns the bare line when only the match fits", () => {
    expect(build(2, 25)).toBe("you said you were leaving");
  });

  it("returns an over-long match unchanged, leaving truncation to formatSnippet", () => {
    expect(build(2, 5)).toBe("you said you were leaving");
  });

  it("returns empty when the match position is absent", () => {
    expect(buildPassage(song, 99, { budget: 500, maxLines: 6 })).toBe("");
  });

  it("produces a passage that formatSnippet keeps inside the platform limit", () => {
    const band = "Example Band";
    const song2 = "Sample Song";
    const long = Array.from({ length: 20 }, (_, i) => ({ pos: i, line: "x".repeat(40) }));
    const passage = buildPassage(long, 19, {
      budget: snippetBudget(band, song2, 260),
      maxLines: 6,
    });
    expect([...formatSnippet({ text: passage, band, song: song2 }, 260)].length).toBeLessThanOrEqual(
      300,
    );
  });
});

describe("expandToPassage", () => {
  // Synthetic lines — not real lyrics.
  const rows = [
    { line: "we drove around all night", pos: 0, match_pos: 2 },
    { line: "the radio was static", pos: 1, match_pos: 2 },
    { line: "you said you were leaving", pos: 2, match_pos: 2 },
  ];

  const settings = {
    matchTopK: 25,
    rerankTopN: 4,
    snippetMaxChars: 260,
    passageMaxLines: 6,
    lineMaxChars: 150,
  };

  const envWith = (all: () => Promise<unknown>) =>
    ({ DB: { prepare: () => ({ bind: () => ({ all }) }) } }) as unknown as Env;

  const expand = (env: Env, s = settings) =>
    expandToPassage(env, { id: "L2", line: "you said you were leaving", band: "B", song: "S" }, s);

  it("returns the lines leading up to the match", async () => {
    const env = envWith(() => Promise.resolve({ results: rows }));
    expect(await expand(env)).toBe(
      "we drove around all night\nthe radio was static\nyou said you were leaving",
    );
  });

  it("skips the query entirely when passages are turned off", async () => {
    const all = vi.fn();
    const out = await expand(envWith(all), { ...settings, passageMaxLines: 1 });
    expect(out).toBe("you said you were leaving");
    expect(all).not.toHaveBeenCalled();
  });

  it("falls back to the bare line for a row with no stored position", async () => {
    const env = envWith(() => Promise.resolve({ results: [] }));
    expect(await expand(env)).toBe("you said you were leaving");
  });

  it("falls back to the bare line rather than losing the reply to a D1 error", async () => {
    const env = envWith(() => Promise.reject(new Error("D1 down")));
    expect(await expand(env)).toBe("you said you were leaving");
  });
});

describe("matchLyric pipeline", () => {
  // Synthetic lines — not real lyrics.
  const vectorMatches = [
    { id: "a", score: 0.80, metadata: { line: "line about leaving town", band: "B1", song: "S1" } },
    { id: "b", score: 0.79, metadata: { line: "line about summer nights", band: "B2", song: "S2" } },
    { id: "c", score: 0.78, metadata: { line: "line about growing up", band: "B3", song: "S3" } },
  ];

  function makeEnv(aiRun: ReturnType<typeof vi.fn>, recent: string[] = []) {
    return {
      AI: { run: aiRun },
      LYRICS_INDEX: { query: vi.fn().mockResolvedValue({ matches: vectorMatches }) },
      // matchLyric checks the recent-use flags before handing candidates to the LLM.
      STATE: { get: async (k: string) => (recent.includes(k) ? "1" : null) },
      AI_EMBED_MODEL: "embed-model",
      AI_RERANK_MODEL: "rerank-model",
      AI_TEXT_MODEL: "text-model",
    } as unknown as Env;
  }

  // Settings are passed in explicitly — matchLyric no longer loads them itself.
  const settings = {
    matchTopK: 25,
    rerankTopN: 2,
    snippetMaxChars: 150,
    passageMaxLines: 1, // passage expansion has its own tests below
    lineMaxChars: 150,
  };
  const noExclusions = new Set<string>();

  it("runs embed -> rerank -> pick and returns the LLM's choice from the shortlist", async () => {
    const run = vi.fn().mockImplementation((model: string) => {
      if (model === "embed-model") return Promise.resolve({ data: [[0.1, 0.2, 0.3]] });
      if (model === "rerank-model")
        // Reranker promotes "c" over the higher-similarity "a".
        return Promise.resolve({ response: [{ id: 2, score: 0.95 }, { id: 0, score: 0.30 }] });
      // LLM picks candidate #1 of the shortlist -> "c".
      return Promise.resolve({ response: '{"choice": 1, "reason": "best fit"}' });
    });

    const env = makeEnv(run);
    const match = await matchLyric(env, "what happened after high school?", settings, noExclusions);

    expect(match).not.toBeNull();
    expect(match!.id).toBe("c");
    expect(match!.rerankScore).toBeCloseTo(0.95);
    expect(match!.score).toBeCloseTo(0.78); // original Vectorize score preserved
    expect(match!.reason).toBe("best fit");

    // Vectorize queried with the wide recall width.
    expect(env.LYRICS_INDEX.query).toHaveBeenCalledWith([0.1, 0.2, 0.3], {
      topK: 25,
      returnMetadata: "all",
    });
    // Reranker saw all 3 candidates; the LLM only saw the 2 survivors.
    const rerankCall = run.mock.calls.find((c) => c[0] === "rerank-model")!;
    expect(rerankCall[1].contexts).toHaveLength(3);
    const llmCall = run.mock.calls.find((c) => c[0] === "text-model")!;
    const prompt = llmCall[1].messages[1].content as string;
    expect(prompt).toContain("line about growing up");
    expect(prompt).not.toContain("line about summer nights");
  });

  it("returns null on an empty corpus", async () => {
    const env = makeEnv(vi.fn().mockResolvedValue({ data: [[0.1]] }));
    (env.LYRICS_INDEX.query as ReturnType<typeof vi.fn>).mockResolvedValue({ matches: [] });
    expect(await matchLyric(env, "anything", settings, noExclusions)).toBeNull();
  });

  it("returns null for blank input without calling the models", async () => {
    const run = vi.fn();
    expect(await matchLyric(makeEnv(run), "   ", settings, noExclusions)).toBeNull();
    expect(run).not.toHaveBeenCalled();
  });

  it("drops downvoted lines before they reach the reranker", async () => {
    const run = vi.fn().mockImplementation((model: string) => {
      if (model === "embed-model") return Promise.resolve({ data: [[0.1]] });
      if (model === "rerank-model") return Promise.resolve({ response: [{ id: 0, score: 0.9 }] });
      return Promise.resolve({ response: '{"choice": 1, "reason": "ok"}' });
    });
    const env = makeEnv(run);

    const match = await matchLyric(env, "a post", settings, new Set(["a", "b"]));

    // Only the un-downvoted "c" survives to the reranker, and is what's returned.
    const rerankCall = run.mock.calls.find((c) => c[0] === "rerank-model");
    expect(rerankCall).toBeUndefined(); // single candidate short-circuits rerank
    expect(match!.id).toBe("c");
  });

  it("skips a line used in a recent post, so similar posts don't get identical replies", async () => {
    // Everything upstream is deterministic, so without this the reply is a pure
    // function of the post text and repeats forever.
    const run = vi.fn().mockImplementation((model: string) => {
      if (model === "embed-model") return Promise.resolve({ data: [[0.1]] });
      if (model === "rerank-model")
        return Promise.resolve({
          response: [{ id: 0, score: 0.9 }, { id: 1, score: 0.8 }, { id: 2, score: 0.7 }],
        });
      return Promise.resolve({ response: '{"choice": 1, "reason": "ok"}' });
    });
    // "a" is the reranker's top but was posted recently, so the pick never sees it.
    const env = makeEnv(run, ["recent:a"]);

    const match = await matchLyric(env, "a post", { ...settings, rerankTopN: 3 }, noExclusions);

    expect(match!.id).toBe("b");
    const llmCall = run.mock.calls.find((c) => c[0] === "text-model")!;
    expect(llmCall[1].messages[1].content).not.toContain("line about leaving town");
  });

  it("still answers when every shortlisted line is recent — a repeat beats silence", async () => {
    const run = vi.fn().mockImplementation((model: string) => {
      if (model === "embed-model") return Promise.resolve({ data: [[0.1]] });
      if (model === "rerank-model")
        return Promise.resolve({ response: [{ id: 0, score: 0.9 }, { id: 1, score: 0.8 }] });
      return Promise.resolve({ response: '{"choice": 1, "reason": "ok"}' });
    });
    const env = makeEnv(run, ["recent:a", "recent:b", "recent:c"]);

    const match = await matchLyric(env, "a post", settings, noExclusions);
    expect(match).not.toBeNull();
    expect(match!.id).toBe("a"); // the reranker's best, unfiltered
  });

  it("returns null when every candidate is excluded", async () => {
    const run = vi.fn().mockResolvedValue({ data: [[0.1]] });
    const env = makeEnv(run);
    expect(await matchLyric(env, "a post", settings, new Set(["a", "b", "c"]))).toBeNull();
  });
});
