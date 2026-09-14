// Kartya a98d02c3. A `/api/kanban` es a `/api/messages/backlog` az `agent=` parametert NEMAN
// eldobta: a valasz a TELJES tablat adta vissza, es a hivonak semmi jele nem volt rola.
//
// ⛔ A MERT ESET, ami miatt ez tobb egy kenyelmi szuronel: egy agens 139 idegen lapot latott
// "sajatjakent" 0 helyett, es egy ELO tulajdonosi SOS-rol kezdett kerdezni. A hiba iranya a
// rosszabbik: nem kevesebbet adott, hanem TOBBET -- es a tobblet johiszemuen feldolgozva mas
// agensek munkajat teszi a sajatunkka.
//
// ⛔ ES AMIERT A HANGOS 400 IS IDE TARTOZIK: a nema elfogadas TANITJA a talalgatast. Merve az
// agens-atiratokban: hat agens HAROM kulonbozo neven probalta ugyanazt (includeArchived 16x,
// archived 6x, include_archived 6x), plusz ?id= 4x. Egyik sem kapott visszajelzest arrol, hogy
// eltalalta-e a nevet -- ezert probaltak tovabb. Egy 400 a tamogatott nevekkel ezt megszunteti.

import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, createKanbanCard, listKanbanCards } from '../db.js'

beforeEach(() => {
  initDatabase(':memory:')
})

function seedHaromAgensnek(): void {
  createKanbanCard({ id: 'a-1', title: 'A elso lapja', assignee: 'agens-a' })
  createKanbanCard({ id: 'a-2', title: 'A masodik lapja', assignee: 'agens-a' })
  createKanbanCard({ id: 'b-1', title: 'B lapja', assignee: 'agens-b' })
  createKanbanCard({ id: 'x-1', title: 'Gazdatlan lap' })
}

describe('listKanbanCards: az agent-szuro SZERVER-oldalon', () => {
  it('⛔ KONTROLL: szuro nelkul MINDEN lap jon (enelkul a tobbi allitas uresen igaz lehetne)', () => {
    seedHaromAgensnek()
    expect(listKanbanCards().length).toBe(4)
  })

  it('agent=agens-a -> CSAK az o ket lapja', () => {
    seedHaromAgensnek()
    expect(listKanbanCards({ agent: 'agens-a' }).map(c => c.id).sort()).toEqual(['a-1', 'a-2'])
  })

  it('⛔ A LAP ELFOGADASI SORA: nem letezo agens -> URES tomb, nem a teljes tabla', () => {
    seedHaromAgensnek()
    expect(listKanbanCards({ agent: 'nincs-ilyen-agens-xyz' })).toEqual([])
  })

  it('a szuro NEM reszszora illeszkedik (az "agens-a" nem hozza az "agens-a-b"-t)', () => {
    createKanbanCard({ id: 'a-1', title: 'A', assignee: 'agens-a' })
    createKanbanCard({ id: 'ab-1', title: 'AB', assignee: 'agens-a-b' })
    expect(listKanbanCards({ agent: 'agens-a' }).map(c => c.id)).toEqual(['a-1'])
  })

  it('az agent-szuro ES az includeArchived EGYUTT is ertelmes (a ketto fuggetlen)', () => {
    createKanbanCard({ id: 'a-1', title: 'A elo', assignee: 'agens-a' })
    createKanbanCard({ id: 'b-1', title: 'B elo', assignee: 'agens-b' })
    const csakA = listKanbanCards({ agent: 'agens-a', includeArchived: true })
    expect(csakA.map(c => c.id)).toEqual(['a-1'])
  })

  it('ures/hianyzo agent ugyanazt adja, mint a szuretlen hivas (a meglevo hivok nem valtoznak)', () => {
    seedHaromAgensnek()
    expect(listKanbanCards({ agent: '' }).length).toBe(4)
    expect(listKanbanCards({ agent: undefined }).length).toBe(4)
  })
})
