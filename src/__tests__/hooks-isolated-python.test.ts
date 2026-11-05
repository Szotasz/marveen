// SITEPKGPLANT1104 (1): every python hook runs `python3 -I -S`. Without it the interpreter runs start-up code the
// gate did not ship before the gate itself: a .pth line or sitecustomize in a writable site-packages, a user site,
// PYTHON* settings. The hooks import only the standard library and their own directory (measured on every hook:
// the same exit code and output with and without -I -S; the one optional site-packages import, yaml in the
// memory-frontmatter lib, has its own fallback, and the two verdicts matched on 4688 real memory files).
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pythonHookCommand, upgradeLegacyHookCommands } from '../web/agent-scaffold.js'
import { PROJECT_ROOT } from '../config.js'

const read = (rel: string) => readFileSync(join(PROJECT_ROOT, rel), 'utf-8')

// every `python3 <...>/scripts/hooks/<x>.py` in a hook command string, with what stands between python3 and the path
function pythonHookRuns(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(/python3((?: -[A-Za-z]+)*) +\\?"?(?:\$CLAUDE_PROJECT_DIR|\{\{PROJECT_ROOT\}\}|\/)[^ "']*\/scripts\/hooks\/[\w-]+\.py/g)) {
    out.push(m[1].trim())
  }
  return out
}

describe('SITEPKGPLANT1104: python hooks run isolated', () => {
  it('the main project settings: every python hook command is python3 -I -S', () => {
    const runs = pythonHookRuns(read('.claude/settings.json'))
    expect(runs.length).toBeGreaterThan(50)
    expect(runs.filter((o) => o !== '-I -S')).toEqual([])
  })

  it('the settings template (user scope and sub-agents): every python hook command is python3 -I -S', () => {
    const runs = pythonHookRuns(read('templates/settings.json.template'))
    expect(runs.length).toBeGreaterThan(20)
    expect(runs.filter((o) => o !== '-I -S')).toEqual([])
  })

  it('the gate builder for injected python gates runs python3 -I -S', () => {
    expect(pythonHookCommand('/x/scripts/hooks/credential-gate.py')).toContain('python3 -I -S "/x/scripts/hooks/credential-gate.py"')
  })

  it('the main-agent extra settings writer runs the sender-role gate isolated', () => {
    expect(read('scripts/main-extra-plugins-settings.sh')).toContain(`'python3 -I -S "$CLAUDE_PROJECT_DIR/scripts/hooks/sender-role-gate.py" --policy '`)
  })

  it('every python3 run in a scripts/hooks shell script is isolated (Bence 69829: the scheduler preCheck, inline -c code)', () => {
    const dir = join(PROJECT_ROOT, 'scripts', 'hooks')
    const loose: string[] = []
    let runs = 0
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.sh'))) {
      read(join('scripts', 'hooks', f)).split('\n').forEach((line, i) => {
        if (line.trim().startsWith('#')) return
        // a run: python3 at a command position, then -c code or a .py path
        for (const m of line.matchAll(/(?:^|[\s|;&(])python3((?: -[A-Za-z]+)*) +(?:-c\b|"?[^\s"']*\.py\b)/g)) {
          runs++
          if (m[1].trim() !== '-I -S') loose.push(`${f}:${i + 1}: ${line.trim().slice(0, 100)}`)
        }
      })
    }
    expect(runs).toBeGreaterThanOrEqual(4)
    expect(loose).toEqual([])
  })

  it('every child python a scripts/hooks python file starts is isolated (Bence 69833: usage-collect; the deferred respawn)', () => {
    const dir = join(PROJECT_ROOT, 'scripts', 'hooks')
    const loose: string[] = []
    let launches = 0
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.py'))) {
      const src = read(join('scripts', 'hooks', f))
      // a subprocess call whose argv list starts with python3 or sys.executable (a parser table is no launch)
      for (const m of src.matchAll(/subprocess\.\w+\(\s*\[\s*(?:["']python3["']|sys\.executable)\s*,\s*([^,\]]+),\s*([^,\]]+)/g)) {
        launches++
        const [a, b] = [m[1].trim(), m[2].trim()]
        if (!(/^["']-I["']$/.test(a) && /^["']-S["']$/.test(b))) loose.push(`${f}: ${m[0].replace(/\s+/g, ' ').slice(0, 100)}`)
      }
    }
    expect(launches).toBeGreaterThanOrEqual(2)
    expect(loose).toEqual([])
  })

  it('an existing install: the old command is upgraded in place, not added beside it', () => {
    // a real script path: the upgrade skips a command whose script does not exist (isUnsafeHookCommand)
    const s = join(PROJECT_ROOT, 'scripts', 'hooks', 'staleness-guard.py')
    const old = `bash -c '[ -f ${s} ] && exec python3 ${s}; exit 0'`
    const tpl = `bash -c '[ -f ${s} ] && exec python3 -I -S ${s}; exit 0'`
    const existing: Record<string, unknown> = { PreToolUse: [{ matcher: '.*', hooks: [{ type: 'command', command: old }] }] }
    const template: Record<string, unknown> = { PreToolUse: [{ matcher: '.*', hooks: [{ type: 'command', command: tpl }] }] }
    expect(upgradeLegacyHookCommands(existing, template)).toBe(true)
    const commands = (existing.PreToolUse as { hooks: { command: string }[] }[]).flatMap((e) => e.hooks.map((h) => h.command))
    expect(commands).toEqual([tpl])
  })
})
