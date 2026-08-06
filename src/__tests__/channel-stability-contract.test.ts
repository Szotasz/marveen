import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Contract tests for the durable Telegram-channel stabilization (source-fix +
// contract-test per Bug-Discipline). These lock the shell/systemd invariants
// that have no other test surface: they read the REAL files and assert the
// fix is present, so a future edit that regresses one of them fails CI.

const ROOT = join(__dirname, '..', '..')
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf-8')

// Helper: extract a systemd INI section body ([Unit], [Service], ...). Only a
// line that is EXACTLY `[Header]` is a section boundary, so `[Unit]`/`[Service]`
// appearing inside a comment does not confuse it.
function section(content: string, name: string): string {
  let inSection = false
  const body: string[] = []
  for (const line of content.split('\n')) {
    const m = line.match(/^\[([A-Za-z]+)\]\s*$/)
    if (m) { inSection = m[1] === name; continue }
    if (inSection) body.push(line)
  }
  return body.join('\n')
}

// Strip comments so a contract assertion checks actual code, not the prose that
// explains it (e.g. a comment saying "NEVER systemctl restart").
const stripBashComments = (s: string) => s.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n')
const stripTsComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n')

describe('P1#1 — channels.sh puts the OAuth token into the tmux SERVER global env', () => {
  const sh = read('scripts/channels.sh')

  it('calls tmux set-environment -g CLAUDE_CODE_OAUTH_TOKEN', () => {
    expect(sh).toMatch(/set-environment -g CLAUDE_CODE_OAUTH_TOKEN/)
  })

  it('does so BEFORE the new-session (launch-order independent)', () => {
    const setIdx = sh.indexOf('set-environment -g CLAUDE_CODE_OAUTH_TOKEN')
    const newSessionIdx = sh.indexOf('new-session -d')
    expect(setIdx).toBeGreaterThan(-1)
    expect(newSessionIdx).toBeGreaterThan(-1)
    expect(setIdx).toBeLessThan(newSessionIdx)
  })
})

describe('P1#2 — marveen-channels.service Restart=always + StartLimit in [Unit]', () => {
  const unit = read('scripts/systemd/marveen-channels.service')

  it('Restart=always (not on-failure)', () => {
    expect(section(unit, 'Service')).toMatch(/^\s*Restart=always\s*$/m)
    expect(unit).not.toMatch(/Restart=on-failure/)
  })

  it('StartLimitIntervalSec + StartLimitBurst are in [Unit], not [Service]', () => {
    const u = section(unit, 'Unit')
    const s = section(unit, 'Service')
    expect(u).toMatch(/StartLimitIntervalSec=/)
    expect(u).toMatch(/StartLimitBurst=/)
    expect(s).not.toMatch(/StartLimitIntervalSec=/)
    expect(s).not.toMatch(/StartLimitBurst=/)
  })
})

describe('P1#3 — .bun/bin PATH on every claude (re)spawn path', () => {
  it('channels.sh exports a PATH containing .bun/bin', () => {
    expect(read('scripts/channels.sh')).toMatch(/export PATH="[^"]*\.bun\/bin/)
  })
  it('the systemd-timer watchdog respawn command exports .bun/bin', () => {
    expect(read('scripts/channel-watchdog.sh')).toMatch(/export PATH=\\?"[^"]*\.bun\/bin/)
  })
  // buildMainSessionRespawnCmd (dashboard respawn) is locked in
  // channel-deafness-recovery.test.ts; agent-process.ts startAgentProcess is
  // a runtime template -- assert its source carries the export here too.
  it('agent-process.ts sub-agent launch exports .bun/bin', () => {
    expect(read('src/web/agent-process.ts')).toMatch(/export PATH=[^\n]*\.bun\/bin/)
  })
})

describe('P1#4 — DISABLE_AUTOUPDATER=1 on the sub-agent spawn path', () => {
  // A spawned agent whose Claude Code auto-updater fires does an in-place global
  // reinstall into the shared package prefix and can corrupt the one install
  // every agent resolves through. The launch command must disable it.
  it('agent-process.ts sub-agent launch disables the auto-updater', () => {
    expect(read('src/web/agent-process.ts')).toMatch(/DISABLE_AUTOUPDATER=1/)
  })
})

describe('P2#4 — independent systemd-timer watchdog', () => {
  const sh = read('scripts/channel-watchdog.sh')
  const timer = read('scripts/systemd/channel-watchdog.timer')

  it('NEVER uses systemctl restart (would kill the shared tmux server / all agents)', () => {
    expect(stripBashComments(sh)).not.toMatch(/systemctl\s+(--user\s+)?restart/)
  })
  it('recovers via tmux respawn-pane of ONLY the channels session', () => {
    expect(sh).toMatch(/respawn-pane -k -t "\$SESSION"/)
  })
  it('runs every 5 minutes', () => {
    expect(timer).toMatch(/OnUnitActiveSec=5min/)
  })
  it('has a respawn grace and a consecutive-respawn backoff (no storm)', () => {
    expect(sh).toMatch(/GRACE_SECONDS=/)
    expect(sh).toMatch(/MAX_CONSECUTIVE=/)
  })
  it('writes the shared respawn stamp the dashboard watchdog also honors', () => {
    expect(sh).toMatch(/\.channel-last-respawn/)
    expect(read('src/web/channel-monitor.ts')).toMatch(/\.channel-last-respawn/)
  })
})

describe('P2#5 — dashboard restart routes the main agent through respawn-pane (no /remote-control, no systemctl)', () => {
  const agents = read('src/web/routes/agents.ts')
  it('the restart route delegates the main agent to hardRestartMarveenChannels', () => {
    expect(agents).toMatch(/isMainChannelsAgent\(name\)/)
    expect(agents).toMatch(/hardRestartMarveenChannels\(\)/)
  })
  it('hardRestartMarveenChannels never systemctl-restarts (respawn-pane only on Linux)', () => {
    const cm = stripTsComments(read('src/web/channel-monitor.ts'))
    // The function must not shell out to `systemctl --user restart` for the unit.
    expect(cm).not.toMatch(/systemctl[^\n]*restart/)
  })
})

describe('P2#6 — channel-watchdog.sh independent auth-dead backstop (GAP 2b)', () => {
  const sh = read('scripts/channel-watchdog.sh')

  it('still NEVER calls systemctl … restart after the restructuring', () => {
    expect(stripBashComments(sh)).not.toMatch(/systemctl\s+(--user\s+)?restart/)
  })

  it('invokes scripts/channels-auth-probe.mjs as the independent auth-dead signal', () => {
    expect(sh).toMatch(/scripts\/channels-auth-probe\.mjs/)
  })

  it('computes STALE and AUTHDEAD independently and proceeds to recovery on either', () => {
    expect(sh).toMatch(/AUTHDEAD=true/)
    expect(sh).toMatch(/\[\s*"\$STALE"\s*!=\s*true\s*\]\s*&&\s*\[\s*"\$AUTHDEAD"\s*!=\s*true\s*\]/)
  })

  it('gates AUTHDEAD on AUTH_DEAD_THRESHOLD_TICKS consecutive dead ticks (not a single probe)', () => {
    expect(sh).toMatch(/AUTH_DEAD_THRESHOLD_TICKS=/)
  })

  it('RESPAWN_CMD construction references main-agent-isolated-config.mjs (GAP 1 parity fix, 3c)', () => {
    expect(sh).toMatch(/scripts\/main-agent-isolated-config\.mjs/)
    // The isolated-mode branch must splice CLAUDE_CONFIG_DIR + the fleet token
    // (read via $(cat …) at spawn time, never embedded literally) into CFG_ENV,
    // and RESPAWN_CMD must actually use it -- a completeness gap here would
    // silently reintroduce GAP 1 on this one recovery path.
    expect(sh).toMatch(/CFG_ENV="export CLAUDE_CONFIG_DIR=/)
    expect(sh).toMatch(/CLAUDE_CODE_OAUTH_TOKEN=\\"\\\$\(cat /)
    expect(sh).toMatch(/RESPAWN_CMD=.*\$\{CFG_ENV\}/)
  })
})
