import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveTemplatePlaceholders, substituteTemplatePlaceholders } from '../web/agent-scaffold.js'

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
const KNOWN_PLACEHOLDERS = ['PROJECT_ROOT', 'INSTALL_DIR', 'MAIN_AGENT_ID', 'BOT_NAME', 'OWNER_NAME', 'WEB_PORT']

// An absolute macOS/Linux home path embeds a real username. The trailing
// slash is optional so a bare literal like "/Users/bob" at end of value is
// still caught. A `<...>` segment (e.g. /Users/<user>/marveen) is a doc
// placeholder, not a real path, so it is allowed. Callers run the line through
// stripUrls() first, so a link like https://host/home/x is not mistaken for a
// home path.
const HOME_PATH_RX = /\/(Users|home)\/(?!<)[A-Za-z0-9._-]+/

// Why the home-path check strips URLs instead of skipping the line (measured
// 2026-09-20, HYGIENEURL920). The predicate used to be
// `!line.includes('://') && HOME_PATH_RX.test(line)`, which does not exclude a
// URL -- it switches the whole LINE off as soon as any `://` appears anywhere
// on it. Both halves of a line like
//     "Bash(curl -H \"Bearer $(cat /home/<user>/x/store/.token)\" \"http://localhost:3420/api/*)"
// are then unchecked, and the hardcoded home path rides through on the back of
// the localhost URL. That is not a narrow gap: it is an off switch anyone can
// hit by accident. Measured on this install the same day: of 17 hardcoded
// lines in the shipped profiles the old predicate reported 12, because 5 of
// them also carried a `://`.
// Stripping keeps the original intent (a home-looking path INSIDE a URL is
// still not a violation) while checking the rest of the line.
// `file:`/`FILE:` is deliberately NOT stripped: a `file:///home/bob/x` is an
// absolute local path wearing a scheme, which is exactly what must be caught.
const URL_RX = /\b(?!file:)[a-z][a-z0-9+.-]*:\/\/\S*/gi
const stripUrls = (line: string): string => line.replace(URL_RX, '')
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

// Text only. readFileSync(..., 'utf-8') does NOT throw on a binary file: it
// returns replacement-character mojibake, and those bytes can spell out any of
// the patterns below -- a compiled .pyc decoded this way matched HOME_PATH_RX
// and failed the scan with a phantom violation. A binary cannot carry readable
// identity anyway, so a NUL byte (which no text file in these trees has) is the
// signal to skip.
function readText(file: string): string | null {
  try {
    const buf = readFileSync(file)
    if (buf.includes(0)) return null
    return buf.toString('utf-8')
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
          if (HOME_PATH_RX.test(stripUrls(line))) {
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

  // web/app.js is the dashboard bundle, shipped verbatim to every install. It
  // must carry no deployment-specific operator identity: the owner display name
  // flows from the backend (OWNER_NAME -> /api/marveen -> window._marveen.ownerName,
  // read via chatOwnerName()), never a hardcoded "Szabolcs"/"Szabi" literal, so a
  // renamed install labels its real owner. This is the exact regression #369
  // fixed -- the chat sidebar used to pin/label the owner thread off a
  // `const CHAT_OWNER_AGENT = 'Szabolcs'` literal. The Marveen product brand and
  // agent role-names are NOT identity and stay allowed (none match these regexes).
  it('web/app.js carries no absolute home path, personal email, or default owner-name literal', () => {
    const violations: string[] = []
    const file = join(REPO_ROOT, 'web', 'app.js')
    const text = readText(file)
    if (text !== null) {
      text.split('\n').forEach((line, i) => {
        if (HOME_PATH_RX.test(stripUrls(line))) {
          violations.push(`web/app.js:${i + 1} absolute home path: ${line.trim().slice(0, 100)}`)
        }
        if (PERSONAL_EMAIL_RX.test(line)) {
          violations.push(`web/app.js:${i + 1} personal email: ${line.trim().slice(0, 100)}`)
        }
        if (FOREIGN_DEFAULT_OWNER_RX.test(line)) {
          violations.push(`web/app.js:${i + 1} default owner name literal (read it from window._marveen.ownerName via chatOwnerName()): ${line.trim().slice(0, 100)}`)
        }
      })
    }
    expect(violations, `Hardcoded operator identity found in web/app.js:\n${violations.join('\n')}`).toEqual([])
  })

  // scripts/support-mail ships operator tooling that talks to a real mailbox.
  // It must carry no operator identity either: the mailbox address, vault key,
  // owner name and branding flow from config (.env) / {{...}} placeholders, so a
  // committed file must not bake in an absolute home path, a personal email, or
  // the default owner-name literal.
  it('scripts/support-mail carries no absolute home path, personal email, or default owner-name literal', () => {
    const violations: string[] = []
    for (const file of walk(join(REPO_ROOT, 'scripts', 'support-mail'))) {
      const text = readText(file)
      if (text === null) continue
      const rel = file.slice(REPO_ROOT.length + 1)
      text.split('\n').forEach((line, i) => {
        if (HOME_PATH_RX.test(stripUrls(line))) {
          violations.push(`${rel}:${i + 1} absolute home path (derive from __file__): ${line.trim().slice(0, 100)}`)
        }
        if (PERSONAL_EMAIL_RX.test(line)) {
          violations.push(`${rel}:${i + 1} personal email: ${line.trim().slice(0, 100)}`)
        }
        if (FOREIGN_DEFAULT_OWNER_RX.test(line)) {
          violations.push(`${rel}:${i + 1} default owner name literal (use config / {{SUPPORT_SIGNATURE}}): ${line.trim().slice(0, 100)}`)
        }
      })
    }
    expect(violations, `Hardcoded identity found in scripts/support-mail:\n${violations.join('\n')}`).toEqual([])
  })
})

// The home-path predicate itself, pinned. The scans above can only go green
// two ways -- the tree is clean, or the predicate did not look -- and until
// 2026-09-20 it was silently the second for any line carrying a `://`. These
// cases fix which of the two a green run means. BYPASS_CORPUS holds lines that
// the previous predicate waved through; if someone reintroduces a line-skip,
// the last case here goes red on its own.
describe('the home-path predicate looks at the whole line, not just URL-free lines', () => {
  const flags = (line: string) => HOME_PATH_RX.test(stripUrls(line))

  // The pre-2026-09-20 predicate, kept only as the control in the last case.
  const oldPredicate = (line: string) => !line.includes('://') && HOME_PATH_RX.test(line)

  // Lines with a hardcoded home path AND a `://` somewhere. Every one of these
  // is a real violation; every one of these used to pass.
  const BYPASS_CORPUS = [
    // the exact shape that hid 5 of 17 findings in the shipped profiles
    '"Bash(curl -H \\"Bearer $(cat /home/bob/app/store/.dashboard-token)\\" \\"http://localhost:3420/api/*)"',
    '# see foo:// for the format, path is /home/bob/app',
    'docs at https://example.com/guide and the tree at /home/bob/app',
    'file:///home/bob/app/notes.md',
  ]

  it('flags a bare absolute home path', () => {
    expect(flags('/home/bob/app/store')).toBe(true)
    expect(flags('INSTALL=/Users/bob')).toBe(true)
  })

  it('does not flag a documentation placeholder', () => {
    expect(flags('/Users/<user>/marveen')).toBe(false)
  })

  it('does not flag a home-looking path that is inside a URL', () => {
    expect(flags('see https://docs.example.com/home/bob for details')).toBe(false)
    expect(flags('curl "http://localhost:3420/api/agents"')).toBe(false)
  })

  it('flags every line in the bypass corpus', () => {
    const missed = BYPASS_CORPUS.filter(line => !flags(line))
    expect(missed, `lines a :// still hides:\n${missed.join('\n')}`).toEqual([])
  })

  // The regression this file exists to prevent. If the predicate ever goes back
  // to skipping whole lines, `flags` starts agreeing with `oldPredicate` here
  // and this goes red. Asserting the DISAGREEMENT (not just the new result)
  // means the case cannot pass vacuously.
  it('disagrees with the old line-skip predicate on exactly those lines', () => {
    const stillWaved = BYPASS_CORPUS.filter(line => oldPredicate(line) === flags(line))
    expect(
      stillWaved,
      `the predicate no longer improves on the old line-skip for:\n${stillWaved.join('\n')}`,
    ).toEqual([])
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

  // The distributed updater (update.sh) ships to every install. Its
  // --reseed-fleet CLAUDE.md identity check detects stale-roster delegation
  // targets by comparing against the LOCAL agents/ dir at runtime, so the
  // script itself must never hard-code the origin fleet's roster names (or an
  // operator's identity) -- otherwise the shipped updater would re-introduce
  // exactly the leak it is meant to guard against. (The roster list lives here
  // in the test, never in shipped code.)
  // 3. Guard: templates/CLAUDE.md.template and src/web/agent-scaffold.ts must
  // use {{WEB_PORT}} / ${WEB_PORT} placeholders, not a hardcoded port literal.
  // A hardcoded localhost:3420 bypasses the substitution and breaks agents on
  // non-default ports (their memory/kanban/inter-agent API calls silently fail).
  it('CLAUDE.md.template contains no hardcoded localhost:3420', () => {
    const template = readFileSync(join(REPO_ROOT, 'templates', 'CLAUDE.md.template'), 'utf-8')
    expect(template, 'templates/CLAUDE.md.template must use {{WEB_PORT}}, not localhost:3420').not.toContain('localhost:3420')
  })

  it('agent-scaffold.ts contains no hardcoded localhost:3420 in its generateClaudeMd prompt', () => {
    const scaffold = readFileSync(join(REPO_ROOT, 'src', 'web', 'agent-scaffold.ts'), 'utf-8')
    expect(scaffold, 'src/web/agent-scaffold.ts must use ${WEB_PORT}, not localhost:3420').not.toContain('localhost:3420')
  })

  it('install scripts write WEB_PORT into the generated .env (heredoc contains WEB_PORT line)', () => {
    for (const script of ['install-linux.sh', 'install-macos.sh']) {
      const src = readFileSync(join(REPO_ROOT, script), 'utf-8')
      // The .env heredoc block must contain a WEB_PORT= line so the runtime
      // dashboard reads the correct port from .env and matches what the
      // CLAUDE.md templates were seeded with at install time.
      expect(src, `${script}: .env heredoc must contain WEB_PORT= line`).toMatch(/WEB_PORT=/)
      // A --port CLI flag must exist so non-default-port installs are ergonomic.
      expect(src, `${script}: must accept a --port CLI flag`).toMatch(/--port/)
    }
  })

  it('substituteTemplatePlaceholders with non-default WEB_PORT seeds the correct port into CLAUDE.md.template', () => {
    const template = readFileSync(join(REPO_ROOT, 'templates', 'CLAUDE.md.template'), 'utf-8')
    const out = substituteTemplatePlaceholders(template, {
      projectRoot: '/test',
      mainAgentId: 'testbot',
      botName: 'TestBot',
      ownerName: 'TestOwner',
      webPort: 3421,
    })
    expect(out, 'substituted template must not contain localhost:3420').not.toContain('localhost:3420')
    expect(out, 'substituted template must not contain unresolved {{WEB_PORT}}').not.toContain('{{WEB_PORT}}')
    expect(out, 'substituted template must contain localhost:3421').toContain('localhost:3421')
  })

  it('update.sh stays host-agnostic (no hardcoded roster or operator identity)', () => {
    const updateSh = readFileSync(join(REPO_ROOT, 'update.sh'), 'utf8')
    for (const name of ['samu', 'zara', 'boni', 'iris', 'deeper', 'slacker']) {
      expect(
        new RegExp(`\\b${name}\\b`, 'i').test(updateSh),
        `update.sh hard-codes fleet roster name "${name}" -- it must compare against agents/ at runtime instead`,
      ).toBe(false)
    }
    for (const line of updateSh.split('\n')) {
      if (/https?:\/\//.test(line)) continue
      expect(HOME_PATH_RX.test(line), `update.sh embeds an absolute home path: ${line.trim()}`).toBe(false)
      expect(PERSONAL_EMAIL_RX.test(line), `update.sh embeds a personal email: ${line.trim()}`).toBe(false)
    }
  })
})
