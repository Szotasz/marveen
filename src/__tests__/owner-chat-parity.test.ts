// OWNERCHAT803 parity -- the shell (scripts/lib/owner-chat.sh) and Python
// (scripts/lib/owner_chat.py) ports of resolveOwnerChatId must agree with the
// TS original on every case owner-chat.test.ts already covers. Same cases,
// same expected answers, three implementations, one spawn each per case.
import { describe, it, expect, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveOwnerChatId } from '../owner-chat.js'

const REAL = '1268077055'
const REPO_ROOT = join(__dirname, '..', '..')
const SH_LIB = join(REPO_ROOT, 'scripts', 'lib', 'owner-chat.sh')
const PY_LIB = join(REPO_ROOT, 'scripts', 'lib')

let dirs: string[] = []

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

function runShell(envFile: string): string {
  try {
    return execFileSync('bash', ['-c', `set -e; . "${SH_LIB}"; resolve_owner_chat_id "$1" 2>/dev/null`, '_', envFile], {
      encoding: 'utf-8',
    }).trim()
  } catch {
    return ''
  }
}

function runPython(envFile: string): string {
  const code = `
import sys
sys.path.insert(0, ${JSON.stringify(PY_LIB)})
import owner_chat
r = owner_chat.resolve_owner_chat_id(${JSON.stringify(envFile)})
print(r or "")
`
  try {
    return execFileSync('python3', ['-c', code], { encoding: 'utf-8' }).trim()
  } catch {
    return ''
  }
}

function runTs(envValue: string, accessBody: unknown): string | null {
  const reader = () => {
    if (accessBody === undefined) throw new Error('ENOENT')
    return typeof accessBody === 'string' ? accessBody : JSON.stringify(accessBody)
  }
  return resolveOwnerChatId(reader, envValue)
}

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
  dirs = []
})

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
  { name: 'falls back to groups when allowFrom is empty', env: '0', access: { allowFrom: [], groups: { '-100999': {} } }, expected: '-100999' },
  { name: 'falls back to channels when allowFrom/groups are empty', env: '0', access: { allowFrom: [], channels: { C0000000001: {} } }, expected: 'C0000000001' },
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
    const out = execFileSync('python3', ['-c', code], { encoding: 'utf-8' }).trim()
    // The mutant lets "0" through as a "valid" configured id -- the opposite
    // of the fixture's expected `null`.
    expect(out).toBe('0')
  })
})
