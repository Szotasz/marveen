// Card 98678bfc. `/api/kanban` returned 48 cards while the DB held 49 -- one archived --
// and `?includeArchived=1` changed nothing. It did not fail, it did not warn: it answered
// a narrower question than the one asked, and the caller had no way to tell.
//
// That is the worst shape for an auditing surface. The 4-hourly kanban audit and every
// API-driven check read this endpoint; a missing row there reads as "no such card", and
// closed cards -- exactly what an audit looks back at -- are the ones that get archived.
//
// Two halves are tested, because the defect had two halves:
//   the DATA layer hard-coded the filter with no parameter (listKanbanCards had no args)
//   the ROUTE dropped an unrecognised parameter instead of honouring or refusing it
//
// Note the auto-archive sweep inside listKanbanCards(): reading the list is what archives
// stale done cards. Both tests below therefore archive explicitly rather than relying on
// the sweep, so they measure the FILTER and not the clock.

import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, createKanbanCard, archiveKanbanCard, listKanbanCards } from '../db.js'
import { parseIncludeArchived } from '../web/routes/kanban.js'

beforeEach(() => {
  initDatabase(':memory:')
})

function seedOneArchivedOneLive(): void {
  createKanbanCard({ id: 'live-1', title: 'Aktiv kartya' })
  createKanbanCard({ id: 'arch-1', title: 'Archivalt kartya' })
  expect(archiveKanbanCard('arch-1')).toBe(true)
}

describe('listKanbanCards: az archivalt sorok elerhetoek, ha a hivo KERI', () => {
  it('alapertelmezesben az archivalt kartya NINCS benne (a tabla viselkedese nem valtozik)', () => {
    seedOneArchivedOneLive()
    expect(listKanbanCards().map(c => c.id)).toEqual(['live-1'])
  })

  it('includeArchived: true eseten BENNE VAN -- ez a regresszios allitas', () => {
    seedOneArchivedOneLive()
    expect(listKanbanCards({ includeArchived: true }).map(c => c.id).sort()).toEqual(['arch-1', 'live-1'])
  })

  it('KONTROLL: az ures opcio-objektum ugyanaz, mint az argumentum nelkuli hivas', () => {
    // Kulonben a fenti ket allitas ugy is atmenne, ha a default csendben megfordulna.
    seedOneArchivedOneLive()
    expect(listKanbanCards({}).map(c => c.id)).toEqual(listKanbanCards().map(c => c.id))
  })

  it('KONTROLL: archivalt sor nelkul a ket hivas ugyanazt adja', () => {
    // Ez zarja ki, hogy az includeArchived-ag veletlenul MINDIG tobbet adjon vissza.
    createKanbanCard({ id: 'live-1', title: 'Aktiv kartya' })
    expect(listKanbanCards({ includeArchived: true }).map(c => c.id)).toEqual(['live-1'])
  })
})

describe('parseIncludeArchived: harom ertek, mert a NEM-ERTELMEZHETO nem azonos a HAMISSAL', () => {
  it('hianyzo parameter -> false (a mai, valtozatlan alapeset)', () => {
    expect(parseIncludeArchived(null)).toBe(false)
  })

  it('igaz-alakok', () => {
    for (const v of ['1', 'true', 'yes', 'on', 'TRUE', ' On ']) {
      expect(parseIncludeArchived(v)).toBe(true)
    }
  })

  it('puszta jelenlet (?includeArchived vagy =) IGAZ -- a tobb sor fele teved, nem a kevesebb fele', () => {
    expect(parseIncludeArchived('')).toBe(true)
  })

  it('hamis-alakok', () => {
    for (const v of ['0', 'false', 'no', 'off', 'FALSE']) {
      expect(parseIncludeArchived(v)).toBe(false)
    }
  })

  it('ERTELMEZHETETLEN ertek -> null, azaz ELUTASITAS. Ez a lelet lenyege', () => {
    // A regi kod minden fel nem ismert bemenetet "false"-ra ejtett. Az `includeArchived=1`
    // ezert jott vissza archivalt sorok nelkul, panasz nelkul.
    for (const v of ['igen', 'maybe', '2', 'archived', 'true;drop']) {
      expect(parseIncludeArchived(v)).toBeNull()
    }
  })
})
