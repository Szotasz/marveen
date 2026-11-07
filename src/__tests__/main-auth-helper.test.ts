// MAINAUTH1107: the helper and its callers, RUN (not read): scripts/main-agent-auth.mjs against a stub dist, and the
// exact channels.sh lines that parse its contract line. Throwaway dirs only.
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const REPO = process.cwd()
const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })
const tmp = (p = 'mauth-h-') => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d }

const STUB = `import { appendFileSync } from 'node:fs'
export const cfgKindFromHelperMode = (m) => (m === 'explicit' || m === 'rotated') ? 'own-login' : m === 'token' ? 'plan-token' : m === 'isolated' ? 'isolated' : 'shared'
export function prepareMainAuth(kind, dir) {
  console.log('a log line on stdout that must never reach the contract')
  appendFileSync(process.env.STUB_LOG, JSON.stringify({ kind, dir, logLevel: process.env.LOG_LEVEL, noMigrate: process.env.MARVEEN_VAULT_NO_KEYCHAIN_MIGRATION }) + '\\n')
  if (process.env.STUB_THROW) throw new Error('vault unreadable')
  if (process.env.STUB_VAULT) { const e = new Error('main-auth: the vault is unreadable (Error)'); e.code = 'vault-unreadable'; throw e }
  return { decision: { configured: 'api', effective: 'api', conflict: null }, result: { failed: ['unstamp'] } }
}
`

function fakeRoot(withDist: boolean): string {
  const root = tmp('mauth-root-')
  mkdirSync(join(root, 'scripts'))
  copyFileSync(join(REPO, 'scripts', 'main-agent-auth.mjs'), join(root, 'scripts', 'main-agent-auth.mjs'))
  if (withDist) {
    mkdirSync(join(root, 'dist', 'web'), { recursive: true })
    writeFileSync(join(root, 'dist', 'web', 'main-auth.js'), STUB)
  }
  return root
}
// the callers' exact redirection: contract on fd 3, the module's stdout and stderr elsewhere
const runHelper = (root: string, args: string[], env: Record<string, string> = {}) =>
  execFileSync('/bin/bash', ['-c', 'node "$1" "$2" "$3" 3>&1 1>/dev/null 2>/dev/null; echo "rc=$?"', 'bash', join(root, 'scripts', 'main-agent-auth.mjs'), ...args],
    { encoding: 'utf-8', env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...env } })

describe('scripts/main-agent-auth.mjs', () => {
  it('one contract line on fd 3, nothing the module prints; the config mode reaches the module; the vault stays quiet', () => {
    const root = fakeRoot(true)
    const log = join(root, 'stub.log')
    expect(runHelper(root, ['isolated', '/cfg/dir'], { STUB_LOG: log })).toBe('main-auth\tapi\tapi\t-\tunstamp\nrc=0\n')
    expect(JSON.parse(readFileSync(log, 'utf-8'))).toEqual({ kind: 'isolated', dir: '/cfg/dir', logLevel: 'silent', noMigrate: '1' })
  })
  it('the shared root ignores a dir argument', () => {
    const root = fakeRoot(true)
    const log = join(root, 'stub.log')
    runHelper(root, ['', '/stale/dir'], { STUB_LOG: log })
    expect(JSON.parse(readFileSync(log, 'utf-8'))).toMatchObject({ kind: 'shared', dir: null })
  })
  it('no dist, or the module throws: no contract line at all, exit 0 (the caller keeps its fallback)', () => {
    expect(runHelper(fakeRoot(false), ['', ''])).toBe('rc=0\n')
    const root = fakeRoot(true)
    expect(runHelper(root, ['', ''], { STUB_LOG: join(root, 'stub.log'), STUB_THROW: '1' })).toBe('rc=0\n')
  })
})

describe('VAULTUNREAD1107: api mode with an unreadable vault is its own contract line, never silence', () => {
  it('the helper says kept / vault-unreadable (and wrote nothing: the module threw before applying)', () => {
    const root = fakeRoot(true)
    expect(runHelper(root, ['', ''], { STUB_LOG: join(root, 'stub.log'), STUB_VAULT: '1' })).toBe('main-auth\tapi\tkept\tvault-unreadable\t-\nrc=0\n')
  })
})

describe('channels.sh: the contract-line parse, run as shipped', () => {
  const sh = readFileSync(join(REPO, 'scripts', 'channels.sh'), 'utf-8')
  const start = sh.indexOf(`  _ma_line="$(printf '%s\\n' "$_ma_line" | grep -m1 -E '^main-auth\t' || true)"`)
  const end = sh.indexOf('  unset _ma_line _ma_mode _ma_dir')
  const block = sh.slice(start, end)
  const parse = (line: string, files: Record<string, string> = {}) => {
    const inst = tmp('mauth-inst-')
    mkdirSync(join(inst, 'store'))
    for (const [f, c] of Object.entries(files)) writeFileSync(join(inst, 'store', f), c)
    const script = `INSTALL_DIR="$1"; _ma_line="$2"\nMAIN_AUTH_APPLIED=""\n${block}\nprintf '%s|%s|%s|%s|%s' "$MAIN_AUTH_APPLIED" "$MAIN_AUTH_CONFIGURED" "$MAIN_AUTH_EFFECTIVE" "$MAIN_AUTH_CONFLICT" "$MAIN_AUTH_FAILED"`
    return execFileSync('/bin/bash', ['-c', script, 'bash', inst, line], { encoding: 'utf-8' })
  }
  it('the block is found', () => {
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
  })
  it('a full line among log noise: every field, applied', () => {
    expect(parse('some noise\nmain-auth\tapi\tapi\t-\t-\nmore')).toBe('1|api|api|-|-')
  })
  it('a failed credential-file write: not applied, so the bash writer runs', () => {
    expect(parse('main-auth\tapi\tsubscription\tno-key\tpost')).toBe('|api|subscription|no-key|post')
    expect(parse('main-auth\tshared\tsubscription\t-\tstamp,pane-auth')).toBe('|shared|subscription|-|stamp,pane-auth')
  })
  it('an unstamp failure alone still counts as applied ("unstamp" is not "pane-auth" or "post")', () => {
    expect(parse('main-auth\tshared\tsubscription\t-\tunstamp')).toBe('1|shared|subscription|-|unstamp')
  })
  it('vault unreadable with a previous launch: its files are kept, the effective mode read from its record', () => {
    expect(parse('main-auth\tapi\tkept\tvault-unreadable\t-', {
      '.channels-pane-auth': "export ANTHROPIC_API_KEY='x'\n",
      '.main-auth-launched': JSON.stringify({ configured: 'api', effective: 'api', conflict: null }, null, 2),
    })).toBe('1|api|api|vault-unreadable|-')
  })
  it('vault unreadable and no previous files: not applied (the subscription rule), still configured api (the notice fires)', () => {
    expect(parse('main-auth\tapi\tkept\tvault-unreadable\t-')).toBe('|api||vault-unreadable|-')
  })
  it('no contract line: nothing set', () => {
    expect(parse('just a log line')).toBe('||||')
  })
})

describe('the owner notice matches whole failure names', () => {
  const lib = join(REPO, 'scripts', 'lib', 'auth-key-mode.sh')
  const notice = (c: string, f: string) => execFileSync('/bin/bash', ['-c', '. "$1" && main_auth_problem_notice "$2" "$3" en', 'bash', lib, c, f], { encoding: 'utf-8' }).trim()
  it('"unstamp" alone is no notice; "stamp" and the file failures are', () => {
    expect(notice('-', 'unstamp')).toBe('')
    expect(notice('-', 'unstamp,stamp')).toContain('approval could not be written')
    expect(notice('-', 'post')).toContain('credential files')
  })
  it('the unreadable vault has its own notice: what it runs on now, and what to do', () => {
    const m = notice('vault-unreadable', '-')
    expect(m).toContain('vault, where the key is stored, could not be read')
    expect(m).toContain("previous start's authentication")
    // Dani 72343: it may run exactly as set (a previous api start), so it never says "does not run as set"
    expect(m).toContain('could not read the key again')
    expect(m).not.toContain('does not run as set')
    const hu = execFileSync('/bin/bash', ['-c', '. "$1" && main_auth_problem_notice vault-unreadable - hu', 'bash', lib], { encoding: 'utf-8' })
    expect(hu).toContain('a kulcsot nem tudta újra kiolvasni')
    expect(hu).not.toContain('nem így fut')
  })
})

describe('the operator vault route refuses agent API keys', () => {
  it('before any write', () => {
    const src = readFileSync(join(REPO, 'src', 'web', 'routes', 'operator.ts'), 'utf-8')
    const refuse = src.indexOf('if (/^agent-[^/]+-api-key$/.test(id)) {')
    expect(refuse).toBeGreaterThan(-1)
    expect(refuse).toBeLessThan(src.indexOf('setSecret(id, finalLabel, value)'))
  })
})
