/**
 * RESTARTFORCEUI1018: the dashboard's main-agent restart button, the SHIPPED handler from web/app.js run against
 * a fake DOM and fetch. The server refuses a manual main restart while the pane is busy (409 restart-blocked);
 * without a way past that refusal the owner's button is dead exactly when the main agent is stuck. What it proves:
 * - an idle pane: one plain POST, success toast, no second confirm;
 * - a refusal: a second confirm, worded for the reason, then a POST with the JSON body {"force": true};
 * - the second confirm declined: no forced POST, a toast that says nothing was started;
 * - another 409 or a 500 is an error toast, never a force;
 * - the first confirm declined: no request at all.
 * Both confirmations go through the app's own confirmDialog, with a danger button; the native confirm()
 * is not called at all (it is injected as a function that fails the test).
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const APP = readFileSync(new URL('../../web/app.js', import.meta.url), 'utf-8')
const start = APP.indexOf('function postMarveenRestart(')
const end = APP.indexOf("\ndocument.getElementById('agentStartBtn')", start)
const SNIPPET = APP.slice(start, end)

interface Reply { status: number; body: Record<string, unknown> }
interface Call { url: string; init: { method?: string; headers?: Record<string, string>; body?: string } }

async function click(replies: Reply[], confirms: boolean[]) {
  const calls: Call[] = []
  const toasts: string[] = []
  const asked: string[] = []
  let handler: (() => Promise<void>) | null = null
  const btn = { disabled: false, addEventListener: (_e: string, fn: () => Promise<void>) => { handler = fn } }
  const document = { getElementById: (id: string) => { if (id !== 'marveenRestartBtn') throw new Error(id); return btn } }
  const fetch = async (url: string, init: Call['init']) => {
    calls.push({ url, init })
    const r = replies.shift()
    if (!r) throw new Error('unexpected request')
    const res = { status: r.status, ok: r.status >= 200 && r.status < 300, json: async () => r.body, clone: () => res }
    return res
  }
  const dialogs: { title: string; okLabel: string; danger?: boolean }[] = []
  const confirmDialog = async (o: { title: string; message: string; okLabel: string; danger?: boolean }) => {
    asked.push(o.message)
    dialogs.push({ title: o.title, okLabel: o.okLabel, danger: o.danger })
    return confirms.shift() ?? false
  }
  const confirm = () => { throw new Error('native confirm() called') }
  const t = (k: string) => k
  const showToast = (m: string) => { toasts.push(m) }
  new Function('document', 'fetch', 'confirm', 'confirmDialog', 't', 'showToast', SNIPPET)(document, fetch, confirm, confirmDialog, t, showToast)
  expect(handler).not.toBeNull()
  await handler!()
  return { calls, toasts, asked, btn, dialogs }
}

const plain = (c: Call) => c.url === '/api/marveen/restart' && c.init.method === 'POST' && c.init.body === undefined
const forced = (c: Call) => c.url === '/api/marveen/restart' && c.init.method === 'POST'
  && c.init.headers?.['Content-Type'] === 'application/json' && JSON.parse(c.init.body ?? 'null')?.force === true

describe('main-agent restart button', () => {
  it('the snippet is found in web/app.js', () => {
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
  })

  it('idle pane: one plain POST, success toast, no second confirm', async () => {
    const r = await click([{ status: 200, body: { ok: true } }], [true])
    expect(r.dialogs).toEqual([{ title: 'agents.confirm.hard_restart_title', okLabel: 'agents.confirm.hard_restart_ok', danger: true }])
    expect(r.calls).toHaveLength(1)
    expect(plain(r.calls[0])).toBe(true)
    expect(r.asked).toEqual(['agents.confirm.hard_restart'])
    expect(r.toasts).toEqual(['agents.toast.marveen_restarted'])
    expect(r.btn.disabled).toBe(false)
  })

  it.each([
    ['busy', 'agents.confirm.force_restart_busy'],
    ['no-pane', 'agents.confirm.force_restart_unreadable'],
    ['unknown-state', 'agents.confirm.force_restart_unreadable'],
  ])('refused (%s): a second confirm, then a forced POST', async (reason, key) => {
    const r = await click([{ status: 409, body: { error: 'restart-blocked', reason } }, { status: 200, body: { ok: true } }], [true, true])
    expect(r.asked).toEqual(['agents.confirm.hard_restart', key])
    expect(r.dialogs[1]).toEqual({ title: 'agents.confirm.hard_restart_title', okLabel: 'agents.confirm.force_restart_ok', danger: true })
    expect(r.calls).toHaveLength(2)
    expect(plain(r.calls[0])).toBe(true)
    expect(forced(r.calls[1])).toBe(true)
    expect(r.toasts).toEqual(['agents.toast.marveen_restarted'])
    expect(r.btn.disabled).toBe(false)
  })

  it('refused, second confirm declined: no forced POST, a toast that nothing started', async () => {
    const r = await click([{ status: 409, body: { error: 'restart-blocked', reason: 'busy' } }], [true, false])
    expect(r.calls).toHaveLength(1)
    expect(r.toasts).toEqual(['agents.toast.restart_not_forced'])
    expect(r.btn.disabled).toBe(false)
  })

  it('a 409 that is not restart-blocked is an error, never a force', async () => {
    const r = await click([{ status: 409, body: { error: 'something else' } }], [true, true])
    expect(r.calls).toHaveLength(1)
    expect(r.asked).toHaveLength(1)
    expect(r.toasts).toEqual(['Hiba: something else'])
  })

  it('a failed forced restart is an error toast', async () => {
    const r = await click([{ status: 409, body: { error: 'restart-blocked', reason: 'busy' } }, { status: 500, body: { error: 'Restart failed' } }], [true, true])
    expect(r.calls).toHaveLength(2)
    expect(r.toasts).toEqual(['Hiba: Restart failed'])
  })

  it('first confirm declined: no request', async () => {
    const r = await click([], [false])
    expect(r.calls).toHaveLength(0)
    expect(r.toasts).toEqual([])
  })
})
