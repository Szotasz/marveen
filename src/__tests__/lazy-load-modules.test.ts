// Contract guard: JS module lazy-load implementation.
//
// Large JS modules (memories, connectors, schedules, settings, etc.) are no
// longer statically imported at app startup. They are loaded on first navigation
// via dynamic import() wrapped in the lazyLoad() helper. These tests ensure the
// structure does not regress to eager loading.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const APP_JS = readFileSync(join(__dirname, '../../web/app.js'), 'utf-8')
const APP_CORE = readFileSync(join(__dirname, '../../web/modules/app-core.js'), 'utf-8')

const LAZY_MODULES = [
  'memories.js',
  'connectors.js',
  'schedules.js',
  'settings.js',
  'token-usage.js',
  'federation.js',
  'ideas.js',
  'status-costs.js',
  'docs-research.js',
  'recall-bgtasks.js',
  'approvals.js',
  'migrate.js',
  'import-memories.js',
  'artifacts.js',
  'backups.js',
]

describe('lazy-load: module structure', () => {
  it('app.js contains the lazyLoad() helper', () => {
    expect(APP_JS).toContain('function lazyLoad(')
  })

  it('app.js contains the _moduleCache Map', () => {
    expect(APP_JS).toContain('_moduleCache = new Map()')
  })

  it('app-core.js applies overlay only when lazy: true (not on all async enter)', () => {
    // The overlay must be gated on pageReg.lazy, NOT on "result instanceof Promise".
    // Static pages (overview, kanban) have async enter() for data-fetching -- they must
    // not trigger the overlay. Using the Promise heuristic would block every navigation.
    expect(APP_CORE).toContain('pageReg?.lazy && result instanceof Promise')
  })

  it('app-core.js registerPage accepts lazy flag', () => {
    expect(APP_CORE).toContain('lazy = false')
  })

  it('app-core.js shows a loading overlay for async page transitions', () => {
    expect(APP_CORE).toContain('_showPageLoading')
  })

  it('app-core.js hides the overlay after async enter() resolves', () => {
    expect(APP_CORE).toContain('_hidePageLoading')
  })

  it('app-core.js shows an error state when async enter() rejects', () => {
    expect(APP_CORE).toContain('_showPageError')
  })

  for (const mod of LAZY_MODULES) {
    it(`app.js uses dynamic import() for ${mod}`, () => {
      expect(APP_JS).toContain(`import('./modules/${mod}')`)
    })

    it(`app.js does NOT statically import ${mod}`, () => {
      // Static import lines start with "import {" and reference the module path.
      // Dynamic imports use import() — those are allowed and tested above.
      const staticPattern = new RegExp(`^import\\s*\\{[^}]+\\}\\s*from\\s*['"]\\./modules/${mod.replace('.', '\\.')}['"]`, 'm')
      expect(APP_JS).not.toMatch(staticPattern)
    })

    it(`app.js marks ${mod} page as lazy: true`, () => {
      // Every lazy module's registerPage call must carry lazy: true so the
      // overlay/timeout logic in switchPage fires only for actual module loads,
      // not for the fire-and-forget data-fetching calls of static pages.
      // A module may appear multiple times (e.g. ideas.js in the kanban thunk AND
      // in registerPage). Check that at least ONE occurrence has lazy: true nearby.
      const importStr = `import('./modules/${mod}')`
      let pos = 0
      let found = false
      while ((pos = APP_JS.indexOf(importStr, pos)) !== -1) {
        const surrounding = APP_JS.slice(Math.max(0, pos - 800), pos + 50)
        if (surrounding.includes('lazy: true')) { found = true; break }
        pos += importStr.length
      }
      expect(found).toBe(true)
    })
  }
})
