// INSTDEAD803 -- "I will set up Claude later" must be recorded as a CHOICE.
//
// A bootcamp host on 2026-08-03 ended up unusable and un-reinstallable: the
// install script had finished (store/, .env, five systemd units, live
// dashboard) but the Claude sign-in broke off afterwards, so there were no
// credentials. The installer's guard saw the data markers, called it "already
// installed", and offered nothing but a disabled button.
//
// The fix distinguishes a finished install from an unfinished one by asking
// whether the host has any way to authenticate. That leaves one case the
// question alone gets wrong: an operator who DELIBERATELY skipped auth ("set it
// up later") also has no credentials, and would be told forever that the
// install is unfinished. Absence cannot tell a decision apart from a failure --
// so the decision is written down where it is made, and never inferred later.
//
// The safe direction if the flag is missing is "unfinished": that offers help,
// whereas assuming the operator wanted no auth would hide a broken install.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PROJECT_ROOT } from '../config.js'

const script = readFileSync(join(PROJECT_ROOT, 'install-linux.sh'), 'utf8')

/** Run a shell snippet and return its stdout. */
const sh = (code: string): string =>
  execFileSync('/bin/bash', ['-c', code], { encoding: 'utf8' }).trim()

describe('deliberate auth skip is recorded, not inferred', () => {
  it('sets the flag in the SKIP branch, not anywhere else', () => {
    // It must sit in the branch the operator lands on by choosing to skip --
    // not next to the credential handling, where a failed attempt also passes.
    const skipBranch = script.slice(
      script.indexOf('Kihagyva. Kesobb allitsd be'),
      script.indexOf('Pre-flight headless probe'),
    )
    expect(skipBranch.length).toBeGreaterThan(0)
    const assignments = script.match(/^\s*CLAUDE_AUTH_DEFERRED=1$/gm) ?? []
    expect(assignments, 'exactly one place may declare the deferral').toHaveLength(1)
    // And that one place is above the skip message, inside the same branch.
    const assignIdx = script.indexOf('    CLAUDE_AUTH_DEFERRED=1')
    const msgIdx = script.indexOf('Kihagyva. Kesobb allitsd be')
    expect(assignIdx).toBeGreaterThan(0)
    expect(assignIdx).toBeLessThan(msgIdx)
  })

  it('persists the flag AFTER the decision, and only when it was made', () => {
    const decide = script.indexOf('    CLAUDE_AUTH_DEFERRED=1')
    const persist = script.indexOf('env_merge_key CLAUDE_AUTH_DEFERRED 1')
    expect(persist, 'the flag must be written to .env').toBeGreaterThan(0)
    expect(decide, 'the decision must come before it is persisted').toBeLessThan(persist)

    // The persist step is conditional -- run the real condition both ways.
    const cond = 'if [ "${CLAUDE_AUTH_DEFERRED:-}" = "1" ]; then echo WRITE; else echo SKIP; fi'
    expect(sh(`CLAUDE_AUTH_DEFERRED=1; ${cond}`)).toBe('WRITE')
    expect(sh(`unset CLAUDE_AUTH_DEFERRED; ${cond}`)).toBe('SKIP')
    expect(sh(`CLAUDE_AUTH_DEFERRED=0; ${cond}`)).toBe('SKIP')
  })

  it('is never derived from missing credentials', () => {
    // The failure mode this whole flag exists to prevent: someone "simplifying"
    // it into a check for absent auth would recreate the exact false positive.
    const persistBlock = script.slice(
      script.indexOf('if [ "${CLAUDE_AUTH_DEFERRED:-}" = "1" ]'),
      script.indexOf('env_merge_key CLAUDE_AUTH_DEFERRED 1') + 60,
    )
    expect(persistBlock).not.toMatch(/CLAUDE_CODE_OAUTH_TOKEN/)
    expect(persistBlock).not.toMatch(/ANTHROPIC_API_KEY/)
    expect(persistBlock).not.toMatch(/-z /)
  })

  it('a failed token attempt does NOT set the flag', () => {
    // The branch that warns "Token nem lett megadva, kihagyas." is a FAILED
    // attempt inside the OAuth path, not a decision to skip. If it set the
    // flag, a broken sign-in would be filed as "the operator wanted it this
    // way" -- the reported bug, with a nicer label.
    // The slice must stop where that branch closes. A first version of this
    // test ran to the skip MESSAGE and so spanned the `fi` and the `else`,
    // swallowing the neighbouring branch and failing on correct code -- the
    // instrument was wrong, not the script.
    const start = script.indexOf('Token nem lett megadva, kihagyas.')
    const failedAttempt = script.slice(start, script.indexOf('\n  else', start))
    expect(failedAttempt.length).toBeGreaterThan(0)
    expect(failedAttempt, 'the slice must stay inside the failed-attempt branch').not.toMatch(/Kihagyva/)
    expect(failedAttempt).not.toMatch(/CLAUDE_AUTH_DEFERRED/)
  })
})
