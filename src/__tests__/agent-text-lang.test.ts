// PERSONAESC1107: the TypeScript reader of the once-decided AGENT_TEXT_LANG (src/web/agent-text-lang.ts). It reads,
// never decides; an install without the key is Hungarian, and only the exact values count.
import { describe, it, expect } from 'vitest'
import { agentTextLang, agentTextLangSetting } from '../web/agent-text-lang.js'

const env = (v?: string) => (): Record<string, string> => (v === undefined ? {} : { AGENT_TEXT_LANG: v })

describe('agentTextLang', () => {
  it('en and hu as set; Hungarian without the key', () => {
    expect(agentTextLang(env('en'))).toBe('en')
    expect(agentTextLang(env('hu'))).toBe('hu')
    expect(agentTextLang(env())).toBe('hu')
  })

  it('only the exact values: anything else is Hungarian, and the setting reads as not set', () => {
    for (const v of ['EN', 'en ', 'english', '', 'de']) {
      expect(agentTextLang(env(v)), JSON.stringify(v)).toBe('hu')
      expect(agentTextLangSetting(env(v)), JSON.stringify(v)).toBeNull()
    }
  })

  it('agentTextLangSetting tells unset from hu (federation falls back to DASHBOARD_LANG only on unset)', () => {
    expect(agentTextLangSetting(env())).toBeNull()
    expect(agentTextLangSetting(env('hu'))).toBe('hu')
    expect(agentTextLangSetting(env('en'))).toBe('en')
  })
})
