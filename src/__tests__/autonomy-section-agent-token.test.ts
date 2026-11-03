// The level-2 consume recipe a sub-agent reads must say what a 403 on consume
// means once its recipes use its OWN token (AGENT_TOKENS): the row is neither
// its own request nor granted to it with for_agent, so it must ask the main
// agent for the grant instead of re-requesting or acting. Without its own
// token (switch off, or the main agent) the text is unchanged.
import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const tmpRoot = mkdtempSync(join(tmpdir(), 'marveen-autonomy-token-test-'))
const tokensOn = { value: '1' }

vi.mock('../config.js', () => ({
  STORE_DIR: '/nonexistent/claudeclaw-test-store',
  PROJECT_ROOT: tmpRoot,
  OWNER_NAME: 'TestOwner',
  MAIN_AGENT_ID: 'agent-a',
  HEARTBEAT_AGENT_ID: 'heartbeat',
  BOT_NAME: 'agent-a',
  CHANNEL_PROVIDER: 'telegram',
  WEB_PORT: 3420,
  OWNER_DRIVE_FOLDER: '',
  DASHBOARD_PUBLIC_URL: '',
  AGENT_API_ORIGIN: '',
  APP_TZ: 'Europe/Budapest',
}))
vi.mock('../settings-store.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../settings-store.js')>()
  return { ...real, getEffectiveSettingValue: (key: string) => (key === 'AGENT_TOKENS' ? tokensOn.value : real.getEffectiveSettingValue(key)) }
})
vi.mock('../web/agent-config.js', () => ({
  agentDir: (name: string) => join(tmpRoot, 'agents', name),
  agentConfigRoot: () => join(tmpRoot, 'agents'),
  listAgentNames: () => ['agent-a', 'agent-b'],
  readAgentCapabilities: () => [],
}))
vi.mock('../web/atomic-write.js', () => ({
  atomicWriteFileSync: (path: string, content: string) => writeFileSync(path, content, 'utf-8'),
}))

const { ensureAutonomySection } = await import('../web/agent-scaffold.js')

function setup(agentName: string, withToken: boolean) {
  const dir = join(tmpRoot, 'agents', agentName)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'CLAUDE.md'), '# Sub\n', 'utf-8')
  if (withToken) writeFileSync(join(dir, '.dashboard-token'), 'c'.repeat(64), { mode: 0o600 })
}
const read = (n: string) => readFileSync(join(tmpRoot, 'agents', n, 'CLAUDE.md'), 'utf-8')
const level2 = (text: string) => text.slice(text.indexOf('**Level 2'), text.indexOf('**Level 3'))

describe('ensureAutonomySection: what a 403 on consume means for a sub-agent token', () => {
  it('a sub-agent on its own token is told: not granted to you, do not act, ask the main agent to file a new row with for_agent=<own name>', () => {
    tokensOn.value = '1'
    setup('consume-sub', true)
    ensureAutonomySection('consume-sub')
    const block = level2(read('consume-sub'))
    // VOICETOKENLEAK1101 PR-A1: the recipe is the helper, which reads the agent's own token itself (PR-A0); no path
    expect(block).not.toContain('.dashboard-token')
    expect(block).toContain('marveen-api.sh approval-consume <id> CATEGORY_KEY consume-sub')
    const line = block.split('\n').find((l) => l.startsWith('403 (agent-identity-binding)'))
    expect(line, block).toBeDefined()
    expect(line).toContain('for_agent')
    expect(line).toContain('agent-a') // the main agent, named as the one to ask
    // for_agent exists only at creation: the text must ask for a NEW row filed
    // with for_agent=<own name>, never a grant of the refused id, and must not
    // forbid the new approval that this takes.
    expect(line).toContain('"for_agent":"consume-sub"')
    expect(line).toContain('iktassa')
    expect(line).toContain('utólag nem adható')
    expect(line).not.toContain('NE kérj új jóváhagyást')
    expect(line).not.toContain('id-ját')
    expect(line).toContain('NE cselekedj')
    // after the consume recipe, so it reads as the answer to that call
    expect(block.indexOf('approval-consume <id>')).toBeLessThan(block.indexOf(line!))
  })

  it('with AGENT_TOKENS off (or no token file yet) there is no such line (the helper recipe either way)', () => {
    tokensOn.value = '0'
    setup('consume-off', true)
    ensureAutonomySection('consume-off')
    const off = level2(read('consume-off'))
    expect(off).toContain('marveen-api.sh approval-consume <id>')
    expect(off).not.toContain('403 (agent-identity-binding)')
    tokensOn.value = '1'
    setup('consume-notoken', false)
    ensureAutonomySection('consume-notoken')
    expect(level2(read('consume-notoken'))).not.toContain('403 (agent-identity-binding)')
  })
})
