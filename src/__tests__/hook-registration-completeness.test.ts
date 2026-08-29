import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

// Registration-completeness lint for scripts/hooks/.
//
// The recurring defect class this pins: a hook ships fully unit-tested but is
// registered NOWHERE, so it never fires in production while its suite stays
// green -- the reply-guard before #1028 registered its decision logic but not
// the Stop wiring, skill-usage-capture (#607) captured nothing for six weeks,
// and the ledger-live-drain never ran while its docs promised a schedule.
// Each was found by hand. This test finds the next one mechanically: every
// shipped hook script must be referenced by at least one REGISTRATION surface,
// or carry an explicit, reasoned exemption below.
//
// Two directions are enforced:
//   - UNWIRED: a hook that is neither registered nor exempted fails the build,
//     so a new hook cannot ship dead.
//   - STALE EXEMPTION: an exempted hook that IS now registered fails the
//     build, so the exemption list cannot rot into a blind spot -- when an
//     in-flight wiring PR lands, its entry must be deleted here.

const ROOT = join(__dirname, '..', '..')
const HOOKS_DIR = join(ROOT, 'scripts', 'hooks')

// Everywhere a hook can legitimately be wired into production:
// the settings template every agent is seeded from, the repo checkout's own
// project settings, the code-side registrations (agent-scaffold), the two
// installer scripts, and the seeded scheduled tasks (a script may be driven by
// a schedule instead of a hook event).
const REGISTRATION_SURFACES = [
  'templates/settings.json.template',
  '.claude/settings.json',
  'src/web/agent-scaffold.ts',
  'scripts/install-telegram-progress-hook.sh',
  'scripts/install-channel-image-hook.sh',
]

// name -> why it is allowed to be unregistered. Keep every reason concrete;
// "misc" entries defeat the lint.
const EXEMPT: Record<string, string> = {
  'ledger_lib.py':
    'shared library imported by the ledger hooks; not itself a hook',
  'memory-save.sh':
    'legacy: referenced only by a historical rebuild prompt, wired nowhere; kept pending a maintainer decision to remove it',
  'telegram-ack.py':
    'unreferenced anywhere in the repo; dead code kept pending a maintainer decision to remove it',
}

function registrationCorpus(): string {
  let corpus = ''
  for (const rel of REGISTRATION_SURFACES) {
    const p = join(ROOT, rel)
    if (existsSync(p)) corpus += readFileSync(p, 'utf-8')
  }
  const tasksDir = join(ROOT, 'scheduled-tasks')
  if (existsSync(tasksDir)) {
    for (const task of readdirSync(tasksDir)) {
      const skill = join(tasksDir, task, 'SKILL.md')
      if (existsSync(skill)) corpus += readFileSync(skill, 'utf-8')
    }
  }
  return corpus
}

// A reference is a PATH ("/name") or a quoted token ("'name'" / "\"name\"") --
// never a bare substring, so "channel-inbox-drain.py" cannot satisfy
// "inbox-drain.py".
function isRegistered(corpus: string, name: string): boolean {
  return corpus.includes(`/${name}`) || corpus.includes(`'${name}'`) || corpus.includes(`"${name}"`)
}

function hookScripts(): string[] {
  return readdirSync(HOOKS_DIR)
    .filter((f) => f.endsWith('.py') || f.endsWith('.mjs') || f.endsWith('.sh'))
    .sort()
}

describe('hook registration completeness (scripts/hooks/)', () => {
  const corpus = registrationCorpus()

  it('every shipped hook is registered on some production surface, or reasoned-exempt', () => {
    const unwired = hookScripts().filter(
      (name) => !(name in EXEMPT) && !isRegistered(corpus, name),
    )
    expect(unwired, `unregistered hooks with no exemption: ${unwired.join(', ')} -- wire them or add a reasoned EXEMPT entry`).toEqual([])
  })

  it('no exemption has gone stale (an exempted hook that is now registered must drop its entry)', () => {
    const stale = Object.keys(EXEMPT).filter((name) => isRegistered(corpus, name))
    expect(stale, `stale exemptions (now registered): ${stale.join(', ')} -- delete their EXEMPT entries`).toEqual([])
  })

  it('every exemption points at a file that still exists (no ghost entries)', () => {
    const ghosts = Object.keys(EXEMPT).filter((name) => !existsSync(join(HOOKS_DIR, name)))
    expect(ghosts).toEqual([])
  })

  it('the boundary rule rejects substring matches (the channel-inbox-drain trap)', () => {
    expect(isRegistered('scripts/hooks/channel-inbox-drain.py', 'inbox-drain.py')).toBe(false)
    expect(isRegistered('scripts/hooks/inbox-drain.py', 'inbox-drain.py')).toBe(true)
    expect(isRegistered("join(PROJECT_ROOT, 'scripts', 'hooks', 'egress-gate.mjs')", 'egress-gate.mjs')).toBe(true)
  })
})
