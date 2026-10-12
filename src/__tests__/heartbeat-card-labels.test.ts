// HBNAME1 -- the heartbeat misnamed urgent cards and invented explanations.
// Root cause: the prompt carried bare card TITLES, our titles routinely
// reference OTHER cards by name, and the summarizing model picked an
// id-looking token out of the wrong title, then explained a disappeared item
// with a reason the data never contained ("completed or deprioritized").
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { formatHeartbeatCardLabel } from '../heartbeat.js'

describe('formatHeartbeatCardLabel', () => {
  it('leads with the bracketed id, the one authoritative handle', () => {
    expect(formatHeartbeatCardLabel({ id: '8290FF71', title: 'Installer re-run .env karositas' }))
      .toBe('[8290FF71] Installer re-run .env karositas')
  })

  it('truncates long titles so cross-referenced card names drop out of view', () => {
    const title = 'A'.repeat(70) + ' lasd meg INSTWIZ1 es ONBAUTH1 kartyakat reszletesen'
    const label = formatHeartbeatCardLabel({ id: 'X1', title })
    expect(label.startsWith('[X1] ')).toBe(true)
    expect(label.length).toBe('[X1] '.length + 80 + 3)
    expect(label).not.toContain('ONBAUTH1')
    expect(label.endsWith('...')).toBe(true)
  })

  it('keeps short titles verbatim, no ellipsis', () => {
    expect(formatHeartbeatCardLabel({ id: 'Y2', title: 'rovid cim' })).toBe('[Y2] rovid cim')
  })
})

describe('heartbeat prompt contract (source-pinned)', () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../heartbeat.ts'), 'utf-8')

  it('the kanban section instructs report-only, id-only naming', () => {
    expect(src).toContain('KIZAROLAG a szogletes zarojeles ID-javal nevezz meg')
    expect(src).toContain('eltunt tetelre okot ne kovetkeztess')
  })

  it('the prompt is fed labeled cards, not bare titles', () => {
    expect(src).toContain('urgentLabels.join')
    expect(src).toContain('waitingLabels.join')
    expect(src).toContain('summary.urgent.map(formatHeartbeatCardLabel)')
  })
})
