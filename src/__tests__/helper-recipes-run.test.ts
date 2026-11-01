// VOICETOKENLEAK1101 PR-A1 (Dani 64941/4): the helper recipe lines the generated CLAUDE.md sections hand EVERY agent
// are run for real, through bash as the agent runs them, against a local capture server: what is checked is what
// reaches the wire (method, path, JSON body, the token header), not the text of the line. The payload files a line
// names are swapped for temp files (runRecipeLine).
import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { recipeLine, runRecipeLine, RECIPE_TOKEN } from './helpers/kanban-recipe.js'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const tmpRoot = mkdtempSync(join(tmpdir(), 'marveen-helper-recipes-'))
// The generated lines name <PROJECT_ROOT>/scripts/marveen-api.sh: the real scripts, copied under the mocked root.
mkdirSync(join(tmpRoot, 'scripts', 'lib'), { recursive: true })
for (const f of ['marveen-api.sh', 'agent-msg.sh', join('lib', 'marveen_api.py'), join('lib', 'homoglyph.py'), join('lib', 'mixed_script.py')]) {
  copyFileSync(join(REPO, 'scripts', f), join(tmpRoot, 'scripts', f))
}

vi.mock('../config.js', () => ({
  STORE_DIR: '/nonexistent/claudeclaw-test-store',
  PROJECT_ROOT: tmpRoot,
  OWNER_NAME: 'TestOwner',
  MAIN_AGENT_ID: 'agent-a',
  BOT_NAME: 'agent-a',
  CHANNEL_PROVIDER: 'telegram',
  WEB_PORT: 3420,
  OWNER_DRIVE_FOLDER: '',
  DASHBOARD_PUBLIC_URL: '',
  AGENT_API_ORIGIN: '',
  APP_TZ: 'Europe/Budapest',
}))
vi.mock('../web/agent-config.js', () => ({
  agentDir: (name: string) => join(tmpRoot, 'agents', name),
  agentConfigRoot: () => join(tmpRoot, 'agents'),
  listAgentNames: () => ['agent-a', 'agent-b'],
  readAgentCapabilities: () => [],
}))
vi.mock('../web/atomic-write.js', () => ({
  atomicWriteFileSync: (path: string, content: string) => writeFileSync(path, content, 'utf-8'),
}))

const S = await import('../web/agent-scaffold.js')
const AGENT = 'agent-b'

describe('the generated helper recipes run for real', () => {
  it('memory-save (the strict-api block): POST /api/memories with the file content, no token on argv', async () => {
    const line = recipeLine(S.buildStrictApiBody(AGENT), 'memory-save', AGENT).replace('<fájl>', join(tmpRoot, 'agents', AGENT, 'api-memoria.txt'))
    const got = await runRecipeLine(line, { 'api-memoria.txt': 'tartalom `backtick` és $(nem fut)' })
    expect(got.method).toBe('POST')
    expect(got.url).toBe('/api/memories')
    expect(got.body).toMatchObject({ agent_id: AGENT, category: 'warm', keywords: 'kulcsszo1, kulcsszo2', content: 'tartalom `backtick` és $(nem fut)' })
    expect(got.headers.authorization).toBe(`Bearer ${RECIPE_TOKEN}`)
    expect(got.argv.join(' ')).not.toContain(RECIPE_TOKEN)
  })

  it('memory-update (agent-id block): PUT with X-Agent-Id and the payload file', async () => {
    const line = recipeLine(S.buildAgentIdHeaderBody(AGENT), 'memory-update').replace('<id>', '42')
    const got = await runRecipeLine(line, { 'api-memoria.txt': 'új tartalom' })
    expect(got.method).toBe('PUT')
    expect(got.url).toBe('/api/memories/42')
    expect(got.headers['x-agent-id']).toBe(AGENT)
    expect(got.body).toMatchObject({ content: 'új tartalom' })
  })

  it('memory-search with an accented query (memory-search block): the query is encoded, no 400 trap', async () => {
    const line = recipeLine(S.buildMemorySearchLabelBody(AGENT), 'memory-search', AGENT).replace('KULCSSZO', "'ékezetes keresés'")
    const got = await runRecipeLine(line)
    expect(got.method).toBe('GET')
    const u = new URL(got.url, 'http://x')
    expect(u.pathname).toBe('/api/memories')
    expect(u.searchParams.get('agent')).toBe(AGENT)
    expect(u.searchParams.get('q')).toBe('ékezetes keresés')
    expect(got.url).not.toMatch(/[^\x00-\x7f]/)
  })

  it('message-close --no-notify (message-close block): PUT done with a real JSON boolean false', async () => {
    const line = recipeLine(S.buildMessageCloseBody(true, AGENT), 'message-close').replace('<id>', '7')
    const got = await runRecipeLine(line)
    expect(got.method).toBe('PUT')
    expect(got.url).toBe('/api/messages/7')
    expect(got.body).toEqual({ status: 'done', notify: false })
  })

  it('approval-consume --content-hash (autonomy block): the hash and the consumer reach the body', async () => {
    // buildAutonomyBody is not exported: the block as the start path writes it
    mkdirSync(join(tmpRoot, 'agents', AGENT), { recursive: true })
    writeFileSync(join(tmpRoot, 'agents', AGENT, 'CLAUDE.md'), `# ${AGENT}\n`, 'utf-8')
    S.ensureAutonomySection(AGENT)
    const md = readFileSync(join(tmpRoot, 'agents', AGENT, 'CLAUDE.md'), 'utf-8')
    // the agent fills CATEGORY_KEY with a real key (the helper checks its shape)
    const line = recipeLine(md, 'approval-consume').replace('<id>', '9').replace('CATEGORY_KEY', 'memory_maintenance') + ' --content-hash sha256:0123abcd'
    const got = await runRecipeLine(line)
    expect(got.method).toBe('POST')
    expect(got.url).toBe('/api/approvals/9/consume')
    expect(got.body).toMatchObject({ category: 'memory_maintenance', consumer: AGENT, content_hash: 'sha256:0123abcd' })
  })
})

// VOICETOKENLEAK1101 PR-A2: the api-helper block an existing agent gets in place of its creation-time curl recipes.
describe('the api-helper block recipes run for real', () => {
  const body = () => S.buildApiHelperBody(AGENT)

  it('daily-log: POST /api/daily-log with the content from api-naplo.txt', async () => {
    const got = await runRecipeLine(recipeLine(body(), 'daily-log', AGENT), { 'api-naplo.txt': '## 18:40 -- Tema\nMi tortent' })
    expect(got.method).toBe('POST')
    expect(got.url).toBe('/api/daily-log')
    expect(got.body).toMatchObject({ agent_id: AGENT, content: '## 18:40 -- Tema\nMi tortent' })
  })

  it('memory-list hot and memory-move: the agent own rows, a category-only PATCH with updated_by', async () => {
    const list = await runRecipeLine(recipeLine(body(), 'memory-list', AGENT))
    const u = new URL(list.url, 'http://x')
    expect([list.method, u.pathname, u.searchParams.get('agent'), u.searchParams.get('category')]).toEqual(['GET', '/api/memories', AGENT, 'hot'])
    const move = await runRecipeLine(recipeLine(body(), 'memory-move').replace('<ID>', '5'))
    expect([move.method, move.url]).toEqual(['PATCH', '/api/memories/5'])
    expect(move.body).toEqual({ category: 'cold', updated_by: AGENT })
  })

  it('message: the unknown-sender ping goes through agent-msg.sh with the text from api-uzenet.txt', async () => {
    const got = await runRecipeLine(recipeLine(body(), 'message', AGENT), { 'api-uzenet.txt': 'Ismeretlen sender `x` $(nem fut)' }, '{"id":1}')
    expect([got.method, got.url]).toEqual(['POST', '/api/messages'])
    expect(got.body).toMatchObject({ from: AGENT, to: 'agent-a', content: 'Ismeretlen sender `x` $(nem fut)' })
  })
})
