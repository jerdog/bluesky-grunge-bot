import { describe, it, expect, vi, afterEach } from "vitest";
import { isSafeToAnswer, cleanPostText, handleMentions, replyToPost } from "./replies";
import * as bluesky from "./bluesky";
import type { Env } from "./env";

afterEach(() => vi.restoreAllMocks());

describe("isSafeToAnswer", () => {
  it("allows ordinary posts", () => {
    expect(isSafeToAnswer("hey what's a good summer road-trip song?")).toBe(true);
  });
  it("blocks flagged content", () => {
    expect(isSafeToAnswer("kys loser")).toBe(false);
  });
});

describe("cleanPostText", () => {
  it("strips the bot mention and collapses whitespace", () => {
    expect(cleanPostText("@bot.bsky.social   what should I listen to?", "bot.bsky.social")).toBe(
      "what should I listen to?",
    );
  });
});


describe("idle-poll cost", () => {
  // What an empty poll costs is what scales with cron frequency: a poll with no new
  // mentions does no AI work at all, so the KV writes are the whole marginal cost of
  // running more often. On the Workers Free plan the KV write cap is 1,000/day, so a
  // single stray write per poll is the difference between a 2-minute cron fitting
  // and blowing the daily budget on an idle bot.
  function makeEnv() {
    const writes: string[] = [];
    return {
      env: {
        STATE: {
          get: async (k: string) => (k === "bsky:notif_cursor" ? "CUR" : null),
          put: async (k: string) => {
            writes.push(k);
          },
        },
        DB: {
          prepare: () => ({
            bind() {
              return this;
            },
            all: async () => ({ results: [] }),
            first: async () => null,
            run: async () => ({}),
          }),
        },
        // One vector hit -> a single candidate, so the pick short-circuits and the
        // reply path runs end to end without needing the rerank/LLM stubs.
        AI: { run: async () => ({ data: [[0.1]] }) },
        LYRICS_INDEX: {
          query: async () => ({
            matches: [{ id: "L1", score: 0.9, metadata: { line: "a line", band: "B", song: "S" } }],
          }),
        },
        BLUESKY_HANDLE: "bot.bsky.social",
        MATCH_TOP_K: "25",
        RERANK_TOP_N: "4",
        SNIPPET_MAX_CHARS: "260",
        PASSAGE_MAX_LINES: "8",
        LINE_MAX_CHARS: "150",
      } as unknown as Env,
      writes,
    };
  }

  it("writes nothing to KV when the cursor has not moved", async () => {
    const { env, writes } = makeEnv();
    vi.spyOn(bluesky, "listMentions").mockResolvedValue({ mentions: [], cursor: "CUR" });

    const stats = await handleMentions(env);

    expect(stats).toEqual({ scanned: 0, answered: 0 });
    expect(writes).toEqual([]); // Bluesky returns a cursor every call; unchanged = no write
  });

  it("writes the cursor once when it does move", async () => {
    const { env, writes } = makeEnv();
    vi.spyOn(bluesky, "listMentions").mockResolvedValue({ mentions: [], cursor: "NEXT" });

    await handleMentions(env);

    expect(writes).toEqual(["bsky:notif_cursor"]);
  });
});

describe("reply dedupe on the shared path", () => {
  const target = {
    uri: "at://already",
    cid: "c",
    reason: "mention" as const,
    authorHandle: "someone.bsky.social",
    authorDid: "did:plc:x",
    text: "what's a good song?",
    root: { uri: "at://already", cid: "c" },
    parent: { uri: "at://already", cid: "c" },
  };
  const settings = {
    matchTopK: 25,
    rerankTopN: 4,
    snippetMaxChars: 260,
    passageMaxLines: 8,
    lineMaxChars: 150,
  };
  // Enough to get past dedupe and reach the match, which finds nothing — these
  // tests are about the gate, not what happens after it.
  const envWith = (handled: string[], get = async (k: string) => (handled.includes(k) ? "1" : null)) =>
    ({
      STATE: { get },
      AI: { run: async () => ({ data: [[0.1]] }) },
      LYRICS_INDEX: { query: async () => ({ matches: [] }) },
      AI_EMBED_MODEL: "e",
    }) as unknown as Env;

  it("refuses a post the bot has already answered", async () => {
    // The manual route had no dedupe at all, so pasting a URL the poller already
    // answered — or pasting the same one twice — published a second public reply.
    const out = await replyToPost(
      envWith(["handled:at://already"]),
      target,
      settings,
      new Set(),
      "bot.bsky.social",
    );
    expect(out).toEqual({ replied: false, reason: "already-answered" });
  });

  it("re-answers when force is set, so a deliberate repeat is a decision", async () => {
    const out = await replyToPost(
      envWith(["handled:at://already"]),
      target,
      settings,
      new Set(),
      "bot.bsky.social",
      { force: true },
    );
    // Past the dedupe; stops at the match for lack of a corpus in this env.
    expect(out.reason).toBe("no-match");
  });

  it("skips the read when the poller has already checked in its batch", async () => {
    const get = vi.fn(async () => null);
    await replyToPost(
      envWith([], get),
      target,
      settings,
      new Set(),
      "bot.bsky.social",
      { alreadyChecked: true },
    );
    expect(get).not.toHaveBeenCalledWith("handled:at://already");
  });
});
