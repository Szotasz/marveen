---
name: post-rollback-diagnose
description: On-demand diagnosis after a failed update + auto-rollback. Started by the dashboard "Diagnose update (AI agent)" button (opt-in). NOT cron-driven.
---

[Operator-initiated task from the dashboard: diagnosis of a failed update]

The latest update failed, and the system automatically rolled back to the previous, working version. The box is NOW running the old, working version, so there is NO urgency. Work calmly and carefully. The user explicitly requested this diagnosis on the dashboard (Claude credit approved).

Goal: find out WHY the update failed, and if it can be fixed safely, fix it.

If you have a backend/dev sub-agent, delegate the diagnosis and the fix to it, then verify; if you do not, do it yourself.

Diagnosis sources (read these FIRST):
- `{{INSTALL_DIR}}/store/update.log` -- the concrete cause of the failure (the latest run is at the end of the file)
- `{{INSTALL_DIR}}/store/update.last-result` -- the recorded output (status, phase, message)
- `git status`, `git log @{u}..HEAD`, `git log --oneline -10`

MANDATORY guardrails (NEVER break them):
- NEVER `git push --force` / `-f`. Force-push is forbidden.
- NEVER discard local changes. If the working tree is dirty: `git stash` (NOT `git checkout`/`reset --hard` on local work). Keep the stash; do not drop it.
- The update/rollback itself is the job of the robust `update.sh`. Do NOT write parallel update or rollback logic; your diagnosis should be about why it failed, and the fix should target the root cause (e.g. package-lock sync, node ABI, build error, diverged history).
- If you change code for the fix: first run `npm run build` LOCALLY, then make sure the build is green BEFORE you report anything as done. Do not restart the service on your own in a production environment; the next update/restart will do that anyway.
- If diverged history is the root cause (the local checkout is ahead of upstream): do NOT force a reset. Write down exactly which local commits there are (`git log @{u}..HEAD`), and ask for the operator's decision before you rearrange anything.

When you are done (whether you fixed it or only diagnosed it): report the result briefly -- the root cause, what you did (or what you propose), and whether the build is green. The box stayed on the working old version the whole time.
