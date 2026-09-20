// Measured on our install. listKanbanCards() ran an UPDATE before its SELECT: every read of the
// board archived 'done' cards older than KANBAN_ARCHIVE_DONE_DAYS. So THE MEASUREMENT
// CHANGED THE MEASURED SET -- an audit asking "what is on the board" archived cards as a
// side effect of asking, and what it reported was not what existed a moment earlier.
//
// The sweep moved to sweepArchivedKanbanCards(), driven by src/web/kanban-archive-runner.ts.
//
// The danger of this change is the INVERSE failure, and that is what most of this file
// guards: if the sweep leaves the read path and is not started anywhere, nothing errors --
// cards simply never archive again, and KANBAN_ARCHIVE_DONE_DAYS becomes a decoration.
// So the tests below assert both that reading is now inert AND that the sweep still works
// and is still wired into the process that is supposed to run it.

import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  initDatabase, getDb, listKanbanCards, sweepArchivedKanbanCards,
  getKanbanCard, createKanbanCard,
} from '../db.js'

beforeEach(() => {
  initDatabase(':memory:')
})

const DAY = 86400
const OLD = Math.floor(Date.now() / 1000) - 40 * DAY // past the 30-day default cutoff

function seedOldDoneCard(id = 'old-done'): void {
  getDb().prepare(
    `INSERT INTO kanban_cards (id, title, status, priority, created_at, updated_at)
     VALUES (?, 'old and done', 'done', 'normal', ?, ?)`
  ).run(id, OLD, OLD)
}

describe('a LEKERDEZES NEM IR -- ez a kartya lenyege', () => {
  it('ket egymas utani listKanbanCards() nem valtoztat az archived_at oszlopon', () => {
    seedOldDoneCard()
    listKanbanCards()
    expect(getKanbanCard('old-done')!.archived_at).toBeNull()
    listKanbanCards()
    expect(getKanbanCard('old-done')!.archived_at).toBeNull()
  })

  it('az includeArchived-es olvasas sem ir', () => {
    // A masik ag ugyanolyan olvasas; ha csak az egyiket tisztitottuk volna meg, a
    // mellekhatas egy kapcsolo mogott elne tovabb.
    seedOldDoneCard()
    listKanbanCards({ includeArchived: true })
    expect(getKanbanCard('old-done')!.archived_at).toBeNull()
  })

  it('a lekerdezes a MERT HALMAZT sem valtoztatja meg ket hivas kozott', () => {
    // A tenyleges kar nem az oszlop volt, hanem hogy a valasz mas lett attol, hogy kerdeztunk.
    seedOldDoneCard()
    createKanbanCard({ id: 'live-1', title: 'Aktiv' })
    expect(listKanbanCards().map(c => c.id)).toEqual(listKanbanCards().map(c => c.id))
  })
})

describe('a SOPRES viszont TOVABBRA IS mukodik -- kulonben ez a javitas kikapcsolna a funkciot', () => {
  it('sweepArchivedKanbanCards() archivalja a regi done kartyat, es megmondja, hanyat', () => {
    seedOldDoneCard()
    expect(sweepArchivedKanbanCards()).toBe(1)
    expect(getKanbanCard('old-done')!.archived_at).not.toBeNull()
  })

  it('KONTROLL: friss done kartyat NEM archival (nem egyszeruen mindent lesopor)', () => {
    createKanbanCard({ id: 'fresh-done', title: 'Ma zarult', status: 'done' })
    expect(sweepArchivedKanbanCards()).toBe(0)
    expect(getKanbanCard('fresh-done')!.archived_at).toBeNull()
  })

  it('KONTROLL: nem-done regi kartyat NEM archival', () => {
    getDb().prepare(
      `INSERT INTO kanban_cards (id, title, status, priority, created_at, updated_at)
       VALUES ('old-open', 'regi, de nyitott', 'planned', 'normal', ?, ?)`
    ).run(OLD, OLD)
    expect(sweepArchivedKanbanCards()).toBe(0)
    expect(getKanbanCard('old-open')!.archived_at).toBeNull()
  })

  it('masodik futasra mar nincs mit archivalni (idempotens)', () => {
    seedOldDoneCard()
    expect(sweepArchivedKanbanCards()).toBe(1)
    expect(sweepArchivedKanbanCards()).toBe(0)
  })
})

describe('a sopres BE VAN KOTVE egy futo helyre -- a nema no-op elleni vedelem', () => {
  const webTs = readFileSync(join(__dirname, '..', 'web.ts'), 'utf-8')
  const runnerTs = readFileSync(join(__dirname, '..', 'web', 'kanban-archive-runner.ts'), 'utf-8')

  it('a runner tenylegesen hivja a sopres-fuggvenyt', () => {
    expect(runnerTs).toContain('sweepArchivedKanbanCards')
    expect(runnerTs).toMatch(/setInterval\(sweep/)
  })

  it('a web.ts IMPORTALJA es EL IS INDITJA a runnert', () => {
    // Ez az az allitas, ami nelkul a javitas csendben kikapcsolna az archivalast:
    // az import onmagaban semmit nem indit el.
    expect(webTs).toContain("from './web/kanban-archive-runner.js'")
    expect(webTs).toMatch(/startKanbanArchiveRunner\(\)/)
  })

  it('a leallitas el is takaritja az intervallumot, mint a tobbi runnernel', () => {
    expect(webTs).toMatch(/clearInterval\(kanbanArchiveInterval\)/)
  })

  it('KONTROLL: a kereso tenyleg talal, ha van mit -- a szomszed runner ugyanigy latszik', () => {
    // Kulonben a fenti harom allitas akkor is atmenne, ha a fajl ures lenne.
    expect(webTs).toMatch(/startModelFallbackRunner\(\)/)
    expect(webTs).toMatch(/clearInterval\(modelFallbackInterval\)/)
  })
})
