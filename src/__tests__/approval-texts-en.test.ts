// APPROVALTAGEN1108 (Samu 73344, 73350): every owner-facing approval text in English, pinned as a FULL string, so the
// English copy is one reviewable list for the owner's copy round and a later edit is a visible diff. The Hungarian
// counterparts are pinned in approval-texts-golden-hu.test.ts; the two server-written descriptions (second reviewer,
// memory delete) are new in scope here, so their Hungarian is pinned here too, byte for byte as before this change.
import { describe, it, expect } from 'vitest'
import { buildOwnerApprovalText, buildOwnerChatApprovedText, approvalsPageUrl } from '../web/routes/approvals.js'
import { reactionText, dashboardOnlyLine, decisionFeedback } from '../web/approval-slack-route.js'
import { envelopeText } from '../approval-envelope.js'
import { announceSlackTargetChange, announceSlackOwnerChange } from '../notify.js'
import { describeCall } from '../web/routes/review-action.js'
import { memoryDeleteDescription } from '../web/routes/memories.js'
import { OWNER_TEXT, formatExpiry } from '../web/approval-texts.js'
import { APP_TZ } from '../config.js'
import type { Approval } from '../db.js'

const A = {
  id: 'test-id-1234', agent_id: 'samu', category: 'skill_patch', action_description: 'Update a skill', action_payload: null,
  status: 'pending', timeout_at: 1787303600, telegram_message_id: null, requested_at: 1787300000,
} as unknown as Approval
const NOW = new Date(1787300000000)
const enWhen = (d: Date) => d.toLocaleString('en-GB', { timeZone: APP_TZ, dateStyle: 'medium', timeStyle: 'medium' })
const enExpiry = (s: number) => new Date(s * 1000).toLocaleString('en-GB', { timeZone: APP_TZ, dateStyle: 'medium', timeStyle: 'short' })

// The Hungarian words the English decide line names on purpose (they decide on an English post too, Samu 73344 Q2).
const NAMED_HU_WORDS = ['mehet', 'jóváhagyom', 'nem', 'elutasítom']
function noHungarianLeft(text: string): void {
  let rest = text
  for (const w of NAMED_HU_WORDS) rest = rest.split(w).join('')
  expect(rest, text).not.toMatch(/[áéíóöőúüűÁÉÍÓÖŐÚÜŰ]/)
  for (const hu of ['Lejárat', 'nincs', 'Döntés', 'Jóváhagyások', 'FIGYELEM', 'JÓVÁHAGYÁS']) expect(rest, text).not.toContain(hu)
}

describe('the English approval texts, byte for byte (APPROVALTAGEN1108)', () => {
  it('the owner request (buildOwnerApprovalText), with and without an expiry', () => {
    const withExpiry = buildOwnerApprovalText(A, 'en')
    expect(withExpiry).toBe(
      `[APPROVAL NEEDED] samu | skill_patch\nUpdate a skill\nExpires: ${enExpiry(1787303600)}\nDecide: Dashboard -> Approvals (id: test-id-1234)\n${approvalsPageUrl()}`)
    expect(buildOwnerApprovalText({ ...A, timeout_at: null }, 'en')).toBe(
      `[APPROVAL NEEDED] samu | skill_patch\nUpdate a skill\nExpires: none\nDecide: Dashboard -> Approvals (id: test-id-1234)\n${approvalsPageUrl()}`)
    noHungarianLeft(withExpiry)
  })

  it('the informative variant (buildOwnerChatApprovedText)', () => {
    expect(buildOwnerChatApprovedText(A, 4711, 'en')).toBe(
      '[APPROVED IN CHAT] samu | skill_patch\nUpdate a skill\nApproved by: your chat message (message id: 4711)\nNothing more to do, this is for your information.\nLog: Dashboard -> Approvals (id: test-id-1234)')
  })

  it('the Slack DM (reactionText) in its three modes; the reply line names every word that decides on an English post', () => {
    const head = '[APPROVAL NEEDED] samu | skill_patch\nCONTENT\nExpires: EXPIRES\n'
    const tail = '\nOr on the dashboard: http://x/#approvals (id: test-id-1234)'
    const r1 = reactionText(A, 'CONTENT', 'EXPIRES', 'http://x/#approvals', { reaction: true, reply: false }, 'en')
    expect(r1).toBe(head + 'To decide: react to this message with ✅ (approve) or ❌ (reject). Only your reaction counts, and only while this message is unchanged.' + tail)
    const r2 = reactionText(A, 'CONTENT', 'EXPIRES', 'http://x/#approvals', { reaction: false, reply: true }, 'en')
    expect(r2).toBe(head + 'To decide: reply with approve or go (approve), or reject or no (reject); mehet, jóváhagyom, nem and elutasítom work too. Only your reply counts, and only while this message is unchanged.' + tail)
    const r3 = reactionText(A, 'CONTENT', 'EXPIRES', 'http://x/#approvals', { reaction: true, reply: true }, 'en')
    expect(r3).toBe(head + 'To decide: reply with approve or go (approve), or reject or no (reject); mehet, jóváhagyom, nem and elutasítom work too; or react with ✅ / ❌. Only your reply counts, and only while this message is unchanged.' + tail)
    for (const t of [r1, r2, r3]) noHungarianLeft(t)
  })

  it('the dashboard-only line and the edited-message notice', () => {
    expect(dashboardOnlyLine('switch_off', 'en')).toBe('Slack approval is not available for this request (switch_off); decide on the dashboard.')
    expect(OWNER_TEXT.en.editedNotice).toBe('An edited message does not count as a decision. If you decided, write it again: approve or reject.')
  })

  it('the e-mail as the owner reads it (envelopeText), every field and the minimum', () => {
    const full = envelopeText({ to: ['a@x.hu'], cc: [], bcc: ['b@x.hu'], account: 'acc', reply_to: ['r@x.hu'], render: 'html', body_format: 'markdown',
      html_sha256: 'h1', attachments: [{ name: 'f.pdf', sha256: 's1' }], text: 'Hi!' } as never, 'ANCHOR', 'en')
    expect(full).toBe('To: a@x.hu\nCc: -\nBcc: b@x.hu\nAccount: acc\nReply to: r@x.hu\nRendering: html\nFormat: markdown\nHTML sha256: h1\nAttachment: f.pdf (sha256 s1)\nText:\nHi!\nAnchor (sha256): ANCHOR')
    expect(envelopeText({ to: [], cc: [], text: 'x' } as never, 'ANCHOR', 'en')).toBe('To: (none)\nCc: -\nText:\nx\nAnchor (sha256): ANCHOR')
    noHungarianLeft(full)
  })

  it('the two tamper alerts of the approval path (notify.ts)', async () => {
    let sent = ''
    const send = (async (_t: string, text: string) => { sent = text; return { ok: true } }) as never
    expect((await announceSlackTargetChange('C1', 'C2', { send, now: NOW, lang: 'en' })).sent).toBe(true)
    expect(sent).toBe(`[WARNING] The Slack target of owner notifications and approval requests changed: C1 -> C2 (${enWhen(NOW)}).\nRequests no longer come here.\nIf you did not change it, set it back under Dashboard -> Settings -> NOTIFY_SLACK_TARGET, and say so.`)
    noHungarianLeft(sent)
    expect((await announceSlackOwnerChange('U0ABCDEF1', 'U0ABCDEF2', { send, readAccess: () => null, now: NOW, lang: 'en' })).sent).toBe(true)
    expect(sent).toBe(`[WARNING] The Slack user id that approves requests changed: U0ABCDEF1 -> U0ABCDEF2 (${enWhen(NOW)}).\nFrom now on your Slack reaction does not approve requests.\nIf you did not change it, set it back under Dashboard -> Settings -> SLACK_OWNER_USER_ID, and say so.`)
    noHungarianLeft(sent)
  })

  it('the expiry: en medium date + short time, "none" without one; hu exactly as before', () => {
    expect(formatExpiry(1787303600, 'en')).toBe(enExpiry(1787303600))
    expect(formatExpiry(null, 'en')).toBe('none')
    expect(formatExpiry(1787303600, 'hu')).toBe(new Date(1787303600 * 1000).toLocaleString('hu-HU', { timeZone: APP_TZ }))
    expect(formatExpiry(null, 'hu')).toBe('nincs')
  })
})

describe('the DM thread after a decision (decisionFeedback), in the post language', () => {
  const via = { binding: 'next_message' as const, ts: '1700000001.000200' }
  it('hu: the texts as before', () => {
    expect(decisionFeedback({ kind: 'approved', userId: 'U', via }, true, '10:15', 'http://x/#approvals', 'hu'))
      .toBe('Jóváhagyva (10:15, a 1700000001.000200 üzeneted alapján). Ha nem erre gondoltál: http://x/#approvals')
    expect(decisionFeedback({ kind: 'rejected', userId: 'U', via }, true, '10:15', 'http://x/#approvals', 'hu'))
      .toBe('Elutasítva (10:15, a 1700000001.000200 üzeneted alapján).')
    expect(decisionFeedback({ kind: 'approved', userId: 'U' }, true, '10:15', '', 'hu')).toBe('Jóváhagyva (10:15, Slack-reakció).')
    expect(decisionFeedback({ kind: 'approved', userId: 'U', via }, false, '10:15', '', 'hu'))
      .toBe('A kérés már nem volt függőben (lejárt, vagy máshol döntöttek róla), ezért nem változott (10:15).')
    expect(decisionFeedback({ kind: 'refused', reason: 'owner_mismatch' } as never, true, '10:15', '', 'hu'))
      .toBe('Elutasítva (10:15): a döntés nem fogadható el (owner_mismatch). Ha jóvá akartad hagyni, kérd újra.')
  })
  it('en: the same five outcomes', () => {
    const all = [
      decisionFeedback({ kind: 'approved', userId: 'U', via }, true, '10:15', 'http://x/#approvals', 'en'),
      decisionFeedback({ kind: 'rejected', userId: 'U', via }, true, '10:15', 'http://x/#approvals', 'en'),
      decisionFeedback({ kind: 'approved', userId: 'U' }, true, '10:15', '', 'en'),
      decisionFeedback({ kind: 'approved', userId: 'U', via }, false, '10:15', '', 'en'),
      decisionFeedback({ kind: 'refused', reason: 'owner_mismatch' } as never, true, '10:15', '', 'en'),
    ]
    expect(all).toEqual([
      'Approved (10:15, based on your message 1700000001.000200). If this is not what you meant: http://x/#approvals',
      'Rejected (10:15, based on your message 1700000001.000200).',
      'Approved (10:15, Slack reaction).',
      'The request was no longer pending (it expired, or was decided elsewhere), so nothing changed (10:15).',
      'Rejected (10:15): the decision could not be accepted (owner_mismatch). If you meant to approve, ask again.',
    ])
    for (const t of all) noHungarianLeft(t)
  })
})

describe('the server-written descriptions (Samu 73350: in scope, in the post language)', () => {
  it('the second reviewer: hu as before, en; a long call points at the dashboard in both', () => {
    expect(describeCall('samu', 'Bash', 'unsure', '{"command":"ls"}', 'hu')).toBe('Második ellenőr: samu Bash hívása jóváhagyásra vár (unsure)\n{"command":"ls"}')
    expect(describeCall('samu', 'Bash', 'unsure', '{"command":"ls"}', 'en')).toBe('Second reviewer: samu\'s Bash call is waiting for approval (unsure)\n{"command":"ls"}')
    const long = 'x'.repeat(3001)
    expect(describeCall('samu', 'Bash', 'r', long, 'hu')).toBe('Második ellenőr: samu Bash hívása jóváhagyásra vár (r)\n(3001 karakter; a teljes hívás a dashboardon, a jóváhagyás adatai között)')
    const en = describeCall('samu', 'Bash', 'r', long, 'en')
    expect(en).toBe('Second reviewer: samu\'s Bash call is waiting for approval (r)\n(3001 characters; the full call is on the dashboard, in the approval\'s details)')
    noHungarianLeft(en)
    // The boundary: 3000 characters still carry the call itself.
    expect(describeCall('samu', 'Bash', 'r', 'y'.repeat(3000), 'en').endsWith('\n' + 'y'.repeat(3000))).toBe(true)
  })

  it('the memory delete: hu as before, en; unknown owner/caller and a long content in both', () => {
    const row = { id: 7, agent_id: 'geri', category: 'warm', content: 'a  b\nc' } as never
    expect(memoryDeleteDescription(row, 'geri', 'hu')).toBe(
      'Emlék végleges törlése: #7 (gazdája: geri, tier: warm, 6 karakter). Kezdete: "a b c" Kérte: geri. A törlés a verziókat is viszi, nem visszaállítható.')
    const en = memoryDeleteDescription(row, 'geri', 'en')
    expect(en).toBe(
      'Permanent deletion of memory #7 (owner: geri, tier: warm, 6 characters). Starts with: "a b c" Requested by: geri. The deletion takes its versions too and cannot be undone.')
    noHungarianLeft(en)
    const anon = { id: 8, agent_id: null, category: null, content: 'y'.repeat(170) } as never
    expect(memoryDeleteDescription(anon, undefined, 'hu')).toBe(
      `Emlék végleges törlése: #8 (gazdája: ismeretlen, tier: -, 170 karakter). Kezdete: "${'y'.repeat(160)}..." Kérte: ismeretlen hívó. A törlés a verziókat is viszi, nem visszaállítható.`)
    expect(memoryDeleteDescription(anon, undefined, 'en')).toBe(
      `Permanent deletion of memory #8 (owner: unknown, tier: -, 170 characters). Starts with: "${'y'.repeat(160)}..." Requested by: unknown caller. The deletion takes its versions too and cannot be undone.`)
  })
})
