/**
 * fb79dc1f (c): the dashboard's Reminders page (web/index.html, web/app.js,
 * web/lang). The page is wired (sidebar link, page, router), every translation
 * key it uses exists in both languages, and its section rule puts a reminder
 * where the card says: the next 7 days, sent in the last 7 days, missed.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const web = join(__dirname, '..', '..', 'web')
const html = readFileSync(join(web, 'index.html'), 'utf-8')
const app = readFileSync(join(web, 'app.js'), 'utf-8')
const hu = readFileSync(join(web, 'lang', 'hu.js'), 'utf-8')
const en = readFileSync(join(web, 'lang', 'en.js'), 'utf-8')

function langKeys(src: string): Set<string> {
  return new Set([...src.matchAll(/^\s*'([a-z0-9_.]+)':/gm)].map(m => m[1]))
}

function extractFunction(src: string, name: string): string {
  const start = src.indexOf(`function ${name}(`)
  if (start < 0) throw new Error(`no function ${name}`)
  const end = src.indexOf('\n}\n', start)
  return src.slice(start, end + 2)
}

describe('the Reminders page is wired', () => {
  it('has a sidebar link and a page with its parts', () => {
    expect(html).toContain('data-page="reminders"')
    for (const id of ['remindersPage', 'remindersSections', 'refreshRemindersBtn', 'remindersFilterRecipient', 'remindersFilterAgent']) {
      expect(html).toContain(`id="${id}"`)
    }
  })

  it('the router loads it and the API it reads is the reminders list', () => {
    expect(app).toContain("if (pageId === 'reminders') loadRemindersPage()")
    expect(app).toContain("reminders: 'nav.reminders'")
    expect(app).toMatch(/async function loadRemindersPage\(\)/)
    expect(app).toContain('/api/reminders?limit=500&due_from=')
    expect(app).toContain('`/api/reminders/${id}`')
  })

  it('CONTROL: the same search sees the neighbour approvals page', () => {
    expect(html).toContain('data-page="approvals"')
    expect(app).toContain("if (pageId === 'approvals') loadApprovalsPage()")
  })
})

describe('every reminders translation key exists in both languages', () => {
  const used = new Set<string>([
    // a literal ending in '.' is a dynamic prefix (t('reminders.status.' + s)): its keys are listed below
    ...[...app.matchAll(/t\('(reminders\.[a-z0-9_.]+)'/g)].map(m => m[1]).filter(k => !k.endsWith('.')),
    ...[...html.matchAll(/data-i18n(?:-placeholder)?="(reminders\.[a-z0-9_.]+|nav\.reminders)"/g)].map(m => m[1]),
    ...['upcoming', 'sent', 'missed'].map(k => `reminders.section.${k}`),
    ...['pending', 'sending', 'sent', 'failed', 'cancelled'].map(k => `reminders.status.${k}`),
    'nav.reminders',
  ])

  it('the scan found the keys (not an empty pass)', () => {
    expect(used.size).toBeGreaterThan(20)
  })

  it.each([['hu', hu], ['en', en]])('%s has them all', (_l, src) => {
    const have = langKeys(src)
    expect([...used].filter(k => !have.has(k))).toEqual([])
  })
})

describe('the section rule', () => {
  const reminderSection = new Function('REMINDERS_DAYS', `${extractFunction(app, 'reminderSection')}; return reminderSection`)(7) as
    (r: Record<string, unknown>, nowSec: number) => string | null
  const now = 1_791_400_000
  const day = 86_400

  it.each([
    ['sent 1 day ago', { status: 'sent', sent_at: now - day, send_after: now - day }, 'sent'],
    ['sent 8 days ago', { status: 'sent', sent_at: now - 8 * day, send_after: now - 8 * day }, null],
    ['failed', { status: 'failed', send_after: now - day }, 'missed'],
    ['cancelled', { status: 'cancelled', send_after: now + day }, 'missed'],
    ['pending in 1 hour', { status: 'pending', send_after: now + 3600 }, 'upcoming'],
    ['pending in 8 days', { status: 'pending', send_after: now + 8 * day }, null],
    ['pending 20 minutes past its moment', { status: 'pending', send_after: now - 1200 }, 'missed'],
    ['pending 5 minutes past (the sender has not come round yet)', { status: 'pending', send_after: now - 300 }, 'upcoming'],
    ['sending', { status: 'sending', send_after: now - 30 }, 'upcoming'],
  ])('%s', (_n, r, want) => {
    expect(reminderSection(r, now)).toBe(want)
  })
})
