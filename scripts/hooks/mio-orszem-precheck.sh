#!/usr/bin/env bash
# Scheduler preCheck for the marveen-io-kozosseg-orszem task (ORSICTX912).
#
# runPreCheck contract: exit 0 + stdout "SKIP" = no model turn this tick;
# exit 0 + other stdout = run the task with stdout as a context prefix;
# non-zero exit / timeout (10s spawnSync) = fail-open, the model turn runs.
#
# Why: the hourly sentinel round re-injects its full SKILL.md (~3.5k tokens of
# a 12-23k token round) and MOST hours have nothing new -- the saturation
# arithmetic (Orsi: 2.5 context restarts/day, each a message-loss window) is
# dominated by quiet rounds, not by round cost. This asks the ONLY question
# that decides quietness -- are there new users/posts/comments/purchases past
# the state-file thresholds -- deterministically, and skips the model turn on
# an all-zero answer.
#
# Deliberately NON-RECORDING: the state file is the model round's closing
# stamp and stays untouched here. A skipped round leaves its trace as the
# 'skipped-precheck' row in task_runs; the stall detector (kanban-audit 3/b)
# reads state-staleness together with those rows.
#
# FAIL DIRECTION, spelled out: every error path here must END IN A MODEL TURN
# (non-zero exit -> runPreCheck fail-open), and only a cleanly measured
# all-zero may print SKIP. A broken precheck must never silence the sentinel.
#
# Daemon environment: the dashboard runs under launchd with a minimal PATH,
# so every binary is absolute (overridable for the hermetic tests -- the
# override envs are test seams, not configuration).
set -u

STATE="${MIO_PRECHECK_STATE:-/Users/marvin/ClaudeClaw/store/mio-kozosseg-orszem-state.json}"
NODE="${MIO_PRECHECK_NODE:-/opt/homebrew/bin/node}"
SUPABASE="${MIO_PRECHECK_SUPABASE:-/opt/homebrew/bin/supabase}"
VAULT_RESOLVE="${MIO_PRECHECK_VAULT:-/Users/marvin/ClaudeClaw/scripts/vault-resolve.mjs}"
PROJECT_REF="${MIO_PRECHECK_PROJECT_REF:-fpxycpxdxgifimbmwgzj}"

fail_open() { echo "mio-orszem-precheck: $1" >&2; exit 3; }

# No state file = the sentinel's FIRST round; per its SKILL.md that round only
# stamps. Intentional model turn, not an error: empty stdout, exit 0.
[ -f "$STATE" ] || exit 0

# Thresholds from the state file. Validation is the SQL-injection gate: the
# state file has concurrent writers, and a corrupted value must fail open
# loudly, never reach the query string.
THRESHOLDS="$("$NODE" -e '
const fs = require("fs");
let s;
try { s = JSON.parse(fs.readFileSync(process.argv[1], "utf-8")); }
catch (e) { console.error("state parse: " + e.message); process.exit(4); }
const keys = ["last_user_at", "last_post_at", "last_comment_at", "last_purchase_at"];
const ok = /^[0-9][0-9T:+. Z-]{9,40}$/;
const out = [];
for (const k of keys) {
  const v = s[k];
  if (typeof v !== "string" || !ok.test(v)) {
    console.error("state threshold invalid: " + k + "=" + JSON.stringify(v));
    process.exit(4);
  }
  out.push(v);
}
console.log(out.join("\n"));
' "$STATE")" || fail_open "state thresholds unreadable"

USER_AT="$(echo "$THRESHOLDS" | sed -n 1p)"
POST_AT="$(echo "$THRESHOLDS" | sed -n 2p)"
COMMENT_AT="$(echo "$THRESHOLDS" | sed -n 3p)"
PURCHASE_AT="$(echo "$THRESHOLDS" | sed -n 4p)"

# The token goes into the environment only -- never stdout (the sentinel's own
# 2026-09-14 lesson, inherited here).
SUPABASE_ACCESS_TOKEN="$(echo 'X=MARVEEN-CONNECTORS-PAT' | "$NODE" "$VAULT_RESOLVE" | cut -d= -f2-)" || fail_open "vault resolve failed"
[ -n "$SUPABASE_ACCESS_TOKEN" ] || fail_open "vault returned an empty PAT"
export SUPABASE_ACCESS_TOKEN

SQL="select
 (select count(*) from auth.users where created_at > '$USER_AT') as users,
 (select count(*) from posts where created_at > '$POST_AT') as posts,
 (select count(*) from comments where created_at > '$COMMENT_AT') as comments,
 (select count(*) from marveen_purchases where created_at > '$PURCHASE_AT') as purchases;"

RAW="$("$SUPABASE" db query "$SQL" --linked --project-ref "$PROJECT_REF" --output-format json 2>/dev/null)" || fail_open "supabase db query failed"

# The CLI can surround the JSON array with noise ("Extra data" both ways) --
# raw_decode from the first bracket, and anything unparseable fails open.
COUNTS="$("$NODE" -e '
let s = "";
process.stdin.on("data", (d) => { s += d; });
process.stdin.on("end", () => {
  const i = s.indexOf("[");
  if (i < 0) { console.error("no JSON array in query output"); process.exit(4); }
  let rows;
  try { rows = JSON.parse(s.slice(i, s.lastIndexOf("]") + 1)); }
  catch (e) { console.error("query output parse: " + e.message); process.exit(4); }
  const r = rows && rows[0];
  const keys = ["users", "posts", "comments", "purchases"];
  if (!r || keys.some((k) => typeof r[k] !== "number" && typeof r[k] !== "string")) {
    console.error("query row shape unexpected: " + JSON.stringify(r));
    process.exit(4);
  }
  console.log(keys.map((k) => k + "=" + Number(r[k])).join(" "));
});
' <<<"$RAW")" || fail_open "query output unparseable"

if [ "$COUNTS" = "users=0 posts=0 comments=0 purchases=0" ]; then
  echo "SKIP"
  exit 0
fi

# Something is new: run the model turn, handing it the measured deltas so the
# round starts with the answer to its own first question.
echo "Delta-elo-meres (precheck): $COUNTS -- a kuszobok a state-fajlbol; a kor a szokott eljarast kovesse, a zaro stamp valtozatlanul a modell-kore."
exit 0
