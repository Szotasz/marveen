import { readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Shared Microsoft Graph plumbing for the app-only (client-credentials) flow:
// credentials file, token mint + cache, and the fetch wrapper. graph-mail,
// graph-calendar and graph-files all sit on this.
//
// Extracted from graph-mail.ts (GRAPHSHARE1015) when calendar and files were
// added: three copies of the token cache would have meant three places to fix
// a rotated secret, and three different answers to "is the token still valid".
// The behaviour is byte-for-byte the one graph-mail shipped with; only the
// error prefix is now per-module, passed in by the caller.
//
// No @azure/msal-node dependency: the client-credentials flow is a single
// form-POST to the token endpoint, and Graph calls are plain fetch with a
// Bearer header. Adding an SDK for that would be more moving parts, not fewer.

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = join(__dirname, '..')

// Gitignored KEY=value credentials file at the repo root. Path is overridable
// so an operator can relocate it (e.g. outside the repo) without code changes.
export const CREDS_PATH = process.env.MARVEEN_MAIL_CREDS || join(PROJECT_ROOT, 'marveen-mail-ugyfelkod')

export const GRAPH_BASE = 'https://graph.microsoft.com/v1.0'
const REQUEST_TIMEOUT_MS = 20_000
/** Uploads stream for minutes, not seconds: they get their own ceiling. */
const UPLOAD_TIMEOUT_MS = 180_000

export interface GraphCredentials {
  tenantId: string
  clientId: string
  clientSecret: string
  mailbox: string
  /**
   * SharePoint site for the shared folder, as `hostname:/sites/<name>`
   * (e.g. `pecibt.sharepoint.com:/sites/Marveen`). Optional: OneDrive works
   * without it, and a tenant may never grant a site. Empty means "not
   * configured", NOT "no access" -- graph-files says which one it hit.
   */
  sharepointSite: string
  /**
   * Drive (document library) id, used as-is instead of resolving it from
   * SHAREPOINT_SITE. Needed in folder mode: an app granted only individual
   * folders (Files.SelectedOperations.Selected) cannot read the site object,
   * so the site-to-drive lookup is not available to it. Optional.
   */
  sharepointDriveId: string
  /**
   * Raw SHAREPOINT_FOLDERS value: `Name:itemId` pairs separated by `;` or `,`.
   * Non-empty switches graph-files into folder mode. Parsed and validated in
   * graph-files (parseFolderMap), not here, so the error names the module.
   */
  sharepointFolders: string
}

/** Back-compat alias: graph-mail exported this name before the split. */
export type MailCredentials = GraphCredentials

/** Keys that must be present and non-empty for any Graph call to work. */
const REQUIRED_KEYS = ['tenantId', 'clientId', 'clientSecret', 'mailbox'] as const
/**
 * A SharePoint-only agent (folder grants, no mailbox of its own) has no
 * MAILBOX to give. When a SharePoint target is configured the mailbox stops
 * being required here; userPath still refuses an empty one, so a mail or
 * OneDrive call from such an agent fails with a clear message, not a bad URL.
 */
const SHAREPOINT_ONLY_REQUIRED = ['tenantId', 'clientId', 'clientSecret'] as const

// Credentials cache with mtime invalidation -- same reasoning as google-api.ts:
// the file is edited out-of-process (operator rotates the secret), and a stale
// in-memory copy would keep authenticating with a revoked secret until a
// restart. Re-read whenever the file's mtime advances.
let cachedCreds: { value: GraphCredentials; mtimeMs: number } | null = null

/**
 * Parse the gitignored KEY=value credentials file. Pure, so the parsing and
 * validation contract is unit-testable without touching the filesystem.
 *
 * SHAREPOINT_SITE, SHAREPOINT_DRIVE_ID and SHAREPOINT_FOLDERS are optional
 * and default to empty. MAILBOX is required unless a SharePoint target is
 * configured (a folder-only agent has no mailbox); every other key is
 * required, and a missing one names ALL the missing keys at once -- an
 * operator filling the file in should not have to run it four times to find
 * out it needs four values.
 */
export function parseCredentials(content: string, modulePrefix = 'graph'): GraphCredentials {
  const map: Record<string, string> = {}
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eqIdx = trimmed.indexOf('=')
    if (eqIdx === -1) continue
    const key = trimmed.slice(0, eqIdx).trim()
    let value = trimmed.slice(eqIdx + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    map[key] = value
  }
  const creds: GraphCredentials = {
    tenantId: map.TENANT_ID ?? '',
    clientId: map.CLIENT_ID ?? '',
    clientSecret: map.CLIENT_SECRET ?? '',
    mailbox: map.MAILBOX ?? '',
    sharepointSite: map.SHAREPOINT_SITE ?? '',
    sharepointDriveId: map.SHAREPOINT_DRIVE_ID ?? '',
    sharepointFolders: map.SHAREPOINT_FOLDERS ?? '',
  }
  const sharepointConfigured = Boolean(creds.sharepointSite || creds.sharepointDriveId)
  const required = sharepointConfigured ? SHAREPOINT_ONLY_REQUIRED : REQUIRED_KEYS
  const missing = required.filter((k) => !creds[k])
  if (missing.length > 0) {
    throw new Error(
      `${modulePrefix}: incomplete credentials, missing ${missing.join(', ')} ` +
        `(expected TENANT_ID / CLIENT_ID / CLIENT_SECRET / MAILBOX in ${CREDS_PATH})`,
    )
  }
  return creds
}

export function loadCredentials(modulePrefix = 'graph'): GraphCredentials {
  let currentMtime = 0
  try {
    currentMtime = statSync(CREDS_PATH).mtimeMs
  } catch {
    throw new Error(
      `${modulePrefix}: credentials file not found at ${CREDS_PATH}. ` +
        `Set MARVEEN_MAIL_CREDS or create the file with TENANT_ID / CLIENT_ID / CLIENT_SECRET / MAILBOX.`,
    )
  }
  if (!cachedCreds || cachedCreds.mtimeMs !== currentMtime) {
    cachedCreds = {
      value: parseCredentials(readFileSync(CREDS_PATH, 'utf-8'), modulePrefix),
      mtimeMs: currentMtime,
    }
  }
  return cachedCreds.value
}

// Access-token cache. The client-credentials token lasts ~1h; we refresh once
// it is within 60s of expiry so an in-flight request never races the cutover.
let cachedToken: { value: string; expiresAt: number; clientId: string } | null = null

export async function withTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fn(controller.signal)
  } finally {
    clearTimeout(timer)
  }
}

export async function getToken(modulePrefix = 'graph'): Promise<string> {
  const creds = loadCredentials(modulePrefix)
  // Bind the cache to the clientId so a rotated app registration doesn't reuse
  // a token minted for the old client.
  if (cachedToken && cachedToken.clientId === creds.clientId && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken.value
  }
  const url = `https://login.microsoftonline.com/${creds.tenantId}/oauth2/v2.0/token`
  const body = new URLSearchParams({
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    scope: 'https://graph.microsoft.com/.default',
    grant_type: 'client_credentials',
  })
  const res = await withTimeout((signal) =>
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal,
    }),
  )
  const text = await res.text()
  if (!res.ok) {
    // Do not log the response body verbatim -- AADSTS errors sometimes echo
    // request parameters. Log status + the short error code only.
    let code = 'unknown'
    try {
      code = JSON.parse(text).error ?? 'unknown'
    } catch {
      /* non-JSON body */
    }
    throw new Error(`${modulePrefix}: token request failed (${res.status} ${code})`)
  }
  const json = JSON.parse(text) as { access_token: string; expires_in: number }
  cachedToken = {
    value: json.access_token,
    expiresAt: Date.now() + json.expires_in * 1000,
    clientId: creds.clientId,
  }
  return json.access_token
}

export interface GraphFetchInit extends RequestInit {
  /** Longer ceiling for uploads/downloads; defaults to the 20s request one. */
  timeoutMs?: number
  /** Module prefix for error messages ('graph-calendar', ...). */
  prefix?: string
}

export async function graphFetch(path: string, init?: GraphFetchInit): Promise<Response> {
  const prefix = init?.prefix ?? 'graph'
  const token = await getToken(prefix)
  const { timeoutMs, prefix: _p, ...rest } = init ?? {}
  // A body that is not a string is a binary upload: leave Content-Type to the
  // caller (or to fetch), because forcing application/json on raw bytes makes
  // Graph store the file with the wrong type.
  const isJsonBody = rest.body === undefined || typeof rest.body === 'string'
  return withTimeout(
    (signal) =>
      fetch(`${GRAPH_BASE}${path}`, {
        ...rest,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(isJsonBody ? { 'Content-Type': 'application/json' } : {}),
          ...(rest.headers ?? {}),
        },
        signal,
      }),
    timeoutMs ?? REQUEST_TIMEOUT_MS,
  )
}

export const UPLOAD_TIMEOUT = UPLOAD_TIMEOUT_MS

/**
 * Turn a failed Graph response into one error message that an operator can act
 * on. 403 and 404 are the two that actually happen with scoped app permissions
 * and they mean very different things, so they get named rather than left as a
 * number in a blob of JSON.
 */
export async function graphError(prefix: string, op: string, res: Response): Promise<Error> {
  const text = await res.text().catch(() => '')
  let hint = ''
  if (res.status === 401) hint = ' (hitelesites: rossz titok vagy rossz berlo)'
  else if (res.status === 403) hint = ' (jogosultsag: a hatokor nem fedi ezt az eroforrast)'
  else if (res.status === 404) hint = ' (nincs ilyen eroforras, vagy a hatokoron kivul esik)'
  return new Error(`${prefix}: ${op} failed (${res.status}${hint}) ${text.slice(0, 500)}`)
}

/** `/users/<mailbox>` -- every app-only call is addressed to the scoped box. */
export function userPath(modulePrefix = 'graph'): string {
  const mailbox = loadCredentials(modulePrefix).mailbox
  if (!mailbox) {
    throw new Error(
      `${modulePrefix}: no MAILBOX in ${CREDS_PATH}. This credentials file is SharePoint-only; ` +
        'mail, calendar and OneDrive calls need a mailbox.',
    )
  }
  return `/users/${encodeURIComponent(mailbox)}`
}

/** Test seam: drop the cached credentials and token between unit tests. */
export function resetGraphCaches(): void {
  cachedCreds = null
  cachedToken = null
}
