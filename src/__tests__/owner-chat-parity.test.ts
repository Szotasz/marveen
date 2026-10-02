// OWNERCHAT803 parity -- the shell (scripts/lib/owner-chat.sh) and Python
// (scripts/lib/owner_chat.py) ports of resolveAlertOwnerChat must agree with
// the TS original. Same cases, same expected answers, three implementations,
// one spawn each per case. Every sender of the two libs is an alert, so they
// port the strict rule (exactly one DM entry, never a group/channel), not
// resolveOwnerChatId's first-entry heuristic (#1555 review round 1).
import { describe, it, expect, afterEach, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveAlertOwnerChat } from '../owner-chat.js'

const REAL = '1268077055'
const REPO_ROOT = join(__dirname, '..', '..')
const SH_LIB = join(REPO_ROOT, 'scripts', 'lib', 'owner-chat.sh')
const PY_LIB = join(REPO_ROOT, 'scripts', 'lib')

let dirs: string[] = []

// Hermetic child env: inside an agent session the inherited *_STATE_DIR and
// HOME (legacy ~/.claude/channels) point at a live access.json. The spawned
// resolvers get neither -- only a PATH (for node) and an empty HOME.
const HOME_DIR = mkdtempSync(join(tmpdir(), 'owner-chat-parity-home-'))
function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: HOME_DIR, ...extra }
}

function makeInstall(envValue: string | undefined, accessBody: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'owner-chat-parity-'))
  dirs.push(dir)
  const envLine = envValue === undefined ? '' : `ALLOWED_CHAT_ID=${envValue}\n`
  writeFileSync(join(dir, '.env'), `MAIN_AGENT_ID=marveen\n${envLine}`)
  if (accessBody !== undefined) {
    const chDir = join(dir, '.claude', 'channels', 'telegram')
    mkdirSync(chDir, { recursive: true })
    writeFileSync(join(chDir, '.env'), 'TELEGRAM_BOT_TOKEN=x\n')
    writeFileSync(join(chDir, 'access.json'), typeof accessBody === 'string' ? accessBody : JSON.stringify(accessBody))
  }
  return dir
}

function runShell(envFile: string, extraEnv: Record<string, string> = {}): string {
  try {
    return execFileSync('bash', ['-c', `set -e; . "${SH_LIB}"; resolve_owner_chat_id "$1" 2>/dev/null`, '_', envFile], {
      encoding: 'utf-8',
      env: childEnv(extraEnv),
    }).trim()
  } catch {
    return ''
  }
}

function runPython(envFile: string, extraEnv: Record<string, string> = {}): string {
  const code = `
import sys
sys.path.insert(0, ${JSON.stringify(PY_LIB)})
import owner_chat
r = owner_chat.resolve_owner_chat_id(${JSON.stringify(envFile)})
print(r or "")
`
  try {
    return execFileSync('python3', ['-c', code], { encoding: 'utf-8', env: childEnv(extraEnv) }).trim()
  } catch {
    return ''
  }
}

function runTs(envValue: string, accessBody: unknown): string | null {
  const reader = () => {
    if (accessBody === undefined) throw new Error('ENOENT')
    return typeof accessBody === 'string' ? accessBody : JSON.stringify(accessBody)
  }
  return resolveAlertOwnerChat(reader, envValue).chatId
}

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
  dirs = []
})
afterAll(() => rmSync(HOME_DIR, { recursive: true, force: true }))

interface Case {
  name: string
  env: string | undefined
  access: unknown
  expected: string | null
}

const cases: Case[] = [
  { name: '"0" placeholder, no access file', env: '0', access: undefined, expected: null },
  { name: 'empty .env value, no access file', env: '', access: undefined, expected: null },
  { name: 'whitespace .env value, no access file', env: '  ', access: undefined, expected: null },
  { name: 'real configured id wins over access.json', env: REAL, access: { allowFrom: ['999'] }, expected: REAL },
  { name: '"0" placeholder falls back to allowFrom', env: '0', access: { allowFrom: [REAL] }, expected: REAL },
  { name: 'numeric allowFrom entries, skips the "0" one', env: '0', access: { allowFrom: ['0', REAL] }, expected: REAL },
  { name: 'never falls back to a groups key', env: '0', access: { allowFrom: [], groups: { '-100999': {} } }, expected: null },
  { name: 'never falls back to a channels key', env: '0', access: { allowFrom: [], channels: { C0000000001: {} } }, expected: null },
  { name: 'two DM entries: no guess', env: '0', access: { allowFrom: [REAL, '2233445566'] }, expected: null },
  { name: 'the same DM entry twice is one entry', env: '0', access: { allowFrom: [REAL, Number(REAL)] }, expected: REAL },
  { name: 'a negative id in allowFrom is a group, not a DM entry', env: '0', access: { allowFrom: ['-100999', REAL] }, expected: REAL },
  { name: 'one DM entry plus groups: the DM entry', env: '0', access: { allowFrom: [REAL], groups: { '-100999': {} } }, expected: REAL },
  { name: 'no access file at all', env: '0', access: undefined, expected: null },
  { name: 'malformed JSON in access.json', env: '0', access: 'not json', expected: null },
  { name: 'allowFrom has only the placeholder', env: '0', access: { allowFrom: ['0'] }, expected: null },
]

describe('owner-chat parity: shell, Python, TS agree', () => {
  for (const c of cases) {
    it(c.name, () => {
      const dir = makeInstall(c.env, c.access)
      const envFile = join(dir, '.env')
      const tsResult = runTs(c.env ?? '', c.access)
      const shResult = runShell(envFile)
      const pyResult = runPython(envFile)

      expect(tsResult, 'TS').toBe(c.expected)
      expect(shResult || null, 'shell').toBe(c.expected)
      expect(pyResult || null, 'python').toBe(c.expected)
    })
  }

  // #1555 review round 1, item 1: notify.sh runs in agents' environments, and
  // a sub-agent with its own channel carries its own TELEGRAM_STATE_DIR. The
  // libs must still read the MAIN install's access.json. (The TS resolver is
  // not in this case: the dashboard's env never has the variable.)
  it('a sub-agent TELEGRAM_STATE_DIR does not redirect the shell/Python libs', () => {
    const dir = makeInstall('0', { allowFrom: [REAL] })
    const sub = join(dir, 'agents', 'helper', '.claude', 'channels', 'telegram')
    mkdirSync(sub, { recursive: true })
    writeFileSync(join(sub, '.env'), 'TELEGRAM_BOT_TOKEN=y\n')
    writeFileSync(join(sub, 'access.json'), JSON.stringify({ allowFrom: ['9988776655'] }))
    const envFile = join(dir, '.env')
    expect(runShell(envFile, { TELEGRAM_STATE_DIR: sub }), 'shell').toBe(REAL)
    expect(runPython(envFile, { TELEGRAM_STATE_DIR: sub }), 'python').toBe(REAL)
  })

  // Mutant probe (Phase 1.1 verification requirement): a deliberately broken
  // Python branch (the "0" normalization removed) must turn RED against the
  // real fixture, proving the parity test actually exercises the Python
  // implementation rather than trivially agreeing with itself.
  it('mutant probe: a Python branch without the "0" guard fails the placeholder case', () => {
    const dir = makeInstall('0', undefined)
    const mutantDir = mkdtempSync(join(tmpdir(), 'owner-chat-mutant-'))
    dirs.push(mutantDir)
    const mutantSrc = require('node:fs').readFileSync(join(PY_LIB, 'owner_chat.py'), 'utf-8')
      .replace('if not v or v == "0":\n        return None', 'if not v:\n        return None')
    writeFileSync(join(mutantDir, 'owner_chat.py'), mutantSrc)
    const code = `
import sys
sys.path.insert(0, ${JSON.stringify(mutantDir)})
import owner_chat
r = owner_chat.resolve_owner_chat_id(${JSON.stringify(join(dir, '.env'))})
print(r or "")
`
    const out = execFileSync('python3', ['-c', code], { encoding: 'utf-8', env: childEnv() }).trim()
    // The mutant lets "0" through as a "valid" configured id -- the opposite
    // of the fixture's expected `null`.
    expect(out).toBe('0')
  })
})
