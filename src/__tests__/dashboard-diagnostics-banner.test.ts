// Behaviour tests for the dashboard diagnostics banner (#95 feature, #140 fix).
//
// The banner used to stay up forever after a single failed request: an F3
// deploy restarted the service while the tab was open, one poll failed, and
// the red MARVEEN DIAGNOSZTIKA stripe was still there long after the endpoint
// answered 200 again. It reached the owner as a screenshot of a problem that
// no longer existed.
//
// web/app.js is a classic browser script, not a module, so it cannot be
// imported. The house idiom is to read it as a string and assert fragments --
// too weak for logic like "clears itself on recovery". Instead the factory is
// delimited by sentinel comments in the source and executed here with a fake
// document, which tests the shipped code rather than a copy of it.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web')
const appSource = readFileSync(join(WEB, 'app.js'), 'utf8')

function extractFactory(): (env: unknown) => Diagnostics {
  const start = appSource.indexOf('// --- createDiagnostics start')
  const end = appSource.indexOf('// --- createDiagnostics end')
  // A missing sentinel means the block was renamed or moved: fail loudly
  // rather than silently testing nothing.
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  const src = appSource.slice(start, end)
  return new Function(`${src}; return createDiagnostics`)() as (env: unknown) => Diagnostics
}

interface Diagnostics {
  report(detail: string, key?: string): void
  resolve(key: string | null): void
  list(): { detail: string; key: string | null }[]
}

// Just enough DOM for the banner: an element registry with a body that keeps
// its children, so "was the banner removed" is answerable.
function fakeDoc() {
  const byId = new Map<string, any>()
  const children: any[] = []
  const body = {
    appendChild(el: any) { children.push(el); el.parentNode = body; byId.set(el.id, el) },
    removeChild(el: any) {
      const i = children.indexOf(el)
      if (i >= 0) children.splice(i, 1)
      el.parentNode = null
      byId.delete(el.id)
    },
  }
  return {
    body,
    children,
    getElementById: (id: string) => byId.get(id) ?? null,
    createElement: () => ({ id: '', style: {}, textContent: '', parentNode: null }),
  }
}

const createDiagnostics = extractFactory()
let doc: ReturnType<typeof fakeDoc>
let enabled: boolean
let diag: Diagnostics

beforeEach(() => {
  doc = fakeDoc()
  enabled = true
  diag = createDiagnostics({ doc, isEnabled: () => enabled, tokenState: () => 'localStorage' })
})

const banner = () => doc.getElementById('mv-diag-banner')

describe('what the banner shows', () => {
  it('appears on the first problem, with the detail in it', () => {
    diag.report('HTTP 500: /api/background-tasks', '/api/background-tasks')
    expect(banner()).not.toBeNull()
    expect(banner().textContent).toContain('HTTP 500: /api/background-tasks')
    expect(banner().textContent).toContain('token: localStorage')
  })

  it('does not repeat the same problem', () => {
    diag.report('HTTP 500: /api/x', '/api/x')
    diag.report('HTTP 500: /api/x', '/api/x')
    expect(diag.list()).toHaveLength(1)
  })

  it('stays out of the DOM entirely while diagnostics are off', () => {
    enabled = false
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    diag.report('HTTP 500: /api/x', '/api/x')
    expect(banner()).toBeNull()
    // Still debuggable: the problem goes to the console instead.
    expect(warn).toHaveBeenCalledWith('[mv-diag]', 'HTTP 500: /api/x')
    warn.mockRestore()
  })
})

describe('a transient failure does not stick', () => {
  it('drops the banner once the endpoint answers again', () => {
    // The exact 2026-07-31 sequence: a poll fails mid-deploy, the next one
    // succeeds.
    diag.report('FETCH FAILED: /api/background-tasks -- Failed to fetch', '/api/background-tasks')
    expect(banner()).not.toBeNull()

    diag.resolve('/api/background-tasks')
    expect(diag.list()).toHaveLength(0)
    expect(banner()).toBeNull()
    expect(doc.children).toHaveLength(0)
  })

  it('clears both the thrown fetch and the http error of the same endpoint', () => {
    diag.report('FETCH FAILED: /api/x -- Failed to fetch', '/api/x')
    diag.report('HTTP 502: /api/x', '/api/x')
    diag.resolve('/api/x')
    expect(diag.list()).toHaveLength(0)
  })

  it('keeps the banner for the endpoints that are still down', () => {
    diag.report('HTTP 500: /api/a', '/api/a')
    diag.report('HTTP 500: /api/b', '/api/b')
    diag.resolve('/api/a')

    expect(diag.list().map(p => p.key)).toEqual(['/api/b'])
    expect(banner()).not.toBeNull()
    expect(banner().textContent).toContain('/api/b')
    expect(banner().textContent).not.toContain('/api/a')
  })

  it('leaves a sustained failure alone -- nothing succeeded for it', () => {
    diag.report('HTTP 500: /api/down', '/api/down')
    diag.resolve('/api/other')
    expect(banner()).not.toBeNull()
    expect(diag.list()).toHaveLength(1)
  })
})

describe('problems no request can clear', () => {
  it('keeps a page error even when every endpoint recovers', () => {
    // A page error is a bug, not weather: no successful poll proves it gone.
    diag.report('PAGE ERROR: x is not a function @ app.js:12')
    diag.report('HTTP 500: /api/x', '/api/x')
    diag.resolve('/api/x')

    expect(diag.list().map(p => p.detail)).toEqual(['PAGE ERROR: x is not a function @ app.js:12'])
    expect(banner()).not.toBeNull()
  })

  it('ignores a resolve with no key', () => {
    diag.report('UNHANDLED PROMISE: boom')
    diag.resolve(null)
    expect(diag.list()).toHaveLength(1)
  })
})

describe('the wiring in app.js', () => {
  it('blames the failing url so a later success can clear it', () => {
    expect(appSource).toContain("mvReportProblem('FETCH FAILED: ' + url + ' -- ' + (err && err.message ? err.message : String(err)), url)")
    expect(appSource).toContain("mvReportProblem('HTTP ' + res.status + ': ' + url, url)")
  })

  it('resolves the url on every ok (or 304) same-origin response', () => {
    expect(appSource).toContain('if (isSameOriginApi && (res.ok || res.status === 304)) mvDiag.resolve(url)')
  })
})
