// APPROVALTAGEN1108, step 1 (EGM design review M2): every Hungarian text the server sends the owner about an approval,
// pinned as a FULL string before the texts get an English version. The earlier pins were fragments (toContain), so a
// refactor could change a Hungarian line unnoticed. The strings were captured from the code at develop 9b31f2ad; only
// the dashboard URL and the formatted date are computed here, with the code's own formula (they depend on the host's
// settings, not on this change).
import { describe, it, expect } from 'vitest'
import { buildOwnerApprovalText, buildOwnerChatApprovedText, approvalsPageUrl } from '../web/routes/approvals.js'
import { reactionText, dashboardOnlyLine, OWNER_EDITED_NOTICE } from '../web/approval-slack-route.js'
import { envelopeText } from '../approval-envelope.js'
import { announceSlackTargetChange, announceSlackOwnerChange } from '../notify.js'
import { APP_TZ } from '../config.js'
import type { Approval } from '../db.js'

const A = {
  id: 'test-id-1234', agent_id: 'samu', category: 'skill_patch', action_description: 'Skill frissítése', action_payload: null,
  status: 'pending', timeout_at: 1787303600, telegram_message_id: null, requested_at: 1787300000,
} as unknown as Approval
const NOW = new Date(1787300000000)
const huWhen = (d: Date) => d.toLocaleString('hu-HU', { timeZone: APP_TZ })

describe('the Hungarian approval texts, byte for byte (APPROVALTAGEN1108 golden)', () => {
  it('the owner request (buildOwnerApprovalText), with and without an expiry', () => {
    expect(buildOwnerApprovalText(A)).toBe(
      `[JÓVÁHAGYÁS KELL] samu | skill_patch\nSkill frissítése\nLejárat: ${huWhen(new Date(1787303600 * 1000))}\nDöntés: Dashboard -> Jóváhagyások (id: test-id-1234)\n${approvalsPageUrl()}`)
    expect(buildOwnerApprovalText({ ...A, timeout_at: null })).toBe(
      `[JÓVÁHAGYÁS KELL] samu | skill_patch\nSkill frissítése\nLejárat: nincs\nDöntés: Dashboard -> Jóváhagyások (id: test-id-1234)\n${approvalsPageUrl()}`)
  })

  it('the informative variant (buildOwnerChatApprovedText)', () => {
    expect(buildOwnerChatApprovedText(A, 4711)).toBe(
      '[JÓVÁHAGYVA A CHATBEN] samu | skill_patch\nSkill frissítése\nJóváhagyás: a chat-üzeneted (üzenet-azonosító: 4711)\nNincs további teendőd, ez csak tájékoztatás.\nNapló: Dashboard -> Jóváhagyások (id: test-id-1234)')
  })

  it('the Slack DM (reactionText) in its three modes', () => {
    const head = '[JÓVÁHAGYÁS KELL] samu | skill_patch\nCONTENT\nLejárat: EXPIRES\n'
    const tail = '\nVagy a dashboardon: http://x/#approvals (id: test-id-1234)'
    expect(reactionText(A, 'CONTENT', 'EXPIRES', 'http://x/#approvals', { reaction: true, reply: false })).toBe(
      head + 'Döntés: reagálj erre az üzenetre ✅ (jóváhagyás) vagy ❌ (elutasítás) reakcióval. Csak a te reakciód számít, és csak amíg ez az üzenet változatlan.' + tail)
    expect(reactionText(A, 'CONTENT', 'EXPIRES', 'http://x/#approvals', { reaction: false, reply: true })).toBe(
      head + 'Döntés: írd be válaszként: mehet (jóváhagyás) vagy nem (elutasítás). Csak a te válaszod számít, és csak amíg ez az üzenet változatlan.' + tail)
    expect(reactionText(A, 'CONTENT', 'EXPIRES', 'http://x/#approvals', { reaction: true, reply: true })).toBe(
      head + 'Döntés: írd be válaszként: mehet (jóváhagyás) vagy nem (elutasítás), vagy reagálj ✅ / ❌ reakcióval. Csak a te válaszod számít, és csak amíg ez az üzenet változatlan.' + tail)
  })

  it('the dashboard-only line and the edited-message notice', () => {
    expect(dashboardOnlyLine('switch_off')).toBe('Erre a kérésre a Slackes jóváhagyás nem érhető el (switch_off); a döntés a dashboardon.')
    expect(OWNER_EDITED_NOTICE).toBe('A szerkesztett üzenetet nem veszem döntésnek. Ha döntöttél, írd be újra: mehet vagy nem.')
  })

  it('the e-mail as the owner reads it (envelopeText), every field and the minimum', () => {
    expect(envelopeText({ to: ['a@x.hu'], cc: [], bcc: ['b@x.hu'], account: 'acc', reply_to: ['r@x.hu'], render: 'html', body_format: 'markdown',
      html_sha256: 'h1', attachments: [{ name: 'f.pdf', sha256: 's1' }], text: 'Szia!' } as never, 'ANCHOR')).toBe(
      'Címzett: a@x.hu\nMásolat: -\nTitkos másolat: b@x.hu\nFiók: acc\nVálasz erre: r@x.hu\nMegjelenítés: html\nFormátum: markdown\nHTML sha256: h1\nCsatolmány: f.pdf (sha256 s1)\nSzöveg:\nSzia!\nHorgony (sha256): ANCHOR')
    expect(envelopeText({ to: [], cc: [], text: 'x' } as never, 'ANCHOR')).toBe('Címzett: (nincs)\nMásolat: -\nSzöveg:\nx\nHorgony (sha256): ANCHOR')
  })

  it('the two tamper alerts of the approval path (notify.ts)', async () => {
    let sent = ''
    const send = (async (_t: string, text: string) => { sent = text; return { ok: true } }) as never
    expect((await announceSlackTargetChange('C1', 'C2', { send, now: NOW })).sent).toBe(true)
    expect(sent).toBe(`[FIGYELEM] A gazda-értesítések és jóváhagyás-kérések Slack-célja megváltozott: C1 -> C2 (${huWhen(NOW)}).\nIde ezután nem jönnek a kérések.\nHa nem te változtattál, a Dashboard -> Beállítások -> NOTIFY_SLACK_TARGET alatt állítsd vissza, és szólj.`)
    expect((await announceSlackOwnerChange('U0ABCDEF1', 'U0ABCDEF2', { send, readAccess: () => null, now: NOW })).sent).toBe(true)
    expect(sent).toBe(`[FIGYELEM] A jóváhagyó Slack-azonosító megváltozott: U0ABCDEF1 -> U0ABCDEF2 (${huWhen(NOW)}).\nMostantól nem a te Slack-reakciód hagyja jóvá a kéréseket.\nHa nem te változtattál, a Dashboard -> Beállítások -> SLACK_OWNER_USER_ID alatt állítsd vissza, és szólj.`)
  })
})
