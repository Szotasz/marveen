import { describe, it, expect, vi, beforeEach } from 'vitest'
import { parseDateExpression } from '../web/routes/recall.js'

// Pin "today" to 2026-05-19 (Tuesday) Europe/Budapest for deterministic tests
const FAKE_TODAY = '2026-05-19'

vi.mock('../web/routes/recall.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../web/routes/recall.js')>()
  return mod
})

// We can't easily mock todayBudapest inside the module, so we test the parser
// with inputs that are absolute or relative. For relative tests we accept that
// results shift with the real date and verify structural correctness instead.

describe('parseDateExpression', () => {
  describe('ISO dates', () => {
    it('parses single ISO date', () => {
      expect(parseDateExpression('2026-05-19')).toEqual({ from: '2026-05-19', to: '2026-05-19' })
    })

    it('parses ISO date range with dash', () => {
      expect(parseDateExpression('2026-05-10-2026-05-15')).toEqual({ from: '2026-05-10', to: '2026-05-15' })
    })

    it('parses ISO date range with en-dash', () => {
      const r = parseDateExpression('2026-05-01–2026-05-07')
      expect(r).toEqual({ from: '2026-05-01', to: '2026-05-07' })
    })
  })

  describe('relative keywords', () => {
    it('parses "ma"', () => {
      const r = parseDateExpression('ma')
      expect(r).not.toBeNull()
      expect(r!.from).toBe(r!.to)
      expect(r!.from).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    })

    it('parses "tegnap"', () => {
      const r = parseDateExpression('tegnap')
      expect(r).not.toBeNull()
      expect(r!.from).toBe(r!.to)
    })

    it('parses "tegnapelőtt"', () => {
      const r = parseDateExpression('tegnapelőtt')
      expect(r).not.toBeNull()
      expect(r!.from).toBe(r!.to)
    })

    it('parses "yesterday"', () => {
      const r = parseDateExpression('yesterday')
      expect(r).not.toBeNull()
    })
  })

  describe('N days/weeks ago', () => {
    it('parses "3 napja"', () => {
      const r = parseDateExpression('3 napja')
      expect(r).not.toBeNull()
      expect(r!.from).toBe(r!.to)
    })

    it('parses "5 nappal ezelőtt"', () => {
      const r = parseDateExpression('5 nappal ezelőtt')
      expect(r).not.toBeNull()
    })

    it('parses "2 hete"', () => {
      const r = parseDateExpression('2 hete')
      expect(r).not.toBeNull()
      expect(r!.from).not.toBe(r!.to)
    })

    it('parses "1 héttel ezelőtt"', () => {
      const r = parseDateExpression('1 héttel ezelőtt')
      expect(r).not.toBeNull()
    })
  })

  describe('week references', () => {
    it('parses "múlt héten"', () => {
      const r = parseDateExpression('múlt héten')
      expect(r).not.toBeNull()
      expect(r!.from < r!.to).toBe(true)
    })

    it('parses "ezen a héten"', () => {
      const r = parseDateExpression('ezen a héten')
      expect(r).not.toBeNull()
    })

    it('parses "ez a hét"', () => {
      const r = parseDateExpression('ez a hét')
      expect(r).not.toBeNull()
    })
  })

  describe('month references', () => {
    it('parses "ebben a hónapban"', () => {
      const r = parseDateExpression('ebben a hónapban')
      expect(r).not.toBeNull()
      expect(r!.from.endsWith('-01')).toBe(true)
    })

    it('parses "múlt hónapban"', () => {
      const r = parseDateExpression('múlt hónapban')
      expect(r).not.toBeNull()
    })

    it('parses "elmúlt 7 nap"', () => {
      const r = parseDateExpression('elmúlt 7 nap')
      expect(r).not.toBeNull()
    })

    it('parses "utolsó 30 nap"', () => {
      const r = parseDateExpression('utolsó 30 nap')
      expect(r).not.toBeNull()
    })
  })

  describe('Hungarian month names', () => {
    it('parses "május első hete"', () => {
      const r = parseDateExpression('május első hete')
      expect(r).not.toBeNull()
      expect(r!.from.includes('-05-')).toBe(true)
      // First week must start ON or AFTER May 1
      expect(r!.from >= `${r!.from.slice(0, 4)}-05-01`).toBe(true)
    })

    it('parses "január első hete" (start-of-month edge)', () => {
      const r = parseDateExpression('január első hete')
      expect(r).not.toBeNull()
      expect(r!.from >= `${r!.from.slice(0, 4)}-01-01`).toBe(true)
    })

    it('parses "március második hete"', () => {
      const r = parseDateExpression('március második hete')
      expect(r).not.toBeNull()
      expect(r!.from.includes('-03-')).toBe(true)
    })

    it('parses "december utolsó hete"', () => {
      const r = parseDateExpression('december utolsó hete')
      expect(r).not.toBeNull()
      expect(r!.to.includes('-12-3')).toBe(true)
    })

    it('parses "május 10"', () => {
      const r = parseDateExpression('május 10')
      expect(r).not.toBeNull()
      expect(r!.from.endsWith('-05-10')).toBe(true)
      expect(r!.from).toBe(r!.to)
    })

    it('parses "januárban"', () => {
      const r = parseDateExpression('januárban')
      expect(r).not.toBeNull()
      expect(r!.from.endsWith('-01-01')).toBe(true)
      expect(r!.to.endsWith('-01-31')).toBe(true)
    })

    it('parses abbreviated "szept"', () => {
      const r = parseDateExpression('szept')
      expect(r).not.toBeNull()
      expect(r!.from.includes('-09-')).toBe(true)
    })
  })

  describe('Hungarian day names', () => {
    it('parses "hétfő"', () => {
      const r = parseDateExpression('hétfő')
      expect(r).not.toBeNull()
      expect(r!.from).toBe(r!.to)
    })

    it('parses "csütörtök"', () => {
      const r = parseDateExpression('csütörtök')
      expect(r).not.toBeNull()
      expect(r!.from).toBe(r!.to)
    })

    it('parses "múlt péntek"', () => {
      const r = parseDateExpression('múlt péntek')
      expect(r).not.toBeNull()
    })

    it('parses "vasárnap"', () => {
      const r = parseDateExpression('vasárnap')
      expect(r).not.toBeNull()
    })

    it('parses "szerda"', () => {
      const r = parseDateExpression('szerda')
      expect(r).not.toBeNull()
    })
  })

  describe('invalid input', () => {
    it('returns null for empty string', () => {
      expect(parseDateExpression('')).toBeNull()
    })

    it('returns null for gibberish', () => {
      expect(parseDateExpression('xyzzy')).toBeNull()
    })

    it('returns null for partial date', () => {
      expect(parseDateExpression('2026-05')).toBeNull()
    })
  })
})
