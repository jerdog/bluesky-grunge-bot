import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { RECORD_POST_SQL, DOWNVOTED_LINE_IDS_SQL } from "./analytics";
import {
  LYRIC_LINE_INSERT_SQL,
  PASSAGE_CONTEXT_SQL,
  DELETE_BAND_LINES_SQL,
  DELETE_BAND_SONGS_SQL,
  DELETE_BAND_ROW_SQL,
  DELETE_BAND_CACHE_SQL,
  likeLiteral,
} from "./state";

/**
 * These run the project's real SQL against the real schema.sql in an in-memory
 * SQLite. The unit tests elsewhere use a mocked D1, which cannot catch a
 * statement that is well-formed JavaScript but invalid SQL against our schema —
 * exactly how `ON CONFLICT(uri)` shipped while the partial unique index made it
 * unresolvable.
 */
function db() {
  const d = new DatabaseSync(":memory:");
  d.exec(readFileSync("schema.sql", "utf8"));
  return d;
}

const row = (uri: string | null, text: string) => [
  uri, null, "reply", text, null, null, null,
  null, null, null, null,
  null, null, null, uri ? 0 : 1, 1_700_000_000,
];

describe("RECORD_POST_SQL against the real schema", () => {
  it("inserts a post", () => {
    const d = db();
    d.prepare(RECORD_POST_SQL).run(...row("at://a", "one"));
    expect(d.prepare("SELECT COUNT(*) AS n FROM posts").get()).toEqual({ n: 1 });
  });

  it("ignores a repeat of the same uri", () => {
    const d = db();
    d.prepare(RECORD_POST_SQL).run(...row("at://a", "one"));
    d.prepare(RECORD_POST_SQL).run(...row("at://a", "duplicate"));
    const rows = d.prepare("SELECT text FROM posts").all();
    expect(rows).toEqual([{ text: "one" }]);
  });

  it("records every dry-run post, which all have a NULL uri", () => {
    const d = db();
    d.prepare(RECORD_POST_SQL).run(...row(null, "dry 1"));
    d.prepare(RECORD_POST_SQL).run(...row(null, "dry 2"));
    expect(d.prepare("SELECT COUNT(*) AS n FROM posts").get()).toEqual({ n: 2 });
  });
});

describe("lyric line SQL against the real schema", () => {
  // Synthetic lines — not real lyrics.
  const LINES = [
    "we drove around all night",
    "the radio was static",
    "you said you were leaving",
    "and I let you",
  ];

  /**
   * lyric_lines.song_id is a real foreign key, so the parents have to exist —
   * buildCorpus upserts the band and song before the line batch for this reason.
   */
  function withSongs(d: ReturnType<typeof db>) {
    d.exec(`INSERT INTO bands (id, name) VALUES (1, 'Example Band'), (2, 'Other');
            INSERT INTO songs (id, band_id, title) VALUES (1, 1, 'Sample Song'), (2, 2, 'Other Song');`);
    return d;
  }

  /** Seed one song's lines at consecutive positions, all candidates. */
  function seed(d: ReturnType<typeof db>, positions = [0, 1, 2, 3]) {
    withSongs(d);
    const ins = d.prepare(LYRIC_LINE_INSERT_SQL);
    positions.forEach((pos, i) => {
      ins.run(`L${i}`, 1, "Example Band", "Sample Song", LINES[i], LINES[i].length, pos, 1);
    });
    return d;
  }

  const context = (d: ReturnType<typeof db>, id: string, window = 6) =>
    d.prepare(PASSAGE_CONTEXT_SQL).all(id, window, window) as Array<{
      line: string;
      pos: number;
      match_pos: number;
    }>;

  it("returns the match's neighbours in position order", () => {
    const rows = context(seed(db()), "L2");
    expect(rows.map((r) => r.pos)).toEqual([0, 1, 2, 3]);
    expect(rows.every((r) => r.match_pos === 2)).toBe(true);
  });

  it("limits the window around the match", () => {
    expect(context(seed(db()), "L3", 1).map((r) => r.pos)).toEqual([2, 3]);
  });

  it("omits downvoted lines, so a retired line can't return as context", () => {
    const d = seed(db());
    d.prepare(
      `INSERT INTO posts (uri, kind, text, line_id, dry_run, created_at, vote)
       VALUES ('at://1', 'reply', 'x', 'L1', 0, 1, -1)`,
    ).run();
    // The gap this leaves is the point: buildPassage will refuse to bridge it.
    expect(context(d, "L3").map((r) => r.pos)).toEqual([0, 2, 3]);
  });

  it("returns nothing for a line stored before positions existed", () => {
    const d = withSongs(db());
    d.prepare(LYRIC_LINE_INSERT_SQL).run("L0", 1, "B", "S", "x", 1, null, 1);
    expect(context(d, "L0")).toEqual([]);
  });

  it("does not reach into another song", () => {
    const d = seed(db());
    d.prepare(LYRIC_LINE_INSERT_SQL).run("X0", 2, "Other", "Other Song", "elsewhere", 9, 1, 1);
    expect(context(d, "L2").map((r) => r.line)).not.toContain("elsewhere");
  });

  it("backfills pos and candidate onto an existing row without re-embedding it", () => {
    const d = withSongs(db());
    const ins = d.prepare(LYRIC_LINE_INSERT_SQL);
    ins.run("L0", 1, "B", "S", "a line", 6, null, 1);
    d.prepare(`UPDATE lyric_lines SET embedded = 1 WHERE id = 'L0'`).run();

    ins.run("L0", 1, "B", "S", "a line", 6, 7, 0); // rebuild sees it again
    expect(d.prepare(`SELECT pos, candidate, embedded FROM lyric_lines WHERE id = 'L0'`).get()).toEqual(
      { pos: 7, candidate: 0, embedded: 1 },
    );
  });
});

describe("DOWNVOTED_LINE_IDS_SQL against the real schema", () => {
  it("selects only downvoted lines", () => {
    const d = db();
    const ins = d.prepare(
      `INSERT INTO posts (uri, kind, text, line_id, dry_run, created_at, vote)
       VALUES (?, 'reply', 'x', ?, 0, 1, ?)`,
    );
    ins.run("at://1", "line-up", 1);
    ins.run("at://2", "line-down", -1);
    ins.run("at://3", "line-none", 0);
    expect(d.prepare(DOWNVOTED_LINE_IDS_SQL).all()).toEqual([{ line_id: "line-down" }]);
  });
});

describe("band-delete SQL against the real schema", () => {
  /** Two bands, each with a song, a line, and a fetch-cache stamp. */
  function seedTwoBands(d: ReturnType<typeof db>) {
    d.exec(`INSERT INTO bands (id, name) VALUES (1, 'Gone'), (2, 'Kept');
            INSERT INTO songs (id, band_id, title) VALUES (1, 1, 'A'), (2, 2, 'B');
            INSERT INTO lyric_lines (id, song_id, band_name, song_title, line, char_len, embedded, pos, candidate)
              VALUES ('g1', 1, 'Gone', 'A', 'a synthetic line', 16, 1, 0, 1),
                     ('k1', 2, 'Kept', 'B', 'another one here', 16, 1, 0, 1);
            INSERT INTO fetch_cache (cache_key, status, fetched_at) VALUES
              ('lrclib:gone:a', 'hit', 1), ('lrclib:kept:b', 'hit', 1);`);
    return d;
  }

  it("removes one band's lines, songs, row and cache without touching the other", () => {
    const d = seedTwoBands(db());
    d.prepare(DELETE_BAND_LINES_SQL).run("Gone");
    d.prepare(DELETE_BAND_SONGS_SQL).run("Gone");
    d.prepare(DELETE_BAND_ROW_SQL).run("Gone");
    d.prepare(DELETE_BAND_CACHE_SQL).run(likeLiteral("gone"));

    expect(d.prepare("SELECT id FROM lyric_lines").all()).toEqual([{ id: "k1" }]);
    expect(d.prepare("SELECT name FROM bands").all()).toEqual([{ name: "Kept" }]);
    expect(d.prepare("SELECT COUNT(*) AS n FROM songs").get()).toEqual({ n: 1 });
    expect(d.prepare("SELECT cache_key FROM fetch_cache").all()).toEqual([
      { cache_key: "lrclib:kept:b" },
    ]);
  });

  it("does not let a LIKE metacharacter in a band name widen the cache delete", () => {
    // An unescaped '_' matches any character, so '%:g_ne:%' would also take
    // 'gone' — a neighbouring band deleted by a name that merely resembles it.
    const d = seedTwoBands(db());
    d.prepare(DELETE_BAND_CACHE_SQL).run(likeLiteral("g_ne"));
    expect(d.prepare("SELECT COUNT(*) AS n FROM fetch_cache").get()).toEqual({ n: 2 });
  });
});
