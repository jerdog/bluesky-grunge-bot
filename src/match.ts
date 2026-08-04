import type { Env } from "./env";
import { embed, rerank, pickBestLyric, type Candidate, type RankedCandidate } from "./ai";
import { POST_MAX_GRAPHEMES } from "./bluesky";
import { getPassageContext, wasRecentlyPosted } from "./state";
import type { Settings } from "./settings";

export interface Match {
  /** Vectorize/D1 id of the chosen line — what analytics and votes key on. */
  id: string;
  /** The single line the matcher chose. `composeQuote` grows it into the quote. */
  line: string;
  band: string;
  song: string;
  /** Vectorize similarity score for the chosen line. */
  score: number;
  /** Cross-encoder relevance score for the chosen line. */
  rerankScore: number;
  reason: string;
}

/**
 * Contextual lyric match for a Bluesky post:
 *   embed(post) -> Vectorize top-K -> cross-encoder rerank -> LLM picks the best line.
 *
 * The wide Vectorize recall gives the reranker plenty to work with; the reranker
 * then cheaply discards the near-misses so the LLM only judges a short list.
 * Returns null if the corpus has no usable candidates.
 *
 * Returns the chosen line, not the finished quote — growing it into a passage and
 * attributing it is `composeQuote`'s job, so both quote paths share one composer.
 *
 * `settings` and `exclude` are required rather than lazily loaded: callers resolve
 * them once per batch, and Vectorize can't express the exclusion predicate itself
 * (unlike the SQL line source in state.ts), so it is applied to the results here.
 */
export async function matchLyric(
  env: Env,
  postText: string,
  settings: Settings,
  exclude: Set<string>,
): Promise<Match | null> {
  const cleaned = postText.trim();
  if (!cleaned) return null;

  const queryVec = await embed(env, cleaned);

  const results = await env.LYRICS_INDEX.query(queryVec, {
    topK: settings.matchTopK,
    returnMetadata: "all",
  });

  const candidates: Candidate[] = [];
  const scoreById = new Map<string, number>();
  for (const m of results.matches ?? []) {
    if (exclude.has(m.id)) continue; // previously downvoted — don't reuse
    const md = (m.metadata ?? {}) as { line?: string; band?: string; song?: string };
    if (!md.line || !md.band || !md.song) continue;
    candidates.push({ id: m.id, line: md.line, band: md.band, song: md.song });
    scoreById.set(m.id, m.score ?? 0);
  }

  if (candidates.length === 0) return null;

  // Narrow the wide recall set down to the few genuinely relevant lines.
  const shortlist = await rerank(env, cleaned, candidates, settings.rerankTopN);
  if (shortlist.length === 0) return null;

  const fresh = await dropRecentlyUsed(env, shortlist);
  const picked = await pickBestLyric(env, cleaned, fresh);
  const chosen = fresh.find((c) => c.id === picked.id) ?? fresh[0];

  return {
    id: chosen.id,
    line: chosen.line,
    band: chosen.band,
    song: chosen.song,
    score: scoreById.get(chosen.id) ?? 0,
    rerankScore: chosen.rerankScore,
    reason: picked.reason,
  };
}

/**
 * Drop lines already used in a recent post, so the bot doesn't answer every
 * similar mention with the same words.
 *
 * Everything upstream is deterministic — the same post yields the same embedding,
 * the same Vectorize hits and the same rerank order — so without this the reply is
 * a pure function of the post text and repeats forever. Original posts have always
 * applied this rule; replies did not, which is the asymmetry rather than anything
 * about how the match itself works.
 *
 * Filters the shortlist (a handful) rather than the full recall set (up to 50), so
 * this costs `rerankTopN` KV reads issued together, not one per candidate. Keeps
 * the whole shortlist if every line is recent: a repeat beats no reply.
 */
async function dropRecentlyUsed(
  env: Env,
  shortlist: RankedCandidate[],
): Promise<RankedCandidate[]> {
  const recent = await Promise.all(shortlist.map((c) => wasRecentlyPosted(env, c.id)));
  const fresh = shortlist.filter((_, i) => !recent[i]);
  return fresh.length > 0 ? fresh : shortlist;
}

/**
 * Grow one matched line into the passage that leads up to it, staying inside the
 * post budget. Falls back to the bare line on any failure — a passage is a nicety,
 * and losing the reply over it would be a bad trade.
 */
export async function expandToPassage(
  env: Env,
  row: QuoteSource,
  settings: Settings,
): Promise<string> {
  if (settings.passageMaxLines <= 1) return row.line;
  try {
    // The SQL window is in rows either side of the match; the setting counts lines
    // in the finished quote. Backward growth can use the whole budget, so the
    // window has to be at least that wide — but no wider.
    const ctx = await getPassageContext(env, row.id, settings.passageMaxLines - 1);
    if (ctx.matchPos === null) return row.line;
    return buildPassage(ctx.lines, ctx.matchPos, {
      budget: snippetBudget(row.band, row.song, settings.snippetMaxChars),
      maxLines: settings.passageMaxLines,
    });
  } catch {
    return row.line;
  }
}

/**
 * A corpus line, in the shape both quote paths already have in hand: `Candidate`
 * from the matcher, and `LyricLineRow` from the random picker.
 */
export interface QuoteSource {
  id: string;
  line: string;
  band: string;
  song: string;
}

/**
 * Expand a chosen line into a passage and attribute it — the single compose step.
 *
 * Both quote paths (a reply's match, and a scheduled original) go through here, so
 * the expand/format pairing can't drift between them. Keeping it in one function
 * also means `snippetBudget` is computed from one set of values rather than twice
 * from two.
 */
export async function composeQuote(
  env: Env,
  row: QuoteSource,
  settings: Settings,
): Promise<string> {
  const text = await expandToPassage(env, row, settings);
  return formatSnippet({ text, band: row.band, song: row.song }, settings.snippetMaxChars);
}

/**
 * Assemble the longest contiguous run of lines ending at `matchPos` that fits.
 *
 * Grows backwards, so the quote reads as build-up landing on the line the matcher
 * actually chose — that arrival is the point, and filling the budget forwards would
 * bury the chosen line mid-quote. Forward growth is only a fallback for when there
 * is no lead-in to take (the match opens its run), where the alternative is the
 * single bare line.
 *
 * Expansion stops the moment the next position is absent: a gap means the extractor
 * dropped a line there, so the two sides are not adjacent in the song and joining
 * them would fabricate a lyric that was never sung.
 *
 * Counts in code points, and charges a character for each newline, because the
 * platform limit counts them too.
 */
export function buildPassage(
  lines: Array<{ line: string; pos: number }>,
  matchPos: number,
  opts: { budget: number; maxLines: number },
): string {
  const byPos = new Map(lines.map((l) => [l.pos, l.line]));
  const anchor = byPos.get(matchPos);
  if (anchor === undefined) return "";

  let used = width(anchor);
  if (used > opts.budget) return anchor; // formatSnippet truncates this case

  let count = 1;

  // Walk out from the match and return where it stopped. Each step costs the line
  // plus the newline joining it.
  const grow = (step: -1 | 1): number => {
    let cursor = matchPos;
    while (count < opts.maxLines) {
      const next = byPos.get(cursor + step);
      if (next === undefined) break;
      const cost = width(next) + 1;
      if (used + cost > opts.budget) break;
      used += cost;
      count++;
      cursor += step;
    }
    return cursor;
  };

  const first = grow(-1);
  // No lead-in existed, so take what follows rather than quoting the line alone.
  const last = first === matchPos ? grow(1) : matchPos;

  const out: string[] = [];
  for (let p = first; p <= last; p++) out.push(byPos.get(p)!);
  return out.join("\n");
}

/**
 * Characters available for the quote itself, once attribution is accounted for.
 *
 * Two caps apply and the tighter wins: `maxChars` (the tunable copyright guard
 * rail) and whatever the platform limit leaves. Shared by the passage builder and
 * `formatSnippet` so they can't disagree about what fits.
 */
export function snippetBudget(band: string, song: string, maxChars: number): number {
  return Math.min(maxChars, POST_MAX_GRAPHEMES - width(attribution(band, song)));
}

/** Blank line then the credit — the same shape for one line or several. */
const attribution = (band: string, song: string) => `\n\n— ${band}, “${song}”`;

/**
 * Length in code points. One definition, because the budget calculator and the
 * truncator disagreeing about what "a character" is would let a post through that
 * neither thought was over the limit. bluesky.ts enforces the real grapheme count
 * behind this — see its note on the known mismatch.
 */
const width = (s: string) => [...s].length;

/**
 * Format a quote — one line or a passage — as an attributed snippet.
 *
 * `text` normally arrives already inside the budget from `buildPassage`; the
 * truncation here is the backstop for the paths that don't go through it, and for
 * a single line longer than the budget. It counts in code points, since `.length`
 * would over-count astral characters and emoji. bluesky.ts asserts the real
 * grapheme limit behind this.
 *
 * `maxChars` is required on purpose — a default would silently disable the
 * copyright cap for any caller that forgot it.
 */
export function formatSnippet(
  match: { text: string; band: string; song: string },
  maxChars: number,
): string {
  const credit = attribution(match.band, match.song);
  const budget = snippetBudget(match.band, match.song, maxChars);
  const chars = [...match.text];
  const text =
    chars.length > budget ? chars.slice(0, budget - 1).join("").trimEnd() + "…" : match.text;
  return `${text}${credit}`;
}
