import { describe, it, expect } from 'vitest'
import { extractKeywords } from '../web/import-crawler.js'

// Regression: the auto-keyword extractor used an ASCII-only \w class, which
// treated every accented character as a word break and shattered Hungarian
// words into 1-2 letter shards (the "sok egybetűs címke" symptom). The fix is
// a Unicode-aware split plus a <2-char token filter.
describe('extractKeywords', () => {
  it('keeps accented Hungarian words intact (no single-letter shards)', () => {
    const kw = extractKeywords('A fejlesztői környezet működése kiváló.', 'notes.md')
    const tokens = kw.split(', ')
    // The accented words survive whole...
    expect(tokens).toContain('fejlesztői')
    expect(tokens).toContain('környezet')
    expect(tokens).toContain('működése')
    // ...and no 1-char shard leaks through.
    expect(tokens.every(t => t.length >= 2)).toBe(true)
  })

  it('drops punctuation and sub-2-char tokens', () => {
    const kw = extractKeywords('Node/Express + MariaDB (RBAC), a b cd.', 'stack.md')
    const tokens = kw.split(', ')
    expect(tokens.every(t => t.length >= 2)).toBe(true)
    expect(tokens).not.toContain('a')
    expect(tokens).not.toContain('b')
    expect(tokens).toContain('cd')
  })

  it('prefers YAML front-matter tags when present', () => {
    const md = '---\ntitle: X\ntags: [alpha, béta, gamma]\n---\nbody text here'
    expect(extractKeywords(md, 'doc.md')).toBe('alpha, béta, gamma')
  })

  it('prepends the filename stem', () => {
    const kw = extractKeywords('some content words', 'architecture.md')
    expect(kw.split(', ')[0]).toBe('architecture')
  })
})
