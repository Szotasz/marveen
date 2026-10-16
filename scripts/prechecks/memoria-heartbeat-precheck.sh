#!/usr/bin/env bash
# PRECHECKSZURO1004: preCheck wrapper for memoria-heartbeat (runPreCheck runs
# `bash <this file>`). The logic and its fail-open contract live in the Python
# file next to it; a failure to even start it must also run the round, so the
# exit status is forced to 0 and nothing is printed on that path.
python3 "$(dirname "$0")/memoria_heartbeat_precheck.py" 2>/dev/null || true
exit 0
