/**
 * #2429: a scheduled task the runner skips (GET /api/schedules `registry` is not 'ok') reads
 * "not firing" with the reason and the fix, not "active". #2430: the Overview memory tile's
 * category count is translated. Runs the SHIPPED code from web/app.js with the real hu/en
 * dictionaries.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const APP = readFileSync(new URL('../../web/app.js', import.meta.url), 'utf-8')
const start = APP.indexOf('const SCHEDULE_REGISTRY_REASONS')
const end = APP.indexOf('\nfunction renderScheduleList(', start)
const SNIPPET = APP.slice(start, end)

function dict(lang: 'hu' | 'en'): Record<string, string> {
  const win: { _i18n?: Record<string, Record<string, string>> } = {}
  new Function('window', readFileSync(new URL(`../../web/lang/${lang}.js`, import.meta.url), 'utf-8'))(win)
  return win._i18n![lang]
}
const DICTS = { hu: dict('hu'), en: dict('en') }
function makeT(lang: 'hu' | 'en') {
  return (key: string, params: Record<string, unknown> = {}) => {
    const str = DICTS[lang][key]
    if (str === undefined) throw new Error(`missing key ${lang}:${key}`)
    return str.replace(/\{(\w+)\}/g, (_, k) => (params[k] != null ? String(params[k]) : `{${k}}`))
  }
}
const escapeHtml = (s: string) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function renderRow(task: Record<string, unknown>, lang: 'hu' | 'en' = 'en'): string {
  const row = { className: '', innerHTML: '', addEventListener() {}, querySelector: () => ({ addEventListener() {} }) }
  const document = { createElement: () => row }
  const make = new Function(
    'document', 't', 'escapeHtml', 'scheduleAgents', 'mainAgentId', 'avatarBust', 'describeCron', 'pauseIcon', 'playIcon', 'trashIcon',
    `${SNIPPET}\nreturn makeScheduleRow`,
  )(document, makeT(lang), escapeHtml, [], () => 'marveen', () => '', () => 'every day', () => '', () => '', () => '') as (t: unknown) => unknown
  make({ name: 'daily-digest', description: 'Daily digest', schedule: '0 8 * * *', enabled: true, ...task })
  return row.innerHTML
}

describe('#2429 schedule row: not firing', () => {
  it('the snippet is found in web/app.js', () => {
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
  })

  it.each(['unregistered', 'hash-mismatch', 'no-hash', 'registry-error'])('registry %s: the not-firing badge with its reason and the fix, no active badge', (reason) => {
    const html = renderRow({ registry: reason, dirName: 'daily-digest' })
    expect(html).toContain('badge-not-firing')
    expect(html).toContain('>not firing<')
    expect(html).not.toContain('badge-active')
    expect(html).toContain(DICTS.en[`tasks.registry.${reason}`])
    expect(html).toContain('schedule-registry-cli.js register daily-digest')
  })

  it('a paused task the runner skips is also "not firing", not "paused"', () => {
    const html = renderRow({ registry: 'hash-mismatch', enabled: false })
    expect(html).toContain('badge-not-firing')
    expect(html).not.toContain('badge-paused')
  })

  it('Hungarian page: the Hungarian badge, reason and fix', () => {
    const html = renderRow({ registry: 'hash-mismatch' }, 'hu')
    expect(html).toContain('>nem fut<')
    expect(html).toContain('a fájljait a dashboardon kívül módosították')
    expect(html).toContain('regisztráld újra')
  })

  it('the register name is the task directory when it differs from the name', () => {
    const html = renderRow({ registry: 'unregistered', name: 'x', dirName: 'real-dir' })
    expect(html).toContain('register real-dir')
  })

  it('an unknown reason is shown as is, escaped', () => {
    const html = renderRow({ registry: '<b>new-reason</b>' })
    expect(html).toContain('badge-not-firing')
    expect(html).toContain('&lt;b&gt;new-reason&lt;/b&gt;')
    expect(html).not.toContain('<b>new-reason')
  })

  it.each([[{ registry: 'ok' }, 'badge-active'], [{}, 'badge-active'], [{ enabled: false }, 'badge-paused'], [{ registry: 'ok', enabled: false }, 'badge-paused']])(
    'runner fires it or an older server without the field (%j): %s as before, no note', (task, badge) => {
      const html = renderRow(task)
      expect(html).toContain(badge)
      expect(html).not.toContain('badge-not-firing')
      expect(html).not.toContain('schedule-not-firing')
    })
})

describe('#2430 Overview memory tile', () => {
  it('the category count goes through a translation key, no literal English word', () => {
    const line = APP.split('\n').find((l) => l.includes("getElementById('statMemoriesSub').textContent"))!
    expect(line).toContain("t('overview.stat.sub.categories', { n: d.memories.categories })")
    expect(line).not.toMatch(/\} category`/)
  })

  it.each([['hu', '4 kategória'], ['en', 'categories: 4']] as const)('%s: %s', (lang, want) => {
    expect(makeT(lang)('overview.stat.sub.categories', { n: 4 })).toBe(want)
  })

  it.each(['hu', 'en'] as const)('the new keys exist in %s without a dash', (lang) => {
    for (const k of ['tasks.status.not_firing', 'tasks.status.not_firing_tip', 'tasks.registry.unregistered', 'tasks.registry.hash-mismatch',
      'tasks.registry.no-hash', 'tasks.registry.registry-error', 'overview.stat.sub.categories']) {
      expect(DICTS[lang][k], k).toBeTruthy()
      expect(DICTS[lang][k]).not.toMatch(/[\u2013\u2014]/)
    }
  })
})
