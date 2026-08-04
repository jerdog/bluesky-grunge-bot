#!/usr/bin/env bash
#
# Account-pinned wrangler wrapper.
#
# With multiple Cloudflare accounts, `wrangler login` is ambiguous: it picks up
# whichever OAuth session happens to be cached. Setting CLOUDFLARE_API_TOKEN and
# CLOUDFLARE_ACCOUNT_ID makes wrangler ignore the cached login entirely, so every
# command here targets exactly the account you asked for.
#
# Usage:  ./scripts/cf.sh [-p PROFILE] <command> [args...]
# Run     ./scripts/cf.sh help     for the command list.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

WRANGLER_CONFIG="wrangler.jsonc"
SCHEMA_FILE="schema.sql"
D1_NAME="bluesky_grunge_bot"
VECTORIZE_INDEX="grunge-lyrics"
VECTORIZE_DIMS=1024
VECTORIZE_METRIC="cosine"
KV_BINDING="STATE"
SECRET_NAMES=(BLUESKY_HANDLE BLUESKY_APP_PASSWORD MANUAL_TRIGGER_KEY)

# ---- output helpers ----------------------------------------------------------

if [[ -t 1 ]]; then
  B=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GRN=$'\033[32m'; YLW=$'\033[33m'; RST=$'\033[0m'
else
  B=""; DIM=""; RED=""; GRN=""; YLW=""; RST=""
fi

info() { printf '%s==>%s %s\n' "$B" "$RST" "$*"; }
ok()   { printf '%s  ok%s %s\n' "$GRN" "$RST" "$*"; }
warn() { printf '%swarn%s %s\n' "$YLW" "$RST" "$*" >&2; }
die()  { printf '%serror%s %s\n' "$RED" "$RST" "$*" >&2; exit 1; }

# Never print a token. 40-char Cloudflare tokens -> "abcd…wxyz".
mask() { local v="${1:-}"; [[ ${#v} -le 8 ]] && printf '********' || printf '%s…%s' "${v:0:4}" "${v: -4}"; }

# ---- credential loading -----------------------------------------------------

PROFILE="${CF_PROFILE:-}"

# Resolve a value that may be a 1Password secret reference, so profile files can
# hold `op://vault/item/field` instead of a literal token.
resolve_secret() {
  local v="$1"
  if [[ "$v" == op://* ]]; then
    command -v op >/dev/null 2>&1 || die "value is an op:// reference but the 1Password CLI ('op') is not installed"
    op read "$v" 2>/dev/null || die "could not read $v via 'op read' (is your 1Password session unlocked?)"
  else
    printf '%s' "$v"
  fi
}

# Precedence: already-exported env vars > .dev.vars[.profile] > error.
#
# Credentials share `.dev.vars` with the Worker secrets so there's one file to
# fill in. Only the CLOUDFLARE_* and MANUAL_TRIGGER_KEY values are used here.
load_credentials() {
  if [[ -z "${CLOUDFLARE_API_TOKEN:-}" || -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]]; then
    local file
    if [[ -n "$PROFILE" ]]; then
      file=".dev.vars.${PROFILE}"
      [[ -f "$file" ]] || die "no profile at $file — copy .dev.vars.example and fill it in"
    else
      file=".dev.vars"
      if [[ ! -f "$file" ]]; then
        # `|| true` matters: with `set -o pipefail`, a grep that filters everything
        # out exits 1 and would kill the script before die() could report anything.
        local found
        found="$(ls .dev.vars.* 2>/dev/null | grep -v '\.example$' | sed 's/^\.dev\.vars\.//' | tr '\n' ' ' || true)"
        die "no credentials.
  Either export CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID,
  or create $file:  cp .dev.vars.example .dev.vars
  Available profiles: ${found:-none}"
      fi
    fi
    # shellcheck disable=SC1090
    set -a; source "$file"; set +a
    LOADED_FROM="$file"
  else
    LOADED_FROM="environment"
  fi

  [[ -n "${CLOUDFLARE_API_TOKEN:-}" ]] || die "CLOUDFLARE_API_TOKEN is not set (from $LOADED_FROM)"
  [[ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ]] || die "CLOUDFLARE_ACCOUNT_ID is not set (from $LOADED_FROM)"

  CLOUDFLARE_API_TOKEN="$(resolve_secret "$CLOUDFLARE_API_TOKEN")"
  export CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID
  # Stop wrangler falling back to a cached OAuth login if the token is rejected.
  export CLOUDFLARE_API_TOKEN_ONLY=1
}

api() {
  curl -sS -X "${2:-GET}" \
    -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
    -H "Content-Type: application/json" \
    "https://api.cloudflare.com/client/v4$1"
}

# Read stdin, JSON.parse it, and run $1 against the parsed value as `o`. The single
# place that knows how to drain stdin — every JSON reader below goes through it, so a
# fix here (chunked reads, encodings) reaches all of them.
node_json() { node -e '
  let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
    try { const o=JSON.parse(s); '"$1"' }
    catch { process.exit(1); }
  });' "${2:-}"; }

jq_get() { node_json 'process.stdout.write(String(eval("o"+process.argv[1]) ?? ""));' "$1"; }

# Verify the token works AND that it can see the requested account. This runs
# before every mutating command so a wrong-account deploy fails up front.
#
# Transport failure and an API rejection are reported differently: a proxy or DNS
# problem is not a bad token, and conflating them sends you hunting the wrong bug.
verify_account() {
  local res rc msg
  set +e
  res="$(api "/accounts/$CLOUDFLARE_ACCOUNT_ID" 2>&1)"
  rc=$?
  set -e

  if (( rc != 0 )); then
    die "could not reach the Cloudflare API (curl exit $rc) — this is a network problem, not a credentials problem.
  ${res:-no response}"
  fi

  if [[ "$(printf '%s' "$res" | jq_get '.success' || echo false)" != "true" ]]; then
    msg="$(printf '%s' "$res" | jq_get '.errors[0].message' || true)"
    die "token cannot access account $CLOUDFLARE_ACCOUNT_ID${msg:+ — $msg}
  Token: $(mask "$CLOUDFLARE_API_TOKEN") (from $LOADED_FROM)
  Check the account id, and that the token is scoped to this account.
  List the accounts this token can see:
    curl -sS -H \"Authorization: Bearer \\\$CLOUDFLARE_API_TOKEN\" \\
      https://api.cloudflare.com/client/v4/accounts"
  fi

  ACCOUNT_NAME="$(printf '%s' "$res" | jq_get '.result.name')"
  ACCOUNT_LABEL="${ACCOUNT_NAME:-unnamed} ($CLOUDFLARE_ACCOUNT_ID)"
}

banner() {
  printf '%s\n' "${DIM}account:${RST} ${B}${ACCOUNT_LABEL}${RST}  ${DIM}token:${RST} $(mask "$CLOUDFLARE_API_TOKEN")  ${DIM}via:${RST} $LOADED_FROM"
}

confirm() {
  [[ "${ASSUME_YES:-0}" == "1" ]] && return 0
  local reply
  printf '%s%s%s [y/N] ' "$B" "$1" "$RST"
  read -r reply
  [[ "$reply" =~ ^[Yy]$ ]] || die "aborted"
}

wr() { npx wrangler "$@"; }

# ---- commands ---------------------------------------------------------------

cmd_whoami() {
  banner
  info "Worker bindings visible to this account:"
  wr kv namespace list 2>/dev/null |
    node_json 'for (const n of o) console.log("  kv        ", n.title, n.id);' || true
  wr d1 list --json 2>/dev/null |
    node_json 'for (const d of o) console.log("  d1        ", d.name, d.uuid);' || true
  wr vectorize list 2>/dev/null | sed 's/^/  vectorize  /' || true
}

# The Worker's name, read out of the JSONC config the same way patch_config writes
# it — `"name"` is the first such key in the file, and neither `"index_name"` nor
# `"database_name"` contains the quoted literal, so the match can't wander.
worker_name() {
  node -e '
    const fs=require("fs");
    const m=fs.readFileSync(process.argv[1],"utf8").match(/"name"\s*:\s*"([^"]*)"/);
    if(!m){ console.error("no \"name\" field in "+process.argv[1]); process.exit(1); }
    process.stdout.write(m[1]);
  ' "$WRANGLER_CONFIG"
}

# The namespace TITLE this Worker owns, which is not the same thing as the binding
# name. `wrangler kv namespace create <arg>` titles the namespace literally `<arg>`
# — v4 adds no worker-name prefix (`title = ${env}${namespace}${preview}`). So
# creating it as the bare binding, "STATE", gives every bot in the account a
# namespace with the SAME title: the second bot's create silently fails as a
# duplicate and any lookup by that title returns the first bot's namespace.
#
# That is what happened here. KV caches the Bluesky session, so this Worker
# resumed the other bot's session and posted under its handle — with correct
# secrets and no error, because BLUESKY_HANDLE is only read when no cached session
# is valid. Qualifying the title with the Worker name is what makes it unique.
kv_title() { printf '%s-%s' "$(worker_name)" "$KV_BINDING"; }

# Look up a resource id by name from wrangler's JSON listings, so we never parse
# the (less stable) output of the `create` commands. Exact match, never a suffix:
# "<worker>-STATE" and a legacy bare "STATE" must stay distinguishable.
kv_id_by_title() { wr kv namespace list 2>/dev/null |
  node_json 'const m=o.find(n=>n.title===process.argv[1]); process.stdout.write(m?m.id:"");' "$1"; }
d1_id_for() { wr d1 list --json 2>/dev/null |
  node_json 'const m=o.find(d=>d.name===process.argv[1]); process.stdout.write(m?m.uuid:"");' "$1"; }

# Guard the failure above: confirm the id currently in the config really is this
# Worker's namespace. Cheap, and the alternative is discovering it from a public
# post made under the wrong account.
configured_kv_id() {
  node -e '
    const fs=require("fs");
    const m=fs.readFileSync(process.argv[1],"utf8").match(/"id"\s*:\s*"([^"]*)"/);
    process.stdout.write(m?m[1]:"");
  ' "$WRANGLER_CONFIG"
}

assert_kv_binding() {
  local want configured listing actual
  want="$(kv_title)"
  configured="$(configured_kv_id)"
  [[ -n "$configured" ]] || die "no KV id in $WRANGLER_CONFIG — run: $0 provision"

  # Fetch once, so "the listing failed" and "the id isn't in the listing" stay
  # distinguishable. Collapsing them is what let a wrong id look acceptable.
  listing="$(wr kv namespace list 2>/dev/null)" || listing=""
  if [[ -z "$listing" ]]; then
    warn "could not list KV namespaces — skipping the binding check"
    return 0
  fi

  actual="$(printf '%s' "$listing" |
    node_json 'const m=o.find(n=>n.id===process.argv[1]); process.stdout.write(m?m.title:"");' \
      "$configured")"

  [[ "$actual" == "$want" ]] || die \
    "KV namespace mismatch: $WRANGLER_CONFIG points at ${actual:-an id this account does not have} ($configured), not '$want'.
  KV holds the cached Bluesky session, so deploying this would make the bot post
  under whichever account owns that namespace. Fix it with: $0 provision"
}

# Patch an id into wrangler.jsonc by targeted replacement — the file is JSONC
# with comments, so a JSON parse/stringify round trip would strip them.
patch_config() {
  local key="$1" value="$2"
  node -e '
    const fs=require("fs"), [f,key,val]=process.argv.slice(1);
    let s=fs.readFileSync(f,"utf8");
    // String.raw so \s reaches RegExp intact — a normal template literal here
    // needs doubled backslashes and silently compiles to a never-matching pattern.
    const re=new RegExp(String.raw`("${key}"\s*:\s*)"[^"]*"`);
    if(!re.test(s)){ console.error(`no "${key}" field in ${f}`); process.exit(1); }
    const cur=s.match(re)[0];
    if(cur.includes(`"${val}"`)){ console.log(`  ${key} already ${val}`); process.exit(0); }
    fs.writeFileSync(f, s.replace(re, `$1"${val}"`));
    console.log(`  ${key} -> ${val}`);
  ' "$WRANGLER_CONFIG" "$key" "$value"
}

cmd_provision() {
  banner
  confirm "Create KV / D1 / Vectorize resources in ${ACCOUNT_LABEL}?"

  local title legacy; title="$(kv_title)"
  info "KV namespace ($title)"
  local kv_id; kv_id="$(kv_id_by_title "$title")"

  if [[ -z "$kv_id" ]]; then
    # A namespace titled with the bare binding predates qualified titles. Renaming
    # beats creating alongside it, because it holds the cached session, the
    # notification cursor and every handled: flag — a fresh namespace starts from
    # nothing and re-answers mentions already answered.
    #
    # But only for the Worker that OWNS it. The unqualified title is exactly what
    # made two bots collide, so in the other repo that same namespace belongs to
    # the first bot, and renaming it there would steal its state instead of
    # inheriting it. Ownership = this config already points at that id.
    legacy="$(kv_id_by_title "$KV_BINDING")"
    if [[ -n "$legacy" && "$(configured_kv_id)" == "$legacy" ]]; then
      warn "'$KV_BINDING' ($legacy) is this Worker's namespace under the old unqualified name"
      confirm "Rename it to '$title'? (keeps its data; a new namespace would lose the session and every dedupe flag)"
      wr kv namespace rename --namespace-id "$legacy" --new-name "$title"
      kv_id="$legacy"
    else
      [[ -n "$legacy" ]] && warn "leaving the namespace titled '$KV_BINDING' ($legacy) alone — it belongs to another Worker"
      wr kv namespace create "$title" >/dev/null 2>&1 || true
      kv_id="$(kv_id_by_title "$title")"
    fi
  fi

  if [[ -z "$kv_id" ]]; then
    # Show what the account actually has. "could not find it" with no listing
    # sent the last debugging session guessing at titles it could have printed.
    printf 'KV namespaces in this account:\n' >&2
    wr kv namespace list 2>/dev/null |
      node_json 'for (const n of o) console.error("  " + n.title + "  " + n.id);' || true
    die "could not create or find a KV namespace titled '$title'.
  Do NOT point this Worker at one of the namespaces above under a different title —
  KV holds the cached Bluesky session, so this bot would post under that bot's handle."
  fi
  echo "  $title -> $kv_id"
  patch_config "id" "$kv_id"

  info "D1 database ($D1_NAME)"
  wr d1 create "$D1_NAME" >/dev/null 2>&1 || true
  local d1_id; d1_id="$(d1_id_for "$D1_NAME")"
  [[ -n "$d1_id" ]] || die "could not find the D1 database after creating it"
  patch_config "database_id" "$d1_id"

  info "Vectorize index ($VECTORIZE_INDEX, ${VECTORIZE_DIMS}d, $VECTORIZE_METRIC)"
  if wr vectorize list 2>/dev/null | grep -q "$VECTORIZE_INDEX"; then
    echo "  already exists"
  else
    wr vectorize create "$VECTORIZE_INDEX" \
      --dimensions="$VECTORIZE_DIMS" --metric="$VECTORIZE_METRIC"
  fi

  ok "resources provisioned and $WRANGLER_CONFIG updated"
  warn "commit the updated $WRANGLER_CONFIG — the ids are not secret"
}

cmd_schema() {
  banner
  confirm "Apply migrations + $SCHEMA_FILE to remote D1 '$D1_NAME' in ${ACCOUNT_LABEL}?"
  # Migrations first: schema.sql indexes the columns they add, so the reverse order
  # fails with "no such column" on any database that already exists.
  run_migrations
  wr d1 execute "$D1_NAME" --file="./$SCHEMA_FILE" --remote
  ok "schema applied"
}

# Bring an already-created database up to date. schema.sql is all CREATE TABLE IF
# NOT EXISTS, so it builds one from scratch but cannot alter a deployed one.
#
# Applied migrations are tracked in a schema_migrations ledger. The obvious
# alternative — reading "duplicate column name" out of stderr — forces every
# migration to be a single ADD COLUMN (nothing else has a recognisable
# already-applied error), and silently reports an unrelated failure as success if
# its message happens to contain the same words. The ledger costs one table and
# removes both problems, so migrations can also drop indexes, backfill, or repair.
# A single quote, for building SQL string literals.
#
# The usual '"'"' idiom escapes a quote inside a SINGLE-quoted string; these SQL
# strings are double-quoted (they interpolate), where that same sequence silently
# produces '"table"' instead of 'table'. That shipped once: it made the fresh-database
# check match nothing, and turned strftime('%s','now') into strftime('"%s"','"now"'),
# which returns NULL and trips the NOT NULL on applied_at.
readonly SQ="'"

# Run a query and print one column, one row per line.
d1_query() {
  wr d1 execute "$D1_NAME" --remote --json --command "$1" 2>/dev/null |
    node_json 'for (const row of (o[0]?.results ?? [])) console.log(row[process.argv[1]]);' "$2" ||
    true
}

run_migrations() {
  local f name applied out
  shopt -s nullglob
  local files=(migrations/*.sql)
  shopt -u nullglob
  [[ ${#files[@]} -gt 0 ]] || return 0

  # The ledger has to predate schema.sql, since migrations run before it.
  wr d1 execute "$D1_NAME" --remote --command \
    "CREATE TABLE IF NOT EXISTS schema_migrations (filename TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)" \
    >/dev/null

  # A brand-new database is baselined, not migrated. schema.sql already creates the
  # current shape, so replaying history against it would fail on the first
  # ALTER TABLE — there is no table to alter yet.
  if [[ "$(d1_query "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = ${SQ}table${SQ} AND name = ${SQ}lyric_lines${SQ}" "n")" == "0" ]]; then
    info "fresh database — baselining ${#files[@]} migration(s) against schema.sql"
    for f in "${files[@]}"; do record_migration "$(basename "$f")"; done
    return 0
  fi

  applied="$(d1_query "SELECT filename FROM schema_migrations" "filename")"

  for f in "${files[@]}"; do
    name="$(basename "$f")"
    if grep -qxF "$name" <<<"$applied"; then
      info "migration $name — already applied"
      continue
    fi
    if out=$(wr d1 execute "$D1_NAME" --file="./$f" --remote 2>&1); then
      ok "migration $name applied"
    elif grep -qiE "duplicate column name|no such table" <<<"$out"; then
      # This database predates the ledger, so a migration it already carries has no
      # record. Adopt it rather than failing. Only these two errors qualify: both
      # mean "the change is already there", and anything else is a real failure.
      info "migration $name — already present, recording it"
    else
      echo "$out" >&2
      die "migration $name failed"
    fi
    record_migration "$name"
  done
}

# `date +%s` rather than SQLite's strftime: one less layer of quoting to get wrong.
record_migration() {
  wr d1 execute "$D1_NAME" --remote --command \
    "INSERT OR REPLACE INTO schema_migrations (filename, applied_at) VALUES (${SQ}${1}${SQ}, $(date +%s))" \
    >/dev/null
}

cmd_migrate() {
  banner
  confirm "Apply migrations to remote D1 '$D1_NAME' in ${ACCOUNT_LABEL}?"
  run_migrations
}

cmd_secrets() {
  banner
  info "Setting Worker secrets (input is hidden, values are never echoed)"
  for name in "${SECRET_NAMES[@]}"; do
    local value
    printf '  %s: ' "$name"
    read -rs value; echo
    if [[ -z "$value" ]]; then
      echo "    (skipped)"
      continue
    fi
    printf '%s' "$value" | wr secret put "$name" >/dev/null
    echo "    set ($(mask "$value"))"
    unset value
  done
  ok "secrets updated"
}

# node_modules/.package-lock.json is npm's record of what is actually installed.
# Missing, or older than the lockfile, means the tree predates a dependency change
# — so typecheck would fail on an absent @types package rather than on the code.
ensure_deps() {
  if [[ ! -f node_modules/.package-lock.json ]] ||
     [[ package-lock.json -nt node_modules/.package-lock.json ]]; then
    info "dependencies out of date"; npm install --silent
  fi
}

# True only if a placeholder survives in a *value*. Comment lines are dropped
# first: the comment documenting the REPLACE_WITH_* convention contains the token
# it documents, so a plain grep matched the documentation and blocked every deploy
# even after provision had filled every id in. Only whole-line comments are
# stripped, so a `//` inside a string value can't be mistaken for one.
has_config_placeholder() {
  grep -vE '^[[:space:]]*//' "$WRANGLER_CONFIG" | grep -q "REPLACE_WITH"
}

cmd_deploy() {
  has_config_placeholder &&
    die "$WRANGLER_CONFIG still has REPLACE_WITH_* placeholders — run: $0 provision"

  assert_kv_binding
  ensure_deps
  info "typecheck";  npm run --silent typecheck
  info "tests";      npm test --silent
  # The vitest suite mocks D1, so it cannot see a migration that emits bad SQL.
  info "migrations"; ./scripts/test-migrations.sh >/dev/null || die "migration test failed — run ./scripts/test-migrations.sh"
  banner
  confirm "Deploy to ${ACCOUNT_LABEL}?"
  wr deploy "$@"
  ok "deployed"
}

# An explicit URL always wins; sniffing the deployed hostname is a convenience, so
# a failure to sniff must never override an argument the caller gave.
# The guarded routes all need this; `call_route` prints the better recovery text
# when the key is wrong, so this only catches it being absent.
require_key() {
  [[ -n "${MANUAL_TRIGGER_KEY:-}" ]] ||
    die "MANUAL_TRIGGER_KEY must be set in $LOADED_FROM to call the guarded routes"
  printf '%s' "$MANUAL_TRIGGER_KEY"
}

resolve_host() {
  local host="${1:-}"
  if [[ -z "$host" ]]; then
    host="$(wr deployments list 2>/dev/null | grep -oE 'https://[a-z0-9.-]+workers\.dev' | head -1 || true)"
    [[ -n "$host" ]] || die "could not determine the deployed URL.
  Pass it explicitly, e.g.:  $0 seed https://your-worker.workers.dev"
  fi
  printf '%s' "${host%/}"
}

# seed [--force] [URL] [maxBands] [tracksPerBand]
cmd_seed() {
  banner
  local force=""
  if [[ "${1:-}" == "--force" ]]; then force=1; shift; fi
  local host="${1:-}" bands="${2:-}" tracks="${3:-}" key qs

  host="$(resolve_host "$host")"

  key="$(require_key)"

  # Bounded first runs are polite: we don't rate-limit MusicBrainz, which asks
  # for ~1 req/sec, and the full band list is 79 lookups.
  qs=""
  [[ -n "$bands" ]] && qs="$qs&maxBands=$bands"
  [[ -n "$tracks" ]] && qs="$qs&tracksPerBand=$tracks"
  # --force re-fetches songs the cache says were tried recently. Needed after an
  # extraction change, since the cache records the request, not the parse.
  [[ -n "$force" ]] && qs="$qs&force=1"

  info "building corpus${qs:+ (${qs#&})}"
  call_route "$host/run/build-corpus?key=$key$qs" "build-corpus"
  info "embedding"
  call_route "$host/run/embed?key=$key" "embed"
  ok "seeded — dashboard: $host/dashboard?key=<your key>"
}

# GET a guarded route, printing the Worker's response body on failure.
# `curl -f` is deliberately avoided: it suppresses the body, which is where the
# Worker explains itself (e.g. {"error":"unauthorized"}).
call_route() {
  local url="$1" label="$2" out code body
  set +e
  out="$(curl -sS -w $'\n%{http_code}' "$url" 2>&1)"
  local rc=$?
  set -e
  if (( rc != 0 )); then
    die "$label: could not reach the Worker (curl exit $rc)
  ${out}"
  fi

  code="${out##*$'\n'}"
  body="${out%$'\n'*}"
  printf '%s\n' "$body"

  # On failure the body carries the Worker's own error text — `/run/*` answers
  # {ok:false, error} — and callers that capture stdout (cmd_seed, cmd_backfill,
  # cmd_prune) swallow it, so `die` fired with the diagnosis invisible. Repeat it
  # on stderr, which no caller captures.
  [[ "$code" == 2* ]] || printf '%s\n' "$body" >&2

  case "$code" in
    2*) return 0 ;;
    401) die "$label: HTTP 401 — the Worker rejected MANUAL_TRIGGER_KEY.
  The key in $LOADED_FROM must match the secret deployed to the Worker.
  Check whether it is set at all:
    $0 run secret list
  If it is missing, or differs, (re)set it:
    $0 secrets" ;;
    *) die "$label: HTTP $code" ;;
  esac
}

# backfill [URL] [songsPerBatch]
#
# Repairs lines harvested before positions existed, which can only ever be quoted
# one at a time. Loops because each call is bounded to fit one Worker invocation.
#
# Stops when nothing is left OR when a pass makes no progress: a song whose lyrics
# API no longer answers would otherwise spin forever.
cmd_backfill() {
  banner
  local host="${1:-}" batch="${2:-25}" key prev="" out remaining pass=0
  host="$(resolve_host "$host")"
  key="$(require_key)"

  while :; do
    pass=$((pass + 1))
    out="$(call_route "$host/run/backfill-positions?key=$key&limit=$batch" "backfill-positions")"
    remaining="$(printf '%s' "$out" | jq_get '.result.remainingSongs' || echo "")"
    [[ -n "$remaining" ]] || die "could not read remainingSongs from the response"

    info "pass $pass — $remaining song(s) still without positions"
    [[ "$remaining" == "0" ]] && { ok "backfill complete"; return 0; }

    if [[ "$remaining" == "$prev" ]]; then
      warn "no progress this pass — $remaining song(s) could not be re-fetched."
      warn "Their lyrics source no longer answers; they stay single-line. Stopping."
      return 0
    fi
    prev="$remaining"
  done
}

# prune [URL]
#
# Deletes bands no longer listed in data/bands.json from D1 and Vectorize.
# `build-corpus` only ever adds, so editing the seed list has no effect on what
# was already ingested — the bot keeps quoting a band you removed until this runs.
cmd_prune() {
  banner
  local host="${1:-}" key out
  host="$(resolve_host "$host")"
  key="$(require_key)"
  confirm "Delete every band in the corpus that data/bands.json no longer lists?"
  out="$(call_route "$host/run/prune?key=$key" "prune")"
  printf '%s\n' "$out" | node_json '
    const r = o.result ?? {};
    const names = r.bandsRemoved ?? [];
    console.log(names.length ? "  removed: " + names.join(", ") : "  nothing to remove");
    console.log("  " + (r.linesRemoved ?? 0) + " line(s), " + (r.vectorsRemoved ?? 0) + " vector(s)");
  ' || printf '%s\n' "$out"
  ok "prune complete"
}

cmd_tail() { banner; wr tail "$@"; }

cmd_run() { banner; wr "$@"; }

cmd_help() {
  cat <<EOF
${B}Account-pinned wrangler wrapper${RST}

  ./scripts/cf.sh [-p PROFILE] [-y] <command>

${B}Commands${RST}
  whoami      Verify the token and list this account's KV / D1 / Vectorize resources
  provision   Create KV + D1 + Vectorize, and write their ids into $WRANGLER_CONFIG
  schema      Apply $SCHEMA_FILE + migrations to the remote D1 database
  migrate     Apply migrations/*.sql only (adds columns to an existing database)
  secrets     Set the Worker secrets (${SECRET_NAMES[*]})
  deploy      Typecheck, test, then deploy
  seed [--force] [URL] [maxBands] [tracksPerBand]
              Build the corpus and embed it. Start small: seed <url> 3 3
              --force re-fetches cached songs (needed after an extraction change)
  backfill [URL] [songsPerBatch]
              Give positions to lines that predate them, so they can be quoted as
              passages. Loops until done. Check % passage-ready on the dashboard.
  prune [URL] Delete bands data/bands.json no longer lists, from D1 AND Vectorize.
              Run after removing a band — seeding again will not remove anything.
  tail        Stream live logs
  run ...     Any other wrangler command, with this account pinned
  help        This message

${B}Flags${RST}
  -p PROFILE  Use .dev.vars.PROFILE  (or set CF_PROFILE)
  -y          Skip confirmation prompts

${B}Credentials${RST}
  Precedence: exported CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID,
  then .dev.vars.<profile>, then .dev.vars.
  Values may be 1Password references (op://vault/item/field).

${B}First run${RST}
  cp .dev.vars.example .dev.vars   # then edit
  ./scripts/cf.sh whoami
  ./scripts/cf.sh provision
  ./scripts/cf.sh schema
  ./scripts/cf.sh secrets
  ./scripts/cf.sh deploy
EOF
}

# ---- arg parsing ------------------------------------------------------------
#
# Guarded so this file can be sourced for its functions without running anything.
# scripts/test-migrations.sh does exactly that, to exercise the REAL run_migrations
# rather than a retyped copy — it used to sed out individual functions, which broke
# silently the moment one of them started calling a helper that wasn't on the list.
if [[ "${BASH_SOURCE[0]}" != "${0}" ]]; then
  return 0
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    -p|--profile) PROFILE="${2:?-p needs a profile name}"; shift 2 ;;
    -y|--yes)     ASSUME_YES=1; shift ;;
    -h|--help|help) cmd_help; exit 0 ;;
    --) shift; break ;;
    -*) die "unknown flag: $1 (try: $0 help)" ;;
    *) break ;;
  esac
done

COMMAND="${1:-help}"; shift || true

[[ "$COMMAND" == "help" ]] && { cmd_help; exit 0; }

# `declare -F` keeps this a whitelist: only a defined cmd_* function is reachable.
declare -F "cmd_$COMMAND" >/dev/null || die "unknown command: $COMMAND (try: $0 help)"

# Account pinning is the entire reason this script exists, so it happens once here
# rather than being repeated on every arm. Spelled per-command, a new command added
# without the preamble would run against whatever OAuth session wrangler had
# cached — deploying to the wrong account with no error at all.
load_credentials
verify_account
"cmd_$COMMAND" "$@"
