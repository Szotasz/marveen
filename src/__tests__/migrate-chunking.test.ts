import { describe, it, expect } from 'vitest'
import { chunkText } from '../web/routes/migrate.js'

// The contract the importer depends on: chunking is lossless. GH #1024 measured
// 30.4% of the source text disappearing on a 20 file run because each section
// was cut at 2000 characters instead of being split.
const nonSpace = (s: string) => s.replace(/\s+/g, '')

describe('chunkText', () => {
  it('returns a short text unchanged, as a single chunk', () => {
    expect(chunkText('  rövid szöveg  ', 2000)).toEqual(['rövid szöveg'])
  })

  it('drops nothing: the chunks hold every non-whitespace character', () => {
    const paragraph = 'A kockázatfelmérés során az alkusz feltérképezi a jármű jellemzőit. '
    const source = paragraph.repeat(200) // ~13k characters
    const chunks = chunkText(source, 2000)

    expect(chunks.length).toBeGreaterThan(5)
    expect(nonSpace(chunks.join(''))).toBe(nonSpace(source))
  })

  it('keeps every chunk within the limit, apart from a merged short tail', () => {
    const source = 'mondat vége. '.repeat(500)
    for (const chunk of chunkText(source, 2000)) {
      expect(chunk.length).toBeLessThanOrEqual(2000 + 20)
    }
  })

  it('prefers a paragraph break over a mid-sentence cut', () => {
    const first = 'a'.repeat(1500)
    const second = 'b'.repeat(1500)
    const [head] = chunkText(`${first}\n\n${second}`, 2000)
    expect(head).toBe(first)
  })

  it('falls back to a sentence end when there is no paragraph break', () => {
    const source = `${'sok szó '.repeat(200)}. ${'még több szó '.repeat(200)}`
    const [head] = chunkText(source, 2000)
    expect(head.endsWith('.')).toBe(true)
  })

  it('hard cuts only when the window holds no boundary at all', () => {
    const oneLongWord = 'x'.repeat(5000)
    const chunks = chunkText(oneLongWord, 2000)
    expect(chunks).toHaveLength(3)
    expect(chunks[0]).toHaveLength(2000)
    expect(chunks.join('')).toBe(oneLongWord)
  })

  it('merges a very short tail into the previous chunk instead of emitting a fragment row', () => {
    const source = `${'y'.repeat(2000)} vég`
    const chunks = chunkText(source, 2000)
    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toContain('vég')
  })

  it('returns nothing for empty or whitespace-only input', () => {
    expect(chunkText('', 2000)).toEqual([])
    expect(chunkText('   \n\n  ', 2000)).toEqual([])
  })

  it('reproduces the issue scenario: a 6000 character heading-free section survives whole', () => {
    // The install measured in GH #1024 had 217 of 360 files over 2000 characters
    // and only 40 with any `##` heading, so most files became one section.
    const section = 'Ez egy hosszú, tagolatlan memóriafájl tartalma. '.repeat(130)
    const chunks = chunkText(section, 2000)
    expect(nonSpace(chunks.join(''))).toBe(nonSpace(section))
    expect(chunks.length).toBeGreaterThan(2)
  })
})
