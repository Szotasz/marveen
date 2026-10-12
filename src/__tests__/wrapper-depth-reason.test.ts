// HEADDEPTH924: at the wrapper depth bound a head that is still a wrapper
// counts as a send (fail-closed), so a deeply wrapped NON-send is blocked too.
// That is intended -- but the block must say WHY. Before, the copy gate told a
// `nohup x9 git status` that "the letter could not be audited", which sends
// the reader looking for a letter that does not exist (Marveen, #1522 review).
// These tests pin the reason on both gates, and that the ordinary reasons are
// unchanged everywhere else.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// @ts-expect-error -- plain .mjs hook script, no types
import { gateDecision, wrapperDepthHit, buildWrapperDepthMsg } from '../../scripts/email-send-gate.mjs'

const ROOT = join(__dirname, '..', '..')
const COPY_GATE = join(ROOT, 'scripts', 'hooks', 'outgoing-copy-gate.py')
const HARD_GATE = join(ROOT, 'scripts', 'email-send-gate.mjs')
const wrap = (n: number, cmd: string) => 'nohup '.repeat(n) + cmd
const CYR_A = String.fromCodePoint(0x430)

let dir: string
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'headdepth-')) })
afterAll(() => { rmSync(dir, { recursive: true, force: true }) })

function copyGate(cmd: string): { code: number | null; err: string } {
  const r = spawnSync('python3', [COPY_GATE], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: cmd }, hook_event_name: 'PreToolUse' }),
    encoding: 'utf-8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: ROOT, OUTGOING_COPY_GATE_RULES: join(dir, 'rules.json') },
  })
  return { code: r.status, err: r.stderr }
}

describe('copy gate: the depth-bound block names its own reason', () => {
  it('a deeply wrapped non-send is blocked with the wrapper reason, not "the letter"', () => {
    const r = copyGate(wrap(9, 'git status'))
    expect(r.code).toBe(2)
    expect(r.err).toContain('a parancs valodi fejet nem latom')
    expect(r.err).toContain('burkolo-korlatnal (8')
    expect(r.err).not.toContain('a levelet nem tudtam megvizsgalni')
  })

  // Both reasons could be named here (a visible send AND a segment past the
  // bound): the VISIBLE send wins, in either order, so a refactor cannot flip
  // the precedence silently. And the mirror: a mixed command whose visible
  // segment is NOT a send keeps the depth reason (Marveen, #1523 review).
  it('both reasons present: the VISIBLE send wins, in either segment order (Samu, #1523 review)', () => {
    for (const cmd of [`sendmail a@b.hu; ${wrap(9, 'true')}`, `${wrap(9, 'true')}; sendmail a@b.hu`]) {
      const r = copyGate(cmd)
      expect({ cmd, code: r.code }).toEqual({ cmd, code: 2 })
      expect(r.err).toContain('a levelet nem tudtam megvizsgalni')
      expect(r.err).not.toContain('valodi fejet')
    }
  })

  it('only the bound present: a visible NON-send beside it keeps the depth reason', () => {
    for (const cmd of [`git status; ${wrap(9, 'true')}`, `${wrap(9, 'true')}; git status`]) {
      const r = copyGate(cmd)
      expect({ cmd, code: r.code }).toEqual({ cmd, code: 2 })
      expect(r.err).toContain('a parancs valodi fejet nem latom')
    }
  })

  it('inside the bound the same command is not a send and passes', () => {
    expect(copyGate(wrap(8, 'git status')).code).toBe(0)
  })

  it('an ordinary unreadable send keeps the ordinary reason', () => {
    const r = copyGate('sendmail a@b.hu < "$BODY"')
    expect(r.code).toBe(2)
    expect(r.err).toContain('a levelet nem tudtam megvizsgalni')
    expect(r.err).not.toContain('valodi fejet')
  })

  it('a deeply wrapped send with a READABLE body is audited on its content, not blocked for depth', () => {
    const clean = join(dir, 'clean.txt')
    writeFileSync(clean, 'Szia, küldöm a számlát, kérlek nézd meg, köszönöm.\n')
    expect(copyGate(wrap(9, `sendmail a@b.hu < ${clean}`)).code).toBe(0)
    const homo = join(dir, 'homo.txt')
    writeFileSync(homo, `Szia, küldöm a számlát, k${CYR_A}pcsolat.\n`)
    const r = copyGate(wrap(9, `sendmail a@b.hu < ${homo}`))
    expect(r.code).toBe(2)
    expect(r.err).not.toContain('valodi fejet')
  })
})

describe('hard gate (sub-agents): the depth-bound deny has its own kind and message', () => {
  it('detects the depth bound only past it', () => {
    expect(wrapperDepthHit(wrap(9, 'git status'))).toBe(true)
    expect(wrapperDepthHit(wrap(8, 'git status'))).toBe(false)
    expect(wrapperDepthHit('sendmail a@b.hu')).toBe(false)
  })

  it('both reasons present: the visible send wins, in either order; only the bound: the depth kind', () => {
    for (const cmd of [`sendmail a@b.hu < body.txt; ${wrap(9, 'true')}`, `${wrap(9, 'true')}; sendmail a@b.hu < body.txt`]) {
      expect({ cmd, hit: wrapperDepthHit(cmd) }).toEqual({ cmd, hit: false })
      expect({ cmd, d: gateDecision('Bash', { command: cmd }) }).toEqual({ cmd, d: { deny: true } })
    }
    for (const cmd of [`git status; ${wrap(9, 'true')}`, `${wrap(9, 'true')}; git status`]) {
      expect({ cmd, d: gateDecision('Bash', { command: cmd }) }).toEqual({ cmd, d: { deny: true, kind: 'wrapper-depth' } })
    }
  })

  it('gives kind wrapper-depth past the bound, the ordinary deny otherwise', () => {
    expect(gateDecision('Bash', { command: wrap(9, 'git status') })).toEqual({ deny: true, kind: 'wrapper-depth' })
    expect(gateDecision('Bash', { command: 'sendmail a@b.hu' })).toEqual({ deny: true })
    expect(gateDecision('Bash', { command: wrap(8, 'git status') })).toEqual({ deny: false })
  })

  it('the hook process prints the wrapper message', () => {
    const r = spawnSync(process.execPath, [HARD_GATE], {
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: wrap(9, 'git status') } }),
      encoding: 'utf-8',
    })
    const out = r.stdout + r.stderr
    expect(out).toContain('a parancs valodi fejet nem latom')
    expect(out).not.toContain('Email-kuldes sub-agentkent tiltott')
    expect(buildWrapperDepthMsg()).toContain('burkolo-korlatnal (8')
  })
})
