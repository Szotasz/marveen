// The Telegram channel plugin's handler for the email-approval buttons
// (callback data with the apv: prefix).
//
// The dashboard never loads this file. scripts/patch-telegram-plugin.py copies
// it verbatim into the plugin's server.ts (a line-leading `export ` is cut),
// right before the callback_query handler, and the handler hands every `apv:`
// callback to marveenApprovalCallback before its `perm:` regex runs. Hence:
//  - zero dependencies: no module loading of any kind. What the block needs
//    from the plugin (state dir, file read, fetch, the allowlist) comes in
//    through `deps`, typed structurally below;
//  - every top-level name starts with marveenApv / MarveenApv / MARVEEN_APV
//    (plus the entry point), so the inlined block cannot collide with a
//    plugin name;
//  - the block never talks to the model: an apv: press is decided by the
//    dashboard, and nothing about it reaches the Claude Code session;
//  - it writes no log line at all: the bearer token and the nonce leave this
//    function only inside the one POST.
//
// The plugin only pre-checks (exact shape, allowlisted sender, a private chat
// whose id is the sender's id -- never the display name). The dashboard
// decides: strict owner, the stored message id, the single-use nonce of the
// pressed button, pending and not expired (POST /api/approvals/:id/telegram).
// Every failure here is fail-closed: nothing is decided, the user gets a short
// reason. That includes a dashboard older than this block: it has no such
// endpoint and answers 404, which leaves the buttons in place. (The legacy
// PATCH is never used: an old dashboard would decide it without the nonce.)

// Same contract as src/web/approval-callback-data.ts (blueprint 4.2):
// apv:<a|r>:<approval uuid without dashes, lowercase hex>:<16-byte nonce, base64url, no padding>
// (each button has its own nonce)
export const MARVEEN_APV_CALLBACK_RE = /^apv:([ar]):([0-9a-f]{32}):([A-Za-z0-9_-]{22})$/

// channels.sh exports TELEGRAM_STATE_DIR=<install>/.claude/channels/telegram for
// the main agent; the install root, and with it the dashboard, comes from there.
const MARVEEN_APV_STATE_SUFFIX = '/.claude/channels/telegram'
// src/config.ts: WEB_PORT from the install's .env, default 3420.
const MARVEEN_APV_DEFAULT_PORT = 3420
const MARVEEN_APV_TIMEOUT_MS = 10_000
// Telegram's limit for a message text.
const MARVEEN_APV_MAX_TEXT = 4096
// An outcome line longer than this is not the server's outcome_text.
const MARVEEN_APV_MAX_OUTCOME = 300
// The plugin runtime (bun, measured on 1.4.2) sends even a 127.0.0.1 request
// through HTTP_PROXY / http_proxy, so a proxy would get the bearer token and
// the nonce in clear, and could answer for the dashboard. A per-request opt-out
// was not found (proxy: '' / undefined / false / null all still went through
// the proxy). NO_PROXY with the exact entry 127.0.0.1 did keep it direct; with
// both spellings set the lowercase one won. So: any proxy variable set, and
// not every NO_PROXY spelling lists 127.0.0.1 exactly -> no request at all.
// "Set" is any non-empty value, untrimmed (bun takes a blank value as set),
// and an entry counts only if it is 127.0.0.1 once outer spaces and tabs are
// cut (a JS trim() would also cut NBSP or U+2028, which bun keeps). Checked on
// two environments: the one now, and the one the plugin loaded with (the
// patcher's MARVEEN_APV_ENV_AT_LOAD line), because bun keeps proxying after a
// variable is deleted from the environment at runtime (measured).
const MARVEEN_APV_PROXY_VARS = ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy']
const MARVEEN_APV_NO_PROXY_VARS = ['NO_PROXY', 'no_proxy']
// approvals.status values that make a 409 already_resolved well-formed.
const MARVEEN_APV_FINAL_STATUSES = ['approved', 'rejected', 'timeout']

// Toasts (answerCallbackQuery, at most 200 characters) and the lines appended
// under the message. Outgoing copy: Hungarian, plain text.
export const MARVEEN_APV_TOAST = {
  invalid: 'Érvénytelen gomb.',
  forbidden: 'Nem engedélyezett.',
  unavailable: 'A gomb most nem működik, dönts a dashboardon.',
  approved: '✅ Jóváhagyva.',
  rejected: '❌ Elutasítva.',
  alreadyResolved: 'Ez a kérés már el van döntve.',
  expired: 'Ez a kérés lejárt, már nem dönthető el.',
  notBound: 'Ez a gomb nincs a kéréshez kötve, dönts a dashboardon.',
  notFound: 'Ez a kérés nem található.',
} as const

export interface MarveenApvMarkup {
  inline_keyboard: { text: string; callback_data: string }[][]
}

// The part of grammY's callback-query context the block touches.
export interface MarveenApvCtx {
  from?: { id: number }
  callbackQuery: {
    message?: { message_id: number; chat: { id: number; type: string }; text?: string }
  }
  answerCallbackQuery(other?: { text?: string }): Promise<unknown>
  editMessageText(text: string, other?: { reply_markup?: MarveenApvMarkup }): Promise<unknown>
  editMessageReplyMarkup(other?: { reply_markup?: MarveenApvMarkup }): Promise<unknown>
}

export interface MarveenApvDeps {
  stateDir: string
  readFileSync: (p: string, enc: 'utf8') => string
  fetch: typeof fetch
  loadAccess: () => { allowFrom: string[] }
  // The plugin's environment now, and a copy taken when it loaded (after its
  // .env loader); read only for the proxy variables.
  env: Record<string, string | undefined>
  envAtLoad: Record<string, string | undefined>
}

type MarveenApvResponse = Awaited<ReturnType<typeof fetch>>

/**
 * Handle one `apv:` callback. Never throws, answers the callback exactly once,
 * and sends at most one HTTP request (no retry).
 */
export async function marveenApprovalCallback(ctx: MarveenApvCtx, data: string, deps: MarveenApvDeps): Promise<void> {
  let toast: string
  try {
    toast = await marveenApvHandle(ctx, data, deps)
  } catch {
    toast = MARVEEN_APV_TOAST.unavailable
  }
  await marveenApvQuiet(() => ctx.answerCallbackQuery({ text: toast }))
}

async function marveenApvHandle(ctx: MarveenApvCtx, data: string, deps: MarveenApvDeps): Promise<string> {
  const m = typeof data === 'string' ? MARVEEN_APV_CALLBACK_RE.exec(data) : null
  if (!m) return MARVEEN_APV_TOAST.invalid

  // The sender is the numeric user id Telegram put on the update.
  const fromId = ctx.from?.id
  if (typeof fromId !== 'number' || !Number.isSafeInteger(fromId) || fromId <= 0) return MARVEEN_APV_TOAST.forbidden
  const allowFrom = deps.loadAccess()?.allowFrom
  if (!Array.isArray(allowFrom) || !allowFrom.includes(String(fromId))) return MARVEEN_APV_TOAST.forbidden

  const msg = ctx.callbackQuery?.message
  if (!msg || !msg.chat) return MARVEEN_APV_TOAST.invalid
  if (msg.chat.type !== 'private' || msg.chat.id !== fromId) return MARVEEN_APV_TOAST.forbidden
  if (typeof msg.message_id !== 'number' || !Number.isSafeInteger(msg.message_id) || msg.message_id <= 0) {
    return MARVEEN_APV_TOAST.invalid
  }

  if (marveenApvProxied(deps.env) || marveenApvProxied(deps.envAtLoad)) return MARVEEN_APV_TOAST.unavailable
  const dash = marveenApvDashboard(deps)
  if (!dash) return MARVEEN_APV_TOAST.unavailable

  const [, action, id32, nonce] = m
  const status = action === 'a' ? 'approved' : 'rejected'
  const uuid = `${id32.slice(0, 8)}-${id32.slice(8, 12)}-${id32.slice(12, 16)}-${id32.slice(16, 20)}-${id32.slice(20)}`

  let res: MarveenApvResponse
  try {
    res = await deps.fetch(`${dash.base}/api/approvals/${uuid}/telegram`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${dash.token}` },
      body: JSON.stringify({
        status,
        resolved_by: `owner:telegram:${fromId}`,
        telegram_message_id: msg.message_id,
        telegram_chat_id: String(msg.chat.id),
        telegram_chat_type: msg.chat.type,
        callback_nonce: nonce,
        callback_protocol: 1,
      }),
      // Never follow a redirect with the bearer token: a 3xx is just a failure here.
      redirect: 'manual',
      signal: AbortSignal.timeout(MARVEEN_APV_TIMEOUT_MS),
    })
  } catch {
    // network error or timeout: nothing is known to be decided, buttons stay
    return MARVEEN_APV_TOAST.unavailable
  }
  const body = await marveenApvBody(res)
  const reason = typeof body?.reason === 'string' ? body.reason : ''

  // Decided only when the dashboard says so in full: anything less (an empty
  // 200 from something that is not the dashboard, a status other than the one
  // asked for) leaves the buttons in place.
  if (res.status === 200) {
    const approval = body?.approval
    const applied = body?.ok === true && approval !== null && typeof approval === 'object' &&
      (approval as { status?: unknown }).status === status
    if (!applied) return MARVEEN_APV_TOAST.unavailable
    const label = status === 'approved' ? MARVEEN_APV_TOAST.approved : MARVEEN_APV_TOAST.rejected
    await marveenApvSettle(ctx, marveenApvOutcome(body?.outcome_text) ?? label)
    return label
  }
  // A final 409 only with the known reasons and fields; only already_resolved
  // carries a server outcome line.
  if (res.status === 409 && body?.ok === false) {
    if (reason === 'already_resolved' && MARVEEN_APV_FINAL_STATUSES.includes(body.status as string)) {
      await marveenApvSettle(ctx, marveenApvOutcome(body.outcome_text) ?? MARVEEN_APV_TOAST.alreadyResolved)
      return MARVEEN_APV_TOAST.alreadyResolved
    }
    if (reason === 'expired') {
      await marveenApvSettle(ctx, MARVEEN_APV_TOAST.expired)
      return MARVEEN_APV_TOAST.expired
    }
    if (reason === 'not_bound') {
      await marveenApvSettle(ctx, MARVEEN_APV_TOAST.notBound)
      return MARVEEN_APV_TOAST.notBound
    }
  }
  // Everything below leaves the buttons in place.
  if (res.status === 409 && body?.ok === false && reason === 'wrong_category') return MARVEEN_APV_TOAST.invalid
  if (res.status === 403) {
    return reason === 'bad_nonce' || reason === 'message_mismatch' ? MARVEEN_APV_TOAST.invalid : MARVEEN_APV_TOAST.forbidden
  }
  // The dashboard's own not_found; any other 404 is a dashboard without this
  // endpoint (older than the block): the button cannot work there yet.
  if (res.status === 404 && body?.ok === false && reason === 'not_found') return MARVEEN_APV_TOAST.notFound
  return MARVEEN_APV_TOAST.unavailable
}

// True when the request could leave through a proxy (see MARVEEN_APV_PROXY_VARS).
// No usable environment counts as proxied.
function marveenApvProxied(env: unknown): boolean {
  if (env === null || typeof env !== 'object') return true
  const e = env as Record<string, unknown>
  const isSet = (k: string): boolean => typeof e[k] === 'string' && e[k] !== ''
  if (!MARVEEN_APV_PROXY_VARS.some(isSet)) return false
  const noProxy = MARVEEN_APV_NO_PROXY_VARS.filter(isSet)
  return noProxy.length === 0 ||
    !noProxy.every(k => (e[k] as string).split(',').some(entry => entry.replace(/^[ \t]+|[ \t]+$/g, '') === '127.0.0.1'))
}

// The dashboard of THIS install: base URL and bearer token, or null (fail-closed).
function marveenApvDashboard(deps: MarveenApvDeps): { base: string; token: string } | null {
  let dir = typeof deps.stateDir === 'string' ? deps.stateDir : ''
  while (dir.length > 1 && dir.endsWith('/')) dir = dir.slice(0, -1)
  if (!dir.startsWith('/') || dir.includes('\0') || !dir.endsWith(MARVEEN_APV_STATE_SUFFIX)) return null
  const install = dir.slice(0, -MARVEEN_APV_STATE_SUFFIX.length)
  const segs = install.split('/')
  if (!install || segs.some(seg => seg === '.' || seg === '..')) return null
  // <x>/agents/<id> is a sub-agent with its own bot, not an install root: its
  // state dir has the same suffix, and a token found there is not this
  // dashboard's.
  if (segs.length >= 3 && segs[segs.length - 2] === 'agents') return null

  let token: string
  try {
    token = deps.readFileSync(`${install}/store/.dashboard-token`, 'utf8').trim()
  } catch {
    return null
  }
  // One printable-ASCII word, or it is not a token (and must not reach a header).
  if (!/^[\x21-\x7e]{1,1024}$/.test(token)) return null

  const port = marveenApvPort(deps, install)
  if (port === null) return null
  return { base: `http://127.0.0.1:${port}`, token }
}

// WEB_PORT as the dashboard reads it (src/env-parse.ts: trimmed key, last line
// wins). The token goes to that port, so any doubt is a refusal, never a guess:
// a WEB_PORT line not in the exact `WEB_PORT=<digits>` form, two such lines, or
// an unreadable .env (other than a missing one) gives null.
function marveenApvPort(deps: MarveenApvDeps, install: string): number | null {
  let raw: string
  try {
    raw = deps.readFileSync(`${install}/.env`, 'utf8')
  } catch (e) {
    return (e as { code?: unknown } | null)?.code === 'ENOENT' ? MARVEEN_APV_DEFAULT_PORT : null
  }
  let port: number | null = MARVEEN_APV_DEFAULT_PORT
  let seen = 0
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    const eq = trimmed.indexOf('=')
    if (trimmed.startsWith('#') || eq === -1 || trimmed.slice(0, eq).trim() !== 'WEB_PORT') continue
    seen++
    const pm = /^WEB_PORT=(\d{2,5})$/.exec(line.replace(/\r$/, ''))
    const n = pm ? Number(pm[1]) : NaN
    port = n >= 1 && n <= 65535 ? n : null
  }
  return seen > 1 ? null : port
}

async function marveenApvBody(res: MarveenApvResponse): Promise<Record<string, unknown> | null> {
  try {
    const v: unknown = JSON.parse(await res.text())
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function marveenApvOutcome(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' && v.length <= MARVEEN_APV_MAX_OUTCOME ? v : null
}

// Take the buttons off; append the outcome line when the result still fits.
// editMessageText without reply_markup drops the inline keyboard (the plugin's
// perm: branch relies on the same).
async function marveenApvSettle(ctx: MarveenApvCtx, outcome: string): Promise<void> {
  const msg = ctx.callbackQuery?.message
  const text = msg && typeof msg.text === 'string' ? msg.text : ''
  if (text) {
    const next = `${text}\n\n${outcome}`
    if (next.length <= MARVEEN_APV_MAX_TEXT && (await marveenApvQuiet(() => ctx.editMessageText(next)))) return
  }
  await marveenApvQuiet(() => ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }))
}

async function marveenApvQuiet(fn: () => Promise<unknown>): Promise<boolean> {
  try {
    await fn()
    return true
  } catch {
    return false
  }
}
