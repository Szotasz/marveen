import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Regression for the first live promote (2026-08-20): the stats row counted the
// already-filtered list, so under the default "active" filter the "Kanbanban"
// box showed 0 right after a promote and the item's disappearance from the list
// read as data loss. The stats must be computed from the unfiltered fetch.
const appJs = readFileSync(join(__dirname, '../../web/app.js'), 'utf8')

describe('ideas stats count the unfiltered set', () => {
  it('renderIdeasStats iterates ideasAll, not the display list', () => {
    const fn = appJs.slice(appJs.indexOf('function renderIdeasStats'))
    const body = fn.slice(0, fn.indexOf('\n}'))
    expect(body).toContain('of ideasAll')
    expect(body).not.toMatch(/for \(const \w+ of ideas\)/)
  })

  it('loadIdeasPage fetches without a server-side status filter', () => {
    const fn = appJs.slice(appJs.indexOf('async function loadIdeasPage'))
    const body = fn.slice(0, fn.indexOf('\n}'))
    // The status narrowing must happen client-side on ideasAll so the stats
    // row still sees every status.
    expect(body).not.toContain("params.set('status'")
    expect(body).toContain('ideasAll =')
  })
})
