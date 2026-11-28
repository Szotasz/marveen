import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

// MARVEEN_NO_KEYCHAIN_READS=1: the unattended background paths never call /usr/bin/security (a locked login
// Keychain pops a GUI password dialog on the Mac). The child_process call is a mock here: no test touches a real
// Keychain.

const tmpRoot = vi.hoisted(() => {
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs')
  const { tmpdir } = require('node:os') as typeof import('node:os')
  const { join } = require('node:path') as typeof import('node:path')
  const root = mkdtempSync(join(tmpdir(), 'nokeychain-test-'))
  process.env.CLAUDECLAW_ENV_DIR = root
  return root
})

const cp = vi.hoisted(() => ({ calls: [] as string[][] }))
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execFileSync: (_bin: string, args: string[]) => {
    cp.calls.push(args)
    return 'SECRET-JSON-VALUE\n'
  },
}))

const infoLines = vi.hoisted(() => [] as string[])
vi.mock('../logger.js', () => ({
  logger: {
    info: (m: string) => { infoLines.push(String(m)) },
    warn: () => {}, error: () => {}, debug: () => {},
  },
}))

const envPath = join(tmpRoot, '.env')
const realPlatform = process.platform

function setPlatform(p: string) {
  Object.defineProperty(process, 'platform', { value: p, configurable: true })
}

async function fresh() {
  vi.resetModules()
  return await import('../web/claude-credentials.js')
}

beforeEach(() => {
  cp.calls.length = 0
  infoLines.length = 0
  delete process.env.MARVEEN_NO_KEYCHAIN_READS
  rmSync(envPath, { force: true })
  setPlatform('darwin')
})
afterEach(() => setPlatform(realPlatform))

describe('readClaudeCodeOauthJson (worker) honours MARVEEN_NO_KEYCHAIN_READS', () => {
  it('default: calls security', async () => {
    const { readClaudeCodeOauthJson } = await fresh()
    expect(readClaudeCodeOauthJson()).toBe('SECRET-JSON-VALUE')
    expect(cp.calls.length).toBe(1)
  })

  it('process env =1: no security call, returns null, one INFO line without the secret', async () => {
    process.env.MARVEEN_NO_KEYCHAIN_READS = '1'
    const { readClaudeCodeOauthJson } = await fresh()
    expect(readClaudeCodeOauthJson()).toBeNull()
    expect(readClaudeCodeOauthJson()).toBeNull()
    expect(cp.calls.length).toBe(0)
    expect(infoLines.length).toBe(1)
    expect(infoLines[0]).toContain('MARVEEN_NO_KEYCHAIN_READS')
    expect(infoLines[0]).not.toContain('SECRET')
  })

  it('.env =1 alone is enough (dashboard case: .env is never exported to process.env)', async () => {
    writeFileSync(envPath, 'BOT_NAME=Test\nMARVEEN_NO_KEYCHAIN_READS=1\n')
    const { readClaudeCodeOauthJson } = await fresh()
    expect(readClaudeCodeOauthJson()).toBeNull()
    expect(cp.calls.length).toBe(0)
  })

  it('other values (0, empty, unset) keep the Keychain read', async () => {
    for (const v of ['0', '', 'no']) {
      process.env.MARVEEN_NO_KEYCHAIN_READS = v
      cp.calls.length = 0
      const { readClaudeCodeOauthJson } = await fresh()
      expect(readClaudeCodeOauthJson()).toBe('SECRET-JSON-VALUE')
      expect(cp.calls.length).toBe(1)
    }
  })

  it('process env wins over .env', async () => {
    writeFileSync(envPath, 'MARVEEN_NO_KEYCHAIN_READS=1\n')
    process.env.MARVEEN_NO_KEYCHAIN_READS = '0'
    const { readClaudeCodeOauthJson } = await fresh()
    expect(readClaudeCodeOauthJson()).toBe('SECRET-JSON-VALUE')
  })
})

describe('source contracts for the other background callers', () => {
  const root = join(__dirname, '..', '..')
  it('heartbeat.ts guards its security call with skipKeychainRead before execFileSync', () => {
    const src = readFileSync(join(root, 'src/heartbeat.ts'), 'utf-8')
    const fn = src.slice(src.indexOf('function readClaudeCodeOauthJson'))
    expect(fn.indexOf("skipKeychainRead('heartbeat credentials')")).toBeGreaterThan(0)
    expect(fn.indexOf("skipKeychainRead('heartbeat credentials')")).toBeLessThan(fn.indexOf("'/usr/bin/security'"))
  })

  it('agent-worker.ts skips the worker Keychain entry delete too', () => {
    const src = readFileSync(join(root, 'src/web/agent-worker.ts'), 'utf-8')
    expect(src).toMatch(/process\.platform === 'darwin' && !keychainReadsDisabled\(\)\) clearWorkerKeychainEntry/)
  })
})

describe('headless Chrome (pdf-render) never touches the login Keychain', () => {
  it('chromeArgs carries --use-mock-keychain and --password-store=basic', () => {
    const src = readFileSync(join(__dirname, '..', 'web', 'pdf-render.ts'), 'utf-8')
    const fn = src.slice(src.indexOf('export function chromeArgs'))
    expect(fn.slice(0, fn.indexOf('\n}'))).toContain("'--use-mock-keychain', '--password-store=basic'")
  })
})

describe('scripts/usage-collect.py honours MARVEEN_NO_KEYCHAIN_READS', () => {
  const script = join(__dirname, '..', '..', 'scripts', 'usage-collect.py')
  // Loads the module with sys.platform=darwin and subprocess.run replaced by a recorder; prints
  // "<token-or-None>|<number of security calls>".
  const py = `
import importlib.util, sys, subprocess
spec = importlib.util.spec_from_file_location("uc", ${JSON.stringify(script)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
m.ENV_PATH = sys.argv[1]
calls = []
class P: returncode = 0; stdout = '{"claudeAiOauth": {"accessToken": "tok"}}'
def fake(*a, **k): calls.append(a); return P()
subprocess.run = fake
sys.platform = "darwin"
print(str(m._read_keychain_token()) + "|" + str(len(calls)))
`
  function run(env: Record<string, string>) {
    const e: Record<string, string> = { PATH: process.env.PATH ?? '', ...env }
    return spawnSync('python3', ['-I', '-c', py, envPath], { encoding: 'utf-8', env: e })
  }

  it('default: calls security', () => {
    const r = run({})
    expect(r.stdout.trim()).toBe('tok|1')
  })
  it('env =1: no call, INFO on stderr, no secret', () => {
    const r = run({ MARVEEN_NO_KEYCHAIN_READS: '1' })
    expect(r.stdout.trim()).toBe('None|0')
    expect(r.stderr).toContain('INFO: MARVEEN_NO_KEYCHAIN_READS=1')
  })
  it('.env =1: no call', () => {
    writeFileSync(envPath, 'MARVEEN_NO_KEYCHAIN_READS=1\n')
    const r = run({})
    expect(r.stdout.trim()).toBe('None|0')
  })
})
