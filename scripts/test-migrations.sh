#!/usr/bin/env bash
#
# Exercise cf.sh's run_migrations against a real SQLite, with a fake wrangler.
#
# Every migration bug so far has been valid bash producing invalid SQL, which
# nothing else here can catch: the vitest suite mocks D1, and `bash -n` only checks
# syntax. This sources the REAL run_migrations out of cf.sh — testing a retyped
# copy of a snippet is exactly how a quoting bug shipped once already.
#
# Asserts that four starting states converge on one schema:
#   fresh · pre-passage · pre-ledger (migrated by the old runner) · re-run
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Stands in for `wrangler d1 execute`, backed by a local SQLite file.
cat > "$WORK/wrangler.py" <<'PY'
import sys, sqlite3, json
db, args = sys.argv[1], sys.argv[2:]
sql = None
if "--command" in args:
    sql = args[args.index("--command") + 1]
else:
    f = [a for a in args if a.startswith("--file=")]
    if f:
        sql = open(f[0].split("=", 1)[1]).read()
con = sqlite3.connect(db)
try:
    cur = con.executescript(sql) if ";" in sql.strip()[:-1] else con.execute(sql)
    rows = (
        [dict(zip([d[0] for d in cur.description], r)) for r in cur.fetchall()]
        if cur.description else []
    )
    con.commit()
    if "--json" in args:
        print(json.dumps([{"results": rows, "success": True}]))
except Exception as e:
    print(f"ERROR {e}", file=sys.stderr)
    sys.exit(1)
PY

cat > "$WORK/fingerprint.py" <<'PY'
import sqlite3, sys
d = sqlite3.connect(sys.argv[1])
q = lambda s: [r[0] for r in d.execute(s)]
assert all(
    r[0] is not None for r in d.execute("SELECT applied_at FROM schema_migrations")
), "applied_at is NULL — the INSERT's SQL quoting is broken"
print(
    " || ".join([
        ",".join(sorted(q(
            "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx%'"
        ))),
        ",".join(r[1] for r in d.execute("PRAGMA table_info(lyric_lines)")),
        ",".join(sorted(q("SELECT filename FROM schema_migrations"))),
    ])
)
PY

cat > "$WORK/seed.py" <<'PY'
import sqlite3, sys
d = sqlite3.connect(sys.argv[1])
d.executescript(open(sys.argv[2]).read())
d.execute("INSERT INTO bands (id, name) VALUES (1, 'B')")
d.execute("INSERT INTO songs (id, band_id, title) VALUES (1, 1, 'S')")
d.execute(
    "INSERT INTO lyric_lines (id, song_id, band_name, song_title, line, char_len, embedded)"
    " VALUES ('L0', 1, 'B', 'S', 'a line', 6, 1)"
)
d.commit()
PY

# Source cf.sh for the real thing. It returns early when sourced, so this defines
# every helper without running a command — and, unlike picking functions out with
# sed, it cannot go stale when one of them gains a new dependency.
# shellcheck disable=SC1091
. scripts/cf.sh

# Then override only what must not touch the network or the real account.
D1_NAME=db
wr() { shift 2; python3 "$WORK/wrangler.py" "$DB" "$@"; }
info() { printf '    ==> %s\n' "$*"; }
ok()   { printf '    ok  %s\n' "$*"; }
die()  { printf 'error %s\n' "$*" >&2; exit 1; }

# The harness is only meaningful if the functions under test are real. A missing one
# used to surface as `command not found` swallowed by a `|| true`, which made the
# suite report success while exercising nothing.
for fn in run_migrations record_migration d1_query node_json; do
  declare -F "$fn" >/dev/null || {
    echo "FAIL: $fn is not defined after sourcing cf.sh" >&2
    exit 1
  }
done

# What `cf.sh schema` does: migrations first, then schema.sql.
apply() {
  DB="$1"
  run_migrations
  python3 "$WORK/wrangler.py" "$DB" d1 execute --file=schema.sql
}
fingerprint() { python3 "$WORK/fingerprint.py" "$1"; }
seed() { python3 "$WORK/seed.py" "$1" "$2"; }

PRE_PASSAGE=scripts/fixtures/schema-pre-passage.sql

echo "fresh database"
apply "$WORK/fresh.db"
FRESH="$(fingerprint "$WORK/fresh.db")"

echo "pre-passage database, never migrated"
seed "$WORK/old.db" "$PRE_PASSAGE"
apply "$WORK/old.db"
OLD="$(fingerprint "$WORK/old.db")"

echo "pre-ledger database: 001+002 applied by the old runner, ledger empty"
seed "$WORK/pre.db" "$PRE_PASSAGE"
for m in migrations/001_*.sql migrations/002_*.sql; do
  python3 "$WORK/wrangler.py" "$WORK/pre.db" d1 execute --file="$m"
done
apply "$WORK/pre.db"
PRE="$(fingerprint "$WORK/pre.db")"

echo "re-run of an up-to-date database"
apply "$WORK/pre.db"
RERUN="$(fingerprint "$WORK/pre.db")"

fail=0
for pair in "pre-passage:$OLD" "pre-ledger:$PRE" "re-run:$RERUN"; do
  name="${pair%%:*}"
  got="${pair#*:}"
  if [[ "$got" != "$FRESH" ]]; then
    printf '\nFAIL: %s does not match a fresh database\n  fresh : %s\n  %s: %s\n' \
      "$name" "$FRESH" "$name" "$got"
    fail=1
  fi
done
(( fail )) && exit 1

printf '\nall four states converge on:\n  %s\n' "$FRESH"
