// The helper's default dashboard address is a literal loopback IP, not "localhost": where localhost
// resolves to ::1 first and the dashboard listens on IPv4 only, urllib waited out its 30 s timeout on
// every call. The module is copied into a scratch install so its .env is the test's own.
import { describe, it, expect, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const root = mkdtempSync(join(tmpdir(), 'marveen-api-base-test-'))
mkdirSync(join(root, 'scripts', 'lib'), { recursive: true })
const MOD = join(root, 'scripts', 'lib', 'marveen_api.py')
copyFileSync(join(REPO, 'scripts', 'lib', 'marveen_api.py'), MOD)

afterAll(() => rmSync(root, { recursive: true, force: true }))

function apiBase(envFile: string | null, env: Record<string, string> = {}): string {
  if (envFile === null) rmSync(join(root, '.env'), { force: true })
  else writeFileSync(join(root, '.env'), envFile, 'utf-8')
  const code = 'import importlib.util,sys\n'
    + 'spec=importlib.util.spec_from_file_location("m",sys.argv[1]);m=importlib.util.module_from_spec(spec)\n'
    + 'spec.loader.exec_module(m);print(m.api_base())'
  return execFileSync('python3', ['-I', '-c', code, MOD], { env: { PATH: process.env.PATH!, ...env } }).toString().trim()
}

describe('marveen_api.api_base default', () => {
  it('no .env, no environment: http://127.0.0.1:3420, never localhost', () => {
    expect(apiBase(null)).toBe('http://127.0.0.1:3420')
  })

  it('the .env WEB_PORT and the environment port keep working', () => {
    expect(apiBase('WEB_PORT=4555\n')).toBe('http://127.0.0.1:4555')
    expect(apiBase(null, { MARVEEN_WEB_PORT: '4666' })).toBe('http://127.0.0.1:4666')
  })

  it('WEB_HOST 0.0.0.0 or 127.0.0.1 in .env: still 127.0.0.1', () => {
    expect(apiBase('WEB_HOST=0.0.0.0\n')).toBe('http://127.0.0.1:3420')
    expect(apiBase('WEB_HOST=127.0.0.1\n')).toBe('http://127.0.0.1:3420')
  })

  it('an install that binds ::1 only gets [::1]', () => {
    expect(apiBase('WEB_HOST=::1\nWEB_PORT=3999\n')).toBe('http://[::1]:3999')
  })

  it('an explicit MARVEEN_API_BASE still wins, unchanged', () => {
    expect(apiBase('WEB_HOST=::1\n', { MARVEEN_API_BASE: 'http://localhost:3420/' })).toBe('http://localhost:3420')
  })
})
