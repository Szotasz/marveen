import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { resolvePreCheckPath } from '../web/schedule-runner.js'
import { PROJECT_ROOT } from '../config.js'

// PRECHECKSZURO1004: the memoria-heartbeat round fires every 15 minutes in the
// main agent's session, and most rounds have nothing to review (measured on one
// install over 72 h: 131 of 232 rounds had no main-session activity in their
// window, and all 131 ended "quiet"). The preCheck answers "did anything happen
// since the last stamp?" first, so the model turn only runs when it can find
// something. These tests pin the wiring to the seed and the script to the
// contract the seed relies on.

const ROOT = join(__dirname, '..', '..')
const TASK_DIR = join(ROOT, 'scheduled-tasks', 'memoria-heartbeat')
const WRAPPER = join(ROOT, 'scripts', 'prechecks', 'memoria-heartbeat-precheck.sh')
const LOGIC = join(ROOT, 'scripts', 'prechecks', 'memoria_heartbeat_precheck.py')

describe('memoria-heartbeat preCheck seed', () => {
  it('the seed gates the round on the shipped preCheck, through the placeholder the seeder resolves', () => {
    const cfg = JSON.parse(readFileSync(join(TASK_DIR, 'task-config.json'), 'utf-8'))
    expect(cfg.preCheck).toBe('{{PROJECT_ROOT}}/scripts/prechecks/memoria-heartbeat-precheck.sh')
    expect(resolvePreCheckPath('memoria-heartbeat', cfg.preCheck)).toBe(join(PROJECT_ROOT, 'scripts', 'prechecks', 'memoria-heartbeat-precheck.sh'))
    expect(existsSync(WRAPPER)).toBe(true)
    expect(existsSync(LOGIC)).toBe(true)
  })

  it('the wrapper is executable and always exits 0 (fail open: a broken check runs the round)', () => {
    expect(statSync(WRAPPER).mode & 0o111).not.toBe(0)
    const sh = readFileSync(WRAPPER, 'utf-8')
    expect(sh).toMatch(/memoria_heartbeat_precheck\.py" 2>\/dev\/null \|\| true/)
    expect(sh.trim().split('\n').pop()).toBe('exit 0')
  })

  it('the check reads the stamp the shipped round writes', () => {
    // The round's SKILL.md writes {{INSTALL_DIR}}/store/memoria-heartbeat-state.json;
    // the check reads <install root>/store/memoria-heartbeat-state.json. If the two
    // drift apart the check fails open forever and silently saves nothing.
    const skill = readFileSync(join(TASK_DIR, 'SKILL.md'), 'utf-8')
    expect(skill).toContain("{{INSTALL_DIR}}/store/memoria-heartbeat-state.json")
    const py = readFileSync(LOGIC, 'utf-8')
    expect(py).toContain("f'{ROOT}/store/memoria-heartbeat-state.json'")
    expect(py).toMatch(/os\.path\.dirname\(os\.path\.dirname\(os\.path\.dirname\(os\.path\.abspath\(__file__\)\)\)\)/)
  })

  it('SKIP is printed only in live mode (shadow never skips)', () => {
    const py = readFileSync(LOGIC, 'utf-8')
    expect(py).toMatch(/skipped = would_skip and mode == 'live'/)
    expect((py.match(/print\('SKIP'\)/g) ?? []).length).toBe(1)
  })

  it('the default mode is a deliberate release decision, pinned here', () => {
    const py = readFileSync(LOGIC, 'utf-8')
    expect(py).toMatch(/^DEFAULT_MODE = 'live'$/m)
    expect(py).toMatch(/except FileNotFoundError:\n\s+return DEFAULT_MODE/)
    // a present but garbled mode file is a mistyped choice: it never turns skipping on
    expect(py).toMatch(/return mode if mode in \('shadow', 'live'\) else 'shadow'/)
  })

  it('names no install, user or agent of ours (the distribution hardcode rule)', () => {
    for (const f of [WRAPPER, LOGIC, join(TASK_DIR, 'task-config.json')]) {
      const src = readFileSync(f, 'utf-8')
      expect(src, f).not.toMatch(/\/Users\/|\/home\/|marvin|ClaudeClaw|szabolcs/i)
    }
  })
})
