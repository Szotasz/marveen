// #3118: a sub-agent's voice reply. The directive used to put the sub-agent's channel dir
// (agents/<name>/.claude/channels/telegram) on the command line as ?state_dir=, and the sub-agent gate
// (db-write-gate.mjs, TGINREPLAYGATE1104) refuses every command that names such a dir, so the reply never went out.
// The directive now sends ?agent=<id> and POST /api/voice/tts resolves the dir itself.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'

const H = vi.hoisted(() => {
  const os = require('node:os') as typeof import('node:os')
  const fs = require('node:fs') as typeof import('node:fs')
  const path = require('node:path') as typeof import('node:path')
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tts-home-'))
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'tts-store-'))
  return { home, store }
})
vi.mock('node:os', async (importOriginal) => ({ ...(await importOriginal<typeof import('node:os')>()), homedir: () => H.home }))
vi.mock('../config.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../config.js')>()), STORE_DIR: H.store }))

const AGENT = `ttsagent${process.pid}`
const { PROJECT_ROOT, RESERVED_AGENT_IDS } = await import('../config.js')
const { buildTtsDirective } = await import('../web/voice-directive.js')
const { tryHandleVoice } = await import('../web/routes/voice.js')
const { gateDecision } = await import('../../scripts/hooks/db-write-gate.mjs' as string)
type RouteContext = import('../web/routes/types.js').RouteContext

const agentsBase = join(PROJECT_ROOT, 'agents')
const agentChannel = join(agentsBase, AGENT, '.claude', 'channels', 'telegram')

beforeAll(() => {
  writeFileSync(join(H.store, '.dashboard-token'), 'x'.repeat(64))
  // the voice toolkit "installed" (the route answers 503 otherwise); nothing here runs it
  mkdirSync(join(H.home, '.local', 'share', 'marveen-voice', 'venv', 'bin'), { recursive: true })
  writeFileSync(join(H.home, '.local', 'share', 'marveen-voice', 'venv', 'bin', 'python'), '')
  writeFileSync(join(H.home, '.local', 'share', 'marveen-voice', '_vtools.py'), '')
  mkdirSync(agentChannel, { recursive: true })
  writeFileSync(join(agentChannel, '.env'), 'TELEGRAM_BOT_TOKEN=not-a-real-token\n')
  // TTSBIND1125: the bot lets in one user, the chat the tests send to
  writeFileSync(join(agentChannel, 'access.json'), JSON.stringify({ dmPolicy: 'allowlist', allowFrom: ['123'], groups: {} }))
})
afterAll(() => {
  rmSync(join(agentsBase, AGENT), { recursive: true, force: true })
  try { rmSync(agentsBase, { recursive: false }) } catch { /* not empty, or gone */ }
  rmSync(H.home, { recursive: true, force: true })
  rmSync(H.store, { recursive: true, force: true })
})

const bashOf = (directive: string) => /```bash\n([\s\S]*?)\n```/.exec(directive)![1]

describe('the directive a sub-agent receives', () => {
  it('names the agent, not the channel dir, and the sub-agent gate lets it run', () => {
    const d = buildTtsDirective({ chatId: '123', agentId: AGENT, voiceModel: 'hu_HU-imre-medium' }) as string
    const cmd = bashOf(d)
    expect(cmd).toContain(`agent=${AGENT}`)
    expect(cmd).not.toContain('state_dir')
    expect(cmd).not.toContain('.claude')
    const v = gateDecision('Bash', { command: cmd }, { cwd: join(agentsBase, AGENT), root: PROJECT_ROOT, subAgent: true })
    expect(v?.deny ?? false).toBe(false)
  })

  it('the old shape (the channel dir on the command line) stays refused by the gate: the reason for the change', () => {
    const old = `curl -s -X POST 'http://localhost:3420/api/voice/tts?${new URLSearchParams({ chat_id: '123', state_dir: agentChannel, voice_model: 'm' })}' --data-binary @- <<'MARVEEN_TTS_END_ab'\nx\nMARVEEN_TTS_END_ab`
    const v = gateDecision('Bash', { command: old }, { cwd: join(agentsBase, AGENT), root: PROJECT_ROOT, subAgent: true })
    expect(v?.deny).toBe(true)
  })
})

async function tts(query: Record<string, string>, text = 'szia') {
  const out: { status: number; body: any } = { status: 0, body: null }
  const res: any = { setHeader() { return res }, writeHead(s: number) { out.status = s; return res }, end(c?: string) { if (c) out.body = JSON.parse(c) } }
  const req: any = Readable.from([Buffer.from(text)])
  req.headers = { 'content-type': 'text/plain; charset=utf-8' }
  const url = new URL(`http://localhost/api/voice/tts?${new URLSearchParams(query)}`)
  const ctx = { req, res, path: url.pathname, method: 'POST', url, auth: { kind: 'token' } } as RouteContext
  expect(await tryHandleVoice(ctx)).toBe(true)
  return out
}

describe('POST /api/voice/tts with ?agent=', () => {
  it('resolves a fleet agent\'s channel dir and goes on (here to the voice model check, before any synthesis)', async () => {
    const r = await tts({ chat_id: '123', agent: AGENT, voice_model: 'no-such-model' })
    expect(r.status).toBe(400)
    expect(r.body.error).toMatch(/voice model/)
  })

  it('an unknown, reserved or malformed agent id is a 400', async () => {
    for (const agent of ['nosuchagent', RESERVED_AGENT_IDS[0], 'system', '../x', 'a b']) {
      const r = await tts({ chat_id: '123', agent, voice_model: 'hu_HU-imre-medium' })
      expect(r.status, agent).toBe(400)
      expect(r.body.error, agent).toBe('Invalid agent')
    }
  })

  it('agent and state_dir together is a 400; the old state_dir shape alone still works', async () => {
    const both = await tts({ chat_id: '123', agent: AGENT, state_dir: agentChannel, voice_model: 'hu_HU-imre-medium' })
    expect(both.status).toBe(400)
    expect(both.body.error).toMatch(/not both/)
    const old = await tts({ chat_id: '123', state_dir: agentChannel, voice_model: 'no-such-model' })
    expect(old.status).toBe(400)
    expect(old.body.error).toMatch(/voice model/)
  })
})

// TTSBIND1125 (Dani's review on #3125): the caller is not identified, so the voice goes only to a chat the bot already
// lets in (its access.json allowFrom).
describe('POST /api/voice/tts sends only to a chat the channel lets in', () => {
  it('a chat outside the allowlist is a 403, by agent and by state_dir alike', async () => {
    const byAgent = await tts({ chat_id: '999', agent: AGENT, voice_model: 'hu_HU-imre-medium' })
    expect(byAgent.status).toBe(403)
    expect(byAgent.body.error).toMatch(/not allowed/)
    const byDir = await tts({ chat_id: '999', state_dir: agentChannel, voice_model: 'hu_HU-imre-medium' })
    expect(byDir.status).toBe(403)
  })

  it('a missing or malformed allowlist allows nothing', async () => {
    const { chatAllowedByChannel } = await import('../web/routes/voice.js')
    expect(chatAllowedByChannel(agentChannel, '123')).toBe(true)
    expect(chatAllowedByChannel(agentChannel, '12')).toBe(false)
    expect(chatAllowedByChannel(agentChannel, '1234')).toBe(false) // the allowed id as a prefix is not a match
    expect(chatAllowedByChannel(join(agentChannel, 'nope'), '123')).toBe(false)
    const odd = join(H.home, 'odd-dir')
    mkdirSync(odd, { recursive: true })
    writeFileSync(join(odd, 'access.json'), '{ not json')
    expect(chatAllowedByChannel(odd, '123')).toBe(false)
    writeFileSync(join(odd, 'access.json'), JSON.stringify({ allowFrom: 'not-a-list' }))
    expect(chatAllowedByChannel(odd, '123')).toBe(false)
    writeFileSync(join(odd, 'access.json'), JSON.stringify({ allowFrom: [123] }))
    expect(chatAllowedByChannel(odd, '123')).toBe(true)
  })
})
