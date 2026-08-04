import type { Env } from "./env";
import { post } from "./bluesky";
import { composeQuote } from "./match";
import { getRandomLyricLines, wasRecentlyPosted, markRecentlyPosted } from "./state";
import { recordPost } from "./analytics";
import { loadSettings } from "./settings";

/**
 * Publish one original post from a random eligible corpus line.
 *
 * Downvoted lines are already excluded by `getRandomLyricLines` (in SQL), so the
 * only check left here is the recent-use window. Candidates are fetched in one
 * query — the random scan dominates the cost, so asking for a batch is far cheaper
 * than re-querying per attempt.
 */
export async function publishOriginal(env: Env, candidates = 16): Promise<string | null> {
  const [rows, settings] = await Promise.all([
    getRandomLyricLines(env, candidates),
    loadSettings(env),
  ]);
  if (rows.length === 0) return null; // empty corpus, or everything excluded

  // Batched, matching handleMentions' isHandled prefetch and matchLyric's
  // recent-use filter — serially this was up to 16 blocking KV reads before the
  // first send.
  const recent = await Promise.all(rows.map((r) => wasRecentlyPosted(env, r.id)));

  for (const [i, row] of rows.entries()) {
    if (recent[i]) continue;

    // Originals quote a passage too — same compose step as a reply, so the two
    // paths can't drift.
    const snippet = await composeQuote(
      env,
      { id: row.id, line: row.line, band: row.band_name, song: row.song_title },
      settings,
    );
    const ref = await post(env, snippet);
    await Promise.all([
      markRecentlyPosted(env, row.id),
      recordPost(env, {
        uri: ref?.uri,
        cid: ref?.cid,
        kind: "original",
        text: snippet,
        lineId: row.id,
        bandName: row.band_name,
        songTitle: row.song_title,
      }),
    ]);

    return row.id;
  }
  return null; // every candidate was posted recently
}
