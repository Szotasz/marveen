# Heavy-job gate (one heavy job at a time, memory floor, cgroup cap)

> Several agents on one host can each start a video render, a full test suite or a
> TypeScript build at the same moment. Each one alone fits in memory; together they
> do not, and the kernel OOM killer then picks its victims: an agent's pane, the
> dashboard, the channel. The heavy-job gate lets such jobs start one at a time,
> only when there is room, and inside a memory cap of their own.

---

## 🎯 What it does / why it matters

- **One heavy job at a time**, host-wide, in arrival order (a FIFO queue in front
  of a global lock). A late arrival never barges in.
- **Memory floor:** a job starts only when `MemAvailable` is at least
  `max(--min-mb, cap + reserve)`, so even its worst case (its whole cap) leaves the
  reserve for everything else. It waits for that up to `--wait-sec`.
- **Its own memory cap:** the job runs in a transient `systemd-run --user --scope`
  with `MemoryMax` / `MemorySwapMax`. A runaway job is OOM-killed inside its own
  cgroup (exit 137); the host and the other agents are not touched.
- **Nothing outlives the job:** when the main process ends, the whole scope is
  stopped, so a backgrounded child cannot keep using memory after the gate has let
  the next job in.
- **Fails closed:** if it cannot measure memory, cannot use its lock or queue, or
  cannot create a scope whose memory cap is verified to be in effect, it does not
  run the job, and it says why with its own exit code.

It is **opt-in**: nothing in Marveen calls it on its own. An agent (by a rule in its
`CLAUDE.md`) or a script wraps a heavy command in it. **Linux only** (it reads
`/proc/meminfo` and uses a systemd user scope).

### When to use it

Wrap a command in the gate when it can take a large share of the host's memory, or
run for minutes:

- video render, ffmpeg encode, Remotion
- full test suite (`npx vitest run`, `npm test`)
- TypeScript build (`npm run build`, `npx tsc`)
- headless browser test (Playwright)
- local LLM batch

Not needed for: one quick ffmpeg operation on a single image (preview, crop,
scale), `ffprobe`, running a single test file.

```bash
scripts/heavy-job-gate.sh --label vitest -- npx vitest run
scripts/heavy-job-gate.sh --max-mem 3G --wait-sec 600 --label render -- node render.mjs
scripts/heavy-job-gate.sh --max-sec 240 --agent backend-dev --label tsc -- npx tsc --noEmit
```

A wait plus the job can be longer than a Bash tool call's timeout: give the tool
call a long timeout, or run it in the background, so the tool does not kill the job
half-way.

### Exit codes and what to do

The gate passes the command's own exit code through. Its own codes:

| Code | Meaning | What to do |
|------|---------|------------|
| 64 | usage error (also an invalid environment default) | fix the call |
| 73 | another heavy job held the lock (or older jobs were still queued) for the whole `--wait-sec` | retry later; do not run the job without the gate |
| 74 | the lock file or the queue is unusable | system problem: report it |
| 75 | `MemAvailable` stayed below the floor for the whole `--wait-sec`, or could not be read | retry later, or free memory; do not bypass the gate |
| 76 | the job ran and was stopped because it exceeded `--max-sec` | the job is longer than declared: raise `--max-sec` or split it |
| 77 | no verified memory-capped scope: no `systemd-run`, no user manager, or a `MemoryMax` that systemd accepts but does not enforce (memory controller not delegated, `cap_probe=cap_not_in_effect` in the log) | system problem: report it (for `cap_not_in_effect`, see Requirements); `--allow-uncapped` runs without the cap, logged, only as a conscious decision |
| 128+n | the call got signal n (SIGTERM 143, SIGINT 130, SIGHUP 129) while queued or while waiting for memory; the job never started | the log line says `reason=signal` (`phase=memory` for the memory wait) |

A capped job that dies with 137 (or 143) and was not signalled through the gate was
killed by its memory cap or by someone outside the gate;
`journalctl --user -u <unit>.scope` shows which (`Failed with result 'oom-kill'`).

### A rule for an agent's CLAUDE.md

```markdown
## Heavy jobs only through the gate
Video render, ffmpeg encode, full test suite, TypeScript build, browser test and
local LLM batch run only as
`scripts/heavy-job-gate.sh [--max-mem 2G] [--wait-sec 300] --label NAME -- <command...>`.
On 73 or 75 do not run it without the gate: retry later or report it. 74 and 77
are system errors: report them to the main agent.
```

---

## 🛠 How it works

`scripts/heavy-job-gate.sh` is a thin wrapper around `scripts/heavy-job-gate.py`
(Python 3 standard library only). The full contract is the script's docstring.

1. **Queue and lock.** Each call writes a ticket to `store/.heavy-job-queue/`
   (atomic, named by arrival time and pid) and may try the global `flock` on
   `store/.heavy-job.lock` only while no live ticket is ahead of it. Tickets of dead
   processes (or of a reused pid) are removed by whoever sees them, so a crashed
   waiter never blocks the queue.
2. **Memory floor.** After the lock it waits for `MemAvailable >= floor`. The lock
   wait and the memory wait share one deadline (`--wait-sec`).
3. **Scope.** `systemd-run --user --scope --collect -p MemoryMax=<cap>M
   -p MemorySwapMax=<swap>M -p TimeoutStopSec=5s`. Before anything else the gate
   verifies that a cap really takes effect: a probe scope gets `MemoryMax=64M`, and
   its child must read its own cgroup's `memory.max` back as exactly 64 MiB. systemd
   accepts `MemoryMax` even where the memory controller is not delegated to the user
   manager and then does not enforce it; there `memory.max` reads `max` or does not
   exist, and the gate refuses (77) rather than run the job uncapped while logging
   it as capped. The start line's `capped: true` means this check passed.
   The command's argv reaches the job verbatim: where `systemd-run` knows
   `--expand-environment`, the gate passes `=no`, so `$VAR` and `$$` are not
   expanded by systemd-run (with expansion on, `sh -c 'kill -9 $$'` became `kill -9 $`).
4. **Teardown.** When the main process ends: `systemctl --user stop <unit>.scope`,
   then a bounded check that the cgroup is empty, `cgroup.kill` as the last resort.
5. **Log.** One JSON line per event in `store/heavy-job-log.jsonl`: `wait`, `start`,
   `finish` (exit code, duration, peak memory, OOM kills, scope stop result),
   `refuse` (with a `reason`), `uncapped`, `ollama_unload`, `nested`,
   `nested_unverified`. The `cmd` field is the program name plus the first 32
   characters of its arguments, never the full argv (a token can be passed in argv).
   At 5 MiB the log is rotated once to `heavy-job-log.jsonl.1`.
6. **File modes.** The lock, the tickets and the log are created `0600` and the
   queue directory `0700`, whatever the umask (the lock record carries the
   nested-call token). The lock and the log are never opened through a symlink,
   and must be regular files owned by the caller: otherwise the lock is refused
   (74) and the log line is dropped. An older, wider log is narrowed to `0600`.

### Options and configuration

| Flag | Environment default | Default | Meaning |
|------|---------------------|---------|---------|
| `--min-mb N` | `HEAVY_JOB_MIN_MB` | 2500 | lower bound of the memory floor (MB) |
| `--max-mem SIZE` | `HEAVY_JOB_MAX_MEM` | 2G | the job's `MemoryMax` (a bare number is MB) |
| `--swap-max SIZE` | `HEAVY_JOB_SWAP_MAX` | 256M | the job's `MemorySwapMax` (0 allowed) |
| `--wait-sec S` | `HEAVY_JOB_WAIT_SEC` | 300 | how long to wait for the lock and the memory, together |
| | `HEAVY_JOB_RESERVE_MB` | 500 | the reserve in `floor = max(--min-mb, cap + reserve)` |
| `--label TEXT` | | command name | shown in the queue, the lock record and the log |
| `--max-sec N` | | none | runtime ceiling: stop the whole scope after N seconds, exit 76 |
| `--agent NAME` | `HEAVY_JOB_AGENT` | none | fairness tag (below) |
| `--allow-uncapped` | | off | run without the cap if no scope can be created (logged, warned) |
| | `HEAVY_JOB_STORE` | `<install root>/store` | directory of the lock, the queue and the log |
| | `HEAVY_JOB_OLLAMA_UNLOAD=1` | off | when memory is short, unload idle ollama models once (`keep_alive=0`) at `HEAVY_JOB_OLLAMA_URL`, else `OLLAMA_URL`. Leave it off if an agent runs on a local ollama model. |

A flag wins over its environment variable.

### Ordering rules on top of FIFO

- **Fairness (`--agent`):** while the lock record names agent X (X's job runs or ran
  last), X's queued tickets let everybody else's go first, so one agent does not
  take the lock back-to-back while another waits.
- **Short lane (`--max-sec N`, N <= 300):** short jobs go before long ones in the
  same fairness class; at most 3 in a row may pass a waiting long job. `--max-sec`
  makes the claim honest: a "short" job that runs longer is stopped (76).

### Nested calls

A gated job that calls the gate again (a test suite that runs a build) runs the
inner command directly, without a second lock, but only if that is verifiable: the
lock is really held, its record carries the job's token (`HEAVY_JOB_TOKEN`, never
printed or logged), and the caller's own cgroup is inside the recorded scope.
Anything else is treated as a normal call and waits in the queue.

### Requirements

- Linux with cgroup v2 and a systemd user manager for the user that runs the
  agents (on a headless host: `loginctl enable-linger <user>`). `MemoryMax` needs the
  memory controller delegated to the user manager:
  `cat /sys/fs/cgroup/user.slice/user-$(id -u).slice/user@$(id -u).service/cgroup.controllers`
  should list `memory`. The gate checks this itself on every call (the probe above):
  without delegation it refuses with 77, `cap_probe=cap_not_in_effect`.
- macOS is not supported: there is no `systemd-run` (77) and no `/proc/meminfo`
  (75 even with `--allow-uncapped`).

### Tests

`python3 scripts/__tests__/heavy-job-gate.test.py`. Hermetic for the most part (fake
`/proc/meminfo`, a temporary lock, queue and log, stand-in `systemd-run` and
`systemctl` first on `PATH`). A LIVE section creates a few small real scopes (200M
cap) to check the teardown and the nested check; it prints `SKIP` and is skipped
where no user scope can be created (CI container), or with
`HEAVY_JOB_TEST_NO_LIVE=1`.

### Known limits

- Ordering uses the wall clock, so a backward clock step can let a later arrival
  sort first.
- A waiter stopped with SIGSTOP at the head of the queue blocks the ones behind it
  until its own `--wait-sec` runs out.
- It only orders and caps the jobs that go through it; a heavy command started
  without the gate is invisible to it, beyond the free memory it measures.
- A gate that is itself SIGKILLed cannot tear down: the kernel releases its lock
  while the job's scope keeps running, so the next heavy job can be admitted beside
  it, with only the memory floor still protecting the host.
- The ticket's arrival time is taken just before the ticket is renamed into place;
  a writer delayed in that window can look older than a waiter that already took
  the lock.
- If the probe passes but `systemd-run` then fails to create the job's own scope,
  that comes back as `systemd-run`'s exit code (usually 1), indistinguishable from
  the job's own exit 1.
