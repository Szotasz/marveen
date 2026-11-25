// CUSTPROVWATCHDOG1125: the out-of-process main respawns (channel-watchdog.sh, stuck-modal-guard.sh) carry the main
// agent's custom provider, as channels.sh's cold launch and the in-process respawns (#3121) do. The shared function
// (scripts/main-custom-provider-env.sh) is run for real in bash on a stand-in install; the two call sites are pinned in
// the source: the provider is decided before respawn-pane -k, a broken provider means no respawn, the env goes after
// the auth post-file and the --model flag is dropped with it.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO = process.cwd()
const FN = join(REPO, 'scripts', 'main-custom-provider-env.sh')
let root: string

function install(name: string, helper: string | null, withDist = true): string {
  const dir = join(root, name)
  mkdirSync(join(dir, 'scripts'), { recursive: true })
  mkdirSync(join(dir, 'dist', 'web'), { recursive: true })
  if (withDist) writeFileSync(join(dir, 'dist', 'web', 'custom-providers.js'), '')
  // the stand-in helper records its argument and answers as the real one would
  if (helper !== null) writeFileSync(join(dir, 'scripts', 'main-agent-custom-provider.mjs'), helper)
  return dir
}

function run(dir: string, cfg: string) {
  const log = join(dir, 'failures.log')
  const r = spawnSync('bash', ['-c', `set -u; . "$1"; out="$(main_custom_provider_env "$2" "$3" "$4" "$5")"; rc=$?; printf '%s|%s' "$rc" "$out"`,
    'x', FN, dir, process.execPath, cfg, log], { encoding: 'utf8' })
  const [rc, ...rest] = r.stdout.split('|')
  return { rc: Number(rc), out: rest.join('|'), log: (() => { try { return readFileSync(log, 'utf8') } catch { return '' } })() }
}

// CUSTPROVFD3-1125: the prefix on fd 3 (the helper's contract); a line on stdout must not reach it
const OK_HELPER = `import { writeSync } from 'node:fs'; process.stdout.write('noise on stdout\\n'); writeSync(process.env.MARVEEN_CONTRACT_FD === '3' ? 3 : 1, "unset CLAUDE_CODE_OAUTH_TOKEN && export ANTHROPIC_BASE_URL='https://router.example' && arg=" + JSON.stringify(process.argv[2] ?? null) + " && ")`
const NONE_HELPER = `process.exit(0)`
const BROKEN_HELPER = `process.stderr.write("main-agent-custom-provider: vault key missing\\n"); process.exit(1)`

beforeAll(() => { root = mkdtempSync(join(tmpdir(), 'custprov-')) })
afterAll(() => { rmSync(root, { recursive: true, force: true }) })

describe('main_custom_provider_env (the shared function, run in bash)', () => {
  it('a configured provider: its env on stdout, rc 0', () => {
    const r = run(install('ok', OK_HELPER), '')
    expect(r.rc).toBe(0)
    expect(r.out).toContain("export ANTHROPIC_BASE_URL='https://router.example'")
  })

  it('no provider: nothing, rc 0', () => {
    const r = run(install('none', NONE_HELPER), '')
    expect(r).toMatchObject({ rc: 0, out: '' })
  })

  it('a configured provider that cannot be used: rc != 0, the reason in the failures log', () => {
    const r = run(install('broken', BROKEN_HELPER), '')
    expect(r.rc).not.toBe(0)
    expect(r.log).toMatch(/vault key missing/)
  })

  it('no dist (a half-updated tree): nothing, rc 0, the helper is not run', () => {
    const r = run(install('nodist', BROKEN_HELPER, false), '')
    expect(r).toMatchObject({ rc: 0, out: '' })
  })

  it('the config dir is passed only when it exists (as channels.sh)', () => {
    const dir = install('cfg', OK_HELPER)
    const cfg = join(dir, 'cfgdir')
    mkdirSync(cfg)
    expect(run(dir, cfg).out).toContain(`arg=${JSON.stringify(cfg)}`)
    expect(run(dir, join(dir, 'gone')).out).toContain('arg=""')
  })
})

describe('the two out-of-process respawns use it', () => {
  it.each([
    ['channel-watchdog.sh', 'exit 0', '$CLAUDE --dangerously'],
    ['stuck-modal-guard.sh', 'return 0', '$CLAUDE_Q --dangerously'],
  ])('%s: decided before respawn-pane, no respawn when broken, env after the post-file, no --model with it', (file, stop, claude) => {
    const sh = readFileSync(join(REPO, 'scripts', file), 'utf8')
    const call = sh.indexOf('main_custom_provider_env "$INSTALL_DIR" "$NODE_BIN"')
    const kill = sh.indexOf('respawn-pane -k -t')
    expect(call).toBeGreaterThan(-1)
    expect(call).toBeLessThan(kill)
    // the broken branch stops before the kill
    const broken = sh.indexOf('custom provider configured but broken', call)
    expect(broken).toBeGreaterThan(call)
    expect(sh.indexOf(stop, broken)).toBeLessThan(kill)
    expect(sh.slice(call, kill)).toMatch(/if \[ -n "\$CUSTOM_PROVIDER_ENV" \]; then[\s\S]*?MODEL_FLAG=""/)
    expect(sh).toContain(`\${PANE_AUTH_POST}\${CUSTOM_PROVIDER_ENV}\${GROMZO_ENV}\${GROMZO_NA_STEP}${claude}`)
  })
})
