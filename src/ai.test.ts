import { describe, it, expect, vi } from "vitest";
import {
  FALLBACK_REASON,
  NO_REASON_GIVEN,
  parseChoice,
  readChoice,
  pickBestLyric,
  type Candidate,
} from "./ai";
import type { Env } from "./env";

/** One AI env stub for the file: every case here varies only what `run` returns. */
const makeAiEnv = (run: unknown) =>
  ({ AI: { run }, AI_TEXT_MODEL: "text-model" }) as unknown as Env;

describe("parseChoice", () => {
  it("parses clean JSON", () => {
    expect(parseChoice('{"choice": 3, "reason": "matches the mood"}')).toEqual({
      choice: 3,
      reason: "matches the mood",
    });
  });

  it("extracts JSON embedded in prose / markdown fences", () => {
    const text = 'Sure! Here is my pick:\n```json\n{"choice": 2, "reason": "fits"}\n```';
    expect(parseChoice(text)).toEqual({ choice: 2, reason: "fits" });
  });

  it("coerces a stringified choice", () => {
    expect(parseChoice('{"choice": "1", "reason": ""}')).toEqual({ choice: 1, reason: "" });
  });

  it("returns null when no JSON object is present", () => {
    expect(parseChoice("I could not decide")).toBeNull();
  });

  it("returns null when choice is missing/non-numeric", () => {
    expect(parseChoice('{"reason": "no choice"}')).toBeNull();
  });

  // The configured model (Gemma 4) has a thinking mode, so traces must not confuse parsing.
  it("strips <think> blocks and reads the committed answer", () => {
    const text =
      '<think>Maybe {"choice": 1} fits? No, on reflection 3 is better.</think>\n' +
      '{"choice": 3, "reason": "matches the breakup framing"}';
    expect(parseChoice(text)).toEqual({ choice: 3, reason: "matches the breakup framing" });
  });

  it("takes the last committed object when the model floats a tentative pick first", () => {
    const text = 'First thought: {"choice": 1, "reason": "eh"}. Final: {"choice": 2, "reason": "better"}';
    expect(parseChoice(text)).toEqual({ choice: 2, reason: "better" });
  });

  it("handles an unterminated thinking trace with no answer", () => {
    expect(parseChoice("<think>still deliberating about which line")).toBeNull();
  });

  it("still parses when the only JSON follows an unclosed trace", () => {
    // Defensive: unterminated <think> is dropped along with everything after it.
    expect(parseChoice('{"choice": 4, "reason": "ok"}<think>trailing')).toEqual({
      choice: 4,
      reason: "ok",
    });
  });
});

describe("readChoice", () => {
  it("reads a structured object returned on `response` (JSON mode honored)", () => {
    expect(readChoice({ response: { choice: 2, reason: "fits" } })).toEqual({
      choice: 2,
      reason: "fits",
    });
  });

  it("reads a JSON string on `response` (plain generation)", () => {
    expect(readChoice({ response: '{"choice": 3, "reason": "ok"}' })).toEqual({
      choice: 3,
      reason: "ok",
    });
  });

  it("reads the object when it arrives at the top level", () => {
    expect(readChoice({ choice: 1, reason: "top" })).toEqual({ choice: 1, reason: "top" });
  });

  it("tolerates a missing reason", () => {
    expect(readChoice({ response: { choice: 2 } })).toEqual({ choice: 2, reason: "" });
  });

  it("returns null for unusable shapes", () => {
    expect(readChoice(null)).toBeNull();
    expect(readChoice("nope")).toBeNull();
    expect(readChoice({})).toBeNull();
    expect(readChoice({ response: { reason: "no choice" } })).toBeNull();
  });
});

describe("pickBestLyric", () => {
  const candidates: Candidate[] = [
    { id: "a", line: "line one", band: "B1", song: "S1" },
    { id: "b", line: "line two", band: "B2", song: "S2" },
    { id: "c", line: "line three", band: "B3", song: "S3" },
  ];

  const envWith = makeAiEnv;

  it("requests structured output with the choice schema", async () => {
    const run = vi.fn().mockResolvedValue({ response: { choice: 2, reason: "fits" } });
    const picked = await pickBestLyric(envWith(run), "a post", candidates);

    expect(picked).toEqual({ id: "b", reason: "fits" });
    expect(run).toHaveBeenCalledTimes(1);
    const [, opts] = run.mock.calls[0];
    expect(opts.response_format.type).toBe("json_schema");
    expect(opts.response_format.json_schema.required).toEqual(["choice"]);
  });

  it("constrains only the integer choice, never a free-text field", () => {
    // Gemma 4 has a documented repetition loop under grammar-constrained decoding
    // when the schema contains a free-text string field. `reason` must stay out.
    const run = vi.fn().mockResolvedValue({ response: { choice: 1 } });
    return pickBestLyric(envWith(run), "a post", candidates).then(() => {
      const schema = run.mock.calls[0][1].response_format.json_schema;
      expect(Object.keys(schema.properties)).toEqual(["choice"]);
      expect(schema.properties.reason).toBeUndefined();
      expect(schema.properties.choice.type).toBe("integer");
    });
  });

  it("pins the choice enum to the actual candidate indices", async () => {
    const run = vi.fn().mockResolvedValue({ response: { choice: 1 } });
    await pickBestLyric(envWith(run), "a post", candidates);
    expect(run.mock.calls[0][1].response_format.json_schema.properties.choice.enum).toEqual([1, 2, 3]);

    const run2 = vi.fn().mockResolvedValue({ response: { choice: 1 } });
    await pickBestLyric(envWith(run2), "a post", candidates.slice(0, 2));
    expect(run2.mock.calls[0][1].response_format.json_schema.properties.choice.enum).toEqual([1, 2]);
  });

  it("sends a repetition penalty to counter the model-level bias", async () => {
    const run = vi.fn().mockResolvedValue({ response: { choice: 1 } });
    await pickBestLyric(envWith(run), "a post", candidates);
    expect(run.mock.calls[0][1].repetition_penalty).toBeGreaterThan(1);
    expect(run.mock.calls[0][1].max_tokens).toBeLessThanOrEqual(1200);
  });

  it("asks the model not to deliberate, since thinking can't be disabled via the binding", async () => {
    const run = vi.fn().mockResolvedValue({ response: { choice: 1 } });
    await pickBestLyric(envWith(run), "a post", candidates);
    const system = run.mock.calls[0][1].messages[0].content as string;
    expect(system).toMatch(/decide immediately/i);
  });

  it("retries without response_format when the model rejects it", async () => {
    const run = vi
      .fn()
      .mockRejectedValueOnce(new Error("unsupported parameter: response_format"))
      .mockResolvedValueOnce({ response: '{"choice": 3, "reason": "plain"}' });

    const picked = await pickBestLyric(envWith(run), "a post", candidates);

    expect(picked).toEqual({ id: "c", reason: "plain" });
    expect(run).toHaveBeenCalledTimes(2);
    // The retry drops the unsupported field rather than repeating it.
    expect(run.mock.calls[1][1].response_format).toBeUndefined();
  });

  it("does not spend a second call when the first response is merely unparseable", async () => {
    const run = vi.fn().mockResolvedValue({ response: "I cannot decide" });
    const picked = await pickBestLyric(envWith(run), "a post", candidates);

    expect(run).toHaveBeenCalledTimes(1);
    expect(picked.id).toBe("a"); // deterministic fallback
    expect(picked.reason).toMatch(/fallback/);
  });

  it("falls back to the first candidate when both attempts fail", async () => {
    const run = vi.fn().mockRejectedValue(new Error("model down"));
    const picked = await pickBestLyric(envWith(run), "a post", candidates);
    expect(picked.id).toBe("a");
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("ignores an out-of-range choice", async () => {
    const run = vi.fn().mockResolvedValue({ response: { choice: 99, reason: "bogus" } });
    const picked = await pickBestLyric(envWith(run), "a post", candidates);
    expect(picked.id).toBe("a");
  });

  it("short-circuits a single candidate without calling the model", async () => {
    const run = vi.fn();
    expect(await pickBestLyric(envWith(run), "a post", [candidates[0]])).toEqual({
      id: "a",
      reason: "only candidate",
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("throws when given no candidates", async () => {
    await expect(pickBestLyric(envWith(vi.fn()), "a post", [])).rejects.toThrow(/no candidates/);
  });
});

describe("pick labelling: a real pick is never reported as a fallback", () => {
  const cands = [
    { id: "a", line: "line one", band: "B", song: "S" },
    { id: "b", line: "line two", band: "B", song: "S" },
    { id: "c", line: "line three", band: "B", song: "S" },
  ];
  /** The file-level stub takes a `run`; these cases only vary its return value. */
  const envWith = (response: unknown) => makeAiEnv(async () => response);

  it("reports a schema-shaped answer as a pick, not a fallback", async () => {
    // choiceSchema deliberately has no `reason` field, so an answer that obeys it
    // arrives with none. Treating an absent reason as "the model failed" mislabelled
    // every successful structured pick and made pick_reason untrustworthy.
    const out = await pickBestLyric(envWith({ response: { choice: 2 } }), "post", cands);
    expect(out.id).toBe("b");
    expect(out.reason).toBe(NO_REASON_GIVEN);
    expect(out.reason).not.toBe(FALLBACK_REASON);
  });

  it("keeps the model's reason when it gives one", async () => {
    const out = await pickBestLyric(
      envWith({ response: '{"choice": 3, "reason": "fits the mood"}' }),
      "post",
      cands,
    );
    expect(out).toEqual({ id: "c", reason: "fits the mood" });
  });

  it("still reports a genuine fallback when nothing usable comes back", async () => {
    const out = await pickBestLyric(envWith({ response: "I could not decide." }), "post", cands);
    expect(out).toEqual({ id: "a", reason: FALLBACK_REASON });
  });

  it("falls back when the model picks outside the candidate range", async () => {
    const out = await pickBestLyric(envWith({ response: { choice: 99 } }), "post", cands);
    expect(out).toEqual({ id: "a", reason: FALLBACK_REASON });
  });
});

describe("parseChoice brace handling", () => {
  it("survives a brace inside the reason string", () => {
    // The old /\{[^{}]*\}/ stopped at the inner brace, matched the fragment "{vibe}",
    // failed to parse, and discarded a perfectly good answer.
    expect(parseChoice('{"choice": 2, "reason": "the {vibe} matches"}')).toEqual({
      choice: 2,
      reason: "the {vibe} matches",
    });
  });

  it("finds the choice inside a wrapper object", () => {
    expect(parseChoice('{"result": {"choice": 2, "reason": "ok"}}')).toEqual({
      choice: 2,
      reason: "ok",
    });
  });

  it("ignores an escaped quote when tracking string boundaries", () => {
    expect(parseChoice('{"choice": 1, "reason": "she said \\"no\\" {twice}"}')).toEqual({
      choice: 1,
      reason: 'she said "no" {twice}',
    });
  });

  it("takes the committed answer after a thinking trace, not a tentative one", () => {
    const out = parseChoice(
      '<think>maybe {"choice": 1}, though {"choice": 3} could work</think>\n{"choice": 2, "reason": "final"}',
    );
    expect(out).toEqual({ choice: 2, reason: "final" });
  });

  it("returns null for prose with no object at all", () => {
    expect(parseChoice("I like the third one best.")).toBeNull();
  });

  it("returns null for an unbalanced fragment", () => {
    expect(parseChoice('{"choice": 2, "reason": "cut off')).toBeNull();
  });
});

describe("readChoice wrapper tolerance", () => {
  it("finds the choice inside a wrapper, structured or stringified alike", () => {
    // The two differ only in transport, so they must not differ in what parses.
    const wrapped = { result: { choice: 2, reason: "ok" } };
    expect(readChoice({ response: wrapped })).toEqual({ choice: 2, reason: "ok" });
    expect(readChoice({ response: JSON.stringify(wrapped) })).toEqual({ choice: 2, reason: "ok" });
  });

  it("still rejects an object with no choice anywhere in it", () => {
    expect(readChoice({ response: { note: "no answer" } })).toBeNull();
  });
});
