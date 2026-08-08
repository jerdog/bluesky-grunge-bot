import { botHandle, type Env } from "./env";
import { listMentions, reply, type MentionNotification } from "./bluesky";
import { matchLyric, composeQuote } from "./match";
import {
  getNotifCursor,
  setNotifCursor,
  isHandled,
  markHandled,
  markRecentlyPosted,
} from "./state";
import { loadSettings, type Settings } from "./settings";
import { getDownvotedLineIds, recordPost } from "./analytics";

// Lightweight guardrail: skip posts that look abusive/NSFW so the bot never
// engages with them. Not a moderation system — just a courtesy filter.
const BLOCKED = [
  "nazi",
  "kys",
  "kill yourself",
  "slur", // placeholder token; extend with your own denylist as needed
];

export function isSafeToAnswer(text: string): boolean {
  const t = text.toLowerCase();
  return !BLOCKED.some((w) => t.includes(w));
}

/** Strip a leading @mention of the bot so it doesn't skew the contextual match. */
export function cleanPostText(text: string, handle: string): string {
  return text
    .replace(new RegExp(`@${handle}\\b`, "gi"), "")
    .replace(/\s+/g, " ")
    .trim();
}

export interface PollStats {
  scanned: number;
  answered: number;
  /** Why the rest weren't answered, so a quiet run is distinguishable from a broken one. */
  skipped: Partial<Record<"empty" | "unsafe" | "no-match", number>>;
}

/**
 * Poll notifications and reply to new mentions/replies with a contextual lyric.
 * Idempotent: advances the KV cursor and records handled URIs for every mention
 * that reached a terminal outcome, so overlapping cron runs never double-reply.
 * `no-match` is deliberately not terminal — see the loop below.
 */
export async function handleMentions(env: Env): Promise<PollStats> {
  const cursor = await getNotifCursor(env);
  const { mentions, cursor: next } = await listMentions(env, cursor);
  const handle = botHandle(env);

  // Resolved once for the whole batch, but only if there is a batch. Started
  // eagerly they cost a KV read and a D1 SELECT on every poll — and nearly every
  // poll is idle, so that was ~480 wasted round trips a day at the current cadence
  // for work no mention needed.
  let context: Promise<[Settings, Set<string>]> | undefined;
  const replyContext = () =>
    (context ??= Promise.all([loadSettings(env), getDownvotedLineIds(env)]));

  // The dedupe checks are independent of each other — one batch, not N serial reads.
  const alreadyHandled = await Promise.all(mentions.map((m) => isHandled(env, m.uri)));

  let scanned = 0;
  let answered = 0;
  const skipped: PollStats["skipped"] = {};
  const marks: Array<Promise<void>> = [];

  for (const [i, m] of mentions.entries()) {
    scanned++;
    if (alreadyHandled[i]) continue;
    const [settings, exclude] = await replyContext();
    const outcome = await replyToPost(env, m, settings, exclude, handle, {
      alreadyChecked: true, // the batched prefetch above already answered this
    });
    if (outcome.replied) {
      answered++;
      // Nothing later in the loop depends on the mark landing; it is awaited
      // before the cursor advances, which is what keeps the run idempotent.
      marks.push(markHandled(env, m.uri));
    } else if (outcome.reason === "no-match") {
      // Not a verdict on the post, only on the corpus/settings at this instant —
      // both change over time (new lines, retuned matchTopK, a downvote freeing
      // up a line), so this one is deliberately left unmarked. A later poll that
      // re-lists it (or a manual /api/reply-to) gets a real second attempt instead
      // of a permanent, invisible skip.
      skipped["no-match"] = (skipped["no-match"] ?? 0) + 1;
    } else {
      // `empty`/`unsafe` are pure functions of the post text — retrying the same
      // text would fail the same way, so these are terminal.
      skipped[outcome.reason as "empty" | "unsafe"] =
        (skipped[outcome.reason as "empty" | "unsafe"] ?? 0) + 1;
      marks.push(markHandled(env, m.uri));
    }
  }

  await Promise.all(marks);
  // Only when it actually moved. Bluesky returns a cursor on every call, so writing
  // unconditionally spent a KV write on every poll however quiet — the cost that
  // scales with cron frequency rather than with how much there is to do.
  if (next && next !== cursor) await setNotifCursor(env, next);
  return { scanned, answered, skipped };
}

export interface ReplyOutcome {
  replied: boolean;
  /** Why not, when `replied` is false — surfaced by the manual route. */
  reason?: "empty" | "unsafe" | "no-match" | "already-answered";
  snippet?: string;
  band?: string;
  song?: string;
  uri?: string;
}

/**
 * Compose and send one reply. Shared by the notification poller and the manual
 * "reply to this post" route, so both take the identical path: safety filter ->
 * match -> snippet -> reply -> record.
 */
export async function replyToPost(
  env: Env,
  m: MentionNotification,
  settings: Settings,
  exclude: Set<string>,
  handle: string,
  opts: { alreadyChecked?: boolean; force?: boolean } = {},
): Promise<ReplyOutcome> {
  const text = cleanPostText(m.text, handle);

  if (!text) return { replied: false, reason: "empty" };
  if (!isSafeToAnswer(text)) return { replied: false, reason: "unsafe" };

  // Dedupe belongs on the shared path, not only in the poller. The manual route
  // had none, so pasting a URL the poller had already answered — or pasting the
  // same one twice — published a second public reply to that post.
  //
  // `alreadyChecked` lets the poller keep its batched prefetch instead of paying a
  // second read per mention; `force` makes a deliberate re-reply an explicit
  // decision rather than an omission.
  if (!opts.force && !opts.alreadyChecked && (await isHandled(env, m.uri))) {
    return { replied: false, reason: "already-answered" };
  }

  const match = await matchLyric(env, text, settings, exclude);
  if (!match) return { replied: false, reason: "no-match" };

  const snippet = await composeQuote(env, match, settings);
  const ref = await reply(env, snippet, { root: m.root, parent: m.parent });

  // Retire the line for a while, the same way an original post does. Without this
  // the reply path is a pure function of the post text, so every similar mention
  // gets answered with the identical words — and re-running the same post always
  // returns the same line.
  //
  // Concurrent with the analytics write: independent, and this sits inside the
  // serialized reply loop, whose duration is what bounds how fast the poll may run.
  await Promise.all([
    markRecentlyPosted(env, match.id),
    recordPost(env, {
      uri: ref?.uri,
      cid: ref?.cid,
      kind: "reply",
      text: snippet,
      lineId: match.id,
      bandName: match.band,
      songTitle: match.song,
      vectorScore: match.score,
      rerankScore: match.rerankScore,
      pickReason: match.reason,
      textModel: env.AI_TEXT_MODEL,
      replyToUri: m.uri,
      replyToHandle: m.authorHandle,
      replyToText: m.text,
    }),
  ]);

  return {
    replied: true,
    snippet,
    band: match.band,
    song: match.song,
      uri: ref?.uri,
  };
}
