// TTSBIND1125 (a): the voice-reply directive references the AGENT's own dashboard token file when it has one
// (AGENT_TOKENS on, agents/<name>/.dashboard-token in place), so the server can tell who calls POST /api/voice/tts
// and the gate binds ?agent= to that caller. With the switch off, for the main agent, or before the agent's file
// exists, the reference stays the shared store/.dashboard-token, as before. Never the token value (VOICETOKENLEAK1101).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'

const state = vi.hoisted(() => ({ root: '', agentTokens: '0' }))

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  get PROJECT_ROOT() { return state.root },
  get STORE_DIR() { return join(state.root, 'store') },
}))
vi.mock('../settings-store.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../settings-store.js')>()
  return { ...real, getEffectiveSettingValue: (key: string) => (key === 'AGENT_TOKENS' ? state.agentTokens : real.getEffectiveSettingValue(key)) }
})

const { buildTtsDirective } = await import('../web/voice-directive.js')
const { MAIN_AGENT_ID } = await import('../config.js')

// Probe values, not real tokens. Both pass the agent-token format check (>= 32 chars of [A-Za-z0-9_-]).
const SHARED = 'probeSharedTokenTTSBIND1125aaaaaaaaaaaaaaaa'
const OWN = 'probeAgentTokenTTSBIND1125bbbbbbbbbbbbbbbbb'
const AGENT = 'kodi'

function authHeaderWord(directive: string): string {
  const m = directive.match(/-H ("Authorization: Bearer [^\n]*?") --data-binary @-/)
  if (!m) throw new Error('no Authorization header in the directive')
  return m[1]
}
// What the shell sends when the agent runs the command.
const sentHeader = (d: string) => execFileSync('bash', ['-c', `printf '%s' ${authHeaderWord(d)}`], { encoding: 'utf-8' })

describe('buildTtsDirective: whose token file the directive references', () => {
  beforeEach(() => {
    state.root = mkdtempSync(join(tmpdir(), 'ttsbind-a-'))
    mkdirSync(join(state.root, 'store'), { recursive: true })
    writeFileSync(join(state.root, 'store', '.dashboard-token'), `${SHARED}\n`)
    mkdirSync(join(state.root, 'agents', AGENT), { recursive: true })
    state.agentTokens = '0'
  })
  afterEach(() => rmSync(state.root, { recursive: true, force: true }))

  it('AGENT_TOKENS on and the agent has its own file: the agent\'s file, never a value', () => {
    state.agentTokens = '1'
    writeFileSync(join(state.root, 'agents', AGENT, '.dashboard-token'), `${OWN}\n`, { mode: 0o600 })
    const d = buildTtsDirective({ chatId: '123', agentId: AGENT, voiceModel: 'm' }) as string
    expect(d).not.toBeNull()
    expect(authHeaderWord(d)).toContain(join(state.root, 'agents', AGENT, '.dashboard-token'))
    expect(d).not.toContain(OWN)
    expect(d).not.toContain(SHARED)
    expect(sentHeader(d)).toBe(`Authorization: Bearer ${OWN}`)
  })

  it('AGENT_TOKENS off: the shared file, even when the agent\'s own file exists', () => {
    writeFileSync(join(state.root, 'agents', AGENT, '.dashboard-token'), `${OWN}\n`, { mode: 0o600 })
    const d = buildTtsDirective({ chatId: '123', agentId: AGENT, voiceModel: 'm' }) as string
    expect(authHeaderWord(d)).toContain(join(state.root, 'store', '.dashboard-token'))
    expect(sentHeader(d)).toBe(`Authorization: Bearer ${SHARED}`)
  })

  it('AGENT_TOKENS on but the agent has no file yet: the shared file (never a missing path)', () => {
    state.agentTokens = '1'
    const d = buildTtsDirective({ chatId: '123', agentId: AGENT, voiceModel: 'm' }) as string
    expect(sentHeader(d)).toBe(`Authorization: Bearer ${SHARED}`)
  })

  it('the main agent keeps the shared file with AGENT_TOKENS on', () => {
    state.agentTokens = '1'
    const d = buildTtsDirective({ chatId: '123', agentId: MAIN_AGENT_ID, voiceModel: 'm' }) as string
    expect(sentHeader(d)).toBe(`Authorization: Bearer ${SHARED}`)
  })
})
