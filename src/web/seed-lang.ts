// PERSONAESC1107 seed A (Samu 72845, 73243): the dashboard's side of scripts/lib/seed-lang.sh. A seeded Markdown file
// `<rel>` (repo-relative) may have an English version at i18n/en/<rel>; on an English install (agentTextLang(), read only)
// its bytes are written to the target path of `<rel>`. Only .md files have English versions.
import { lstatSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentTextLang } from './agent-text-lang.js'

/** The English version's repo-relative path for `rel`, or null for a file that has none by rule (not .md). */
export function seedEnRel(rel: string): string | null {
  return rel.endsWith('.md') ? join('i18n', 'en', rel) : null
}

/** A regular file, never a symlink (the same rule as scripts/lib/seed-lang.sh and update.sh seed_en_file; Dani 73301 (1)). */
export function isRegularFile(p: string): boolean {
  try {
    const st = lstatSync(p)
    return st.isFile() && !st.isSymbolicLink()
  } catch {
    return false
  }
}

/** The absolute file to read for `rel` under `root`: the English version on en when it is a regular file, else `rel`. */
export function seedSourceFor(root: string, rel: string, lang: AgentTextLang, exists: (p: string) => boolean = isRegularFile): string {
  if (lang === 'en') {
    const en = seedEnRel(rel)
    if (en && exists(join(root, en))) return join(root, en)
  }
  return join(root, rel)
}
