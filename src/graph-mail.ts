import { logger } from './logger.js'
import {
  type GraphCredentials,
  graphError,
  graphFetch,
  loadCredentials,
  parseCredentials as parseCredentialsShared,
  userPath,
} from './graph-client.js'

// Microsoft Graph mail for a single M365 mailbox (marveen@pecibt.hu), via the
// app-only client-credentials flow. The app registration holds NO tenant-wide
// Mail.* Graph permission; access is scoped to one mailbox by an Exchange
// Online RBAC ManagementScope, so this module can only ever touch that box.
// See the m365-graph-mailbox-scoping skill for the full provisioning story.
//
// The credentials file, the token cache and the fetch wrapper now live in
// graph-client.ts, shared with graph-calendar and graph-files. The public API
// of this module is unchanged.

const PREFIX = 'graph-mail'

/** Re-exported so existing callers keep importing it from here. */
export type MailCredentials = GraphCredentials

export function parseCredentials(content: string): GraphCredentials {
  return parseCredentialsShared(content, PREFIX)
}

export interface GraphMessage {
  id: string
  subject?: string
  from?: { emailAddress?: { name?: string; address?: string } }
  toRecipients?: Array<{ emailAddress?: { name?: string; address?: string } }>
  receivedDateTime?: string
  bodyPreview?: string
  isRead?: boolean
  webLink?: string
  conversationId?: string
  hasAttachments?: boolean
}

/** One message read in full: the list fields plus the body and the threading ids. */
export interface GraphFullMessage extends GraphMessage {
  ccRecipients?: Array<{ emailAddress?: { name?: string; address?: string } }>
  /** The Reply-To header: set by the sender, so an outsider controls it. */
  replyTo?: Array<{ emailAddress?: { name?: string; address?: string } }>
  internetMessageId?: string
  body?: { contentType?: string; content?: string }
}

/**
 * An image embedded in an HTML body and referenced from it as `cid:<cid>`
 * (the signature logo and icons). Graph sends it as an inline fileAttachment.
 */
export interface InlineImage {
  cid: string
  /** base64, as Graph expects it */
  contentBytes: string
  contentType: string
  name?: string
}

export interface SendMailOptions {
  to: string | string[]
  subject: string
  body: string
  cc?: string | string[]
  /** 'Text' (default) or 'HTML' for the Graph message body contentType. */
  contentType?: 'Text' | 'HTML'
  /** Persist the sent message to the mailbox Sent Items. Default true. */
  saveToSentItems?: boolean
  /**
   * File attachments. `contentBytes` is base64, as Graph expects it.
   * The combined base64 size is capped at MAX_TOTAL_ATTACHMENT_BASE64_BYTES
   * and rejected here, before the request is built -- Graph's own limit on a
   * simple /sendMail would otherwise surface as an opaque request failure.
   */
  attachments?: { name: string; contentBytes: string; contentType?: string }[]
  /** Images referenced from an HTML body as cid:<cid>. Counted into the attachment cap. */
  inlineImages?: InlineImage[]
  /**
   * Graph id of a message in this mailbox to answer. When set, the mail goes
   * out through /messages/{id}/reply, so it lands in the same conversation on
   * the recipient's side (sendMail cannot set In-Reply-To: Graph only accepts
   * custom x- headers). Graph builds the "RE:" subject itself, so `subject`
   * is not sent on this path.
   */
  replyToId?: string
}

/**
 * Ceiling for the combined base64 payload of all attachments on one message.
 * Graph caps a simple /sendMail request at a few MB total; this sits under it
 * so the failure is ours, named and local, rather than a Graph-side reject.
 */
export const MAX_TOTAL_ATTACHMENT_BASE64_BYTES = 3 * 1024 * 1024

export interface ListMessagesOptions {
  /** How many messages to return (Graph $top). Default 10, capped at 50. */
  top?: number
  /** Well-known folder id, e.g. 'inbox' (default) or 'sentitems'. */
  folder?: string
  /** Only unread messages (Graph $filter isRead eq false). */
  unreadOnly?: boolean
  /** Only messages received at or after this instant (ISO 8601, UTC). */
  since?: string
}

function mailboxPath(): string {
  return userPath(PREFIX)
}

function toRecipientList(addrs: string | string[]): Array<{ emailAddress: { address: string } }> {
  return (Array.isArray(addrs) ? addrs : [addrs])
    .map((a) => a.trim())
    .filter(Boolean)
    .map((address) => ({ emailAddress: { address } }))
}

/** List messages from the scoped mailbox (default: 10 newest from Inbox). */
export async function listMessages(options: ListMessagesOptions = {}): Promise<GraphMessage[]> {
  const top = Math.min(Math.max(options.top ?? 10, 1), 50)
  const folder = options.folder ?? 'inbox'
  const params = new URLSearchParams({
    $top: String(top),
    $orderby: 'receivedDateTime desc',
    $select: 'id,subject,from,toRecipients,receivedDateTime,bodyPreview,isRead,webLink,conversationId,hasAttachments',
  })
  const filters: string[] = []
  // Graph wants the $orderby property to appear first in a combined $filter.
  if (options.since) filters.push(`receivedDateTime ge ${new Date(options.since).toISOString()}`)
  if (options.unreadOnly) filters.push('isRead eq false')
  if (filters.length) params.set('$filter', filters.join(' and '))
  const res = await graphFetch(
    `${mailboxPath()}/mailFolders/${encodeURIComponent(folder)}/messages?${params}`,
    { prefix: PREFIX },
  )
  if (!res.ok) throw await graphError(PREFIX, 'listMessages', res)
  const json = (await res.json()) as { value?: GraphMessage[] }
  return json.value ?? []
}

/**
 * Build the Graph message resource for a send or a reply. Pure, so the
 * attachment cap and the inline-image shape are testable without a network.
 */
export function buildMessage(options: SendMailOptions): Record<string, unknown> {
  const message: Record<string, unknown> = {
    body: { contentType: options.contentType ?? 'Text', content: options.body },
    toRecipients: toRecipientList(options.to),
  }
  if (!options.replyToId) message.subject = options.subject
  if (options.cc) message.ccRecipients = toRecipientList(options.cc)
  const files = options.attachments ?? []
  const inline = options.inlineImages ?? []
  if (inline.length && (options.contentType ?? 'Text') !== 'HTML') {
    throw new Error('graph-mail: inline images need an HTML body (contentType HTML)')
  }
  if (files.length || inline.length) {
    const total = [...files, ...inline].reduce((n, a) => n + a.contentBytes.length, 0)
    if (total > MAX_TOTAL_ATTACHMENT_BASE64_BYTES) {
      throw new Error(
        `graph-mail: attachments too large (${total} base64 bytes across ` +
          `${files.length + inline.length} file(s); limit ${MAX_TOTAL_ATTACHMENT_BASE64_BYTES}). ` +
          'Send fewer or smaller files, or share a link instead.',
      )
    }
    message.attachments = [
      ...files.map((a) => ({
        '@odata.type': '#microsoft.graph.fileAttachment',
        name: a.name,
        contentType: a.contentType ?? 'application/octet-stream',
        contentBytes: a.contentBytes,
      })),
      ...inline.map((img) => ({
        '@odata.type': '#microsoft.graph.fileAttachment',
        name: img.name ?? img.cid,
        contentType: img.contentType,
        contentBytes: img.contentBytes,
        contentId: img.cid,
        isInline: true,
      })),
    ]
  }
  return message
}

/**
 * Send mail from the scoped mailbox via Graph /sendMail, or answer a message
 * of this mailbox via /messages/{id}/reply when `replyToId` is set.
 */
export async function sendMail(options: SendMailOptions): Promise<void> {
  const message = buildMessage(options)
  const res = options.replyToId
    ? await graphFetch(`${mailboxPath()}/messages/${encodeURIComponent(options.replyToId)}/reply`, {
        method: 'POST',
        prefix: PREFIX,
        body: JSON.stringify({ message }),
      })
    : await graphFetch(`${mailboxPath()}/sendMail`, {
        method: 'POST',
        prefix: PREFIX,
        body: JSON.stringify({ message, saveToSentItems: options.saveToSentItems ?? true }),
      })
  if (!res.ok && res.status !== 202) {
    throw await graphError(PREFIX, options.replyToId ? 'reply' : 'sendMail', res)
  }
  logger.info(
    { to: options.to, subject: options.subject, reply: Boolean(options.replyToId) },
    'graph-mail: sent',
  )
}

/**
 * Read one message in full. `asText` asks Graph for a plain-text body
 * (Prefer: outlook.body-content-type="text"), which is what a reader needs;
 * the default keeps the body as stored.
 */
export async function getMessage(id: string, asText = false): Promise<GraphFullMessage> {
  const select =
    'id,subject,from,toRecipients,ccRecipients,replyTo,receivedDateTime,body,bodyPreview,isRead,' +
    'webLink,conversationId,internetMessageId,hasAttachments'
  const res = await graphFetch(`${mailboxPath()}/messages/${encodeURIComponent(id)}?$select=${select}`, {
    prefix: PREFIX,
    headers: asText ? { Prefer: 'outlook.body-content-type="text"' } : undefined,
  })
  if (!res.ok) throw await graphError(PREFIX, 'getMessage', res)
  return (await res.json()) as GraphFullMessage
}

/**
 * Connectivity + scope smoke check: confirms the token mints and the scoped
 * mailbox is reachable. Returns the mailbox address on success, throws on any
 * auth/permission failure. Does not prove the RBAC *restriction* (that another
 * mailbox is denied) -- that is verified once, out of band, at provisioning.
 */
export async function verifyAccess(): Promise<{ mailbox: string; messageCount: number }> {
  const creds = loadCredentials(PREFIX)
  const res = await graphFetch(`${mailboxPath()}/messages?$top=1&$select=id`, { prefix: PREFIX })
  if (!res.ok) throw await graphError(PREFIX, `verifyAccess for ${creds.mailbox}`, res)
  const json = (await res.json()) as { value?: unknown[] }
  return { mailbox: creds.mailbox, messageCount: json.value?.length ?? 0 }
}
