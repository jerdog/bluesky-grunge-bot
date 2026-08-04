import { describe, it, expect } from "vitest";
import { botHandle, isDryRun } from "./env";
import type { Env } from "./env";

const env = (over: Partial<Env> = {}) => over as Env;

describe("isDryRun", () => {
  // This is the one switch between "logs a post" and "posts publicly", so it fails
  // safe: only the exact string "false" goes live. A typo, an empty value, or a
  // missing var all keep the bot quiet rather than surprising anyone.
  it("goes live only for the exact string \"false\"", () => {
    expect(isDryRun(env({ DRY_RUN: "false" }))).toBe(false);
  });

  it("stays in dry run for anything else", () => {
    for (const v of ["true", "False", "FALSE", "0", "no", "", " false", "false ", undefined]) {
      expect(isDryRun(env({ DRY_RUN: v as string }))).toBe(true);
    }
  });
});

describe("botHandle", () => {
  it("strips a leading @ so both reply paths build the same mention pattern", () => {
    expect(botHandle(env({ BLUESKY_HANDLE: "@bot.bsky.social" }))).toBe("bot.bsky.social");
    expect(botHandle(env({ BLUESKY_HANDLE: "bot.bsky.social" }))).toBe("bot.bsky.social");
  });
});
