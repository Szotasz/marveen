// VOICETOKENLEAK1101: buildTtsDirective's text is injected into the agent's prompt, so it
// reaches the pane and the transcript. The dashboard token VALUE must never be in it: the
// directive carries a reference to the token file that the shell resolves when it runs.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'

const state = vi.hoisted(() => ({ storeDir: '' }))

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  get STORE_DIR() { return state.storeDir },
}))

const { buildTtsDirective } = await import('../web/voice-directive.js')

// A probe value, not a real token: if it shows up in the directive, the value leaked.
const PROBE_TOKEN = 'probe-token-VOICETOKENLEAK1101-0123456789abcdef'
const OPTS = { chatId: '12345', stateDir: '/tmp/state', voiceModel: 'eleven_v3' }

// The double-quoted Authorization header word, exactly as the directive's curl line has it.
function authHeaderWord(directive: string): string {
  const m = directive.match(/-H ("Authorization: Bearer [^\n]*?") -d @-/)
  if (!m) throw new Error('no Authorization header in the directive')
  return m[1]
}

describe('buildTtsDirective never embeds the dashboard token value', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'voicetok-'))
    // A space and a single quote in the path: the reference must survive shell quoting.
    state.storeDir = join(root, "st ore'dir")
    execFileSync('mkdir', ['-p', state.storeDir])
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('the directive does not contain the token, only a reference to the token file', () => {
    writeFileSync(join(state.storeDir, '.dashboard-token'), `${PROBE_TOKEN}\n`)
    const d = buildTtsDirective(OPTS)
    expect(d).not.toBeNull()
    expect(d).not.toContain(PROBE_TOKEN)
    expect(d).not.toContain('0123456789abcdef')
    expect(authHeaderWord(d as string)).toContain('$(cat ')
  })

  it('the shell resolves the reference to the token when the command runs (quoting holds)', () => {
    writeFileSync(join(state.storeDir, '.dashboard-token'), `${PROBE_TOKEN}\n`)
    const word = authHeaderWord(buildTtsDirective(OPTS) as string)
    const out = execFileSync('bash', ['-c', `printf '%s' ${word}`], { encoding: 'utf-8' })
    expect(out).toBe(`Authorization: Bearer ${PROBE_TOKEN}`)
  })

  it('a missing token file gives no directive', () => {
    expect(buildTtsDirective(OPTS)).toBeNull()
  })

  it('an empty token file gives no directive, as before', () => {
    writeFileSync(join(state.storeDir, '.dashboard-token'), '  \n')
    expect(buildTtsDirective(OPTS)).toBeNull()
  })
})
