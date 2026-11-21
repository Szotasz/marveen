// SLACKINVCOPY1121: since SLACKINVBIND1120 a Slack invite lets nobody in by itself; whoever messages the bot gets a
// pairing code and the owner approves it. The invite section's description said otherwise (the Telegram text: "anyone
// who clicks it starts the bot"). On Slack it now has its own text, in Hungarian and English, that names the owner's
// approval and the field it happens in; Telegram keeps its text.
import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '../..')
const SLACK_KEY = 'agents.channel.slack_invite_desc'
const TG_KEY = 'agents.channel.tg_invite_desc'

let hu: Record<string, string>
let en: Record<string, string>

beforeAll(async () => {
  ;(globalThis as unknown as { window: Record<string, unknown> }).window ||= {} as Record<string, unknown>
  await import(/* @vite-ignore */ '../../web/lang/hu.js' as string)
  await import(/* @vite-ignore */ '../../web/lang/en.js' as string)
  const i18n = (globalThis as unknown as { window: { _i18n: Record<string, Record<string, string>> } }).window._i18n
  hu = i18n.hu
  en = i18n.en
})

describe('the Slack invite description', () => {
  it('says the owner approves the pairing code, in the field the page shows (hu)', () => {
    expect(hu[SLACK_KEY]).toContain('senkit nem enged be magától')
    expect(hu[SLACK_KEY]).toContain('Neked kell jóváhagynod')
    expect(hu[SLACK_KEY]).toContain(hu['agents.channel.pair_code_label'])
    expect(hu[SLACK_KEY]).not.toMatch(/automatikusan|egy kattint/i)
  })

  it('says the same in English', () => {
    expect(en[SLACK_KEY]).toContain('lets nobody in by itself')
    expect(en[SLACK_KEY]).toContain('you approve that code')
    expect(en[SLACK_KEY]).toContain(en['agents.channel.pair_code_label'])
    expect(en[SLACK_KEY]).not.toMatch(/automatically/i)
  })

  it('has no em or en dash', () => {
    expect(hu[SLACK_KEY] + en[SLACK_KEY]).not.toMatch(/[\u2013\u2014]/)
  })
})

describe('wiring: the invite description follows the provider', () => {
  it('the paragraph has an id and updateProviderUI picks the Slack key on Slack, the Telegram key otherwise', () => {
    const html = readFileSync(join(ROOT, 'web', 'index.html'), 'utf-8')
    expect(html).toContain(`<p class="tg-pairing-info" id="chInviteDesc" data-i18n="${TG_KEY}">`)
    const app = readFileSync(join(ROOT, 'web', 'app.js'), 'utf-8')
    const fn = app.slice(app.indexOf('function updateProviderUI()'), app.indexOf('function updateChannelTab('))
    expect(fn).toContain(`inviteDesc.dataset.i18n = currentChannelProvider === 'slack' ? '${SLACK_KEY}' : '${TG_KEY}'`)
    expect(fn).toContain('inviteDesc.textContent = t(inviteDesc.dataset.i18n)')
  })
})
