import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { inheritedAuthUnset, type InheritedAuthUnsetInput } from '../web/inherited-auth-unset.js'

// BYOSUBUNSET1018: a sub-agent pane inherits the tmux server's global env
// (fleet token, and ANTHROPIC_API_KEY when .env has one). An agent meant to
// authenticate with its OWN credential must start without either. The cases
// are executed: the produced prefix runs in a shell that carries both, the way
// the pane does, and what survives is read back.

/** Names of the two credentials still set after running `prefix` then the launch tail. */
function survivors(prefix: string, tail = ''): string[] {
  const out = execFileSync('sh', ['-c', `${prefix}${tail}env`], {
    encoding: 'utf-8',
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', CLAUDE_CODE_OAUTH_TOKEN: 'fleet', ANTHROPIC_API_KEY: 'host' },
  })
  return out.split('\n').map((l) => l.split('=')[0]).filter((n) => n === 'CLAUDE_CODE_OAUTH_TOKEN' || n === 'ANTHROPIC_API_KEY').sort()
}

const base: InheritedAuthUnsetInput = { needsFleetOauth: true, isOwnTeam: false, configuredConfigDir: false, ownTokenFile: false }

describe('inherited credentials a sub-agent launch strips (executed)', () => {
  it('a fleet agent keeps both: it runs on what the server carries', () => {
    expect(survivors(inheritedAuthUnset(base))).toEqual(['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'])
  })

  it('an operator-configured config dir (own /login) drops both', () => {
    expect(survivors(inheritedAuthUnset({ ...base, configuredConfigDir: true }))).toEqual([])
  })

  it('own_team drops both', () => {
    expect(survivors(inheritedAuthUnset({ ...base, needsFleetOauth: false, isOwnTeam: true }))).toEqual([])
  })

  it('an own token file drops both, and its own export later in the launch wins', () => {
    const prefix = inheritedAuthUnset({ ...base, ownTokenFile: true })
    expect(survivors(prefix)).toEqual([])
    expect(survivors(prefix, 'export CLAUDE_CODE_OAUTH_TOKEN=own && ')).toEqual(['CLAUDE_CODE_OAUTH_TOKEN'])
  })

  it('a BYO / api agent drops the OAuth token but keeps the API key (an api agent may run on the host key)', () => {
    expect(survivors(inheritedAuthUnset({ ...base, needsFleetOauth: false }))).toEqual(['ANTHROPIC_API_KEY'])
  })
})

describe('the binding in startAgentProcess', () => {
  const SRC = readFileSync(join(__dirname, '..', 'web', 'agent-process.ts'), 'utf-8')

  it('byoUnsetEnv comes from inheritedAuthUnset with the real inputs', () => {
    expect(SRC).toMatch(/const byoUnsetEnv = inheritedAuthUnset\(\{ needsFleetOauth, isOwnTeam, configuredConfigDir, ownTokenFile: ownTokenFile !== null \}\)/)
  })

  it('configuredConfigDir is taken BEFORE the auto-isolation can set claudeConfigDir', () => {
    const taken = SRC.indexOf('const configuredConfigDir = claudeConfigDir !== null')
    const firstIsolation = SRC.indexOf('claudeConfigDir = isolated')
    expect(taken).toBeGreaterThan(0)
    expect(taken).toBeLessThan(firstIsolation)
    expect(SRC.indexOf('let claudeConfigDir = planResolution.configDir')).toBeLessThan(taken)
  })

  it('the unset runs before every credential export in the launch command', () => {
    const cmd = SRC.slice(SRC.indexOf('const buildLaunchCmd = '))
    const at = (s: string) => cmd.indexOf(s)
    expect(at('${byoUnsetEnv}')).toBeGreaterThan(0)
    for (const later of ['${apiKeyEnv}', '${oauthTokenEnv}', '${providerEnv}']) {
      expect(at(later)).toBeGreaterThan(at('${byoUnsetEnv}'))
    }
  })
})
