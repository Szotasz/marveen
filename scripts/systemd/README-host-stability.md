# Host stability: WSL-VM restart detection + crash-loop throttle

Root cause of the 2026-07-07 fleet-wide silence: the whole **WSL2 utility VM**
shut down (19:18:14 CEST) and re-booted (19:23:57 CEST) -- `journalctl
--list-boots` shows boot `-1` ending and boot `0` starting with a fresh kernel.
That tears down the kernel, system + user systemd, tmux, dashboard and channels
at once. It is **not** an application crash, and `Linger=yes` does not protect
against it (linger only survives session logout, not a VM teardown).

Under WSL2 a VM teardown is triggered from the **Windows side**, never from
inside the VM: `vmIdleTimeout` auto-shutdown (VM stops shortly after the last
WSL handle/terminal closes), Windows sleep/hibernate -> resume, `wsl
--shutdown`, a Windows/WSL update, or VM OOM.

## Pieces installed here

| File | Role |
|------|------|
| `host-restart-watchdog.sh` + `marveen-host-watchdog.service` | oneshot at every user-manager start; if `/proc/stat btime` changed vs `store/.last-btime`, Telegrams "host/WSL VM restarted" with an estimated downtime. btime-change => host restart. |
| `unit-fail-notify.sh` + `marveen-notify@.service` | instantiated by `OnFailure=marveen-notify@%n.service` drop-ins on the dashboard/channels units; Telegrams "app-crash: <unit> FAILED". OnFailure => app crash. |
| `marveen-channels.service` StartLimit fix | `StartLimitIntervalSec`/`StartLimitBurst` moved from `[Service]` (where systemd logged "Unknown key ... in section [Service]" and ignored them) to `[Unit]`, so the crash-loop throttle actually applies. |

The two notifiers deliberately use different triggers so a fleet-wide silence
can be classified: **btime change = host/VM restart**, **OnFailure = app crash**.

## Memory: three layers with different jobs (Linux)

| Piece | Decides | When |
|-------|---------|------|
| `scripts/fleet-memory-gate.sh` (+ `fleet-safe-start.sh`) | may this AGENT start now? (safe-mode band, agent cap) | before every agent start (dashboard reconcile loop) |
| `scripts/heavy-job.sh` | may this heavy JOB (render, ffmpeg, full test suite, `tsc`, browser test, local LLM batch) start now? | when an agent runs one |
| `scripts/ram-emergency-brake.py` + `marveen-ram-emergency-brake.service` | memory is about to run out anyway: unload ollama, stop the heaviest allowlisted job | every 3 s, opt-in service |

**Heavy-job gate.** Prefix a heavy command with the gate:

    scripts/heavy-job.sh [--max-mem 2G] [--min-mb 2500] [--wait-sec 300] [--max-sec N] [--label NAME] [--agent NAME] -- <command...>

One heavy job runs at a time, in arrival order (a FIFO ticket queue in
`store/.heavy-job-queue/`, lock `store/.heavy-job.lock`; `--agent` stops one agent
from taking the lock back-to-back while others wait, and a job with
`--max-sec <= 300` may pass long ones, at most 3 in a row). It starts only when
`MemAvailable >= max(--min-mb, cap + 500 MB)`, inside a `systemd-run --user --scope`
with `MemoryMax`, so a runaway job is OOM-killed in its own cgroup; when it ends
the whole scope is stopped. Exit codes: the command's own, or 64 usage, 73 lock
busy for `--wait-sec`, 74 lock/queue unusable, 75 memory floor not met or
unreadable, 76 stopped after `--max-sec`, 77 no enforceable memory cap (needs
cgroup2 with the memory controller delegated to the user manager; also: not Linux),
128+signo when signalled while queued. On 73/75 retry later; do not run the job
around the gate. Log: `store/heavy-job-log.jsonl`. Linux only: on macOS every
call is refused with 77 (no systemd scope, no `/proc` to measure).

**Emergency brake (opt-in).** Install the unit as its header says. It never
stops agent sessions, tmux, the dashboard, channels, bun, sshd or ollama. Killable
are a `heavy-job-*.scope` first, then ffmpeg/media tools, headless browsers and
node test runners/builds/renders; python scripts only when listed in the
optional `store/ram-emergency-brake.json`:

    {"python_scripts": [
      {"dir": "agents/video", "scripts": ["render.py", "batch.py"]},
      {"dir": "agents/video/scripts", "scripts": "*"}
    ]}

(`dir` relative to the install root; a malformed file is ignored and logged as
`config_error`, so it can only mean fewer kills; restart the service after an
edit.) One owner alert per incident through `scripts/lib/send-telegram.sh`, owner
chat resolved like `scripts/lib/owner-chat.sh` (`MARVEEN_ALERT_CHAT_ID`
overrides). Every target is signalled on its own through one checked path (identity,
owner, cgroup and never-kill re-checked right before each send); a process the brake
cannot identify is never a target. One acting brake per install (an flock on
`store/.ram-emergency-brake.lock`; a second one exits 3).
Log: `store/ram-emergency-brake-log.jsonl`. Dry run:
`python3 scripts/ram-emergency-brake.py --dry-run --cycles 3 --simulate-avail-mb 300`.

## Windows-side fix (do NOT automate from Linux)

To stop the VM from auto-shutting-down when idle, edit on the Windows host:

    %UserProfile%\.wslconfig

    [wsl2]
    vmIdleTimeout=-1

Then `wsl --shutdown` once from Windows for it to take effect. This is a Windows
filesystem change under `/mnt/c` and must be made by the user on Windows -- the
Linux side must not write it automatically.

## Rollback

    systemctl --user disable --now marveen-host-watchdog.service
    rm ~/.config/systemd/user/marveen-host-watchdog.service
    rm -rf ~/.config/systemd/user/marveen-dashboard.service.d/onfailure.conf \
           ~/.config/systemd/user/marveen-channels.service.d/onfailure.conf
    rm ~/.config/systemd/user/marveen-notify@.service
    # revert the channels StartLimit move by reinstalling the previous unit, then:
    systemctl --user daemon-reload
