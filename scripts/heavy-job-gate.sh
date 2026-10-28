#!/usr/bin/env bash
# Admission gate for heavy jobs: one at a time, memory floor, cgroup cap.
# Thin wrapper; the logic and the full usage text live in heavy-job-gate.py,
# the guide in docs/heavy-job-gate.md.
#   heavy-job-gate.sh [--min-mb N] [--max-mem 2G] [--swap-max 256M] [--wait-sec S] [--label TEXT] [--allow-uncapped] [--max-sec N] [--agent NAME] -- <command...>
# Gate exit codes: 64 usage, 73 lock busy / older jobs still queued, 74 lock file
# or FIFO queue unusable, 75 memory floor not met or unreadable, 76 job stopped
# after --max-sec, 77 no capped scope, 128+signo if signalled while queued;
# otherwise the command's own code.
exec python3 "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/heavy-job-gate.py" "$@"
