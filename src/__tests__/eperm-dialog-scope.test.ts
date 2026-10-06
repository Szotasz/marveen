import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// DIALOGSCOPE922 (2026-09-22, upstream review on #1460): the EPERM watcher's
// dialog-answering block was NOT scoped to the /tmp fallback. The EPERM branch
// returns early, so on a normal start (no EPERM) control fell through to the
// dialogs, and they ran on every tick of every channel-having sub-agent launch.
// One branch answers the "Bypass Permissions mode" prompt with a keystroke:
// acceptable on a directory we just minted for a relaunch, not acceptable as a
// blanket behaviour on every normal start. The comment above it claimed the
// narrow scope the code did not keep -- which is the part that makes this a
// silent class of bug rather than a visible one.
//
// Source-level assertion, in the style of pane-first-run-gate.test.ts: the file
// cannot be imported without a live dashboard, so the control flow is measured
// in the shipped text.

const SRC = readFileSync(join(__dirname, '..', 'web', 'agent-process.ts'), 'utf-8')

function epermWatcherBody(): string {
  const start = SRC.indexOf('const checkEperm = () => {')
  expect(start, 'checkEperm not found in agent-process.ts').toBeGreaterThan(-1)
  const end = SRC.indexOf('setTimeout(checkEperm, 1500)', start)
  expect(end, 'checkEperm scheduling tail not found').toBeGreaterThan(start)
  return SRC.slice(start, end)
}

describe('EPERM watcher dialog scope', () => {
  it('answers startup dialogs only after an EPERM relaunch', () => {
    const body = epermWatcherBody()

    const bypass = body.indexOf('Bypass Permissions mode')
    expect(bypass, 'the Bypass Permissions branch is gone -- did the block move?').toBeGreaterThan(-1)

    // The guard must OPEN before the dialogs and still be open at the Bypass branch.
    const guard = body.indexOf('if (epermRestarted) {')
    expect(guard, 'dialog block is not guarded by epermRestarted').toBeGreaterThan(-1)
    expect(guard).toBeLessThan(bypass)

    // Every dialog branch lives inside that guard: no send-keys before it.
    const beforeGuard = body.slice(0, guard)
    expect(beforeGuard).not.toContain("'send-keys'")
  })

  it('still relaunches once from a /tmp dir on EPERM', () => {
    const body = epermWatcherBody()
    expect(body).toContain('mkdtempSync')
    expect(body).toContain('epermRestarted = true')
    expect(body).toContain('buildLaunchCmd(fallbackCwd)')
  })
})
