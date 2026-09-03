import { describe, it, expect } from 'vitest'
import { maskKeysPreview } from '../web/routes/agent-terminal.js'

/**
 * Kanban: dashboard-key-logging. A tét nem a formázás, hanem hogy a beírt szöveg SOHA ne
 * kerüljön az audit-naplóba. A tesztek ezért a TARTALOM HIÁNYÁT állítják, nem a kimenet alakját
 * -- egy formázás-átírás nem viheti pirosra, egy visszaszivárgó payload viszont igen.
 */
describe('maskKeysPreview', () => {
  it('a titok EGYETLEN darabja sem jelenik meg a naplo-sorban', () => {
    const secret = 'sk-ant-super-titkos-ertek-amit-soha-nem-naplozunk'
    const out = maskKeysPreview(secret)
    expect(out).not.toContain(secret)
    // a farka a lenyeg: a fej 4 karaktere szandekosan bent van, a TOBBI nem
    expect(out).not.toContain(secret.slice(4))
    expect(out).not.toContain('titkos')
  })

  it('a hosszt es a fej 4 karakteret KOZLI -- enelkul egy hamisitott prompt nem kereshetp vissza', () => {
    const out = maskKeysPreview('/login abcdef')
    expect(out).toContain('len=13')
    expect(out).toContain('"/log"')
    expect(out).toContain('maszkolva')
  })

  it('rovid bemenetnel nincs "maszkolva" jeloles, mert nincs mit elrejteni', () => {
    expect(maskKeysPreview('ab')).toBe('keys:len=2 head="ab"')
    expect(maskKeysPreview('')).toBe('keys:len=0 head=""')
  })

  it('a fejben levo ujsor/tab nem tori szet a naplo-sort', () => {
    const out = maskKeysPreview('a\nb\tc-tovabbi-titok')
    expect(out).not.toContain('\n')
    expect(out).not.toContain('\t')
    expect(out).not.toContain('tovabbi-titok')
  })

  it('EGY 92 KARAKTERES VAULT-TOKEN ALAK sem szivarog at (ez volt az eles eset)', () => {
    // A naploban talalt alak: 48 karakter + '#' + 43 karakter.
    const token = 'A'.repeat(48) + '#' + 'B'.repeat(43)
    const out = maskKeysPreview(token)
    expect(out).toContain('len=92')
    expect(out).not.toContain('#')
    expect(out).not.toContain('B')
  })
})
