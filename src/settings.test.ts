import { describe, it, expect, vi } from "vitest";
import { clamp, defaults, loadSettings, saveSettings, resolveSettings } from "./settings";
import type { Env } from "./env";

function envWith(stored: Record<string, number> | null) {
  const put = vi.fn().mockResolvedValue(undefined);
  const get = vi.fn().mockResolvedValue(stored);
  return {
    env: {
      STATE: { get, put },
      MATCH_TOP_K: "25",
      RERANK_TOP_N: "4",
      SNIPPET_MAX_CHARS: "150",
      PASSAGE_MAX_LINES: "8",
      LINE_MAX_CHARS: "150",
    } as unknown as Env,
    put,
    get,
  };
}

/**
 * What `envWith`'s vars parse to. Assertions spread this instead of respelling the
 * whole object, so adding a SPEC entry is one edit here rather than seven failures.
 */
const ENV_DEFAULTS = {
  matchTopK: 25,
  rerankTopN: 4,
  snippetMaxChars: 150,
  passageMaxLines: 8,
  lineMaxChars: 150,
};

describe("clamp", () => {
  it("clamps into range and truncates", () => {
    expect(clamp("rerankTopN", 999)).toBe(20);
    expect(clamp("rerankTopN", 0)).toBe(1);
    expect(clamp("rerankTopN", "6")).toBe(6);
    expect(clamp("rerankTopN", 4.7)).toBe(4);
    expect(clamp("matchTopK", 1000)).toBe(50); // Vectorize caps topK at 50
    expect(clamp("snippetMaxChars", 10)).toBe(40);
    expect(clamp("snippetMaxChars", 9999)).toBe(280);
  });

  it("returns null for non-numeric input", () => {
    expect(clamp("rerankTopN", "abc")).toBeNull();
    expect(clamp("rerankTopN", null)).toBeNull();
  });
});

describe("defaults", () => {
  it("reads env vars", () => {
    const { env } = envWith(null);
    expect(defaults(env)).toEqual(ENV_DEFAULTS);
  });
});

describe("loadSettings", () => {
  it("returns env defaults when nothing is stored", async () => {
    const { env } = envWith(null);
    expect(await loadSettings(env)).toEqual(ENV_DEFAULTS);
  });

  it("applies stored overrides on top of defaults", async () => {
    const { env } = envWith({ rerankTopN: 8 });
    expect(await loadSettings(env)).toEqual({ ...ENV_DEFAULTS, rerankTopN: 8 });
  });

  it("clamps out-of-range stored values", async () => {
    const { env } = envWith({ rerankTopN: 9999 });
    expect((await loadSettings(env)).rerankTopN).toBe(20);
  });

  it("ignores unknown stored keys", async () => {
    const { env } = envWith({ somethingElse: 5 } as unknown as Record<string, number>);
    expect(await loadSettings(env)).toEqual(ENV_DEFAULTS);
  });

  it("falls back to defaults if KV read throws", async () => {
    const { env } = envWith(null);
    (env.STATE.get as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("kv down"));
    expect(await loadSettings(env)).toEqual(ENV_DEFAULTS);
  });
});

describe("saveSettings", () => {
  it("persists only known keys, clamped", async () => {
    const { env, put } = envWith({});
    // `bogus` mimics an unexpected field arriving from the dashboard POST body.
    await saveSettings(env, { rerankTopN: "7", bogus: 1, matchTopK: 500 });
    const written = JSON.parse(put.mock.calls[0][1] as string);
    expect(written).toEqual({ rerankTopN: 7, matchTopK: 50 });
    expect(written.bogus).toBeUndefined();
  });

  it("merges with existing overrides rather than replacing them", async () => {
    const { env, put } = envWith({ matchTopK: 40 });
    await saveSettings(env, { rerankTopN: 6 });
    expect(JSON.parse(put.mock.calls[0][1] as string)).toEqual({ matchTopK: 40, rerankTopN: 6 });
  });

  it("an empty value clears the override", async () => {
    const { env, put } = envWith({ matchTopK: 40, rerankTopN: 6 });
    await saveSettings(env, { matchTopK: "" });
    expect(JSON.parse(put.mock.calls[0][1] as string)).toEqual({ rerankTopN: 6 });
  });

  it("returns the effective result without re-reading KV after the write", async () => {
    const { env, get } = envWith({ matchTopK: 40 });
    const res = await saveSettings(env, { rerankTopN: 6 });
    expect(res.settings).toEqual({ ...ENV_DEFAULTS, matchTopK: 40, rerankTopN: 6 });
    expect(res.overridden.sort()).toEqual(["matchTopK", "rerankTopN"]);
    // One read (the merge base) — no read-after-write.
    expect(get).toHaveBeenCalledTimes(1);
  });
});

describe("resolveSettings", () => {
  it("returns settings and overridden keys from a single KV read", async () => {
    const { env, get } = envWith({ rerankTopN: 8 });
    const res = await resolveSettings(env);
    expect(res.settings).toEqual({ ...ENV_DEFAULTS, rerankTopN: 8 });
    expect(res.overridden).toEqual(["rerankTopN"]);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("reports nothing overridden when KV is empty", async () => {
    const { env } = envWith(null);
    expect((await resolveSettings(env)).overridden).toEqual([]);
  });
});
