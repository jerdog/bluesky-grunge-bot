import type { Env } from "./../env";
import { embedMany } from "./../ai";
import bandsData from "./../../data/bands.json";
import {
  upsertBand,
  upsertSong,
  lyricLineInsert,
  getUnembeddedLines,
  getFreshFetchKeys,
  getUnpositionedSongs,
  countUnpositionedSongs,
  dropUnpositionedLines,
  markLinesEmbedded,
} from "./../state";
import { fetchLines, getJson, FETCH_TTL_SECONDS, type ExtractedLine } from "./fetch";
import { loadSettings } from "./../settings";

interface BandSeed {
  name: string;
  mbid?: string;
  seedTracks?: string[];
}

const bands = (bandsData as { bands: BandSeed[] }).bands;

/**
 * Separator for the id hash. Must stay an escape sequence, never a literal
 * control byte: a raw NUL makes this file binary to grep/diff, and any tool that
 * normalises it would silently re-key the entire corpus (orphaning every
 * downvote and recent-use key). `lineId` is pinned by a golden test.
 */
const ID_SEP = "\u0000";

/** Stable id for a lyric line so re-runs don't create duplicates (FNV-1a hex). */
export function lineId(band: string, song: string, line: string): string {
  const s = `${band}${ID_SEP}${song}${ID_SEP}${line}`.toLowerCase();
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0") + "-" + s.length.toString(16);
}

/** Look up track titles for an artist via MusicBrainz (no key required). */
async function musicbrainzTracks(artist: string, limit: number): Promise<string[]> {
  const url =
    "https://musicbrainz.org/ws/2/recording?" +
    new URLSearchParams({
      query: `artist:"${artist}" AND status:official`,
      fmt: "json",
      limit: String(limit),
    }).toString();
  const body = await getJson<{ recordings?: Array<{ title?: string }> }>(url);
  const titles = new Set<string>();
  for (const rec of body?.recordings ?? []) {
    if (rec.title) titles.add(rec.title.trim());
  }
  return [...titles];
}

/**
 * Statements that write one song's fetched lines, plus its cache stamps.
 *
 * Shared because the two callers must produce byte-identical rows: `lineId` keys
 * `posts.line_id` (what makes a 👎 stick) and the `recent:<id>` flags, so if the
 * seeder and the repair job ever derived it differently the repair would insert
 * duplicates instead of updating in place, orphaning both. Spelling it once is the
 * only thing keeping that true as columns get added.
 */
function songWrite(
  env: Env,
  song: { id: number; band: string; title: string },
  result: { lines: ExtractedLine[]; stamps: D1PreparedStatement[] },
): D1PreparedStatement[] {
  return [
    ...result.stamps,
    ...result.lines.map((l) =>
      lyricLineInsert(env, {
        id: lineId(song.band, song.title, l.line),
        song_id: song.id,
        band_name: song.band,
        song_title: song.title,
        line: l.line,
        pos: l.pos,
        candidate: l.candidate,
      }),
    ),
  ];
}

export interface CorpusStats {
  bandsProcessed: number;
  songsFetched: number;
  linesInserted: number;
}

/**
 * Build/refresh the lyric-line corpus in D1: for each band, resolve tracks
 * (seedTracks first, else MusicBrainz), fetch short lines, and insert them.
 * Embedding into Vectorize happens separately via embedPending().
 *
 * `tracksPerBand` keeps each run bounded so it fits comfortably in a cron
 * invocation and stays friendly to the upstream APIs.
 *
 * `force` ignores the fetch cache. Use it after a change to extraction — the
 * cache remembers that a song was fetched, not how it was parsed, so a plain
 * rerun would skip every song it already has.
 *
 * Line inserts are issued one D1 batch per song rather than one round trip per
 * line — the scan is dominated by network hops, and a full build is thousands of
 * lines. (A multi-row VALUES insert would be worse: D1 caps bound parameters at
 * 100 per statement, so 6 params/row would allow only 16 rows.)
 */
export async function buildCorpus(
  env: Env,
  now: number,
  opts: { maxBands?: number; tracksPerBand?: number; force?: boolean } = {},
): Promise<CorpusStats> {
  const tracksPerBand = opts.tracksPerBand ?? 8;
  const selected = bands.slice(0, opts.maxBands ?? bands.length);
  let songsFetched = 0;
  let linesInserted = 0;
  // Harvesting has its own cap: it bounds how long a stored line may be, which is
  // a different question from how much of a song a post may quote.
  //
  // The warm-cache set is resolved once for the whole run, like the settings are.
  // Asked per song it was 2 round trips x every song — paid in full even on a run
  // with nothing to do, which is exactly what the weekly refresh usually is.
  const [{ lineMaxChars }, fresh] = await Promise.all([
    loadSettings(env),
    getFreshFetchKeys(env, FETCH_TTL_SECONDS, now),
  ]);

  for (const band of selected) {
    // The band upsert and the track lookup are independent.
    const seeds = band.seedTracks ?? [];
    const [bandId, resolved] = await Promise.all([
      upsertBand(env, band.name, band.mbid),
      seeds.length ? Promise.resolve(seeds) : musicbrainzTracks(band.name, tracksPerBand),
    ]);
    const titles = resolved.slice(0, tracksPerBand);

    for (const title of titles) {
      const result = await fetchLines(env, band.name, title, now, lineMaxChars, fresh, opts.force);
      if (!result) continue; // fully cached — nothing was even attempted

      // A song with no usable lines still has cache stamps to flush, or every run
      // would retry it. Only a song we actually kept lines from gets a songs row.
      let inserts = result.stamps;
      if (result.lines.length > 0) {
        const songId = await upsertSong(env, bandId, title, result.source, now);
        songsFetched++;
        inserts = songWrite(env, { id: songId, band: band.name, title }, result);
        linesInserted += result.lines.length;
      }
      if (inserts.length > 0) await env.DB.batch(inserts);
    }
  }

  return { bandsProcessed: selected.length, songsFetched, linesInserted };
}

export interface BackfillStats {
  songsProcessed: number;
  linesPositioned: number;
  /** Songs still awaiting positions after this batch — 0 means done. */
  remainingSongs: number;
}

/**
 * Give positions to lines harvested before `pos` existed.
 *
 * Targeted rather than a blind re-seed: it asks D1 which songs still have
 * position-less lines and re-fetches exactly those. A `seed --force` cannot do this
 * reliably, because track titles come from MusicBrainz and its result set is not
 * stable between runs, so it re-fetches an arbitrary subset each time and may never
 * revisit a given song. This converges.
 *
 * Bounded by `limit` songs per call so it fits one invocation; `remainingSongs`
 * tells the caller whether to go again. Lines the source no longer returns are
 * dropped, but only when the fetch actually succeeded — otherwise a transient API
 * failure would delete a whole song.
 */
export async function backfillPositions(
  env: Env,
  now: number,
  opts: { limit?: number } = {},
): Promise<BackfillStats> {
  const limit = opts.limit ?? 25;
  const [{ lineMaxChars }, songs] = await Promise.all([
    loadSettings(env),
    getUnpositionedSongs(env, limit),
  ]);

  let songsProcessed = 0;
  let linesPositioned = 0;

  for (const song of songs) {
    // force: the whole point is to re-read a song the cache says we already have.
    const result = await fetchLines(
      env,
      song.band_name,
      song.song_title,
      now,
      lineMaxChars,
      new Set(),
      true,
    );
    if (!result || result.lines.length === 0) continue; // leave it for another run

    // Refresh the songs row too. Omitting it left `source`/`fetched_at` describing
    // the *previous* fetch on exactly the rows this job rewrote, so a song that now
    // resolves via lyrics.ovh would still claim lrclib.
    const bandId = await upsertBand(env, song.band_name);
    const songId = await upsertSong(env, bandId, song.song_title, result.source, now);

    await env.DB.batch([
      ...songWrite(env, { id: songId, band: song.band_name, title: song.song_title }, result),
      // Same batch as the inserts: the delete means "still position-less after this
      // write", which is only true once the write has landed.
      dropUnpositionedLines(env, songId, result.lines.map((l) =>
        lineId(song.band_name, song.song_title, l.line),
      )),
    ]);
    linesPositioned += result.lines.length;
    songsProcessed++;
  }

  return {
    songsProcessed,
    linesPositioned,
    remainingSongs: await countUnpositionedSongs(env),
  };
}

/**
 * Embed lines not yet in Vectorize and upsert them.
 *
 * Reads one page of candidates up front instead of re-querying per batch, then
 * embeds in chunks sized for the upstream limits (Workers AI embedding models
 * accept ~100 texts per request). Safe to call repeatedly; each chunk commits its
 * own `embedded` flags so a partial run still makes progress.
 */
export async function embedPending(env: Env, chunkSize = 100, maxLines = 2000): Promise<number> {
  const rows = await getUnembeddedLines(env, maxLines);
  let total = 0;

  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const vectors = await embedMany(
      env,
      chunk.map((r) => r.line),
    );
    if (vectors.length !== chunk.length) break;

    await env.LYRICS_INDEX.upsert(
      chunk.map((r, j) => ({
        id: r.id,
        values: vectors[j],
        metadata: { line: r.line, band: r.band_name, song: r.song_title },
      })),
    );
    await markLinesEmbedded(
      env,
      chunk.map((r) => r.id),
    );
    total += chunk.length;
  }
  return total;
}
