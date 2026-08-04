import type { Env } from "./env";

// Thin wrappers around Workers AI. No external LLM key required.

/**
 * Options we send to a text-generation model. Declared locally and checked, so a
 * typo like `repetition_penality` is a compile error — the Gemma 4 workaround
 * parameters below are load-bearing and must not be silently dropped.
 */
interface TextGenOptions {
  messages: Array<{ role: string; content: string }>;
  temperature?: number;
  max_tokens?: number;
  repetition_penalty?: number;
  response_format?: { type: "json_schema"; json_schema: unknown };
}

/**
 * The one place a model id crosses into Workers AI's per-model overloads.
 * Model ids are env vars by design (config over code), so the overload can't be
 * resolved statically; this is the single cast rather than one per call site.
 */
function runModel<T>(env: Env, modelId: string, input: object): Promise<T> {
  return env.AI.run(modelId as keyof AiModels, input as never) as Promise<T>;
}

/** Embed many texts at once (batched by the caller). */
export async function embedMany(env: Env, texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const out = await runModel<{ data?: number[][] }>(env, env.AI_EMBED_MODEL, { text: texts });
  return out?.data ?? [];
}

/** Embed a single text. Throws if the model returns nothing usable. */
export async function embed(env: Env, text: string): Promise<number[]> {
  const [vec] = await embedMany(env, [text]);
  if (!vec?.length) throw new Error("embedding model returned no vector");
  return vec;
}

export interface Candidate {
  id: string;
  line: string;
  band: string;
  song: string;
}

export interface RankedCandidate extends Candidate {
  /** Cross-encoder relevance score for this candidate against the post. */
  rerankScore: number;
}

/**
 * Re-score Vectorize candidates with a cross-encoder and return the best `topN`,
 * highest-scoring first. Unlike embeddings (which compare two vectors computed
 * independently), a reranker reads the post and the candidate line together, so
 * it's far better at judging "does this line actually answer this post".
 *
 * Falls back to the input order (truncated to topN) if the model errors or
 * returns an unusable shape — matching never hard-fails on the reranker.
 */
export async function rerank(
  env: Env,
  postText: string,
  candidates: Candidate[],
  topN: number,
): Promise<RankedCandidate[]> {
  const fallback = () =>
    candidates.slice(0, topN).map((c) => ({ ...c, rerankScore: 0 }));

  // 0 or 1 candidates: nothing to rank, skip the inference entirely. Same result
  // as the fallback (SPEC pins rerankTopN >= 1), so it uses it rather than
  // re-spelling the mapping.
  if (candidates.length <= 1) return fallback();

  try {
    const out = await runModel<{ response?: Array<{ id?: number; score?: number }> }>(
      env,
      env.AI_RERANK_MODEL,
      {
        query: postText,
        // The index in this array is what the response refers back to.
        contexts: candidates.map((c) => ({ text: c.line })),
        top_k: Math.min(topN, candidates.length),
      },
    );

    const ranked: RankedCandidate[] = [];
    for (const r of out?.response ?? []) {
      if (typeof r.id !== "number") continue;
      const c = candidates[r.id];
      if (!c) continue; // guard against an out-of-range index
      ranked.push({ ...c, rerankScore: r.score ?? 0 });
    }

    if (ranked.length === 0) return fallback();
    // The model returns best-first, but sort defensively so callers can rely on it.
    ranked.sort((a, b) => b.rerankScore - a.rerankScore);
    return ranked.slice(0, topN);
  } catch {
    console.warn("rerank failed; falling back to vector order");
    return fallback();
  }
}

export interface Choice {
  choice: number;
  reason: string;
}

/**
 * The two ways `pick_reason` can carry no model prose. They mean opposite things,
 * so they must never share a string: one says the model chose and simply wasn't
 * asked why, the other says it never produced a usable answer at all.
 */
export const NO_REASON_GIVEN = "picked (structured output — no reason given)";
export const FALLBACK_REASON = "fallback: first candidate";

/**
 * Schema for the pick, constraining ONLY the integer choice — deliberately no
 * free-text field.
 *
 * Gemma 4 (26B-A4B included) has a documented model-level repetition bias that
 * grammar-constrained decoding amplifies into runaway loops, and the reported
 * trigger is precisely a free-text string field in the schema. The `reason` is
 * still requested in the prompt and picked up by `parseChoice` whenever the model
 * answers in prose; it's explanatory only, so it isn't worth constraining.
 *
 * The enum pins the output to the actual candidate indices, which keeps the
 * grammar's token space as small as possible.
 */
function choiceSchema(candidateCount: number) {
  return {
    type: "object",
    properties: {
      choice: {
        type: "integer",
        enum: Array.from({ length: candidateCount }, (_, i) => i + 1),
        description: "1-based index of the chosen line",
      },
    },
    required: ["choice"],
  };
}

/**
 * Ask the text model to choose the single most contextually-fitting lyric line
 * for a given Bluesky post. Returns the chosen candidate's id, or the first
 * candidate as a deterministic fallback if the model output can't be used.
 */
export async function pickBestLyric(
  env: Env,
  postText: string,
  candidates: Candidate[],
): Promise<{ id: string; reason: string }> {
  if (candidates.length === 0) throw new Error("no candidates to pick from");
  if (candidates.length === 1) return { id: candidates[0].id, reason: "only candidate" };

  const list = candidates
    .map((c, i) => `${i + 1}. "${c.line}" — ${c.band}, "${c.song}"`)
    .join("\n");

  const system =
    "You are curating replies for a 1990s grunge and alt-rock lyrics bot on Bluesky. " +
    "Given a user's post and a numbered list of candidate lyric lines, choose the ONE line " +
    "that best fits the post's mood, topic, or wording as a witty or fitting reply. " +
    'Respond ONLY as compact JSON: {"choice": <number>, "reason": "<short reason>"}. ' +
    "Never invent a line; pick strictly from the list. " +
    // Gemma 4's thinking mode can't be switched off through the Workers AI
    // binding (it's driven by a chat-template token). Google's documented
    // mitigation is to ask for a shorter trace, which bounds the latency and
    // output tokens we pay for on a task that needs no deliberation.
    "Decide immediately. Do not deliberate or explain your reasoning at length.";

  const user = `User post:\n"""${postText.slice(0, 800)}"""\n\nCandidate lines:\n${list}`;

  const parsed = await requestChoice(
    env,
    [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    candidates.length,
  );

  let choice = 1;
  let reason = FALLBACK_REASON;
  if (parsed && parsed.choice >= 1 && parsed.choice <= candidates.length) {
    choice = parsed.choice;
    // A structured answer arrives with NO reason, because `choiceSchema`
    // deliberately has no reason field (see its note on the Gemma repetition
    // hazard). That is a real pick. Falling through to FALLBACK_REASON here
    // reported the model as having failed when it had done exactly as asked —
    // the pick was right and only the label was wrong, which made the dashboard
    // untrustworthy for the one thing it exists to show.
    reason = parsed.reason || NO_REASON_GIVEN;
  }

  return { id: candidates[choice - 1].id, reason };
}

/**
 * Request the pick, preferring structured output. If the model or the platform
 * rejects `response_format` the call is retried once without it, so this works
 * whether or not the configured model supports JSON mode. Only a thrown error
 * triggers the retry — an unparseable-but-successful response isn't worth a
 * second inference call.
 */
async function requestChoice(
  env: Env,
  messages: Array<{ role: string; content: string }>,
  candidateCount: number,
): Promise<Choice | null> {
  const base: TextGenOptions = {
    messages,
    temperature: 0.4,
    // Headroom for a reasoning trace, but bounded: it also caps the damage if the
    // model falls into a repetition loop under grammar-constrained decoding.
    max_tokens: 1200,
    // Counters the model-level repetition bias that constrained decoding amplifies.
    repetition_penalty: 1.1,
  };
  // Preferred shape first, then the same request without the schema. Returning
  // inside the loop preserves the rule that only a *thrown* error retries.
  const attempts: TextGenOptions[] = [
    { ...base, response_format: { type: "json_schema", json_schema: choiceSchema(candidateCount) } },
    base,
  ];
  for (const input of attempts) {
    try {
      return readChoice(await runModel<unknown>(env, env.AI_TEXT_MODEL, input));
    } catch {
      // response_format may be unsupported for this model — try the plainer shape.
    }
  }
  return null; // both attempts failed — caller falls back deterministically
}

/**
 * Normalize whatever the model returned into a Choice, covering the shapes JSON
 * mode and plain text generation can produce: a parsed object on `response`, a
 * JSON/prose string on `response`, or the object at the top level.
 */
export function readChoice(out: unknown): Choice | null {
  if (!out || typeof out !== "object") return null;
  const response = (out as { response?: unknown }).response;
  // `findChoice` rather than `coerceChoice`, so a wrapper object is tolerated on
  // this path too. Otherwise {"response":{"result":{"choice":2}}} parsed when it
  // arrived as a string and failed when it arrived already-structured, which is a
  // difference in the transport, not in the answer.
  return typeof response === "string" ? parseChoice(response) : findChoice(response ?? out);
}

/** Read a Choice out of an already-structured object. */
function coerceChoice(obj: unknown): Choice | null {
  const o = obj as { choice?: unknown; reason?: unknown };
  const choice = typeof o.choice === "number" ? o.choice : Number.parseInt(String(o.choice), 10);
  if (!Number.isFinite(choice)) return null;
  return { choice, reason: typeof o.reason === "string" ? o.reason : "" };
}

/**
 * Every balanced top-level {...} span in `text`.
 *
 * Brace-counting rather than a regex, and string-aware so a brace inside a quoted
 * value doesn't open a span. `/\{[^{}]*\}/` cannot express either: it stops at the
 * first inner brace, so a perfectly good `{"choice":2,"reason":"the {vibe} fits"}`
 * yielded only the fragment `{vibe}`, failed to parse, and the whole reply fell
 * back — the model had answered correctly.
 */
function jsonObjects(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}" && depth > 0) {
      depth--;
      if (depth === 0 && start >= 0) {
        out.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return out;
}

/** Find a usable choice anywhere in a parsed value, including inside a wrapper. */
function findChoice(value: unknown): Choice | null {
  if (!value || typeof value !== "object") return null;
  const direct = coerceChoice(value);
  if (direct) return direct;
  for (const nested of Object.values(value as Record<string, unknown>)) {
    const found = findChoice(nested);
    if (found) return found;
  }
  return null;
}

/**
 * Extract {"choice": n, "reason": "..."} from a model response, tolerating prose,
 * markdown fences, wrapper objects, and reasoning models that emit a <think> trace.
 *
 * Thinking traces are stripped, then the LAST parseable object wins: a model that
 * reasons out loud may float a tentative pick mid-trace before committing to its
 * final answer, and the final one is the real choice.
 */
export function parseChoice(text: string): Choice | null {
  // Drop <think>...</think> blocks, plus an unterminated trailing trace.
  const cleaned = text
    .replace(/<think>[\s\S]*?<\/think>/gi, " ")
    .replace(/<think>[\s\S]*$/i, " ");

  for (const raw of jsonObjects(cleaned).reverse()) {
    try {
      const parsed = findChoice(JSON.parse(raw));
      if (parsed) return parsed;
    } catch {
      continue;
    }
  }
  return null;
}
