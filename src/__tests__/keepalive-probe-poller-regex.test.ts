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
function shellAccepts(cmd: string): boolean {
  const runtime = probeRuntimeRegex()
  try {
    const out = execFileSync('/bin/sh', ['-c', `printf '%s\\n' "$1" | grep -E "$2" | grep -E '/telegram/' | grep -v grep`, 'sh', cmd, runtime], { encoding: 'utf-8' })
    return out.trim().length > 0
  } catch {
    return false // grep exits non-zero when nothing matches
  }
}

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
})
