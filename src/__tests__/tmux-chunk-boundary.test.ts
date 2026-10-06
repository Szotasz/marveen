import { describe, it, expect } from 'vitest'
import { computeTmuxChunk, TMUX_CHUNK_MAX_SLIDE } from '../web/agent-process.js'

// BORITEKVESZ927: measured 2026-09-27 on the kanban-audit and nap-zaro
// scheduled tasks -- every "spliced" delivery lost exactly the one chunk
// whose 80-char `send-keys -l` boundary landed on a trailing ';'. tmux's own
// command-line parser treats an unescaped ';' as the end of the current
// command when it is the last character of the final argv element, even
// though execFileSync passes it as one literal argv token (no shell
// involved) and even under -l literal-key mode. Reconstructed from the
// actual incident: position 42643 of a 45958-char prompt, chunk 533 of 575
// (indices 42560..42640), ends exactly on ';' and that ';' is dropped.
function reassemble(text: string, chunkSize: number, maxSlide = TMUX_CHUNK_MAX_SLIDE): string {
  let out = ''
  let i = 0
  while (i < text.length) {
    const { chunk, end } = computeTmuxChunk(text, i, chunkSize, maxSlide)
    out += chunk
    i = end
  }
  return out
}

describe('computeTmuxChunk', () => {
  it('never returns a chunk whose last character is a bare ;', () => {
    const text = 'a'.repeat(78) + ';' + 'b'.repeat(200)
    let i = 0
    while (i < text.length) {
      const { chunk, end } = computeTmuxChunk(text, i, 80)
      expect(chunk.endsWith(';')).toBe(false)
      i = end
    }
  })

  it('folds the boundary forward when the chunk would otherwise end on ; (BORITEKVESZ927 reproduction)', () => {
    // 79 filler chars + ';' as chars 79 puts the ';' exactly at index 79,
    // i.e. the last character of an 80-char chunk starting at 0.
    const text = 'x'.repeat(79) + ';' + 'REST-OF-MESSAGE'
    const { chunk, end } = computeTmuxChunk(text, 0, 80)
    expect(chunk.endsWith(';')).toBe(false)
    expect(chunk).toBe(text.slice(0, end))
    expect(end).toBeGreaterThan(80)
  })

  it('appends a trailing space instead of dropping a ; that is the very last character of the whole prompt', () => {
    const text = 'y'.repeat(79) + ';'
    const { chunk, end } = computeTmuxChunk(text, 0, 80)
    expect(end).toBe(text.length)
    expect(chunk).toBe(text.slice(0, end) + ' ')
  })

  it('leaves an internal ; (not at a chunk boundary) completely untouched', () => {
    const text = 'a'.repeat(40) + ';' + 'b'.repeat(40)
    const { chunk, end } = computeTmuxChunk(text, 0, 80)
    expect(chunk).toBe(text.slice(0, end))
    expect(chunk).toContain(';')
  })

  it('round-trips arbitrary text containing many chunk-boundary semicolons without losing any', () => {
    const segment = 'x'.repeat(79) + ';'
    const text = segment.repeat(50) + 'tail-without-semicolon'
    const result = reassemble(text, 80)
    // Every semicolon present in the source must survive somewhere in the
    // reassembled stream (this is the exact defect: BEFORE the fix, one
    // vanished per chunk-aligned semicolon).
    const sourceSemicolons = (text.match(/;/g) || []).length
    const resultSemicolons = (result.match(/;/g) || []).length
    expect(resultSemicolons).toBe(sourceSemicolons)
  })

  it('still applies the leading-dash guard (existing behaviour unaffected)', () => {
    const text = 'a'.repeat(80) + '-szal folytatva'
    const { chunk, end } = computeTmuxChunk(text, 0, 80)
    expect(chunk.startsWith('-')).toBe(false)
    expect(end).toBeGreaterThan(80)
  })

  it("';x-' at the boundary: folding past the ';' must not leave the next chunk starting with '-' (no space typed into the text)", () => {
    // Two sequential dodge loops slid past the ';' and stopped right before
    // the '-', so the NEXT chunk started with '-' and got a ' ' prepended.
    const text = 'a'.repeat(79) + ';x-szal folytatva'
    const out = reassemble(text, 80)
    expect(out).toBe(text)
    let i = 0
    while (i < text.length) {
      const { chunk, end } = computeTmuxChunk(text, i, 80)
      expect(chunk.startsWith('-')).toBe(false)
      expect(chunk.endsWith(';')).toBe(false)
      i = end
    }
  })

  it('handles a chunk that would both start with a slid-past dash and end near a ;', () => {
    const text = 'a'.repeat(80) + '-' + ';'.repeat(3) + 'z'.repeat(40)
    let i = 0
    let sawContent = ''
    while (i < text.length) {
      const { chunk, end } = computeTmuxChunk(text, i, 80)
      expect(chunk.endsWith(';')).toBe(false)
      sawContent += chunk.startsWith(' ') ? chunk.slice(1) : chunk
      i = end
    }
    expect(sawContent.replace(/ /g, '')).toContain('aaa')
  })
})
