import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { matchesProviderPollerCmd } from '../channel-coordinator/provider-poller-match.js'

// GH #1147: scripts/channel-keepalive-probe.sh and the TypeScript detector both
// answer "is this argv a telegram poller?", and they disagreed. The shell side
// required a space or line start before the runtime token, so a poller launched
// from a full path -- what the official bun installer produces -- never matched.
// The probe then reported "no live telegram poller" and never advanced the
// keepalive; with the 45 minute liveness ceiling the reporter measured 41 fresh
// respawns in one night, each losing the main agent's conversation.
//
// These tests pin the two implementations against ONE corpus, so the next
// divergence fails here instead of on a stranger's host at 3am.

const PROBE = join(process.cwd(), 'scripts', 'channel-keepalive-probe.sh')

// The pattern the probe actually runs, read from the script rather than
// duplicated here -- a copy would drift exactly the way this test exists to stop.
function probeRuntimeRegex(): string {
  const src = readFileSync(PROBE, 'utf-8')
  const m = src.match(/^RUNTIME_TOKEN_RX='([^']+)'$/m)
  expect(m, 'RUNTIME_TOKEN_RX not found in the probe script').not.toBeNull()
  return m![1]
}

// Run the real grep the probe runs. Testing the ERE through a JS RegExp would
// prove nothing about how BSD/GNU grep reads it, which is where this bug lived.
// CHANSTATEDIR925 sibling: the probe's plugin-dir filter must come from
// CHANNEL_PROVIDER, not the literal 'telegram'. A hardcoded provider makes the
// probe a permanent no-op on every non-telegram install -- it never finds a
// poller, never advances store/.channel-keepalive, and the only producer left
// is organic inbound. Measured on a live discord install 2026-09-25: every tick
// since setup logged "no live telegram poller". That also silently arms the
// channel-watchdog STALE arm to respawn a quiet-but-healthy session.
describe('the probe matches the CONFIGURED provider, not a hardcoded telegram', () => {
  const src = readFileSync(PROBE, 'utf-8')

  it('derives CHANNEL_PROVIDER from .env with a telegram fallback', () => {
    expect(src).toMatch(/^CHANNEL_PROVIDER="\$\(grep -E '\^CHANNEL_PROVIDER='/m)
    expect(src).toContain('CHANNEL_PROVIDER="${CHANNEL_PROVIDER:-telegram}"')
  })

  it('filters candidate pollers by the resolved provider slug', () => {
    const pollerScan = src.split('\n').find((l) => l.includes('ps -axo pid,command'))
    expect(pollerScan, 'poller scan line not found').toBeDefined()
    expect(pollerScan).toContain('grep -E "$PROVIDER_SLUG_RX"')
    expect(src).toContain('PROVIDER_SLUG_RX="/${PROBE_PLUGIN_SEG}')
    expect(pollerScan).not.toContain("'/telegram/'")
  })

  // PROVIDERSLUG1015: the filter used to be `grep -F "/${CHANNEL_PROVIDER}/"`,
  // which assumes the plugin directory is named exactly after the provider.
  // True for telegram and discord, FALSE for slack: the marveen-marketplace
  // plugin installs under `.../cache/marveen-marketplace/slack-channel/<ver>/`,
  // so the probe would have been a permanent no-op on every slack install --
  // the 2026-09-25 discord no-op one layer further in. Measured on this host
  // 2026-10-15: the live poller's argv carries /slack-channel/.
  it('accepts the slack-channel plugin dir, not just /slack/', () => {
    expect(src).toContain('/slack(-channel)?')
    // Scoped to the scan LINE on purpose: the old filter is quoted in the
    // comment above the fix, and a file-wide assertion would read that as the
    // defect coming back.
    const pollerScan = src.split('\n').find((l) => l.includes('ps -axo pid,command'))
    expect(pollerScan, 'the -F literal provider dir must not come back')
      .not.toContain('grep -F')
  })
})

// The slack slug ERE the probe actually runs, read from the script rather than
// duplicated here -- a copy would drift exactly the way this test exists to stop.
function probeSlackSlugRegex(): string {
  const src = readFileSync(PROBE, 'utf-8')
  const m = src.match(/^\s*PROVIDER_SLUG_RX='([^']+)'$/m)
  expect(m, "the slack PROVIDER_SLUG_RX literal not found in the probe script").not.toBeNull()
  return m![1]
}

// Run the real greps the probe runs, for the given provider: the runtime-token
// filter and then the provider slug filter, exactly as the pipeline chains them.
function shellAccepts(cmd: string, provider: 'telegram' | 'slack' = 'telegram'): boolean {
  const runtime = probeRuntimeRegex()
  const slug = provider === 'slack'
    ? probeSlackSlugRegex()
    : `/${provider}(/|[[:space:]]|$)` // the script's default branch, spelled out
  try {
    const out = execFileSync('/bin/sh', ['-c', `printf '%s\\n' "$1" | grep -E "$2" | grep -E "$3" | grep -v grep`, 'sh', cmd, runtime, slug], { encoding: 'utf-8' })
    return out.trim().length > 0
  } catch {
    return false // grep exits non-zero when nothing matches
  }
}

// The shapes measured on this host 2026-10-15 (ps -axo pid,command rows).
const SLACK_POLLERS = [
  '83835 node /Users/u/.claude/plugins/cache/marveen-marketplace/slack-channel/0.1.0/node_modules/.bin/tsx /Users/u/.claude/plugins/cache/marveen-marketplace/slack-channel/0.1.0/server.ts',
  // a hypothetical upstream plugin installed under a plain /slack dir
  '123 /home/u/.bun/bin/bun run --cwd /home/u/.claude/plugins/cache/claude-plugins-official/slack/0.0.1 start',
]

const SLACK_NON_POLLERS = [
  // right runtime, a different provider's plugin dir
  '222 /home/u/.bun/bin/bun run --cwd /home/u/.claude/plugins/cache/x/telegram/0.0.6 start',
  // right plugin dir, wrong runtime
  '111 python3 /home/u/.claude/plugins/cache/marveen-marketplace/slack-channel/0.1.0/bot.py',
]

const TELEGRAM_POLLERS = [
  // The exact argv from the report: bun from the official installer's path.
  '3319876 /home/telep/.bun/bin/bun run --cwd /home/telep/.claude/plugins/cache/claude-plugins-official/telegram/0.0.6 --shell=bun --silent start',
  // bun on PATH, the shape the old pattern did match.
  '123 bun run --cwd /home/u/.claude/plugins/cache/claude-plugins-official/telegram/0.0.6 start',
  // node from a full path, and from an nvm path.
  '456 /usr/local/bin/node /home/u/.claude/plugins/cache/claude-plugins-official/telegram/server.js',
  '789 /home/u/.nvm/versions/node/v22.3.0/bin/node /home/u/.claude/plugins/.../telegram/server.js',
]

const NOT_POLLERS = [
  // node_modules must not read as the node runtime: the token is followed by _.
  '999 /usr/lib/node_modules/some-tool/cli.js --plugin /telegram/x',
  // right plugin dir, wrong runtime.
  '111 python3 /home/u/.claude/plugins/cache/claude-plugins-official/telegram/bot.py',
  // right runtime, no telegram plugin dir.
  '222 /home/u/.bun/bin/bun run --cwd /home/u/.claude/plugins/cache/x/discord/0.1.0 start',
]

describe('channel-keepalive-probe.sh poller detection', () => {
  it('accepts a full-path bun poller, which is the case the report was filed for', () => {
    expect(shellAccepts(TELEGRAM_POLLERS[0])).toBe(true)
  })

  it('accepts every known telegram poller shape', () => {
    for (const cmd of TELEGRAM_POLLERS) {
      expect(shellAccepts(cmd), cmd).toBe(true)
    }
  })

  it('rejects argv that is not a telegram poller', () => {
    for (const cmd of NOT_POLLERS) {
      expect(shellAccepts(cmd), cmd).toBe(false)
    }
  })

  it('does not use \\b, which BSD grep on macOS does not support reliably', () => {
    expect(probeRuntimeRegex()).not.toContain('\\b')
  })
})

describe('the shell probe and the TypeScript detector agree', () => {
  // This is the defect the reporter named: two detectors, one question, two
  // answers. The verdicts must match on every sample, in both directions.
  it('agrees on every telegram poller sample', () => {
    for (const cmd of TELEGRAM_POLLERS) {
      expect(matchesProviderPollerCmd(cmd, 'telegram'), `TS: ${cmd}`).toBe(true)
      expect(shellAccepts(cmd), `shell: ${cmd}`).toBe(true)
    }
  })

  it('agrees on every non-poller sample', () => {
    for (const cmd of NOT_POLLERS) {
      expect(matchesProviderPollerCmd(cmd, 'telegram'), `TS: ${cmd}`).toBe(false)
      expect(shellAccepts(cmd), `shell: ${cmd}`).toBe(false)
    }
  })

  it('agrees on the slack poller shapes, including the slack-channel plugin dir', () => {
    for (const cmd of SLACK_POLLERS) {
      expect(matchesProviderPollerCmd(cmd, 'slack'), `TS: ${cmd}`).toBe(true)
      expect(shellAccepts(cmd, 'slack'), `shell: ${cmd}`).toBe(true)
    }
  })

  it('agrees on what is NOT a slack poller', () => {
    for (const cmd of SLACK_NON_POLLERS) {
      expect(matchesProviderPollerCmd(cmd, 'slack'), `TS: ${cmd}`).toBe(false)
      expect(shellAccepts(cmd, 'slack'), `shell: ${cmd}`).toBe(false)
    }
  })
})
