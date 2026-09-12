import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..', '..')
const SCRIPTS = join(REPO_ROOT, 'scripts')

// CFGDIR686 structural locks -- the sibling of the RESPAWNMODEL807 describe in
// main-model-resolution-parity.test.ts, on the OTHER axis.
//
// The main agent's isolated CLAUDE_CONFIG_DIR is the fix for the 2026-07-23/27
// 401 outages: without it the agent re-authenticates from whatever refreshes the
// shared ~/.claude, that credential expires, and the main bot goes silent until
// someone runs /login by hand.
//
// PR #686 put that decision on ONE of the two shell respawn paths. The other,
// stuck-modal-guard.sh, was written in PR #264 and never had it -- so a respawn
// from there dropped the agent back onto the shared root, silently, and at the
// worst possible moment (the session is already stuck, so the owner is already
// not getting answers and has no way to tell the two causes apart).
//
// The same shape had already happened on the model axis, which is why the model
// test locks all its paths at once. This file does it for the config-dir axis:
// the point is not that these two files are correct today, but that a THIRD
// respawner cannot be added without either carrying the decision or failing here.
const SHELL_RESPAWNERS = ['channel-watchdog.sh', 'stuck-modal-guard.sh'] as const

const read = (name: string) => readFileSync(join(SCRIPTS, name), 'utf-8')

describe('every shell respawn path carries the main-agent config decision (CFGDIR686)', () => {
  it.each(SHELL_RESPAWNERS)('%s asks the one helper for the config dir', (name) => {
    const src = read(name)
    expect(src).toContain('main-agent-isolated-config.mjs')
    // The helper's modes must ALL be handled: an `explicit`/`rotated` dir
    // carries its own credentials (injecting the fleet token there would swap
    // the identity), `token` shares the isolated dir but needs a PLAN token
    // resolved via vault-resolve.mjs, and plain `isolated` needs the flotta
    // token. A script that only handles some of them is half-fixed, and the
    // half it misses is the half that authenticates.
    expect(src).toContain('explicit')
    expect(src).toContain('"token"')
    expect(src).toContain('vault-resolve.mjs')
    expect(src).toContain('CLAUDE_CODE_OAUTH_TOKEN')
  })

  it.each(SHELL_RESPAWNERS)('%s interpolates ${CFG_ENV} into the respawn command it hands tmux', (name) => {
    const src = read(name)
    // Building CFG_ENV is not the guarantee -- USING it is. A variable that is
    // computed, logged and then left out of RESPAWN_CMD looks correct in review
    // and changes nothing at runtime.
    const cmdLines = src.split('\n').filter((l) => /RESPAWN_CMD="/.test(l))
    expect(cmdLines.length).toBe(1)
    expect(cmdLines[0]).toContain('${CFG_ENV}')
  })

  it('the shell respawners are EXACTLY these two -- a third one fails here first', () => {
    // toBe, not toBeGreaterThanOrEqual: an at-least assertion is exactly what
    // let #686 look complete with one of two paths fixed. The number is the
    // point, so a new respawner must come here and be listed.
    const respawners = readdirSync(SCRIPTS)
      .filter((f) => f.endsWith('.sh'))
      .filter((f) => /respawn-pane/.test(readFileSync(join(SCRIPTS, f), 'utf-8')))
      .sort()
    expect(respawners).toEqual([...SHELL_RESPAWNERS].sort())
    expect(respawners.length).toBe(SHELL_RESPAWNERS.length)
  })

  it('POSITIVE CONTROL: the assertions can fail -- a script without the decision is detectable', () => {
    // Without this, every assertion above would also pass on a file that simply
    // contains the words for unrelated reasons. channels.sh is the LAUNCH path:
    // it carries the config decision too, but it is not a respawner, so it must
    // NOT appear in the list the previous test locks.
    const launcher = read('channels.sh')
    expect(launcher).toContain('CLAUDE_CONFIG_DIR')
    expect([...SHELL_RESPAWNERS]).not.toContain('channels.sh')
    // And a file that genuinely lacks the decision reads as lacking it:
    const unrelated = read('main-agent-isolated-config.mjs')
    expect(unrelated).not.toContain('RESPAWN_CMD')
  })
})
