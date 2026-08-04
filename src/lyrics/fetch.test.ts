import { describe, it, expect } from "vitest";
import { extractLines } from "./fetch";

describe("extractLines", () => {
  it("keeps distinct lines, drops section markers, and marks short ones as context-only", () => {
    // Synthetic content — not real lyrics.
    const raw = [
      "[Chorus]",
      "the parking lot was empty when we left",
      "the parking lot was empty when we left", // duplicate
      "hey", // too short to quote on its own
      "(Verse 1)",
      "we drove around all summer with the windows down",
      "   ",
    ].join("\n");

    expect(extractLines(raw, 150)).toEqual([
      { line: "the parking lot was empty when we left", pos: 0, candidate: true },
      { line: "hey", pos: 2, candidate: false },
      { line: "we drove around all summer with the windows down", pos: 3, candidate: true },
    ]);
  });

  it("advances pos past dropped lines, so a gap marks the two sides as non-adjacent", () => {
    const raw = ["first line of the song", "x".repeat(200), "third line of the song"].join("\n");
    // The over-long line consumed pos 1. Positions 0 and 2 are left non-consecutive
    // on purpose: they are not adjacent when sung, and buildPassage relies on that.
    expect(extractLines(raw, 150).map((l) => l.pos)).toEqual([0, 2]);
  });

  it("counts a duplicate's position too, rather than closing the gap it leaves", () => {
    const raw = ["the same line twice over", "the same line twice over", "a different line"].join(
      "\n",
    );
    expect(extractLines(raw, 150).map((l) => l.pos)).toEqual([0, 2]);
  });

  it("does not count blank lines or section markers as positions", () => {
    const raw = ["[Chorus]", "", "first line of the song", "   ", "second line of the song"].join(
      "\n",
    );
    expect(extractLines(raw, 150).map((l) => l.pos)).toEqual([0, 1]);
  });

  it("returns empty for whitespace-only input", () => {
    expect(extractLines("\n\n   \n", 150)).toEqual([]);
  });
});
