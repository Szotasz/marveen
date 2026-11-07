// PERSONAESC1107: the TypeScript reader of the once-decided AGENT_TEXT_LANG (src/web/agent-text-lang.ts). It reads,
// never decides; an install without the key is Hungarian unless its main CLAUDE.md was rendered English (Samu 72862),
// and only the exact values count.
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { agentTextLang, agentTextLangSetting, agentFacingLang, renderedEnglish } from '../web/agent-text-lang.js'
import { parseEnvContent } from '../env-parse.js'

const env = (v?: string) => (): Record<string, string> => (v === undefined ? {} : { AGENT_TEXT_LANG: v })
const notRendered = () => false
const renderedEn = () => true

describe('agentTextLang', () => {
  it('en and hu as set; Hungarian without the key', () => {
    expect(agentTextLang(env('en'), notRendered)).toBe('en')
    expect(agentTextLang(env('hu'), notRendered)).toBe('hu')
    expect(agentTextLang(env(), notRendered)).toBe('hu')
  })

  it('the key wins over the rendered file, either way; without the key an English-rendered install is English', () => {
    expect(agentTextLang(env('hu'), renderedEn)).toBe('hu')
    expect(agentTextLang(env('en'), notRendered)).toBe('en')
    expect(agentTextLang(env(), renderedEn)).toBe('en')
  })

  it('only the exact values: anything else is not set (Hungarian on a not English-rendered install)', () => {
    for (const v of ['EN', 'english', '', 'de']) {
      expect(agentTextLang(env(v), notRendered), JSON.stringify(v)).toBe('hu')
      expect(agentTextLangSetting(env(v)), JSON.stringify(v)).toBeNull()
    }
  })

  it('the real .env parser trims: AGENT_TEXT_LANG=en with trailing spaces is en (the reader never sees the spaces)', () => {
    const read = () => parseEnvContent('AGENT_TEXT_LANG=en   \n', ['AGENT_TEXT_LANG'])
    expect(agentTextLang(read, notRendered)).toBe('en')
  })

  it('agentTextLangSetting tells unset from hu (federation falls back to DASHBOARD_LANG only on unset)', () => {
    expect(agentTextLangSetting(env())).toBeNull()
    expect(agentTextLangSetting(env('hu'))).toBe('hu')
    expect(agentTextLangSetting(env('en'))).toBe('en')
  })
})

describe('renderedEnglish (an install rendered English before the key existed)', () => {
  let dir = ''
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })
  const install = (claudeMd: string | null, enTemplate = true) => {
    dir = mkdtempSync(join(tmpdir(), 'marveen-rendered-en-'))
    if (enTemplate) { mkdirSync(join(dir, 'templates', 'en'), { recursive: true }); writeFileSync(join(dir, 'templates', 'en', 'CLAUDE.md.template'), '# x\n') }
    if (claudeMd !== null) writeFileSync(join(dir, 'CLAUDE.md'), claudeMd)
    return dir
  }
  it('the English heading -> English; CRLF too', () => {
    expect(renderedEnglish(install('# Bot\n\n## Inter-agent communication\n\ntext\n'))).toBe(true)
    expect(renderedEnglish(install('# Bot\r\n## Inter-agent communication\r\n'))).toBe(true)
  })
  it('the Hungarian heading, no heading, no file, or no English template -> not English', () => {
    expect(renderedEnglish(install('# Bot\n\n## Inter-agent kommunikáció\n'))).toBe(false)
    expect(renderedEnglish(install('# Bot\n\nsomething\n'))).toBe(false)
    expect(renderedEnglish(install(null))).toBe(false)
    expect(renderedEnglish(install('## Inter-agent communication\n', false))).toBe(false)
    expect(renderedEnglish(install('see ## Inter-agent communication here\n'))).toBe(false)
  })
})

describe('agentFacingLang (federation and the inbox nudge)', () => {
  it('the key wins when it is set, either way', () => {
    expect(agentFacingLang(() => 'hu', env('en'))).toBe('en')
    expect(agentFacingLang(() => 'en', env('hu'))).toBe('hu')
  })
  it('without the key DASHBOARD_LANG decides, as before; a throwing or other value is Hungarian', () => {
    expect(agentFacingLang(() => 'en', env())).toBe('en')
    expect(agentFacingLang(() => 'hu', env())).toBe('hu')
    expect(agentFacingLang(() => undefined, env())).toBe('hu')
    expect(agentFacingLang(() => { throw new Error('settings unreadable') }, env())).toBe('hu')
  })
})
