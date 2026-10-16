import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

import { readConfiguredMainModel } from '../web/channel-monitor.js'
import { DISTRIBUTION_DEFAULT_AGENT_MODEL, DISTRIBUTION_DEFAULT_FALLBACK_MODEL } from '../config-registry.js'
import { CLI_VERSION_OVERRIDE_ENV } from '../web/claude-cli-version.js'
import ts from 'typescript'

// The main agent's model is resolved by TWO independent implementations:
//
//   LAUNCH   scripts/channels.sh   resolve_main_model()      (shell)
//   RESPAWN  src/web/channel-monitor.ts readConfiguredMainModel()  (TS)
//
// They must agree. When they disagree the failure is SILENT in the worst way:
// the agent boots on the model the operator chose and comes back on a DIFFERENT
// one after the nightly restart / a recovery resume / a hard respawn. Nothing
// throws, no probe goes red -- the agent simply answers as another model.
//
// That is not hypothetical. Until 2026-08-03 readConfiguredMainModel() read
// ONLY .claude/settings.json, while its own comment claimed to mirror
// channels.sh. channels.sh had honoured MAIN_AGENT_MODEL from .env since
// 2026-07-29 (that route exists because settings.json is TRACKED: a per-install
// model written there is a permanent local diff that blocks the update
// preflight's clean-tree check and is reverted by the next update). So any
// install using the supported .env route drifted on every respawn.
//
// The defect was MASKED on the install where it was found: settings.json
// happened to be dirty with the same value the .env carried, so both paths
// agreed by accident. Restoring a clean tree would have ACTIVATED it. A test
// that only exercised the TS side would have gone green through all of that --
// hence parity: same fixtures through BOTH implementations, asserted equal.
const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..', '..')
const CHANNELS_SH = join(REPO_ROOT, 'scripts', 'channels.sh')

// DEFAULTCLIGUARD927: the third layer is guarded against the installed CLI on
// both sides. Pin the CLI version to UNMEASURED ('' = fail-open) for every
// case, so the host's real `claude` never decides a result here; the guard
// cases below set a version explicitly. The child shell inherits process.env.
const savedCliVersion = process.env[CLI_VERSION_OVERRIDE_ENV]
beforeEach(() => { process.env[CLI_VERSION_OVERRIDE_ENV] = '' })
const roots: string[] = []
afterEach(() => {
  if (savedCliVersion === undefined) delete process.env[CLI_VERSION_OVERRIDE_ENV]
  else process.env[CLI_VERSION_OVERRIDE_ENV] = savedCliVersion
  while (roots.length) rmSync(roots.pop() as string, { recursive: true, force: true })
})

// The shell side requires the REAL guard module out of dist/. Transpile the
// source once, so the shell and the TS side run the same table and decision.
const CLI_SUPPORT_JS = ts.transpileModule(
  readFileSync(join(REPO_ROOT, 'src', 'claude-cli-support.ts'), 'utf-8'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
).outputText

/** Build a throwaway install root. channels.sh derives INSTALL_DIR from its own
 *  path, so a copy under <root>/scripts sees <root> as the install. */
function fixture(envBody: string | null, settingsBody: string | null): string {
  const root = mkdtempSync(join(tmpdir(), 'mainmodel-'))
  roots.push(root)
  mkdirSync(join(root, 'scripts'), { recursive: true })
  mkdirSync(join(root, '.claude'), { recursive: true })
  copyFileSync(CHANNELS_SH, join(root, 'scripts', 'channels.sh'))
  // RESPAWNMODEL807: a real install always has a BUILT dist/config-registry.js
  // (the launch path's third layer reads it with node). The fixture ships the
  // SAME constant the TS side compiled in, so parity is measured over all
  // three layers, exactly like production.
  mkdirSync(join(root, 'dist'), { recursive: true })
  writeFileSync(join(root, 'dist', 'config-registry.js'),
    `exports.DISTRIBUTION_DEFAULT_AGENT_MODEL = ${JSON.stringify(DISTRIBUTION_DEFAULT_AGENT_MODEL)};\n` +
    `exports.DISTRIBUTION_DEFAULT_FALLBACK_MODEL = ${JSON.stringify(DISTRIBUTION_DEFAULT_FALLBACK_MODEL)};\n`)
  writeFileSync(join(root, 'dist', 'claude-cli-support.js'), CLI_SUPPORT_JS)
  if (envBody !== null) writeFileSync(join(root, '.env'), envBody + '\n')
  if (settingsBody !== null) writeFileSync(join(root, '.claude', 'settings.json'), settingsBody + '\n')
  return root
}

/** The shell answer, via the script's own side-effect-free test seam. */
function shellResolves(root: string): string {
  return execFileSync('bash', [join(root, 'scripts', 'channels.sh'), '--resolve-main-model'], {
    encoding: 'utf-8',
  })
    .split('\n')[0]
    .trim()
}

// label, .env body, settings.json body, expected model
const CASES: Array<[string, string | null, string | null, string]> = [
  ['settings.json alone is honoured (the shipped default)', null, '{"model":"claude-opus-4-8[1m]"}', 'claude-opus-4-8[1m]'],
  // The regression case. These are the REAL values of the install where the
  // drift was found: .env said opus-5, the tracked file said opus-4-8[1m].
  ['.env wins over settings.json (the whole point)', 'MAIN_AGENT_MODEL=claude-opus-5', '{"model":"claude-opus-4-8[1m]"}', 'claude-opus-5'],
  ['.env alone works with no settings.json', 'MAIN_AGENT_MODEL=claude-sonnet-5', null, 'claude-sonnet-5'],
  // RESPAWNMODEL807: 'neither present' no longer means flag-less -- BOTH paths
  // land on the shipped distribution default (the third layer). The '' era is
  // exactly what let a respawn drop --model the day the shipped settings.json
  // stopped pinning a model.
  ['neither present -> the shipped distribution default', null, null, DISTRIBUTION_DEFAULT_AGENT_MODEL],
  ['an EMPTY MAIN_AGENT_MODEL does not shadow settings.json', 'MAIN_AGENT_MODEL=', '{"model":"claude-opus-5"}', 'claude-opus-5'],
  // `[1m]` must survive intact: it is a glob in shell and would silently vanish
  // if either side let a bare word through an unquoted expansion.
  ['a bracketed 1M suffix survives the .env route', 'MAIN_AGENT_MODEL=claude-opus-4-8[1m]', null, 'claude-opus-4-8[1m]'],
  ['a similarly named key does not leak in', 'NOT_MAIN_AGENT_MODEL=wrong-model', '{"model":"claude-opus-5"}', 'claude-opus-5'],
  ['settings.json without a model key falls back to the distribution default', null, '{"enabledPlugins":{}}', DISTRIBUTION_DEFAULT_AGENT_MODEL],
]

describe('main-agent model resolution: launch and respawn agree', () => {
  it.each(CASES)('%s', (_label, envBody, settingsBody, want) => {
    const root = fixture(envBody, settingsBody)
    const fromShell = shellResolves(root)
    const fromTs = readConfiguredMainModel(root)

    // Each side is right on its own...
    expect(fromShell).toBe(want)
    expect(fromTs).toBe(want)
    // ...and, the invariant that actually matters, they are right TOGETHER.
    expect(fromTs).toBe(fromShell)
  })
})

// DEFAULTCLIGUARD927 (Szotasz review of #1609): a model-less install on a CLI
// measured too old for the shipped default launches the previous tier, on the
// launch AND the respawn path alike; explicit values are never touched.
// label, CLI version ('' = unmeasured), .env body, settings.json body, expected
const GUARD_CASES: Array<[string, string, string | null, string | null, string]> = [
  ['model-less on the AVX-less pin 2.1.110 -> the previous tier', '2.1.110', null, null, DISTRIBUTION_DEFAULT_FALLBACK_MODEL],
  ['model-less on 2.1.278 -> the previous tier', '2.1.278', null, null, DISTRIBUTION_DEFAULT_FALLBACK_MODEL],
  ['model-less on 2.1.280 -> the shipped default', '2.1.280', null, null, DISTRIBUTION_DEFAULT_AGENT_MODEL],
  ['model-less, CLI unmeasured -> the shipped default (fail-open)', '', null, null, DISTRIBUTION_DEFAULT_AGENT_MODEL],
  ['explicit MAIN_AGENT_MODEL on 2.1.110 is the operator\'s choice, untouched', '2.1.110', 'MAIN_AGENT_MODEL=claude-opus-5-5[1m]', null, 'claude-opus-5-5[1m]'],
  ['explicit settings.json model on 2.1.110 is untouched', '2.1.110', null, '{"model":"claude-opus-5-5[1m]"}', 'claude-opus-5-5[1m]'],
]

describe('the distribution default is guarded against the installed CLI (DEFAULTCLIGUARD927)', () => {
  it('the shipped default is one the pin cannot run, so these cases exercise a real fallback', () => {
    expect(DISTRIBUTION_DEFAULT_FALLBACK_MODEL).not.toBe(DISTRIBUTION_DEFAULT_AGENT_MODEL)
  })

  it.each(GUARD_CASES)('%s', (_label, cli, envBody, settingsBody, want) => {
    process.env[CLI_VERSION_OVERRIDE_ENV] = cli
    const root = fixture(envBody, settingsBody)
    const fromShell = shellResolves(root)
    const fromTs = readConfiguredMainModel(root)
    expect(fromShell).toBe(want)
    expect(fromTs).toBe(want)
    expect(fromTs).toBe(fromShell)
  })

  it('the shell fallback leaves a NAMED line in channels-failures.log', () => {
    process.env[CLI_VERSION_OVERRIDE_ENV] = '2.1.110'
    const root = fixture(null, null)
    mkdirSync(join(root, 'store'), { recursive: true })
    shellResolves(root)
    const log = readFileSync(join(root, 'store', 'channels-failures.log'), 'utf-8')
    expect(log).toContain('DEFAULTCLIGUARD927')
    expect(log).toContain('2.1.110')
    expect(log).toContain(DISTRIBUTION_DEFAULT_FALLBACK_MODEL)
  })

  it('a dist WITHOUT the guard module keeps the default (fail-open) and says so', () => {
    process.env[CLI_VERSION_OVERRIDE_ENV] = '2.1.110'
    const root = fixture(null, null)
    rmSync(join(root, 'dist', 'claude-cli-support.js'))
    mkdirSync(join(root, 'store'), { recursive: true })
    expect(shellResolves(root)).toBe(DISTRIBUTION_DEFAULT_AGENT_MODEL)
    expect(readFileSync(join(root, 'store', 'channels-failures.log'), 'utf-8')).toContain('guard unavailable')
  })
})

describe('the respawn path reads .env at all (guards the 2026-08-03 defect directly)', () => {
  // Pinned separately from the table above so the specific regression stays
  // legible in a failure report: a settings.json-only implementation returns
  // 'claude-opus-4-8[1m]' here and this assertion names why that is wrong.
  it('does NOT return the tracked settings.json value when .env overrides it', () => {
    const root = fixture('MAIN_AGENT_MODEL=claude-opus-5', '{"model":"claude-opus-4-8[1m]"}')
    expect(readConfiguredMainModel(root)).not.toBe('claude-opus-4-8[1m]')
    expect(readConfiguredMainModel(root)).toBe('claude-opus-5')
  })

  it('survives an unreadable .env by falling back, not by throwing', () => {
    const root = fixture(null, '{"model":"claude-opus-5"}')
    mkdirSync(join(root, '.env')) // a directory where a file is expected
    expect(readConfiguredMainModel(root)).toBe('claude-opus-5')
  })
})


// RESPAWNMODEL807 structural locks: four copies of the model resolution
// existed and three went stale. Lock every respawn path onto the ONE resolver
// so a fifth copy (or a revived jq-only read) fails loudly here.
import { readFileSync as _rf } from 'node:fs'
describe('every respawn path asks the one resolver (RESPAWNMODEL807)', () => {
  it('channel-watchdog.sh calls --resolve-main-model and carries no jq-only model read', () => {
    const src = _rf(join(REPO_ROOT, 'scripts', 'channel-watchdog.sh'), 'utf-8')
    expect(src).toContain('--resolve-main-model')
    expect(src).not.toMatch(/jq -r '\.model/)
  })

  it('stuck-modal-guard.sh calls --resolve-main-model and carries no jq-only model read', () => {
    const src = _rf(join(REPO_ROOT, 'scripts', 'stuck-modal-guard.sh'), 'utf-8')
    expect(src).toContain('--resolve-main-model')
    expect(src).not.toMatch(/jq -r '\.model/)
  })

  it('every buildMainSessionRespawnCmd call site passes model: readConfiguredMainModel()', () => {
    const src = _rf(join(REPO_ROOT, 'src', 'web', 'channel-monitor.ts'), 'utf-8')
    // CALL sites only: `= buildMainSessionRespawnCmd({` -- the bare-substring
    // count also caught the definition and a comment mention (measured: 4 vs
    // 3 real calls at 714/784/997) and would drift with prose edits.
    const sites = src.split('= buildMainSessionRespawnCmd({').length - 1
    const wired = src.split('model: readConfiguredMainModel()').length - 1
    expect(sites).toBeGreaterThanOrEqual(3)
    expect(wired).toBe(sites)
  })

  it('readConfiguredMainModel never returns empty while a distribution default exists', () => {
    const root = fixture(null, null)
    expect(readConfiguredMainModel(root)).toBe(DISTRIBUTION_DEFAULT_AGENT_MODEL)
  })

  it('NEGATIVE CONTROL: a per-install .env choice beats the distribution default on the respawn path', () => {
    const root = fixture('MAIN_AGENT_MODEL=claude-sonnet-5', null)
    expect(readConfiguredMainModel(root)).toBe('claude-sonnet-5')
    expect(readConfiguredMainModel(root)).not.toBe(DISTRIBUTION_DEFAULT_AGENT_MODEL)
  })
})
