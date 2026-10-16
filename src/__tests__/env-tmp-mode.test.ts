import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { writeFileSync, readFileSync, mkdtempSync, rmSync, chmodSync, statSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { syncTeamsDisplayName } from '../web/agent-process.js'

// ENVTMPMODE925: two .env writers that left a secrets file readable by every
// local user for a while -- the follow-up of ENVPERM925 (#1594).

const SANDBOX = mkdtempSync(join(tmpdir(), 'env-tmp-mode-'))
const modeOf = (p: string) => statSync(p).mode & 0o777

afterAll(() => { rmSync(SANDBOX, { recursive: true, force: true }) })

describe('syncTeamsDisplayName (teams channel .env)', () => {
  it('a teams .env it creates is 0600', () => {
    const envPath = join(SANDBOX, 'teams-new.env')
    expect(existsSync(envPath)).toBe(false)
    expect(syncTeamsDisplayName(envPath, 'Samu')).toBe(true)
    expect(modeOf(envPath)).toBe(0o600)
    expect(readFileSync(envPath, 'utf-8')).toBe('TEAMS_BOT_DISPLAY_NAME=Samu\n')
  })

  it('an existing .env keeps its own mode, and the name is updated in place', () => {
    const envPath = join(SANDBOX, 'teams-existing.env')
    writeFileSync(envPath, 'TEAMS_APP_PASSWORD=s3cret\nTEAMS_BOT_DISPLAY_NAME=Old\n')
    chmodSync(envPath, 0o640)
    expect(syncTeamsDisplayName(envPath, 'New')).toBe(true)
    expect(modeOf(envPath)).toBe(0o640)
    expect(readFileSync(envPath, 'utf-8')).toBe('TEAMS_APP_PASSWORD=s3cret\nTEAMS_BOT_DISPLAY_NAME=New\n')
  })

  it('no drift, no write; no display name, no write', () => {
    const envPath = join(SANDBOX, 'teams-same.env')
    writeFileSync(envPath, 'TEAMS_BOT_DISPLAY_NAME=Same\n')
    expect(syncTeamsDisplayName(envPath, 'Same')).toBe(false)
    expect(syncTeamsDisplayName(join(SANDBOX, 'teams-none.env'), '')).toBe(false)
    expect(existsSync(join(SANDBOX, 'teams-none.env'))).toBe(false)
  })
})

// The installers' env_merge_key writes the WHOLE .env into a tmp file and then
// renames it over .env. The window that matters is the tmp BEFORE the mv, so the
// real function is run with `mv` shadowed by a recorder that stats its source.
describe.each(['install-linux.sh', 'install-macos.sh'])('%s env_merge_key', (script) => {
  let fn = ''
  beforeAll(() => {
    const src = readFileSync(join(__dirname, '..', '..', script), 'utf-8')
    const m = src.match(/^env_merge_key\(\) \{\n[\s\S]*?\n\}\n/m)
    expect(m, `env_merge_key() not found in ${script}`).not.toBeNull()
    fn = m![0]
  })

  const run = (dir: string) => execFileSync('bash', ['-c', [
    'set -e',
    'umask 022',
    `INSTALL_DIR='${dir}'`,
    fn,
    `mv() { perl -e 'printf "%o\\n", (stat $ARGV[0])[2] & 07777' "$1" > '${dir}/tmp-mode'; command mv "$@"; }`,
    'env_merge_key NEW_KEY new-value',
  ].join('\n')], { encoding: 'utf-8' })

  it('the tmp holding the full .env is 0600 before the mv, and the merge is right', () => {
    const dir = mkdtempSync(join(SANDBOX, 'inst-'))
    writeFileSync(join(dir, '.env'), 'TELEGRAM_BOT_TOKEN=123:abc\nNEW_KEY=old\n')
    chmodSync(join(dir, '.env'), 0o600)
    run(dir)
    expect(readFileSync(join(dir, 'tmp-mode'), 'utf-8').trim()).toBe('600')
    expect(modeOf(join(dir, '.env'))).toBe(0o600)
    expect(readFileSync(join(dir, '.env'), 'utf-8')).toBe('TELEGRAM_BOT_TOKEN=123:abc\nNEW_KEY=new-value\n')
  })

  it('a leftover tmp of the same name does not pass its 0644 on', () => {
    const dir = mkdtempSync(join(SANDBOX, 'inst-'))
    writeFileSync(join(dir, '.env'), 'A=1\n')
    // $$ inside `bash -c` is that shell's pid, unknown here -- so pre-create the
    // leftover from inside the same shell, right before the call.
    execFileSync('bash', ['-c', [
      'umask 022',
      `INSTALL_DIR='${dir}'`,
      fn,
      `mv() { perl -e 'printf "%o\\n", (stat $ARGV[0])[2] & 07777' "$1" > '${dir}/tmp-mode'; command mv "$@"; }`,
      `printf 'stale\\n' > "${dir}/.env.tmp.$$"; chmod 644 "${dir}/.env.tmp.$$"`,
      'env_merge_key B 2',
    ].join('\n')], { encoding: 'utf-8' })
    expect(readFileSync(join(dir, 'tmp-mode'), 'utf-8').trim()).toBe('600')
    expect(readFileSync(join(dir, '.env'), 'utf-8')).toBe('A=1\nB=2\n')
  })
})
