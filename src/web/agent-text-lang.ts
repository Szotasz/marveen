// PERSONAESC1107 (Samu 72762 (b)): the language of the text the dashboard writes into the agents' CLAUDE.md (the managed
// sections, the new sub-agent's prompt). It is decided ONCE, at the install's first render, and kept in .env as
// AGENT_TEXT_LANG=en|hu (scripts/lib/persona-template.sh agent_text_lang_decide); here it is only read, at call time.
// Without the key (every install from before this): Hungarian, so those files stay byte-for-byte as they are.
import { readEnvFile } from '../env.js'

export type AgentTextLang = 'hu' | 'en'

/** The key as set, or null when it is not set (or not exactly en/hu). Federation falls back to DASHBOARD_LANG on null. */
export function agentTextLangSetting(read: (keys: string[]) => Record<string, string> = readEnvFile): AgentTextLang | null {
  const v = read(['AGENT_TEXT_LANG']).AGENT_TEXT_LANG
  return v === 'en' || v === 'hu' ? v : null
}

/** The language the agents' text is written in: the key, Hungarian without it. */
export function agentTextLang(read: (keys: string[]) => Record<string, string> = readEnvFile): AgentTextLang {
  return agentTextLangSetting(read) ?? 'hu'
}
