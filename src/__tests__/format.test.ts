import { describe, it, expect } from 'vitest'
import { formatForTelegram, splitMessage } from '../format.js'
import { formatForSlackMrkdwn } from '../channel-provider.js'

describe('formatForTelegram', () => {
  it('felcimeket vastagit', () => {
    expect(formatForTelegram('# Cim')).toBe('<b>Cim</b>')
  })

  it('vastagitast konvertal', () => {
    expect(formatForTelegram('ez **vastag** szoveg')).toBe('ez <b>vastag</b> szoveg')
  })

  it('doltbetut konvertal', () => {
    expect(formatForTelegram('ez *dolt* szoveg')).toBe('ez <i>dolt</i> szoveg')
  })

  it('inline kodot konvertal', () => {
    expect(formatForTelegram('hasznald a `parancs` kodot')).toBe(
      'hasznald a <code>parancs</code> kodot'
    )
  })

  it('kodblokkot konvertal', () => {
    const input = '```js\nconsole.log("hello")\n```'
    const result = formatForTelegram(input)
    expect(result).toContain('<pre>')
    expect(result).toContain('console.log')
  })

  it('athuzast konvertal', () => {
    expect(formatForTelegram('ez ~~torolt~~ szoveg')).toBe('ez <s>torolt</s> szoveg')
  })

  it('linkeket konvertal', () => {
    expect(formatForTelegram('[szoveg](https://pelda.hu)')).toBe(
      '<a href="https://pelda.hu">szoveg</a>'
    )
  })

  it('HTML karaktereket escape-el', () => {
    expect(formatForTelegram('a < b & c > d')).toBe('a &lt; b &amp; c &gt; d')
  })

  it('jelolonegyzeteket konvertal', () => {
    expect(formatForTelegram('- [ ] teendo')).toContain('☐')
    expect(formatForTelegram('- [x] kesz')).toContain('☑')
  })

  it('elvalaszto vonalakat eltavolít', () => {
    expect(formatForTelegram('szoveg\n---\nszoveg')).not.toContain('---')
  })
})

describe('formatForSlackMrkdwn', () => {
  it('converts markdown headers to bold', () => {
    expect(formatForSlackMrkdwn('# Hello')).toBe('*Hello*')
    expect(formatForSlackMrkdwn('## Section')).toBe('*Section*')
    expect(formatForSlackMrkdwn('### Sub')).toBe('*Sub*')
  })

  it('converts **bold** to mrkdwn bold', () => {
    expect(formatForSlackMrkdwn('ez **vastag** szoveg')).toBe('ez *vastag* szoveg')
  })

  it('converts __bold__ to mrkdwn bold', () => {
    expect(formatForSlackMrkdwn('ez __vastag__ szoveg')).toBe('ez *vastag* szoveg')
  })

  it('converts markdown links to Slack format', () => {
    expect(formatForSlackMrkdwn('[text](https://example.com)')).toBe('<https://example.com|text>')
  })

  it('converts strikethrough to single tilde', () => {
    expect(formatForSlackMrkdwn('~~torolt~~')).toBe('~torolt~')
  })

  it('converts checkboxes to Slack emojis', () => {
    expect(formatForSlackMrkdwn('- [ ] teendo')).toContain(':white_square:')
    expect(formatForSlackMrkdwn('- [x] kesz')).toContain(':white_check_mark:')
  })

  it('removes horizontal rules', () => {
    expect(formatForSlackMrkdwn('above\n---\nbelow')).not.toContain('---')
    expect(formatForSlackMrkdwn('above\n***\nbelow')).not.toContain('***')
  })

  it('preserves inline code', () => {
    expect(formatForSlackMrkdwn('use `cmd` here')).toBe('use `cmd` here')
  })

  it('preserves code blocks', () => {
    const input = '```js\nconsole.log("hi")\n```'
    expect(formatForSlackMrkdwn(input)).toContain('```')
  })

  it('trims whitespace from output', () => {
    expect(formatForSlackMrkdwn('  hello  ')).toBe('hello')
  })
})

describe('splitMessage', () => {
  it('rovid uzeneteket nem bontja', () => {
    expect(splitMessage('hello')).toEqual(['hello'])
  })

  it('hosszu uzeneteket sortoresnel bontja', () => {
    const long = 'A '.repeat(2500) // >4096 karakter
    const chunks = splitMessage(long)
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(4096)
    }
  })

  it('egyeni limitet hasznalhat', () => {
    const text = 'abc\ndef\nghi\njkl'
    const chunks = splitMessage(text, 8)
    expect(chunks.length).toBeGreaterThan(1)
  })
})
