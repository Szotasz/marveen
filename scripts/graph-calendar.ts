#!/usr/bin/env tsx
// Thin CLI over src/graph-calendar.ts, so the calendar can be smoke-tested and
// operated by hand on handover day without writing code.
//
//   tsx scripts/graph-calendar.ts verify
//   tsx scripts/graph-calendar.ts list [--from 2026-10-16] [--days 1] [--top N]
//   tsx scripts/graph-calendar.ts create --subject "..." --start 2026-10-16T09:00 --end 2026-10-16T09:30
//                                        [--attendee a@b.hu,c@d.hu] [--location "..."] [--body "..."] [--online]
//   tsx scripts/graph-calendar.ts delete --id <eventId> --yes
//   tsx scripts/graph-calendar.ts freebusy --who a@b.hu,c@d.hu [--from 2026-10-16] [--days 1]
//
// Times are Europe/Budapest local, written as the calendar shows them
// (2026-10-16T09:00). No Z suffix, no offset arithmetic by hand: the zone
// travels with the request.
//
// Credentials come from the gitignored marveen-mail-ugyfelkod file (override
// with MARVEEN_MAIL_CREDS) -- the same file and the same app registration the
// mailbox uses.

import {
  createEvent,
  deleteEvent,
  getSchedule,
  listEvents,
  verifyCalendarAccess,
} from '../src/graph-calendar.js'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const INVITE_ALLOWLIST = join(import.meta.dirname, '..', 'store', 'calendar-invite-allowlist.json')

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i !== -1 ? process.argv[i + 1] : undefined
}
function has(name: string): boolean {
  return process.argv.includes(`--${name}`)
}

/** Local YYYY-MM-DD for today, in the machine's zone (Europe/Budapest). */
function todayLocal(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** Window from --from (default today) spanning --days (default 1). */
function window(): { start: string; end: string } {
  const from = flag('from') ?? todayLocal()
  const days = Number(flag('days') ?? 1)
  const end = new Date(`${from}T00:00:00`)
  end.setDate(end.getDate() + (Number.isFinite(days) && days > 0 ? days : 1))
  const pad = (n: number) => String(n).padStart(2, '0')
  const endStr = `${end.getFullYear()}-${pad(end.getMonth() + 1)}-${pad(end.getDate())}`
  return { start: `${from}T00:00:00`, end: `${endStr}T00:00:00` }
}

async function main(): Promise<void> {
  const cmd = process.argv[2]
  switch (cmd) {
    case 'verify': {
      const r = await verifyCalendarAccess()
      console.log(`OK -- reachable calendar for ${r.mailbox}`)
      console.log('(ez az OLVASAST bizonyitja; az irast az elso create fogja)')
      break
    }
    case 'list': {
      const w = window()
      const events = await listEvents({ ...w, top: flag('top') ? Number(flag('top')) : undefined })
      console.log(`ablak: ${w.start} -> ${w.end}`)
      if (events.length === 0) {
        console.log('(nincs esemeny)')
        break
      }
      for (const e of events) {
        const when = e.isAllDay ? `${e.start?.dateTime ?? ''} (egesz nap)` : `${e.start?.dateTime} - ${e.end?.dateTime}`
        const where = e.location?.displayName ? `  @ ${e.location.displayName}` : ''
        console.log(`${when}${where}\n    ${e.subject ?? '(nincs targy)'}\n    id: ${e.id}\n`)
      }
      break
    }
    case 'create': {
      const subject = flag('subject')
      const start = flag('start')
      const end = flag('end')
      if (!subject || !start || !end) {
        console.error('create requires --subject, --start and --end (e.g. --start 2026-10-16T09:00)')
        process.exit(2)
      }
      const attendees = flag('attendee')?.split(',').map((a) => a.trim()).filter(Boolean)
      if (attendees?.length) {
        // Invites leave the house, so they are gated by an owner-maintained
        // allowlist. Missing or unreadable list means nobody: fail closed.
        let allowed: string[] = []
        try {
          const list = JSON.parse(readFileSync(INVITE_ALLOWLIST, 'utf-8'))
          allowed = (list.addresses ?? []).map((a: { address: string }) => a.address.toLowerCase())
        } catch {
          /* fall through with an empty list */
        }
        const denied = attendees.filter((a) => !allowed.includes(a.toLowerCase()))
        if (denied.length) {
          console.error(`create refused: not on the invite allowlist (${INVITE_ALLOWLIST}): ${denied.join(', ')}`)
          process.exit(3)
        }
      }
      const event = await createEvent({
        subject,
        start,
        end,
        location: flag('location'),
        body: flag('body'),
        attendees,
        isOnlineMeeting: has('online'),
      })
      console.log(`letrehozva: ${event.id}`)
      if (event.onlineMeeting?.joinUrl) console.log(`online link: ${event.onlineMeeting.joinUrl}`)
      break
    }
    case 'delete': {
      const id = flag('id')
      if (!id) {
        console.error('delete requires --id')
        process.exit(2)
      }
      // A delete on an organised event cancels it for every attendee. That is
      // not something a mistyped command should do, so it needs --yes.
      if (!has('yes')) {
        console.error('delete requires --yes (egy szervezett esemeny torlese MINDEN resztvevonel lemondja)')
        process.exit(2)
      }
      await deleteEvent(id)
      console.log(`torolve: ${id}`)
      break
    }
    case 'freebusy': {
      const who = flag('who')
      if (!who) {
        console.error('freebusy requires --who a@b.hu[,c@d.hu]')
        process.exit(2)
      }
      const w = window()
      const rows = await getSchedule({ addresses: who.split(','), ...w })
      for (const r of rows) {
        console.log(`${r.address}:`)
        if (r.items.length === 0) {
          console.log('    (szabad, vagy nem lathatjuk a naptarat)')
          continue
        }
        for (const i of r.items) {
          console.log(`    ${i.start?.dateTime} - ${i.end?.dateTime}  ${i.status ?? ''} ${i.subject ?? ''}`)
        }
      }
      break
    }
    default:
      console.error('usage: graph-calendar.ts <verify|list|create|delete|freebusy> [options] (see file header)')
      process.exit(2)
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
