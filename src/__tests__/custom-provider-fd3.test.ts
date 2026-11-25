// CUSTPROVFD3-1125: the custom provider prefix travels on fd 3, never on stdout, on every caller (channels.sh, the
// dashboard's respawns through runCustomProviderHelper, channel-watchdog.sh and stuck-modal-guard.sh through
// main_custom_provider_env). A dist module the helper imports may log to fd 1, from a worker thread too (pino); that
// line must never become part of the launch command. Stand-in helpers write noise to stdout (main thread and a worker)
// and the prefix to fd 3; an old-contract helper writes the prefix to stdout only, and no caller takes it.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runCustomProviderHelper } from '../web/main-custom-provider-env.js'

const REPO = process.cwd()
const PREFIX = "unset CLAUDE_CODE_OAUTH_TOKEN && export ANTHROPIC_BASE_URL='https://router.example' && "
let root: string

// noise on fd 1 from the main thread AND from a worker thread (the pino-pretty shape), then the prefix on fd 3
const NOISY = `
import { Worker } from 'node:worker_threads'
import { writeSync } from 'node:fs'
process.stdout.write('{"level":30,"msg":"kept target-only settings keys"}\\n')
await new Promise((res) => { const w = new Worker('process.stdout.write("worker log line\\\\n")', { eval: true }); w.on('exit', res) })
writeSync(process.env.MARVEEN_PREFIX_FD === '3' ? 3 : 1, ${JSON.stringify(PREFIX)})
`
const OLD_CONTRACT = `process.stdout.write(${JSON.stringify(PREFIX)})`
const BROKEN = `process.stderr.write('main-agent-custom-provider: vault key missing\\n'); process.exit(1)`

function script(name: string, body: string): string {
  const p = join(root, `${name}.mjs`)
  writeFileSync(p, body)
  return p
}

beforeAll(() => { root = mkdtempSync(join(tmpdir(), 'custprov-fd3-')) })
afterAll(() => { rmSync(root, { recursive: true, force: true }) })

describe('runCustomProviderHelper (the dashboard respawns)', () => {
  it('returns exactly the fd 3 prefix while the helper logs to stdout from two threads', () => {
    expect(runCustomProviderHelper(script('noisy', NOISY), [])).toBe(PREFIX)
  })

  it('an old-contract helper (prefix on stdout only) gives nothing: stdout is never read', () => {
    expect(runCustomProviderHelper(script('old', OLD_CONTRACT), [])).toBe('')
  })

  it('a failing helper throws, with its stderr on the error', () => {
    try {
      runCustomProviderHelper(script('broken', BROKEN), [])
      expect.unreachable()
    } catch (err) {
      expect((err as { stderr?: string }).stderr).toMatch(/vault key missing/)
    }
  })
})

describe('main_custom_provider_env (the watchdog and the stuck-modal guard)', () => {
  function install(name: string, helperBody: string): string {
    const dir = join(root, name)
    mkdirSync(join(dir, 'scripts'), { recursive: true })
    mkdirSync(join(dir, 'dist', 'web'), { recursive: true })
    writeFileSync(join(dir, 'dist', 'web', 'custom-providers.js'), '')
    writeFileSync(join(dir, 'scripts', 'main-agent-custom-provider.mjs'), helperBody)
    return dir
  }
  function run(dir: string) {
    const log = join(dir, 'failures.log')
    const r = spawnSync('bash', ['-c', `set -u; . "$1"; out="$(main_custom_provider_env "$2" "$3" "" "$4")"; rc=$?; printf '%s|%s' "$rc" "$out"`,
      'x', join(REPO, 'scripts', 'main-custom-provider-env.sh'), dir, process.execPath, log], { encoding: 'utf8' })
    const i = r.stdout.indexOf('|')
    return { rc: Number(r.stdout.slice(0, i)), out: r.stdout.slice(i + 1), log: readFileSync(log, 'utf8') }
  }

  it('the prefix alone; the helper\'s stdout lands in the failures log', () => {
    const r = run(install('noisy', NOISY))
    expect(r.rc).toBe(0)
    expect(r.out).toBe(PREFIX)
    expect(r.log).toMatch(/kept target-only settings keys/)
    expect(r.log).toMatch(/worker log line/)
  })

  it('an old-contract helper gives nothing', () => {
    expect(run(install('old', OLD_CONTRACT)).out).toBe('')
  })
})

describe('channels.sh reads the helper the same way', () => {
  it('fd 3 is the prefix, stdout and stderr go to the failures log', () => {
    const sh = readFileSync(join(REPO, 'scripts', 'channels.sh'), 'utf8')
    expect(sh).toContain('"$INSTALL_DIR/scripts/main-agent-custom-provider.mjs" "$_cp_cfg_dir" 3>&1 2>>"$INSTALL_DIR/store/channels-failures.log" 1>&2)"')
  })
})
