import { describe, it, expect, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { pruneRemovedBands } from "./corpus";
import type { Env } from "./../env";

/** A D1-shaped adapter over real SQLite, with foreign keys ENFORCED. */
function d1(db: DatabaseSync) {
  const mk = (sql: string, args: unknown[]): any => ({
    bind: (...a: unknown[]) => mk(sql, a),
    all: async () => ({ results: db.prepare(sql).all(...(args as never[])) }),
    first: async () => db.prepare(sql).get(...(args as never[])) ?? null,
    run: async () => ({ meta: { changes: db.prepare(sql).run(...(args as never[])).changes } }),
    __exec: () => db.prepare(sql).run(...(args as never[])),
  });
  return {
    prepare: (sql: string) => mk(sql, []),
    batch: async (stmts: any[]) => stmts.map((s) => s.__exec()),
  };
}

describe("pruneRemovedBands against real SQLite", () => {
  it("removes the stale band without violating a foreign key", async () => {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON;");
    // Repo-relative, exactly as schema.test.ts reads it — vitest runs from the
    // repo root. An absolute path passes only on the machine that wrote it.
    db.exec(readFileSync("schema.sql", "utf8"));
    db.exec(`
      INSERT INTO bands (id, name) VALUES (1, 'Deleted Band'), (2, 'Nirvana');
      INSERT INTO songs (id, band_id, title) VALUES (1, 1, 'A'), (2, 2, 'B');
      INSERT INTO lyric_lines (id, song_id, band_name, song_title, line, char_len, embedded, pos, candidate)
        VALUES ('g1', 1, 'Deleted Band', 'A', 'a synthetic line', 16, 1, 0, 1),
               ('k1', 2, 'Nirvana', 'B', 'another synth line', 18, 1, 0, 1);
      INSERT INTO fetch_cache (cache_key, status, fetched_at)
        VALUES ('lrclib:deleted band:a', 'hit', 1), ('lrclib:nirvana:b', 'hit', 1);
      INSERT INTO posts (kind, text, line_id, band_name, created_at, dry_run)
        VALUES ('reply', 'x', 'g1', 'Deleted Band', 1, 1);
    `);

    const deleted: string[][] = [];
    const env = {
      DB: d1(db),
      LYRICS_INDEX: { deleteByIds: vi.fn(async (ids: string[]) => { deleted.push(ids); }) },
    } as unknown as Env;

    const stats = await pruneRemovedBands(env);

    expect(stats.bandsRemoved).toEqual(["Deleted Band"]);
    expect(deleted.flat()).toEqual(["g1"]);
    expect(db.prepare("SELECT id FROM lyric_lines").all()).toEqual([{ id: "k1" }]);
    expect(db.prepare("SELECT name FROM bands").all()).toEqual([{ name: "Nirvana" }]);
    expect(db.prepare("SELECT cache_key FROM fetch_cache").all()).toEqual([
      { cache_key: "lrclib:nirvana:b" },
    ]);
    // Analytics history survives.
    expect(db.prepare("SELECT COUNT(*) AS n FROM posts").get()).toEqual({ n: 1 });
  });
});
