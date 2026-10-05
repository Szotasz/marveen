import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { decideStateObserver, stateObserverLaunchEnv, STATE_OBSERVER_MIN_CLI } from '../web/state-observer.js'
import { shSingleQuote } from '../web/agent-process.js'

// MODSTERMEK1005: the agent-state-observer mod is opt-in per agent, version
// gated, and reaches the agent only through its launch command's environment.

const base = { enabled: true, isMainAgent: false, installedCli: '2.1.289', remote: false, runAs: false }

describe('decideStateObserver', () => {
  it('loads only when enabled, local, own user, and on a new enough CLI', () => {
    expect(decideStateObserver(base).load).toBe(true)
  })

  it('is off by default', () => {
    expect(decideStateObserver({ ...base, enabled: false })).toEqual({ load: false, reason: 'off (stateObserver not set)' })
  })

  it('never loads into the main agent (it is not launched here)', () => {
    expect(decideStateObserver({ ...base, isMainAgent: true }).load).toBe(false)
  })

  it('skips remote and run-as agents (local paths, this OS user)', () => {
    expect(decideStateObserver({ ...base, remote: true }).load).toBe(false)
    expect(decideStateObserver({ ...base, runAs: true }).load).toBe(false)
  })

  it('the version gate: below the floor or unmeasured -> not loaded, no error', () => {
    expect(STATE_OBSERVER_MIN_CLI).toBe('2.1.287')
    expect(decideStateObserver({ ...base, installedCli: '2.1.286' }).load).toBe(false)
    expect(decideStateObserver({ ...base, installedCli: '2.1.287' }).load).toBe(true)
    expect(decideStateObserver({ ...base, installedCli: '2.1.280' }).reason).toMatch(/below 2\.1\.287/)
    expect(decideStateObserver({ ...base, installedCli: null }).load).toBe(false)
  })
})

describe('stateObserverLaunchEnv', () => {
  it('is empty when not loading', () => {
    expect(stateObserverLaunchEnv(false, 'alpha', shSingleQuote)).toBe('')
  })

  it('exports the plugin folder, the agent name and the state folder', () => {
    const env = stateObserverLaunchEnv(true, 'alpha', shSingleQuote, '/inst/plugins/agent-state-observer', '/inst/store/mod-state')
    expect(env).toBe("export CLAUDE_CODE_PLUGIN_DIRS='/inst/plugins/agent-state-observer' MARVEEN_AGENT_ID='alpha' MARVEEN_STATE_OBSERVER_DIR='/inst/store/mod-state' && ")
  })

  it('quotes every value into one inert shell word', () => {
    const env = stateObserverLaunchEnv(true, "a'; touch /tmp/pwned; echo '", shSingleQuote, "/p a'th", '/s')
    expect(env).toContain(`MARVEEN_AGENT_ID='a'\\''; touch /tmp/pwned; echo '\\'''`)
    expect(env).toContain(`CLAUDE_CODE_PLUGIN_DIRS='/p a'\\''th'`)
  })
})

describe('the launcher binding', () => {
  const SRC = readFileSync(join(__dirname, '../web/agent-process.ts'), 'utf-8')

  it('decides only for an agent that has the flag on, and exports into the launch command before cd', () => {
    const gate = SRC.indexOf('if (readAgentStateObserver(name)) {')
    expect(gate).toBeGreaterThan(0)
    const block = SRC.slice(gate, SRC.indexOf('\n    }\n', gate))
    expect(block).toMatch(/decideStateObserver\(/)
    expect(block).toMatch(/stateObserverLaunchEnv\(observer\.load, name, shSingleQuote\)/)
    expect(block).toMatch(/isMainAgent: name === MAIN_AGENT_ID/)
    expect(SRC).toMatch(/\$\{providerEnv\}\$\{stateObserverEnv\}cd "\$\{launchCwd\}"/)
  })

  it('reads the flag from agent-config.json as a strict boolean', () => {
    const CFG = readFileSync(join(__dirname, '../web/agent-config.ts'), 'utf-8')
    const fn = CFG.slice(CFG.indexOf('export function readAgentStateObserver('))
    expect(fn.slice(0, 400)).toMatch(/config\.stateObserver === true/)
  })

  it('ships the mod folder the launcher points at', () => {
    const root = join(__dirname, '../../plugins/agent-state-observer')
    const manifest = JSON.parse(readFileSync(join(root, '.claude-plugin/plugin.json'), 'utf-8'))
    expect(manifest.name).toBe('agent-state-observer')
    const hooks = JSON.parse(readFileSync(join(root, 'hooks/hooks.json'), 'utf-8'))
    expect(hooks.modules).toEqual(['./register.ts'])
    const mod = readFileSync(join(root, 'hooks/register.ts'), 'utf-8')
    expect(mod).toContain("$.env.get('MARVEEN_AGENT_ID')")
    expect(mod).toContain("$.env.get('MARVEEN_STATE_OBSERVER_DIR')")
  })
})
