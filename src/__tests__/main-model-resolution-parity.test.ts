import { describe, it, expect, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

import { readConfiguredMainModel } from '../web/channel-monitor.js'

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

const roots: string[] = []
afterEach(() => {
  while (roots.length) rmSync(roots.pop() as string, { recursive: true, force: true })
})

/** Build a throwaway install root. channels.sh derives INSTALL_DIR from its own
 *  path, so a copy under <root>/scripts sees <root> as the install. */
function fixture(envBody: string | null, settingsBody: string | null): string {
  const root = mkdtempSync(join(tmpdir(), 'mainmodel-'))
  roots.push(root)
  mkdirSync(join(root, 'scripts'), { recursive: true })
  mkdirSync(join(root, '.claude'), { recursive: true })
  copyFileSync(CHANNELS_SH, join(root, 'scripts', 'channels.sh'))
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
  ['neither present -> empty, so the launcher omits --model', null, null, ''],
  ['an EMPTY MAIN_AGENT_MODEL does not shadow settings.json', 'MAIN_AGENT_MODEL=', '{"model":"claude-opus-5"}', 'claude-opus-5'],
  // `[1m]` must survive intact: it is a glob in shell and would silently vanish
  // if either side let a bare word through an unquoted expansion.
  ['a bracketed 1M suffix survives the .env route', 'MAIN_AGENT_MODEL=claude-opus-4-8[1m]', null, 'claude-opus-4-8[1m]'],
  ['a similarly named key does not leak in', 'NOT_MAIN_AGENT_MODEL=wrong-model', '{"model":"claude-opus-5"}', 'claude-opus-5'],
  ['settings.json without a model key falls back to empty', null, '{"enabledPlugins":{}}', ''],
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
