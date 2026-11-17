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
| `scripts/heavy-job-gate.sh` ([docs/heavy-job-gate.md](../../docs/heavy-job-gate.md)) | may this heavy JOB (render, ffmpeg, full test suite, `tsc`, browser test, local LLM batch) start now? | when an agent runs one |
| `scripts/ram-emergency-brake.py` + `marveen-ram-emergency-brake.service` | memory is about to run out anyway: stop the heaviest allowlisted job (ollama unload first only if opted in) | every 3 s, opt-in service |

**Heavy-job gate.** Documented in [docs/heavy-job-gate.md](../../docs/heavy-job-gate.md)
(lock `store/.heavy-job.lock`, queue `store/.heavy-job-queue/`, log
`store/heavy-job-log.jsonl` by default; `HEAVY_JOB_STORE` moves all three). The brake
does not read or take the gate's lock, queue or log; it only recognises the
gate's transient `heavy-job-*.scope` units and never kills the gate process
(`heavy-job-gate.py`, including its memory-cap probe child).

**Emergency brake (opt-in).** Install the unit as its header says. It never
stops agent sessions, tmux, the dashboard, channels, bun, sshd or ollama. Killable
are a `heavy-job-*.scope` first, then ffmpeg/media tools, headless browsers and
node test runners/builds/renders; python scripts only when listed in the
optional `store/ram-emergency-brake.json`:

    {"python_scripts": [
      {"dir": "agents/video", "scripts": ["render.py", "batch.py"]},
      {"dir": "agents/video/scripts", "scripts": "*"}
    ],
     "ollama_unload": true,
     "ollama_models": ["llama3.1:8b"]}

(`dir` relative to the install root; every key is optional; a malformed file is
ignored and logged as `config_error`, so it can only mean fewer actions; restart
the service after an edit.)

**Ollama unload is opt-in, off by default.** With `"ollama_unload": true` the
first action of an incident unloads the models loaded in the local ollama server
(`keep_alive: 0`; the brake cannot stop ollama itself). It is not free: an agent
running on the `ollama` provider, or the memory embeddings when they come from
the same ollama (`EMBED_URL` falls back to `OLLAMA_URL`), lose their model. Their
next call loads it again, so the same memory comes back, and as the brake retries
the unload every 60 s, this can repeat during one incident; a generation in
flight during the unload may fail. Turn it on for models nothing interactive
depends on, and name them in `ollama_models` (as `ollama ps` shows them; a name
without a tag also matches `:latest`): only those are unloaded, the others are
kept and logged as `ollama_kept_unlisted`. `ollama_models` without
`"ollama_unload": true` is a config error.

One owner alert per incident through `scripts/notify.sh`: Slack first when
`NOTIFY_SLACK_TARGET` is set, Telegram as the fallback (or beside it), exactly as
for the other owner notifications, so an install whose owner channel is not
Telegram is told too. The brake reads no channel token itself. The alert counts
as sent only when `notify.sh` exits 0 (a channel delivered); otherwise it is
retried, at most 3 times, then logged as `alert_gave_up`. When Slack delivers
but Telegram, wanted beside it, fails, `notify.sh` exits 1, so the owner can get
the same alert on Slack up to 3 times: a duplicate, never silence. Every target is signalled on its own through one checked path (identity,
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
