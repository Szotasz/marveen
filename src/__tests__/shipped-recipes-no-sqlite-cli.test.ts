import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

// What we ship as a RECIPE has to run on the machine we ship it to.
//
// A customer's Linux box reported `sqlite3: command not found` (exit 127) from
// the agent's own activity. It was not that machine: the installer's dependency
// list is ffmpeg, git, tmux, lsof, curl, python3, pipx, unzip (+ toolchain and
// node) -- neither `sqlite3` nor `jq` is in it. Measured on two live Linux hosts
// on 2026-08-04: both missing, `python3` present on both. It never showed up for
// us because our own host is macOS, where sqlite3 ships with the system.
//
// The damage is quiet: the 4-hourly kanban-audit task ran its cleanup and its
// stuck-card detection through `sqlite3` and `jq`, so on every Linux install
// those steps died while the audit still looked like it had run.
//
// The dashboard API covers all of it, so these tests pin three things:
//   1. shipped recipes (fenced shell blocks under seed-*/) call neither binary,
//   2. the files that were fixed actually use the API instead,
//   3. the two seeding paths substitute the SAME placeholders -- otherwise a
//      recipe means different things depending on which script wrote the copy.

const ROOT = join(__dirname, '..', '..')

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else if (p.endsWith('.md')) out.push(p)
  }
  return out
}

/** Only fenced shell blocks -- prose that MENTIONS sqlite3 is not a recipe. */
function shellBlocks(src: string): string[] {
  const blocks: string[] = []
  const re = /```(?:bash|sh|shell)\n([\s\S]*?)```/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) blocks.push(m[1])
  return blocks
}

const SHIPPED = [...walk(join(ROOT, 'seed-skills')), ...walk(join(ROOT, 'seed-scheduled-tasks'))]

describe('shipped recipes only use binaries the installer guarantees', () => {
  it('finds the shipped skill/task files at all (positive control)', () => {
    expect(SHIPPED.length).toBeGreaterThan(3)
    expect(SHIPPED.some((f) => f.includes('kanban-audit'))).toBe(true)
    expect(SHIPPED.some((f) => f.includes('handoff'))).toBe(true)
  })

  it('no fenced shell block invokes sqlite3 or jq', () => {
    const offenders: string[] = []
    for (const file of SHIPPED) {
      for (const block of shellBlocks(readFileSync(file, 'utf-8'))) {
        for (const line of block.split('\n')) {
          const code = line.replace(/#.*$/, '')
          if (/(^|[|;&(]\s*|\$\()\s*sqlite3\s/.test(code)) offenders.push(`${file}: ${line.trim().slice(0, 90)}`)
          if (/(^|[|;&(]\s*|\$\()\s*jq\s/.test(code)) offenders.push(`${file}: ${line.trim().slice(0, 90)}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('the two fixed recipes go through the dashboard API instead', () => {
    const audit = readFileSync(join(ROOT, 'seed-scheduled-tasks', 'kanban-audit', 'SKILL.md'), 'utf-8')
    const handoff = readFileSync(join(ROOT, 'seed-skills', 'handoff', 'SKILL.md'), 'utf-8')
    expect(audit).toContain('/api/kanban')
    expect(audit).toMatch(/python3/)
    expect(handoff).toContain('/api/kanban')
    expect(handoff).toMatch(/python3/)
  })

  it('the recipes resolve the port instead of hardcoding 3420', () => {
    const handoff = readFileSync(join(ROOT, 'seed-skills', 'handoff', 'SKILL.md'), 'utf-8')
    const audit = readFileSync(join(ROOT, 'seed-scheduled-tasks', 'kanban-audit', 'SKILL.md'), 'utf-8')
    for (const src of [handoff, audit]) {
      expect(src).toMatch(/WEB_PORT=/)
      expect(src).not.toMatch(/localhost:3420/)
    }
  })

  it('the CLAUDE.md template hands the agent the kanban API, not a table name', () => {
    const tpl = readFileSync(join(ROOT, 'templates', 'CLAUDE.md.template'), 'utf-8')
    const section = tpl.slice(tpl.indexOf('## Kanban tábla'), tpl.indexOf('## Ütemezett feladatok'))
    // each operation asserted on its own: a single toContain('/api/kanban')
    // passed even when the LIST endpoint had been broken, because the move and
    // comment URLs still carried the substring (mutation control, 2026-08-04).
    expect(section).toMatch(/^\s*http:\/\/localhost:\{\{WEB_PORT\}\}\/api\/kanban$/m)             // list (bare URL on its own line)
    expect(section).toMatch(/-X POST http:\/\/localhost:\{\{WEB_PORT\}\}\/api\/kanban\s*\\/)      // create
    expect(section).toMatch(/\/api\/kanban\/KARTYA_ID\/move/)                                     // move
    expect(section).toMatch(/\/api\/kanban\/KARTYA_ID\/comments/)                                 // comment
    expect(section).toMatch(/sqlite3/)   // it must WARN about it
  })
})

describe('both seeding paths substitute the same placeholders', () => {
  const INSTALL = readFileSync(join(ROOT, 'install-linux.sh'), 'utf-8')
  const UPDATE = readFileSync(join(ROOT, 'update.sh'), 'utf-8')

  /** Placeholder names substituted in the sed block that follows `anchor`. */
  function placeholdersAfter(src: string, anchor: string): Set<string> {
    const start = src.indexOf(anchor)
    if (start < 0) throw new Error(`anchor not found: ${anchor}`)
    const sed = src.indexOf('sed -e', start)
    if (sed < 0) throw new Error(`no sed block after ${anchor}`)
    const end = src.indexOf('> "$target/$(basename "$f")"', sed)
    if (end < 0) throw new Error(`unterminated sed block after ${anchor}`)
    const chunk = src.slice(sed, end)
    return new Set([...chunk.matchAll(/\{\{([A-Z_]+)\}\}/g)].map((m) => m[1]))
  }

  it('the scheduled-task seeder in update.sh matches the installer', () => {
    const fromInstaller = placeholdersAfter(INSTALL, 'SEED_SCHED_DIR="$INSTALL_DIR/seed-scheduled-tasks"')
    const fromUpdate = placeholdersAfter(UPDATE, 'SEED_SCHED_DIR="$INSTALL_DIR/seed-scheduled-tasks"')
    expect([...fromUpdate].sort()).toEqual([...fromInstaller].sort())
    // and WEB_PORT specifically, since that is the one that was missing
    expect(fromUpdate.has('WEB_PORT')).toBe(true)
  })
})
