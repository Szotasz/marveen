import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// scripts/usage-collect.py: when no session token is found (isolated main-agent
// config dir, nothing in .env), the rate-limit header probe falls back to the
// fleet setup-token file. The probe entry is replaced by a stub that answers ok
// only when it got the expected token in its environment; the session-token
// reader is stubbed to find nothing, so the host's own login is never read.

const SCRIPT = join(__dirname, '..', '..', 'scripts', 'usage-collect.py')

const HARNESS = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("uc", sys.argv[1])
uc = importlib.util.module_from_spec(spec); spec.loader.exec_module(uc)
uc._read_claude_token = lambda: (None, None)
uc.SETUP_TOKEN_PATH = sys.argv[2]
uc.RATELIMIT_ENTRY = sys.argv[3]
w, err = uc._collect_claude_ratelimit_headers()
print(json.dumps({"windows": w, "err": err}))
`

const STUB = `
const ok = process.env.CLAUDE_RATELIMIT_TOKEN === 'setup-tok-123'
console.log(JSON.stringify(ok
  ? { ok: true, windows: { five_hour: { used_percent: 93 } }, argv: process.argv.length }
  : { ok: false, reason: 'wrong token' }))
`

let dir: string
let stub: string
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'usage-collect-st-'))
  stub = join(dir, 'stub.js')
  writeFileSync(stub, STUB)
})
afterAll(() => { rmSync(dir, { recursive: true, force: true }) })

function run(tokenPath: string) {
  const r = spawnSync('python3', ['-I', '-c', HARNESS, SCRIPT, tokenPath, stub], { encoding: 'utf-8' })
  if (r.status !== 0) throw new Error(r.stderr)
  return { out: JSON.parse(r.stdout), raw: r.stdout + r.stderr }
}

describe('usage-collect: setup-token fallback for the rate-limit header probe', () => {
  it('uses the setup-token file when no session token exists', () => {
    const p = join(dir, 'tok')
    writeFileSync(p, 'setup-tok-123\n')
    const { out, raw } = run(p)
    expect(out.err).toBeNull()
    expect(out.windows).toEqual({ five_hour: { used_percent: 93 } })
    expect(raw).not.toContain('setup-tok-123')
  })

  it('without the file the old behaviour stays: no token, no probe', () => {
    const { out } = run(join(dir, 'missing'))
    expect(out.windows).toBeNull()
    expect(out.err).toBe('no oauth token available')
  })

  it('an empty file counts as no token', () => {
    const p = join(dir, 'empty')
    writeFileSync(p, '  \n')
    expect(run(p).out.err).toBe('no oauth token available')
  })
})
