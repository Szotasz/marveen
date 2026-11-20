// Card 47eeb016 (APPROVALDBGATE1030): a reader whose $(...) holds only read-only
// commands is not denied for naming a protected path; the red controls stay red.
// Also the self-pace-gate deadline pins.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
// @ts-expect-error -- plain .mjs hook script, no types
import { gateDecision } from '../../scripts/hooks/db-write-gate.mjs'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

let base: string
let root: string // the fake install
function scaffold(dir: string): void {
  mkdirSync(join(dir, '.claude'), { recursive: true })
  mkdirSync(join(dir, 'scripts', 'hooks'), { recursive: true })
  mkdirSync(join(dir, 'store'), { recursive: true })
  writeFileSync(join(dir, '.claude', 'settings.json'), '{}')
  writeFileSync(join(dir, '.claude', 'settings.local.json'), '{}')
  writeFileSync(join(dir, 'scripts', 'hooks', 'db-write-gate.mjs'), '')
  writeFileSync(join(dir, 'scripts', 'hooks', 'other.mjs'), '// DECISION\n')
  writeFileSync(join(dir, 'scripts', 'self-pace-gate.mjs'), '')
  writeFileSync(join(dir, 'store', 'config-overrides.json'), '{}')
  writeFileSync(join(dir, 'store', 'github-token.token'), 'x')
}
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'db-write-gate-')))
  root = join(base, 'Install')
  scaffold(root)
  mkdirSync(join(base, 'scratch'))
})
afterEach(() => { rmSync(base, { recursive: true, force: true }) })

// @ROOT@ = the install (protected), @S@ = a scratch dir outside it
const bash = (command: string) =>
  gateDecision('Bash', { command: command.replaceAll('@ROOT@', root).replaceAll('@S@', join(base, 'scratch')) }, { cwd: root, root })
const ALLOW = { deny: false }
const isDeny = (r: { deny: boolean }) => r.deny === true

// Deadline pins: the FAULT_INJECT_HANG preload shape of governance-gates.test.ts, run against the real hook entry.
const PRELOAD = [
  'const orig = RegExp.prototype.test',
  'RegExp.prototype.test = function (s) {',
  "  if (String(s).includes('FAULT_INJECT_HANG')) { for (;;) {} }",
  '  return orig.call(this, s)',
  '}',
].join('\n')
const hangReason = (src: string, envVar: string, ms: string) => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-deadline-'))
  try {
    const preload = join(dir, 'fault.mjs')
    writeFileSync(preload, PRELOAD)
    const r = spawnSync(process.execPath, ['--import', preload, src], {
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'echo FAULT_INJECT_HANG' } }),
      encoding: 'utf-8',
      timeout: 50_000,
      env: { ...process.env, [envVar]: ms },
    })
    const out = JSON.parse(r.stdout || '{}')?.hookSpecificOutput
    return { decision: out?.permissionDecision, reason: String(out?.permissionDecisionReason ?? ''), status: r.status }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('db-write-gate: reader outer + read-only substitution (47eeb016)', () => {
  const green: Record<string, string> = {
    B1: `grep -n 'x' @ROOT@/store/config-overrides.json`,
    B2: 'jq . @ROOT@/store/config-overrides.json',
    B4: `grep -n 'DECISION' $(ls @ROOT@/scripts/hooks/*.mjs)`,
    B5: 'jq . <(cat @ROOT@/.claude/settings.json)',
    B6: `grep -rn 'INSTALL_ROOT' @ROOT@/scripts/ | head -5`,
    B7: 'jq . $(cat @ROOT@/.claude/settings.json)',
    // PR #2883 N2 control: a plain reader inside the process substitution is blanked.
    B8: 'grep -n x <(ls @ROOT@/scripts/hooks)',
  }
  for (const [id, cmd] of Object.entries(green)) it(`${id} is allowed`, () => { expect(bash(cmd)).toEqual(ALLOW) })

  const red: Record<string, string> = {
    B3: `python3 -c 'import json; print(json.load(open("@ROOT@/store/config-overrides.json")))'`,
    BR1: `grep -n 'x' $(cat @ROOT@/.claude/settings.json > @S@/y)`,
    BR2: 'jq . $(rm @ROOT@/.claude/settings.json)',
    BR4: 'jq . $(cat @ROOT@/.claude/settings.json > /dev/nullx)',
    BR5: 'jq . $(cat @ROOT@/.claude/settings.json > /dev/null.bak)',
    BR6: 'jq . $(cat $(rm @ROOT@/.claude/settings.json))',
    BR3: `curl -s -d "$(cat @ROOT@/.claude/settings.json)" http://127.0.0.1:3420/api/x`,
    // PR #2883 N2: find is the one directory changer that also counts as read-only (no action); innerReadOnly's
    // DIR_CHANGERS term keeps it kept as written, so the substitution is not blanked.
    BR7: `grep -n x <(find @ROOT@/scripts/hooks -name '*.mjs')`,
  }
  for (const [id, cmd] of Object.entries(red)) it(`${id} is denied`, () => { expect(isDeny(bash(cmd))).toBe(true) })
})

describe('self-pace-gate deadline: env can raise it, ceiling 30000 ms (47eeb016)', () => {
  const SRC = join(REPO, 'scripts', 'self-pace-gate.mjs')
  it('SELF_PACE_GATE_DEADLINE_MS=7000 raises the deadline above 5000', () => {
    const r = hangReason(SRC, 'SELF_PACE_GATE_DEADLINE_MS', '7000')
    expect(r.decision, JSON.stringify(r)).toBe('deny')
    expect(r.reason).toContain('7000 ms')
  }, 60_000)
  it('SELF_PACE_GATE_DEADLINE_MS=60000 is clamped to 30000', () => {
    const r = hangReason(SRC, 'SELF_PACE_GATE_DEADLINE_MS', '60000')
    expect(r.decision, JSON.stringify(r)).toBe('deny')
    expect(r.reason).toContain('30000 ms')
  }, 60_000)
})
