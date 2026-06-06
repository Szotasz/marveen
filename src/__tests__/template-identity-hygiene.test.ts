import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveTemplatePlaceholders } from '../web/agent-scaffold.js'

// Repo root = two levels up from src/__tests__/.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

// Template / skill trees that ship in the repo and get copied into a user's
// tree at install or first boot. They must never carry deployment-specific
// identity, because that value is seeded verbatim into every other install:
// an absolute home path breaks (it points at a user that does not exist on
// the target machine), and a personal email leaks one operator's account into
// everyone else's generated files. Identity must instead flow through
// placeholders that the installer and the runtime seed substitute per host.
//
// Only fully-shipped trees are listed. The repo's `skills/` dir is excluded
// on purpose: on a live operator checkout it also accumulates untracked,
// machine-specific skills, so a recursive scan there would fail locally for
// reasons unrelated to what ships. Its one tracked, shipped skill
// (skill-factory) is kept host-agnostic by hand instead.
const TEMPLATE_DIRS = ['scheduled-tasks', 'templates', 'seed-scheduled-tasks', 'seed-skills']

// The identity placeholders the runtime seed (resolveTemplatePlaceholders)
// substitutes, kept in sync with the install scripts' sed substitutions.
const KNOWN_PLACEHOLDERS = ['PROJECT_ROOT', 'INSTALL_DIR', 'MAIN_AGENT_ID', 'BOT_NAME', 'OWNER_NAME']

// An absolute macOS/Linux home path embeds a real username. The trailing
// slash is optional so a bare literal like "/Users/bob" at end of value is
// still caught. A `<...>` segment (e.g. /Users/<user>/marveen) is a doc
// placeholder, not a real path, so it is allowed. URL lines are skipped by the
// caller so a link like https://host/home/x is not mistaken for a home path.
const HOME_PATH_RX = /\/(Users|home)\/(?!<)[A-Za-z0-9._-]+/
// A personal mailbox baked into a shipped file would leak / break on every
// other install. example.com and the noreply providers are not listed.
const PERSONAL_EMAIL_RX = /[A-Za-z0-9._%+-]+@(gmail|outlook|icloud|yahoo|hotmail)\.[A-Za-z]+/i

// The canonical default OWNER_NAME from src/config.ts (`?? 'Szabolcs'`) and its
// common Hungarian nickname (Szabi). It is one specific deployment's operator
// name, so it must never be baked into a shipped template as a bare literal --
// the placeholder {{OWNER_NAME}} carries it per host. Catching the literal
// stops the exact regression where a task addresses the wrong person ("<owner>
// is asleep", "escalate to <owner>") on every other install. No trailing \b:
// the name takes Hungarian suffixes (Szabolcsnak, Szabihoz), and both the
// inflected full name and the nickname were among the leaks fixed here. The
// `(olcs|i)` after the shared `Szab` stem avoids common words like szabaly /
// szabad / szabas.
const FOREIGN_DEFAULT_OWNER_RX = /\bSzab(olcs|i)/i

// A hardcoded numeric chat id (e.g. a Telegram chat id, 5+ digits) is one
// operator's personal channel. Seeded into a task it would make every other
// install post to that one person's chat. Use chat_id: 0 (the bound channel)
// or the {{CHAT_ID}} placeholder instead.
const HARDCODED_CHAT_ID_RX = /chat_id["':\s]+-?\d{5,}/i

function walk(dir: string): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else out.push(p)
  }
  return out
}

function readText(file: string): string | null {
  try {
    return readFileSync(file, 'utf-8')
  } catch {
    return null
  }
}

describe('shipped templates carry no hardcoded identity', () => {
  it('has no absolute home path, personal email, default owner-name literal, or hardcoded chat id in any shipped template file', () => {
    const violations: string[] = []
    for (const dir of TEMPLATE_DIRS) {
      for (const file of walk(join(REPO_ROOT, dir))) {
        const text = readText(file)
        if (text === null) continue
        const rel = file.slice(REPO_ROOT.length + 1)
        text.split('\n').forEach((line, i) => {
          if (!line.includes('://') && HOME_PATH_RX.test(line)) {
            violations.push(`${rel}:${i + 1} absolute home path (use {{INSTALL_DIR}}): ${line.trim().slice(0, 100)}`)
          }
          if (PERSONAL_EMAIL_RX.test(line)) {
            violations.push(`${rel}:${i + 1} personal email: ${line.trim().slice(0, 100)}`)
          }
          if (FOREIGN_DEFAULT_OWNER_RX.test(line)) {
            violations.push(`${rel}:${i + 1} default owner name literal (use {{OWNER_NAME}}): ${line.trim().slice(0, 100)}`)
          }
          if (HARDCODED_CHAT_ID_RX.test(line)) {
            violations.push(`${rel}:${i + 1} hardcoded numeric chat id (use chat_id: 0 or {{CHAT_ID}}): ${line.trim().slice(0, 100)}`)
          }
        })
      }
    }
    expect(violations, `Hardcoded identity found in shipped templates:\n${violations.join('\n')}`).toEqual([])
  })
})

describe('runtime-seeded placeholders are all substituted', () => {
  // ensureDefaultScheduledTasks() copies scheduled-tasks/* into the user's
  // tree, running each file through resolveTemplatePlaceholders. Two ways this
  // could regress, each covered below.

  // 1. The seed stops substituting one of the identity placeholders (e.g. a
  // replaceAll line is deleted). Feeding every known placeholder through the
  // real function and asserting none survive exercises all five every run --
  // including {{OWNER_NAME}}/{{BOT_NAME}}, the highest-risk identity fields --
  // so it can never pass vacuously.
  it('resolveTemplatePlaceholders replaces every known identity placeholder', () => {
    const probe = KNOWN_PLACEHOLDERS.map(p => `{{${p}}}`).join('\n')
    const out = resolveTemplatePlaceholders(probe)
    const survivors = [...out.matchAll(/\{\{[A-Z_]+\}\}/g)].map(m => m[0])
    expect(
      survivors,
      `Known placeholders the seed failed to substitute: ${survivors.join(', ')}`,
    ).toEqual([])
  })

  // 2. A task template starts using a NEW placeholder the seed does not know
  // about, which would land verbatim ({{FOO}}) in the user's task. Assert
  // every placeholder actually used under scheduled-tasks/ is in the known
  // set. (Empty set is fine -- nothing to leak.)
  it('every placeholder used under scheduled-tasks/ is in the known set', () => {
    const used = new Set<string>()
    for (const file of walk(join(REPO_ROOT, 'scheduled-tasks'))) {
      const text = readText(file)
      if (text === null) continue
      for (const m of text.matchAll(/\{\{([A-Z_]+)\}\}/g)) used.add(m[1])
    }
    const unknown = [...used].filter(p => !KNOWN_PLACEHOLDERS.includes(p))
    expect(
      unknown,
      `Placeholders used in scheduled-tasks/ that the seed does not substitute: ${unknown.join(', ')}`,
    ).toEqual([])
  })
})
