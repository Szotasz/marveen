// AGENTCREATEPR3-1119 (Samu 81756, 2): an agent_create request too long for one Slack message is never split; the
// owner's Slack DM is a short pointer to the dashboard, with no post row, so no reply to it approves anything. A short
// request goes out whole. Slack, Telegram and the owner send are fakes; the DB is in memory.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { initDatabase, createApproval, getApprovalSlackPost } from '../db.js'

const slackTexts: string[] = []
vi.mock('../notify.js', () => ({
  sendOwnerSlackDm: async (text: string) => { slackTexts.push(text); return { attempted: true, sent: true } },
  sendOwnerMessage: async () => ({ sent: true }),
  notifyChannel: async () => {},
  notifyTelegram: async () => {},
  notifySecurityEvent: async () => {},
}))
vi.mock('../web/telegram.js', () => ({ sendTelegramMessage: async () => 42 }))
vi.mock('../config.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../config.js')>()
  return { ...real, MAIN_AGENT_ID: 'fo-agens', CHANNEL_PROVIDER: 'slack', DASHBOARD_PUBLIC_URL: 'https://marveen.example.com/' }
})

const gromzoPosts: Array<[string, string]> = []
vi.mock('../web/agent-create-gromzo.js', () => ({
  postAgentCreateToGromzo: async (a: { id: string }, lang: string) => { gromzoPosts.push([a.id, lang]); return 'posted' },
}))

const { _notifyOwnerForTest, _runAgentCreateNotifierForTest, _setAgentCreateNotifierForTest, approvalsPageUrl } = await import('../web/routes/approvals.js')
const { OWNER_TEXT } = await import('../web/approval-texts.js')

let n = 0
const agentCreate = (text: string) => createApproval({
  id: `ac-notify-${n++}`, agent_id: 'samu', category: 'agent_create', action_description: text, action_payload: null,
  timeout_at: Math.floor(Date.now() / 1000) + 3600, content_hash: 'a'.repeat(64),
})
const settle = () => new Promise((r) => setTimeout(r, 20))

beforeEach(() => { initDatabase(':memory:'); slackTexts.length = 0; gromzoPosts.length = 0 })

describe('an agent_create request in the owner\'s Slack DM', () => {
  it('too long for one message: the short dashboard pointer, never the text in parts; no post row', async () => {
    const a = agentCreate('Új ügynök létrehozása, jóváhagyásra:\n' + '- sor\n'.repeat(800))
    _notifyOwnerForTest(a, 'hu')
    await settle()
    expect(slackTexts).toEqual([OWNER_TEXT.hu.agentCreateTooLong(a.id, approvalsPageUrl())])
    expect(slackTexts[0]).toContain('túl hosszú a Slackhez, a dashboardon döntesz')
    expect(getApprovalSlackPost(a.id)).toBeUndefined()
  })
  it('in English too', async () => {
    const a = agentCreate('x'.repeat(4000))
    _notifyOwnerForTest(a, 'en')
    await settle()
    expect(slackTexts).toEqual([OWNER_TEXT.en.agentCreateTooLong(a.id, approvalsPageUrl())])
  })
  it('a short request goes out whole', async () => {
    const a = agentCreate('Új ügynök létrehozása, jóváhagyásra:\n- azonosító: kutato')
    _notifyOwnerForTest(a, 'hu')
    await settle()
    expect(slackTexts).toHaveLength(1)
    expect(slackTexts[0]).toContain('- azonosító: kutato')
    expect(slackTexts[0]).not.toContain('túl hosszú')
  })
})

describe('the default agent_create notifier', () => {
  it('asks the owner\'s channels AND posts to the Gromzo app', async () => {
    _setAgentCreateNotifierForTest(null)
    const a = agentCreate('Új ügynök létrehozása, jóváhagyásra:\n- azonosító: kutato')
    _runAgentCreateNotifierForTest(a, 'hu')
    await settle()
    expect(slackTexts).toHaveLength(1)
    expect(gromzoPosts).toEqual([[a.id, 'hu']])
  })
})
