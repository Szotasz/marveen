// The Connectors page's last native alert() calls: a server error goes to a toast, and a failed
// npm install after a GitHub repo install stays in the install's own status line, in red.
// The real code runs here, cut out of web/app.js, with the browser parts passed in.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const APP = readFileSync(new URL('../../web/app.js', import.meta.url), 'utf-8')
const CSS = readFileSync(new URL('../../web/style.css', import.meta.url), 'utf-8')

// The block that starts at `start` (a function or an IIFE), up to its matching closing brace.
function block(start: string): string {
  const i = APP.indexOf(start)
  if (i < 0) return ''
  let depth = 0
  for (let j = APP.indexOf('{', i); j < APP.length; j++) {
    if (APP[j] === '{') depth++
    else if (APP[j] === '}' && --depth === 0) return APP.slice(i, j + 1)
  }
  return ''
}

const OPT_IN = block('async function offerGitHubRepoScriptsOptIn(')
const REPOS = block('async function loadGitHubRepos(')
// An IIFE is cut at its function's closing brace: the call is added back.
const iife = (start: string) => { const b = block(start); return b ? `${b})()` : '' }
const INSTALL = iife(';(function wireGitHubRepos() {')
const EXTERNAL = iife(';(function wireExternalPaths() {')
const tr = (key: string, vars?: Record<string, string>) => (vars ? `${key} ${JSON.stringify(vars)}` : key)
const NATIVE = /(^|[^.\w])alert\(/

function el(extra: Record<string, unknown> = {}) {
  const listeners: Record<string, (e?: unknown) => Promise<void> | void> = {}
  return {
    listeners,
    hidden: false, value: '', className: '', textContent: '', disabled: false, checked: false,
    addEventListener: (type: string, f: (e?: unknown) => Promise<void> | void) => { listeners[type] = f },
    querySelector: () => ({ textContent: '' }),
    classList: { contains: (_c: string) => false },
    ...extra,
  }
}

describe('the Connectors page has no native alert() left', () => {
  it('the four places were found, and no alert() call is left in app.js', () => {
    for (const part of [OPT_IN, REPOS, INSTALL, EXTERNAL]) expect(part).not.toBe('')
    const code = APP.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
    expect(code).not.toMatch(NATIVE)
  })

  it('a failed script opt-in shows the server error in a toast', async () => {
    const toasts: string[] = []
    const run = new Function('confirmDialog', 't', 'fetch', 'showToast', `${OPT_IN}\nreturn offerGitHubRepoScriptsOptIn`)(
      async () => true, tr,
      async () => ({ json: async () => ({ error: 'scripts failed' }) }),
      (m: string) => { toasts.push(m) },
    ) as (name: string, skipped: string[]) => Promise<void>
    await run('owner--repo', ['postinstall'])
    expect(toasts).toEqual(['scripts failed'])
  })

  it('a failed repo update shows the server error in a toast, offers nothing and gives the button back', async () => {
    const toasts: string[] = []
    const offers: string[] = []
    const btn = { disabled: false, textContent: '', innerHTML: '' }
    let onUpdate: ((e: unknown) => Promise<void>) | null = null
    const item = {
      className: '', innerHTML: '',
      querySelector: (sel: string) => ({ addEventListener: (_: string, f: (e: unknown) => Promise<void>) => { if (sel === '.github-repo-update') onUpdate = f } }),
    }
    const list = { innerHTML: '', textContent: '', appendChild: () => {} }
    const run = new Function('fetch', 'document', 't', 'escapeHtml', 'showToast', 'offerGitHubRepoScriptsOptIn', 'loadConnectors', 'confirmDialog', 'loadExternalPaths', `${REPOS}\nreturn loadGitHubRepos`)(
      async (url: string, init: { method?: string } = {}) => ({
        json: async () => (init.method === 'PATCH' ? { error: 'update failed' } : { repos: [{ name: 'owner--repo', installedAt: 0 }] }),
        ok: true,
        url,
      }),
      { getElementById: () => list, createElement: () => item },
      tr, (x: string) => x,
      (m: string) => { toasts.push(m) },
      async (name: string) => { offers.push(name) },
      () => {}, async () => true, () => {},
    ) as () => Promise<void>
    await run()
    expect(onUpdate).not.toBeNull()
    await onUpdate!({ currentTarget: btn })
    expect(toasts).toEqual(['update failed'])
    expect(offers).toEqual([])
    expect(btn.disabled).toBe(false)
  })

  it('a failed external path shows the server error in a toast and keeps what was typed', async () => {
    const toasts: string[] = []
    const reloads: string[] = []
    const els: Record<string, ReturnType<typeof el>> = {
      externalPathsToggle: el(), externalPathsBody: el(), externalPathAddBtn: el(), externalPathInput: el({ value: '/srv/x' }),
    }
    new Function('document', 'fetch', 'showToast', 'loadExternalPaths', 'loadConnectors', EXTERNAL)(
      { getElementById: (id: string) => els[id] },
      async () => ({ json: async () => ({ error: 'path refused' }) }),
      (m: string) => { toasts.push(m) },
      () => { reloads.push('paths') }, () => { reloads.push('connectors') },
    )
    await els.externalPathAddBtn.listeners.click()
    expect(toasts).toEqual(['path refused'])
    expect(els.externalPathInput.value).toBe('/srv/x')
    expect(reloads).toEqual([])
  })
})

describe('a failed npm install stays in the install status line', () => {
  async function install(answer: Record<string, unknown>, envValues: Record<string, string> | null = null, vaultOk = true) {
    const offers: string[] = []
    const timers: number[] = []
    let statusClass = ''
    const status = {
      hidden: true, textContent: '',
      get className() { return statusClass },
      set className(v: string) { statusClass = v },
      classList: { contains: (c: string) => statusClass.split(' ').includes(c) },
    }
    const els: Record<string, unknown> = {
      githubReposToggle: el(), githubReposBody: el(), githubRepoAddBtn: el(), githubRepoInput: el({ value: 'owner/repo' }),
      githubRepoStatus: status, githubRepoRunScripts: el(),
    }
    new Function('document', 'fetch', 'confirmDialog', 't', 'offerGitHubRepoScriptsOptIn', 'showEnvVarModal', 'loadVault', 'loadGitHubRepos', 'loadExternalPaths', 'loadConnectors', 'setTimeout', INSTALL)(
      { getElementById: (id: string) => els[id] },
      async (url: string) => ({ ok: url !== '/api/vault' || vaultOk, json: async () => answer }),
      async () => true, tr,
      async (name: string) => { offers.push(name) },
      async () => envValues,
      () => {}, () => {}, () => {}, () => {},
      (_f: () => void, ms: number) => { timers.push(ms) },
    )
    await (els.githubRepoAddBtn as ReturnType<typeof el>).listeners.click()
    return { status, offers, timers }
  }
  const warned = { repo: { name: 'owner--repo' }, installWarning: 'npm install failed: ERR! 404', scriptsSkipped: ['postinstall'] }
  const warning = 'connectors.install_warning {"msg":"npm install failed: ERR! 404"}'

  it('in red, in place of the success text, and it is not hidden after a few seconds; no opt-in is offered', async () => {
    const r = await install(warned)
    expect(r.status.className).toBe('github-repo-status error')
    expect(r.status.textContent).toBe(warning)
    expect(r.status.hidden).toBe(false)
    expect(r.timers).toEqual([])
    expect(r.offers).toEqual([])
  })

  it('a key-save failure stays below the warning', async () => {
    const r = await install({ ...warned, requiredEnvVars: ['API_KEY'] }, { API_KEY: 'x' }, false)
    expect(r.status.className).toBe('github-repo-status error')
    expect(r.status.textContent.startsWith(warning + '\n\n')).toBe(true)
    expect(r.status.textContent).toContain('kulcs mentése sikertelen')
  })

  it('without a warning the install reports success, offers the opt-in and hides the line later, as before', async () => {
    const r = await install({ repo: { name: 'owner--repo' }, scriptsSkipped: ['postinstall'] })
    expect(r.status.className).toBe('github-repo-status success')
    expect(r.offers).toEqual(['owner--repo'])
    expect(r.timers).toEqual([4000])
  })

  it('the status line keeps the line breaks of the warning and wraps a long npm message', () => {
    const rule = /\.github-repo-status \{([^}]*)\}/.exec(CSS)?.[1] ?? ''
    expect(rule).toMatch(/white-space:\s*pre-line/)
    expect(rule).toMatch(/overflow-wrap:\s*anywhere/)
  })
})
