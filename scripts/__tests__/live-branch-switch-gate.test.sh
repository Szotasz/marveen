#!/usr/bin/env bash
# live-branch-switch-gate: behaviour test. 0 = allowed through, 2 = stopped.
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
GATE="$ROOT/scripts/hooks/live-branch-switch-gate.py"
pass=0; fail=0
check() { if [ "$2" = "$3" ]; then pass=$((pass+1)); echo "ok   - $1"
  else fail=$((fail+1)); echo "FAIL - $1 (want=$2 got=$3)"; fi; }
run() { python3 -c 'import json,sys;print(json.dumps({"tool_name":"Bash","tool_input":{"command":sys.argv[1]}}))' "$1" \
        | python3 "$GATE" >/dev/null 2>&1; echo $?; }

check "bare checkout -b in the live tree STOPS" 2 "$(run 'git checkout -b feature/x')"
check "switch -c stops too"                     2 "$(run 'git switch -c feature/x')"
check "cd live && checkout -b STOPS"           2 "$(run 'git checkout -b fix/y')"
check "from a sub-agent directory it STOPS"                2 "$(run 'cd '"$ROOT"'/agents/subagent && git checkout -b feature/subagent/z')"
check "git -C live checkout -b STOPS"          2 "$(run 'git -C '"$ROOT"' checkout -b fix/y')"

check "worktree form passes"                     0 "$(run 'git worktree add /tmp/wt -b fix/y develop && cd /tmp/wt')"
check "cd into /tmp passes"                     0 "$(run 'cd /tmp/wt-x && git checkout -b fix/y')"
check "a variable path passes"                 0 "$(run 'cd "$WT" && git checkout -b fix/y')"
check "an intervening command does not fool it"      0 "$(run 'cd "$SCRATCH/wt" && rm -f node_modules && git checkout -b fix/y')"
check "a worktree under ~ passes"              0 "$(run 'cd ~/claw-test && git checkout -b fix/y')"

check "switching to an existing branch passes"              0 "$(run 'git checkout develop')"
check "restoring a file passes"               0 "$(run 'git checkout -- scripts/x.sh')"
check "listing branches passes"              0 "$(run 'git branch --show-current')"

# The two false hits measurement produced: the forbidden form appears as DATA.
check "MENTIONED inside a curl -d payload passes"       0 "$(run "curl -s -X POST http://localhost:3420/api/messages -d '{\"content\":\"do not run git checkout -b feature/x\"}'")"
check "MENTIONED in backticked prose passes"      0 "$(run 'echo "not `git checkout -b feature/sub/daily-log-digest`"')"
check "MENTIONED in a heredoc passes"               0 "$(run "cat > /tmp/a.md <<'XX'
git checkout -b feature/x
XX")"

check "a non-Bash tool passes"  0 "$(printf '%s' '{"tool_name":"Write","tool_input":{"file_path":"/a.py","content":"git checkout -b x"}}' | python3 "$GATE" >/dev/null 2>&1; echo $?)"
check "malformed json passes"   0 "$(printf 'nem-json' | python3 "$GATE" >/dev/null 2>&1; echo $?)"
check "an empty command passes"   0 "$(run '')"
check "it speaks EVERY time (second run too)" 2 "$(run 'git checkout -b feature/x')"

echo '---'; echo "pass=$pass fail=$fail"; [ "$fail" -eq 0 ]
