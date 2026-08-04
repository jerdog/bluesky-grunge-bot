import type { Env } from "./../env";
import { fetchCachedInsert } from "./../state";

// Fetch lyrics for a known (artist, title) from ToS-permissible lyrics APIs and
// return only SHORT candidate lines. We never store or expose full lyrics — the
// corpus keeps single short lines purely to power contextual matching, and only
// short attributed snippets are ever posted.

/**
 * Shared User-Agent for every upstream call. MusicBrainz enforces a UA policy and
 * will throttle a generic agent; keeping this private forces all callers through
 * `getJson`, so it can only ever be defined once.
 */
const USER_AGENT = "bluesky-grunge-bot/0.1 (+https://github.com/jerdog/bluesky-grunge-bot)";

// Refetch a given (source, artist, title) at most this often.
export const FETCH_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

/** GET a JSON document, returning null for any non-OK or unparseable response. */
export async function getJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export interface ExtractedLine {
  line: string;
  /**
   * Ordinal in the song's sung-line sequence. Gaps are meaningful: a missing pos
   * means a line was dropped, so its neighbours are NOT adjacent and must never be
   * quoted as a run.
   */
  pos: number;
  /** Eligible to be embedded, matched, and quoted as the headline of a post. */
  candidate: boolean;
}

export type LyricSource = (typeof SOURCES)[number]["name"];

export interface FetchResult {
  source: LyricSource;
  lines: ExtractedLine[];
  /** Cache stamps for the sources tried, for the caller to flush in its batch. */
  stamps: D1PreparedStatement[];
}

const cacheKey = (source: string, artist: string, title: string) =>
  `${source}:${artist.toLowerCase()}:${title.toLowerCase()}`;

/** Below this a line is real, but too slight to stand on its own as a quote. */
const MIN_CANDIDATE_CHARS = 12;

const SECTION_MARKER = /^[\[(](chorus|verse|bridge|intro|outro|pre-chorus|hook|refrain)/i;

/**
 * Split a raw lyrics blob into positioned lines: trimmed, non-empty, free of
 * section markers like "[Chorus]", within the length cap, and de-duplicated.
 *
 * `pos` counts every line that is actually sung — it is advanced before the length
 * and duplicate filters, so it tracks the song rather than what we chose to keep.
 * That is the whole point: a dropped line leaves a gap, and the passage builder
 * reads a gap as "not adjacent" and stops there instead of splicing two distant
 * lines into a quote that never existed.
 *
 * De-duplication has to stay. `lineId` hashes (band, song, line), so storing a
 * repeated chorus line twice would collide on the primary key.
 *
 * Short lines are kept but marked `candidate: false`: they are poor matches on
 * their own, yet dropping them entirely would punch holes through every chorus.
 */
export function extractLines(raw: string, maxChars: number): ExtractedLine[] {
  const seen = new Set<string>();
  const out: ExtractedLine[] = [];
  let pos = 0;

  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (SECTION_MARKER.test(line)) continue;

    const at = pos++;
    if (line.length > maxChars) continue; // too long to quote

    const key = line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({ line, pos: at, candidate: line.length >= MIN_CANDIDATE_CHARS });
  }
  return out;
}

async function fetchFromLrclib(artist: string, title: string): Promise<string | null> {
  const url =
    "https://lrclib.net/api/get?" +
    new URLSearchParams({ artist_name: artist, track_name: title }).toString();
  const body = await getJson<{ plainLyrics?: string | null }>(url);
  return body?.plainLyrics ?? null;
}

async function fetchFromLyricsOvh(artist: string, title: string): Promise<string | null> {
  const url = `https://api.lyrics.ovh/v1/${encodeURIComponent(artist)}/${encodeURIComponent(title)}`;
  const body = await getJson<{ lyrics?: string }>(url);
  return body?.lyrics ?? null;
}

/** Tried in order — LRCLIB first. Order is structural here, not a property of key order. */
const SOURCES = [
  { name: "lrclib", fetch: fetchFromLrclib },
  { name: "lyrics.ovh", fetch: fetchFromLyricsOvh },
] as const;

/**
 * Fetch short candidate lines for one song. Tries LRCLIB first, then lyrics.ovh.
 * Uses a D1-backed cache to avoid re-hitting the APIs. `now` is unix seconds.
 *
 * `maxChars` is required so callers pass the resolved (dashboard-tunable) value —
 * defaulting to the raw env var here would silently bypass the KV override.
 *
 * `force` re-fetches a song the cache says was tried recently. Needed when the
 * extraction itself changed: the cache records that we asked, not what we kept, so
 * without it a rebuild would skip every song and change nothing.
 *
 * `fresh` is the set of still-valid cache keys, resolved once for the whole run by
 * `getFreshFetchKeys`. Cache stamps come back as prepared statements rather than
 * being run here, so the caller can flush them in the batch it already sends.
 */
export async function fetchLines(
  env: Env,
  artist: string,
  title: string,
  now: number,
  maxChars: number,
  fresh: Set<string>,
  force = false,
): Promise<FetchResult | null> {
  const stamps: D1PreparedStatement[] = [];

  for (const { name, fetch: fetchRaw } of SOURCES) {
    const key = cacheKey(name, artist, title);
    if (!force && fresh.has(key)) continue; // recently attempted

    // getJson never throws, so the attempt and its cache stamp are a flat pair.
    const raw = await fetchRaw(artist, title);
    stamps.push(fetchCachedInsert(env, key, raw ? "hit" : "miss", now));

    if (raw) {
      const lines = extractLines(raw, maxChars);
      // A song with no candidate lines is worth nothing to the matcher, and the
      // context-only lines around them are worth nothing on their own.
      if (lines.some((l) => l.candidate)) return { source: name, lines, stamps };
    }
  }
  // Nothing usable, but the attempts still need recording or we retry every run.
  return stamps.length ? { source: SOURCES[0].name, lines: [], stamps } : null;
}
