/**
 * The dashboard shows what the server answered, not what it asked for (#2424-#2427).
 * Each case runs the SHIPPED code from web/app.js (sliced out by its own markers) with a
 * fake fetch, a fake DOM and the real hu/en dictionaries:
 * - #2424 schedules: pause/resume and delete show the refusal (409 / 500) with the server's
 *   reason, never "Task paused" / "Task deleted"; run-now's refusal is no longer hardcoded Hungarian;
 * - #2425 memories: a refused save keeps the modal open and the text, and says why
 *   (destructive_memory_write with the two lengths, other refusals with the server reason);
 * - #2426 messages: a 200 with queued:true says the agent is not running and the message waits;
 * - #2427 owner-only actions (approvals, quarantined skills, federation): 403
 *   owner_session_required is shown in the page language; every other error keeps the server text.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const APP = readFileSync(new URL('../../web/app.js', import.meta.url), 'utf-8')

function slice(startMarker: string, endMarker: string): string {
  const start = APP.indexOf(startMarker)
  const end = APP.indexOf(endMarker, start + 1)
  if (start < 0 || end < 0) throw new Error(`snippet not found: ${startMarker}`)
  return APP.slice(start, end)
}

const HELPERS = slice('async function readActionReply(', '\n// === Agents API ===')
const SCHEDULE_ROW = slice('function makeScheduleRow(task) {', '\nfunction renderScheduleList(')
const SAVE_MEMORY = slice('async function saveMemoryFromModal() {', "\ndocument.getElementById('saveMemBtn')")
const SEND_CHAT = slice('async function sendChatMessage(toAgent) {', "\ndocument.getElementById('chatRefreshBtn')")
const RESOLVE_APPROVAL = slice('async function _resolveApproval(id, decision) {', '\n}\n') + '\n}\n'

function dict(lang: 'hu' | 'en'): Record<string, string> {
  const win: { _i18n?: Record<string, Record<string, string>> } = {}
  new Function('window', readFileSync(new URL(`../../web/lang/${lang}.js`, import.meta.url), 'utf-8'))(win)
  return win._i18n![lang]
}
const DICTS = { hu: dict('hu'), en: dict('en') }

// The same lookup and {param} substitution as window.t in web/app.js; a missing key throws.
function makeT(lang: 'hu' | 'en') {
  return (key: string, params: Record<string, unknown> = {}) => {
    const str = DICTS[lang][key]
    if (str === undefined) throw new Error(`missing key ${lang}:${key}`)
    return str.replace(/\{(\w+)\}/g, (_, k) => (params[k] != null ? String(params[k]) : `{${k}}`))
  }
}

interface Reply { status: number; body?: unknown }
function fakeFetch(replies: Reply[]) {
  const calls: Array<{ url: string; method?: string; body?: string }> = []
  const fetch = async (url: string, init: { method?: string; body?: string } = {}) => {
    calls.push({ url, method: init.method, body: init.body })
    const r = replies.shift()
    if (!r) throw new Error('unexpected request ' + url)
    return {
      status: r.status,
      ok: r.status >= 200 && r.status < 300,
      json: async () => { if (r.body === undefined) throw new SyntaxError('no body'); return r.body },
    }
  }
  return { fetch, calls }
}

// --- #2424 schedules -------------------------------------------------------------------------

function fakeRowDocument() {
  const handlers: Record<string, (e: { stopPropagation(): void }) => Promise<void>> = {}
  const row = {
    className: '',
    innerHTML: '',
    addEventListener() {},
    querySelector(sel: string) {
      const m = /data-action="(\w+)"/.exec(sel)
      return { addEventListener: (_: string, fn: (e: { stopPropagation(): void }) => Promise<void>) => { handlers[m![1]] = fn } }
    },
  }
  return { document: { createElement: () => row }, row, handlers }
}

async function clickSchedule(action: 'toggle' | 'delete' | 'run', reply: Reply, lang: 'hu' | 'en' = 'en', task: Record<string, unknown> = {}) {
  const { fetch, calls } = fakeFetch([reply])
  const toasts: string[] = []
  let reloads = 0
  const { document, handlers } = fakeRowDocument()
  const make = new Function(
    'document', 'fetch', 't', 'showToast', 'loadSchedules', 'confirmDialog', 'scheduleAgents', 'mainAgentId', 'avatarBust',
    'escapeHtml', 'describeCron', 'pauseIcon', 'playIcon', 'trashIcon', 'openEditSchedule', 'openScheduleRunHistory',
    `${HELPERS}\n${SCHEDULE_ROW}\nreturn makeScheduleRow`,
  )(document, fetch, makeT(lang), (m: string) => { toasts.push(m) }, () => { reloads++ }, async () => true, [], () => 'marveen', () => '',
    (s: string) => s, () => '', () => '', () => '', () => '', () => {}, () => {}) as (t: unknown) => unknown
  make({ name: 'daily-digest', description: 'Daily digest', schedule: '0 8 * * *', enabled: true, ...task })
  await handlers[action]({ stopPropagation() {} })
  return { toasts, calls, reloads }
}

describe('#2424 schedule row actions show the server answer', () => {
  it('the snippets are found in web/app.js', () => {
    for (const s of [HELPERS, SCHEDULE_ROW, SAVE_MEMORY, SEND_CHAT, RESOLVE_APPROVAL]) expect(s.length).toBeGreaterThan(50)
  })

  it('pause accepted: the paused toast, list reloaded', async () => {
    const r = await clickSchedule('toggle', { status: 200, body: { ok: true, enabled: false } })
    expect(r.calls).toEqual([{ url: '/api/schedules/daily-digest/toggle', method: 'POST', body: undefined }])
    expect(r.toasts).toEqual(['Task paused'])
    expect(r.reloads).toBe(1)
  })

  it('pause refused (409 foreign edit): "Not done" with the server reason, list reloaded', async () => {
    const r = await clickSchedule('toggle', { status: 409, body: { error: 'Schedule files changed outside the dashboard API' } })
    expect(r.toasts).toEqual(['Not done: Schedule files changed outside the dashboard API'])
    expect(r.reloads).toBe(1)
  })

  it('resume refused on a Hungarian page: the Hungarian frame around the server reason', async () => {
    const r = await clickSchedule('toggle', { status: 409, body: { error: 'Schedule files changed' } }, 'hu', { enabled: false })
    expect(r.toasts).toEqual(['Nem történt meg: Schedule files changed'])
  })

  it('delete refused (500): never "Task deleted"', async () => {
    const r = await clickSchedule('delete', { status: 500, body: { error: 'Schedule NOT deleted: registry cleanup failed' } })
    expect(r.calls[0]).toMatchObject({ url: '/api/schedules/daily-digest', method: 'DELETE' })
    expect(r.toasts).toEqual(['Not done: Schedule NOT deleted: registry cleanup failed'])
    expect(r.reloads).toBe(1)
  })

  it('delete accepted: the deleted toast', async () => {
    const r = await clickSchedule('delete', { status: 200, body: { ok: true } })
    expect(r.toasts).toEqual(['Task deleted'])
  })

  it('a refusal without a JSON body names the HTTP status', async () => {
    const r = await clickSchedule('delete', { status: 502 })
    expect(r.toasts).toEqual(['Not done: HTTP 502'])
  })

  it('run now refused: the page-language frame, not a hardcoded "Hiba:"', async () => {
    const r = await clickSchedule('run', { status: 409, body: { error: 'already running' } })
    expect(r.toasts).toEqual(['Not done: already running'])
  })
})

// --- #2425 memories ------------------------------------------------------------------------------

async function saveMemory(reply: Reply, opts: { editId?: string; lang?: 'hu' | 'en' } = {}) {
  const { fetch, calls } = fakeFetch([reply])
  const toasts: string[] = []
  const events: string[] = []
  const fields: Record<string, { value: string; focus?: () => void }> = {
    memContent: { value: '  Egy rövid mondat.  ', focus: () => events.push('focus') },
    memEditId: { value: opts.editId ?? '' },
    memTier: { value: 'warm' },
    memAgent: { value: 'marveen' },
    memKeywords: { value: 'a, b' },
  }
  const document = { getElementById: (id: string) => fields[id] }
  const save = new Function(
    'document', 'fetch', 't', 'showToast', 'closeModal', 'memModalOverlay', 'loadMemories', 'loadMemStats',
    `${HELPERS}\n${SAVE_MEMORY}\nreturn saveMemoryFromModal`,
  )(document, fetch, makeT(opts.lang ?? 'en'), (m: string) => { toasts.push(m) }, () => events.push('close'), {},
    () => events.push('reload'), () => events.push('stats')) as () => Promise<void>
  await save()
  return { toasts, events, calls, text: fields.memContent.value }
}

describe('#2425 a refused memory save keeps the modal and the text', () => {
  it('edit accepted: updated toast, modal closed, lists reloaded', async () => {
    const r = await saveMemory({ status: 200, body: { id: 7 } }, { editId: '7' })
    expect(r.calls[0]).toMatchObject({ url: '/api/memories/7', method: 'PUT' })
    expect(r.toasts).toEqual(['Memory updated'])
    expect(r.events).toEqual(['close', 'reload', 'stats'])
  })

  it('new accepted: created toast, modal closed', async () => {
    const r = await saveMemory({ status: 201, body: { id: 8 } })
    expect(r.calls[0]).toMatchObject({ url: '/api/memories', method: 'POST' })
    expect(r.toasts).toEqual(['Memory created'])
    expect(r.events).toContain('close')
  })

  it('edit refused (409 destructive_memory_write): the two lengths, modal open, text kept', async () => {
    const r = await saveMemory({ status: 409, body: { error: 'destructive_memory_write', old_len: 640, new_len: 18, how_to_proceed: 'POST /api/memories ...' } }, { editId: '7', lang: 'hu' })
    expect(r.toasts).toHaveLength(1)
    expect(r.toasts[0]).toContain('Nem mentettem')
    expect(r.toasts[0]).toContain('640')
    expect(r.toasts[0]).toContain('18')
    expect(r.toasts[0]).not.toContain('POST /api')
    expect(r.events).toEqual([])
    expect(r.text).toBe('  Egy rövid mondat.  ')
  })

  it('new refused (400 security filter): the server reason, modal open', async () => {
    const r = await saveMemory({ status: 400, body: { error: 'Content rejected by security filter' } })
    expect(r.toasts).toEqual(['Not saved, your text is still in the window. Reason: Content rejected by security filter'])
    expect(r.events).toEqual([])
  })

  it('a destructive refusal without the lengths falls back to the reason text', async () => {
    const r = await saveMemory({ status: 409, body: { error: 'destructive_memory_write' } }, { editId: '7' })
    expect(r.toasts).toEqual(['Not saved, your text is still in the window. Reason: destructive_memory_write'])
    expect(r.events).toEqual([])
  })
})

// --- #2426 messages ------------------------------------------------------------------------------

async function sendChat(reply: Reply, lang: 'hu' | 'en' = 'en') {
  const { fetch } = fakeFetch([reply])
  const toasts: string[] = []
  const textarea = { value: 'hello', focus() {} }
  const btn = { disabled: false }
  const document = { getElementById: (id: string) => (id === 'chatComposeText' ? textarea : id === 'chatSendBtn' ? btn : null) }
  const send = new Function(
    'document', 'fetch', 't', 'showToast', 'resolveOwnerName', 'loadChatThread', 'loadChatAgentList',
    `${HELPERS}\n${SEND_CHAT}\nreturn sendChatMessage`,
  )(document, fetch, makeT(lang), (m: string) => { toasts.push(m) }, async () => 'Szabolcs', async () => {}, async () => {}) as (to: string) => Promise<void>
  await send('dani')
  return { toasts, text: textarea.value, btn }
}

describe('#2426 a message to a stopped agent says it is queued', () => {
  it('delivered (no queued flag): "Message sent"', async () => {
    const r = await sendChat({ status: 200, body: { id: 1, status: 'pending' } })
    expect(r.toasts).toEqual(['Message sent'])
    expect(r.text).toBe('')
  })

  it('queued: the agent is named and the message waits, not "sent"', async () => {
    const r = await sendChat({ status: 200, body: { id: 1, queued: true, targetRunning: false, warning: 'POST /api/agents/dani/start' } }, 'hu')
    expect(r.toasts).toEqual(['dani most nem fut: az üzenet sorban vár, és megkapja, amint elindul.'])
    expect(r.text).toBe('')
    expect(r.btn.disabled).toBe(false)
  })

  it('refused: the server reason, the text stays', async () => {
    const r = await sendChat({ status: 400, body: { error: 'Unknown agent' } })
    expect(r.toasts).toEqual(['Error: Unknown agent'])
    expect(r.text).toBe('hello')
  })
})

// --- #2427 owner-only actions --------------------------------------------------------------------

const OWNER_403 = { status: 403, body: { error: 'Approving needs the dashboard login (an owner session); ...', code: 'owner_session_required' } }

async function resolveApproval(reply: Reply, lang: 'hu' | 'en') {
  const { fetch } = fakeFetch([reply])
  const toasts: string[] = []
  const fn = new Function(
    'fetch', 't', 'showToast', '_approvalsAll', '_renderApprovalsStats', '_renderApprovalsTable',
    `${HELPERS}\n${RESOLVE_APPROVAL}\nreturn _resolveApproval`,
  )(fetch, makeT(lang), (m: string) => { toasts.push(m) }, [], () => {}, () => {}) as (id: number, d: string) => Promise<void>
  await fn(5, 'approved')
  return toasts
}

describe('#2427 the owner-session refusal is shown in the page language', () => {
  it.each(['hu', 'en'] as const)('approvals, %s: the translated owner-login text, not the English server text', async (lang) => {
    const toasts = await resolveApproval(OWNER_403, lang)
    expect(toasts).toHaveLength(1)
    expect(toasts[0]).toContain(DICTS[lang]['common.owner_session_required'])
    expect(toasts[0]).not.toContain('an owner session')
  })

  it('approvals, any other refusal keeps the server text', async () => {
    const toasts = await resolveApproval({ status: 409, body: { error: 'already resolved' } }, 'en')
    expect(toasts[0]).toContain('already resolved')
  })

  it('every caller named in the issue goes through refusalReason, none shows the raw error', () => {
    const fed = APP.slice(APP.indexOf('async function loadFederationPage'), APP.indexOf('async function fedApplyToMainAgent'))
    expect(fed.length).toBeGreaterThan(1000)
    expect(fed).not.toMatch(/msg: data\.error \|\|/)
    expect((APP.match(/federation\.toast\.error', \{ msg: refusalReason\(res, data\) \}/g) || []).length).toBe(10)
    const skills = APP.slice(APP.indexOf("`/api/skills/pending/${encodeURIComponent(p.id)}/approve`"), APP.indexOf("t('skills.pending.rejected'"))
    expect((skills.match(/refusalReason\(res, /g) || []).length).toBe(2)
    expect(RESOLVE_APPROVAL).toContain('refusalReason(res, data)')
  })

  it.each(['hu', 'en'] as const)('the new keys exist in %s', (lang) => {
    for (const k of ['common.not_done', 'common.owner_session_required', 'memories.toast.save_refused', 'memories.toast.destructive_refused', 'messages.queued']) {
      expect(DICTS[lang][k], k).toBeTruthy()
      expect(DICTS[lang][k]).not.toMatch(/[\u2013\u2014]/)
    }
  })
})

// --- #2427 Bridge point (Dani 65605, Samu 65608): the owner-session text names the real path ---

describe('#2427 the owner-session text is a working path, also in the Bridge', () => {
  // The Bridge opens the dashboard with ?token=<its device key>, which the page keeps in
  // localStorage and sends as Bearer; the owner gates refuse a device key. The button on the
  // Settings > Security > Dashboard login card drops the stored key and reloads, so the window
  // runs on the password session (measured on the live install 2026-11-01 22:21:51 -> 22:22:14).
  it.each(['hu', 'en'] as const)('%s: names every UI label on the way, with their current text', (lang) => {
    const text = DICTS[lang]['common.owner_session_required']
    for (const k of ['settings.page_title', 'settings.module.security', 'auth.card.title', 'auth.card.token_mode_signin_btn']) {
      expect(text, k).toContain(DICTS[lang][k])
    }
  })

  it.each(['hu', 'en'] as const)('%s: says the Bridge opens with its key and that it repeats after a restart', (lang) => {
    const text = DICTS[lang]['common.owner_session_required']
    expect(text).toContain('Bridge')
    expect(text).toMatch(lang === 'hu' ? /következő indításkor vagy újrakapcsolódáskor/ : /next start or reconnect/)
  })
})

describe('toast duration follows the message length', () => {
  const toastDuration = new Function(`${slice('function toastDuration(', '\n// The server')}\nreturn toastDuration`)() as (m: unknown, d: number) => number

  it('a short message keeps the default 3 s', () => {
    expect(toastDuration('Task paused', 3000)).toBe(3000)
  })

  it('the owner-session refusal stays long enough to be read (at most 15 s)', () => {
    const msg = 'Hiba: ' + DICTS.hu['common.owner_session_required']
    expect(toastDuration(msg, 3000)).toBeGreaterThanOrEqual(12000)
    expect(toastDuration(msg, 3000)).toBeLessThanOrEqual(15000)
  })

  it('never shorter than the caller asked for', () => {
    expect(toastDuration('short', 12000)).toBe(12000)
  })
})
