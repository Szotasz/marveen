// scripts/vault-ssh.sh runs one command on a vault-registered SSH server. The REAL scripts run
// as child processes in a throwaway root (same layout trick as vault-headers-helper-ssh.test.ts):
// a stubbed dist/web/vault.js, a real SQLite file with vault_ssh_servers, and -- for the
// connecting path -- a fake `ssh` first on PATH that records what it was given.
//
// What is pinned: the key never reaches stdout/stderr, every run directory is gone afterwards
// (success, remote failure, dry), stdin reaches the remote command, the remote exit code comes
// back, and the perl locale warning is filtered from stderr while other stderr lines stay.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile, execFileSync } from 'node:child_process'
import {
  mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, readdirSync, rmSync, symlinkSync, chmodSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const Database = require('better-sqlite3')

const ROOT = mkdtempSync(join(tmpdir(), 'vault-ssh-runner-test-'))
const RUNTMP = join(ROOT, 'runtmp')
const BIN = join(ROOT, 'bin')
const LOG = join(ROOT, 'ssh-args.txt')
const STDIN_LOG = join(ROOT, 'ssh-stdin.txt')
let KEY = ''

function hasSshKeygen(): boolean {
  try { execFileSync('ssh-keygen', ['-?'], { stdio: 'ignore' }) } catch (e) {
    return (e as { code?: string }).code !== 'ENOENT'
  }
  return true
}

function run(args: string[], input = ''): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    const child = execFile('bash', [join(ROOT, 'scripts', 'vault-ssh.sh'), ...args], {
      env: { ...process.env, PATH: `${BIN}:${process.env.PATH}`, TMPDIR: RUNTMP, LANG: 'hu_HU.UTF-8', LC_ALL: 'hu_HU.UTF-8' },
    }, (error, stdout, stderr) => {
      const code = error && typeof (error as unknown as { code?: number }).code === 'number'
        ? (error as unknown as { code: number }).code : error ? 1 : 0
      resolve({ code, stdout, stderr })
    })
    child.stdin?.end(input)
  })
}

const leftovers = () => readdirSync(RUNTMP)

beforeAll(() => {
  for (const d of ['scripts', 'dist/web', 'store', 'bin', 'runtmp']) mkdirSync(join(ROOT, d), { recursive: true })
  for (const f of ['vault-ssh.sh', 'vault-ssh-key.mjs']) {
    copyFileSync(join(process.cwd(), 'scripts', f), join(ROOT, 'scripts', f))
  }
  writeFileSync(join(ROOT, 'package.json'), '{"type":"module"}\n')
  symlinkSync(join(process.cwd(), 'node_modules'), join(ROOT, 'node_modules'))

  // A real, throwaway ed25519 key, so the dry path's ssh-keygen fingerprint has something real.
  const kp = join(ROOT, 'throwaway')
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'test', '-f', kp])
  KEY = readFileSync(kp, 'utf8')
  writeFileSync(join(ROOT, 'dist', 'web', 'vault.js'),
    `export function getSecret(id) { return id === 'ssh-key-k1' ? ${JSON.stringify(KEY)} : null }\n`)

  const db = new Database(join(ROOT, 'store', 'claudeclaw.db'))
  db.exec(`CREATE TABLE vault_ssh_servers (id TEXT PRIMARY KEY, name TEXT NOT NULL, host TEXT NOT NULL,
    port INTEGER NOT NULL DEFAULT 22, username TEXT NOT NULL, ssh_key_id TEXT, description TEXT,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`)
  const ins = db.prepare('INSERT INTO vault_ssh_servers VALUES (?,?,?,?,?,?,NULL,0,0)')
  ins.run('srv-1', 'Live Server', '203.0.113.7', 2222, 'deploy', 'k1')
  ins.run('srv-nokey', 'No Key', '203.0.113.8', 22, 'deploy', null)
  ins.run('srv-lost', 'Lost Key', '203.0.113.9', 22, 'deploy', 'gone')
  db.close()

  // Fake ssh: records its argv and stdin, proves the key file exists while it runs, prints the
  // perl locale warning plus one real stderr line, and exits with the code the command asks for.
  writeFileSync(join(BIN, 'ssh'), `#!/usr/bin/env bash
printf '%s\\n' "$@" > ${JSON.stringify(LOG)}
env | grep -E '^(LANG|LC_)' >> ${JSON.stringify(LOG)}
cat > ${JSON.stringify(STDIN_LOG)}
prev=""; key=""; for a in "$@"; do [ "$prev" = "-i" ] && key="$a"; prev="$a"; done
[ -f "$key" ] && echo "KEYFILE_PRESENT" >> ${JSON.stringify(LOG)}
echo "remote stdout line"
echo "perl: warning: Setting locale failed." >&2
printf '\\tLC_ALL = "hu_HU.UTF-8",\\n' >&2
printf '\\tLANG = "hu_HU.UTF-8"\\n' >&2
echo "    are supported and installed on your system." >&2
echo "real remote error" >&2
last="\${@: -1}"
case "$last" in *exit7*) exit 7 ;; esac
exit 0
`)
  chmodSync(join(BIN, 'ssh'), 0o755)
})
afterAll(() => { rmSync(ROOT, { recursive: true, force: true }) })

describe.skipIf(!hasSshKeygen())('vault-ssh.sh', () => {
  it('connects with the vault key: args, stdin, stdout through, locale noise filtered, nothing left behind', async () => {
    const r = await run(['srv-1', 'cd ~/site && php'], '<?php echo 1;')
    expect(r.code).toBe(0)
    expect(r.stdout).toBe('remote stdout line\n')
    expect(r.stderr).toBe('real remote error\n')
    const args = readFileSync(LOG, 'utf8').split('\n')
    expect(args).toEqual(expect.arrayContaining([
      '-o', 'IdentitiesOnly=yes', 'BatchMode=yes', 'ConnectTimeout=20', '-p', '2222', 'deploy@203.0.113.7', 'cd ~/site && php',
    ]))
    expect(args).toContain('KEYFILE_PRESENT')
    expect(args.some(l => /^(LANG|LC_)/.test(l))).toBe(false)
    expect(readFileSync(STDIN_LOG, 'utf8')).toBe('<?php echo 1;')
    expect(r.stdout + r.stderr).not.toContain('PRIVATE KEY')
    expect(leftovers()).toEqual([])
  })

  it('returns the remote exit code, and still wipes', async () => {
    const r = await run(['srv-1', 'false # exit7'])
    expect(r.code).toBe(7)
    expect(leftovers()).toEqual([])
  })

  it('finds the server by name, case-insensitively', async () => {
    const r = await run(['live server', 'true'])
    expect(r.code).toBe(0)
    expect(readFileSync(LOG, 'utf8')).toContain('deploy@203.0.113.7')
  })

  it('--dry: modes, fingerprint and wipe checked, no connection, key never printed', async () => {
    writeFileSync(LOG, '')
    const r = await run(['--dry', 'srv-1', 'uptime'])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('dir:  700 (want 700)')
    expect(r.stdout).toMatch(/key:  600 \(want 600\)/)
    expect(r.stdout).toContain('private key header OK')
    expect(r.stdout).toMatch(/fingerprint: 256 SHA256:/)
    expect(r.stdout).toContain('deploy@203.0.113.7')
    expect(r.stdout).toContain('wipe: OK')
    expect(readFileSync(LOG, 'utf8')).toBe('')
    expect(r.stdout + r.stderr).not.toContain('PRIVATE KEY-----\n')
    expect(r.stdout + r.stderr).not.toContain(KEY.split('\n')[1])
    expect(leftovers()).toEqual([])
  })

  it.each([
    [['no-such-server', 'true'], 3, 'no server "no-such-server"'],
    [['srv-nokey', 'true'], 4, 'has no key assigned'],
    [['srv-lost', 'true'], 5, 'the vault has no secret for key gone'],
  ])('%j fails loudly with exit %i and leaves nothing behind', async (args, code, msg) => {
    const r = await run(args as string[])
    expect(r.code).toBe(code)
    expect(r.stderr).toContain(msg)
    expect(leftovers()).toEqual([])
  })

  it('usage error without a remote command', async () => {
    const r = await run(['srv-1'])
    expect(r.code).toBe(2)
    expect(leftovers()).toEqual([])
  })
})
