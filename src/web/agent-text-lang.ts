// PERSONAESC1107 (Samu 72762 (b)): the language of the text the dashboard writes into the agents' CLAUDE.md (the managed
// sections, the new sub-agent's prompt). It is decided ONCE, at the install's first render, and kept in .env as
// AGENT_TEXT_LANG=en|hu (scripts/lib/persona-template.sh agent_text_lang_decide); here it is only read, at call time.
// Without the key (every install from before this): Hungarian, so those files stay byte-for-byte as they are.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { readEnvFile } from '../env.js'
import { PROJECT_ROOT } from '../config.js'

export type AgentTextLang = 'hu' | 'en'

/** The key as set, or null when it is not set (or not exactly en/hu). Federation falls back to DASHBOARD_LANG on null. */
export function agentTextLangSetting(read: (keys: string[]) => Record<string, string> = readEnvFile): AgentTextLang | null {
  const v = read(['AGENT_TEXT_LANG']).AGENT_TEXT_LANG
  return v === 'en' || v === 'hu' ? v : null
}

/**
 * An install rendered English BEFORE the key existed (from develop, after #2596): its main CLAUDE.md carries the English
 * template's heading (Samu 72862). The same rule as scripts/lib/persona-template.sh _atl_rendered_en, so the persona and
 * the managed sections agree on such an install too. A Hungarian file, or one without the heading, is not English.
 */
export function renderedEnglish(root: string = PROJECT_ROOT): boolean {
  try {
    if (!existsSync(join(root, 'templates', 'en', 'CLAUDE.md.template'))) return false
    return readFileSync(join(root, 'CLAUDE.md'), 'utf-8').split('\n').some((l) => l.replace(/\r$/, '') === '## Inter-agent communication')
  } catch {
    return false
  }
}

/** The language the agents' text is written in: the key; without it, English only for an install rendered English. */
export function agentTextLang(
  read: (keys: string[]) => Record<string, string> = readEnvFile,
  rendered: () => boolean = () => renderedEnglish(),
): AgentTextLang {
  return agentTextLangSetting(read) ?? (rendered() ? 'en' : 'hu')
}

/**
 * The language of the agent-facing text that followed DASHBOARD_LANG before this key existed (the federation
 * onboarding block and capability summary, the inbox nudge): AGENT_TEXT_LANG when it is set, else DASHBOARD_LANG as
 * before, else Hungarian. One place for the four copies that each had their own resolveLang.
 */
export function agentFacingLang(dashboardLang: () => unknown, read: (keys: string[]) => Record<string, string> = readEnvFile): AgentTextLang {
  const set = agentTextLangSetting(read)
  if (set) return set
  try {
    return dashboardLang() === 'en' ? 'en' : 'hu'
  } catch {
    return 'hu'
  }
}
