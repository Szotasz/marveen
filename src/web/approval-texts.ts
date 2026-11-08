// APPROVALTAGEN1108 (Samu 73234, 73344): every text the server sends the OWNER about an approval, in the post's /
// install's language (approvalTextLang(): the explicit AGENT_TEXT_LANG key). One table per text, so the English copy
// is one list for the owner's copy round, and the Hungarian stays byte-for-byte as before (approval-texts-golden-hu).
// The tags are [APPROVAL NEEDED] / [APPROVED IN CHAT] (Samu 73344 Q3). The words that DECIDE live in
// src/approval-slack.ts (APPROVE_WORDS, APPROVE_WORDS_EN, ...); the English decide line names every word that decides
// there on an English post, the Hungarian ones included (EGM design m2).
import type { ApprovalLang } from '../approval-slack.js'
import { APP_TZ } from '../config.js'

export type { ApprovalLang }

/** The expiry as the owner reads it: hu exactly as before; en a medium date and a short time, the same zone. */
export function formatExpiry(timeoutAt: number | null | undefined, lang: ApprovalLang): string {
  if (!timeoutAt) return lang === 'en' ? 'none' : 'nincs'
  const d = new Date(timeoutAt * 1000)
  return lang === 'en'
    ? d.toLocaleString('en-GB', { timeZone: APP_TZ, dateStyle: 'medium', timeStyle: 'short' })
    : d.toLocaleString('hu-HU', { timeZone: APP_TZ })
}

/** A wall-clock moment in an owner alert (the notify.ts tamper alerts): hu exactly as before. */
export function formatMoment(d: Date, lang: ApprovalLang): string {
  return lang === 'en'
    ? d.toLocaleString('en-GB', { timeZone: APP_TZ, dateStyle: 'medium', timeStyle: 'medium' })
    : d.toLocaleString('hu-HU', { timeZone: APP_TZ })
}

/** The time of a decision in the DM thread (hours:minutes), in APP_TZ. */
export function formatDecisionTime(d: Date, lang: ApprovalLang): string {
  return d.toLocaleTimeString(lang === 'en' ? 'en-GB' : 'hu-HU', { hour: '2-digit', minute: '2-digit', timeZone: APP_TZ })
}

export const OWNER_TEXT = {
  hu: {
    requestTag: '[JÓVÁHAGYÁS KELL]',
    chatApprovedTag: '[JÓVÁHAGYVA A CHATBEN]',
    expires: 'Lejárat',
    decideOnDashboard: (id: string) => `Döntés: Dashboard -> Jóváhagyások (id: ${id})`,
    chatApprovedBy: (messageId: string) => `Jóváhagyás: a chat-üzeneted (üzenet-azonosító: ${messageId})`,
    nothingToDo: 'Nincs további teendőd, ez csak tájékoztatás.',
    logOnDashboard: (id: string) => `Napló: Dashboard -> Jóváhagyások (id: ${id})`,
    decideLine: {
      reaction: 'Döntés: reagálj erre az üzenetre ✅ (jóváhagyás) vagy ❌ (elutasítás) reakcióval. Csak a te reakciód számít, és csak amíg ez az üzenet változatlan.',
      reply: 'Döntés: írd be válaszként: mehet (jóváhagyás) vagy nem (elutasítás). Csak a te válaszod számít, és csak amíg ez az üzenet változatlan.',
      both: 'Döntés: írd be válaszként: mehet (jóváhagyás) vagy nem (elutasítás), vagy reagálj ✅ / ❌ reakcióval. Csak a te válaszod számít, és csak amíg ez az üzenet változatlan.',
    },
    orOnDashboard: (pageUrl: string, id: string) => `Vagy a dashboardon: ${pageUrl} (id: ${id})`,
    dashboardOnly: (reason: string) => `Erre a kérésre a Slackes jóváhagyás nem érhető el (${reason}); a döntés a dashboardon.`,
    result: { approved: 'Jóváhagyva', rejected: 'Elutasítva' },
    editedNotice: 'A szerkesztett üzenetet nem veszem döntésnek. Ha döntöttél, írd be újra: mehet vagy nem.',
    refusedFeedback: (when: string, reason: string) => `Elutasítva (${when}): a döntés nem fogadható el (${reason}). Ha jóvá akartad hagyni, kérd újra.`,
    unchangedFeedback: (when: string) => `A kérés már nem volt függőben (lejárt, vagy máshol döntöttek róla), ezért nem változott (${when}).`,
    replyFeedback: (result: string, when: string, ts: string) => `${result} (${when}, a ${ts} üzeneted alapján).`,
    notMeant: (pageUrl: string) => ` Ha nem erre gondoltál: ${pageUrl}`,
    reactionFeedback: (result: string, when: string) => `${result} (${when}, Slack-reakció).`,
    alertReplyUsed: (id: string) => `[FIGYELEM] Egy Slack-válasz már egy másik kérést döntött el, ezért ez a kérés elutasítva (id: ${id}).`,
    alertRefused: (reason: string, id: string) => `[FIGYELEM] Egy Slackes jóváhagyás nem volt elfogadható (${reason}), a kérés elutasítva (id: ${id}).`,
    targetChanged: (before: string, after: string, when: string) => [
      `[FIGYELEM] A gazda-értesítések és jóváhagyás-kérések Slack-célja megváltozott: ${before} -> ${after || '(nincs)'} (${when}).`,
      'Ide ezután nem jönnek a kérések.',
      'Ha nem te változtattál, a Dashboard -> Beállítások -> NOTIFY_SLACK_TARGET alatt állítsd vissza, és szólj.',
    ].join('\n'),
    ownerChanged: (before: string, after: string | null, when: string) => [
      `[FIGYELEM] A jóváhagyó Slack-azonosító megváltozott: ${before} -> ${after ?? '(nincs)'} (${when}).`,
      'Mostantól nem a te Slack-reakciód hagyja jóvá a kéréseket.',
      'Ha nem te változtattál, a Dashboard -> Beállítások -> SLACK_OWNER_USER_ID alatt állítsd vissza, és szólj.',
    ].join('\n'),
  },
  en: {
    requestTag: '[APPROVAL NEEDED]',
    chatApprovedTag: '[APPROVED IN CHAT]',
    expires: 'Expires',
    decideOnDashboard: (id: string) => `Decide: Dashboard -> Approvals (id: ${id})`,
    chatApprovedBy: (messageId: string) => `Approved by: your chat message (message id: ${messageId})`,
    nothingToDo: 'Nothing more to do, this is for your information.',
    logOnDashboard: (id: string) => `Log: Dashboard -> Approvals (id: ${id})`,
    decideLine: {
      reaction: 'To decide: react to this message with ✅ (approve) or ❌ (reject). Only your reaction counts, and only while this message is unchanged.',
      reply: 'To decide: reply with approve or go (approve), or reject or no (reject); mehet, jóváhagyom, nem and elutasítom work too. Only your reply counts, and only while this message is unchanged.',
      both: 'To decide: reply with approve or go (approve), or reject or no (reject); mehet, jóváhagyom, nem and elutasítom work too; or react with ✅ / ❌. Only your reply counts, and only while this message is unchanged.',
    },
    orOnDashboard: (pageUrl: string, id: string) => `Or on the dashboard: ${pageUrl} (id: ${id})`,
    dashboardOnly: (reason: string) => `Slack approval is not available for this request (${reason}); decide on the dashboard.`,
    result: { approved: 'Approved', rejected: 'Rejected' },
    editedNotice: 'An edited message does not count as a decision. If you decided, write it again: approve or reject.',
    refusedFeedback: (when: string, reason: string) => `Rejected (${when}): the decision could not be accepted (${reason}). If you meant to approve, ask again.`,
    unchangedFeedback: (when: string) => `The request was no longer pending (it expired, or was decided elsewhere), so nothing changed (${when}).`,
    replyFeedback: (result: string, when: string, ts: string) => `${result} (${when}, based on your message ${ts}).`,
    notMeant: (pageUrl: string) => ` If this is not what you meant: ${pageUrl}`,
    reactionFeedback: (result: string, when: string) => `${result} (${when}, Slack reaction).`,
    alertReplyUsed: (id: string) => `[WARNING] A Slack reply had already decided another request, so this request was rejected (id: ${id}).`,
    alertRefused: (reason: string, id: string) => `[WARNING] A Slack approval could not be accepted (${reason}), so the request was rejected (id: ${id}).`,
    targetChanged: (before: string, after: string, when: string) => [
      `[WARNING] The Slack target of owner notifications and approval requests changed: ${before} -> ${after || '(none)'} (${when}).`,
      'Requests no longer come here.',
      'If you did not change it, set it back under Dashboard -> Settings -> NOTIFY_SLACK_TARGET, and say so.',
    ].join('\n'),
    ownerChanged: (before: string, after: string | null, when: string) => [
      `[WARNING] The Slack user id that approves requests changed: ${before} -> ${after ?? '(none)'} (${when}).`,
      'From now on your Slack reaction does not approve requests.',
      'If you did not change it, set it back under Dashboard -> Settings -> SLACK_OWNER_USER_ID, and say so.',
    ].join('\n'),
  },
}

export type OwnerText = (typeof OWNER_TEXT)['hu']
