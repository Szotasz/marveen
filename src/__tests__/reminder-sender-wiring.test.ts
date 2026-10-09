/**
 * fb79dc1f: the reminder sender and the reminders API are WIRED into the
 * dashboard (src/web.ts): a module that is imported but never started, or a
 * route that is never asked, would make every reminder silently wait forever.
 * The sender must not start in WEB_ONLY (a staging copy never sends), and the
 * shutdown clears its interval like the other runners.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const webTs = readFileSync(join(__dirname, '..', 'web.ts'), 'utf-8')

describe('src/web.ts wiring of the reminders', () => {
  it('imports the route and the sender', () => {
    expect(webTs).toContain("import { tryHandleReminders } from './web/routes/reminders.js'")
    expect(webTs).toContain("import { startReminderSender } from './web/reminder-sender.js'")
  })

  it('asks the reminders route in the request chain', () => {
    expect(webTs).toMatch(/if \(await tryHandleReminders\(routeCtx\)\) return/)
  })

  it('starts the sender only outside WEB_ONLY, and clears it on shutdown', () => {
    expect(webTs).toMatch(/const reminderSenderInterval = webOnly \? undefined : startReminderSender\(\)/)
    expect(webTs).toMatch(/if \(reminderSenderInterval\) clearInterval\(reminderSenderInterval\)/)
  })

  it('CONTROL: the same search sees a neighbour runner (the file is the real one)', () => {
    expect(webTs).toMatch(/const midTurnCommandInterval = webOnly \? undefined : startMidTurnCommandWatcher\(\)/)
    expect(webTs).toMatch(/if \(await tryHandleApprovals\(routeCtx\)\) return/)
  })
})
