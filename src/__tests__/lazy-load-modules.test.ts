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

  it('app-core.js handles async enter() results in switchPage', () => {
    expect(APP_CORE).toContain('result instanceof Promise')
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
  }
})
