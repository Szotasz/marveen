// SITEPKGPLANT1104 (1): every python hook runs `python3 -I -S`. Without it the interpreter runs start-up code the
// gate did not ship before the gate itself: a .pth line or sitecustomize in a writable site-packages, a user site,
// PYTHON* settings. The hooks import only the standard library and their own directory (measured on every hook:
// the same exit code and output with and without -I -S; the one optional site-packages import, yaml in the
// memory-frontmatter lib, has its own fallback, and the two verdicts matched on 4688 real memory files).
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  pythonHookCommand, upgradeLegacyHookCommands, webSearchEnvelopeCommand, injectWebSearchEnvelope,
  removeRetiredHookCommands, WEBSEARCH_ENVELOPE_SCRIPT,
} from '../web/agent-scaffold.js'
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

// HOOKISOAGENTS1105: the two hook forms the agents' settings still ran without -I -S after SITEPKGPLANT1104
// (measured on the live fleet: browser-content-notice in 18, claude-usage in 15), and the one hook whose sibling
// import -I broke (the script's own directory is not on sys.path under -I).
describe('HOOKISOAGENTS1105: the agents\' envelope hook runs isolated, the retired claude-usage entry goes', () => {
  type G = { matcher?: unknown; hooks: Array<{ type?: string; command: string; timeout?: number }> }
  const ABS = join(PROJECT_ROOT, 'scripts', 'hooks', WEBSEARCH_ENVELOPE_SCRIPT)
  const envelopes = (s: { hooks: { PostToolUse: G[] } }) =>
    s.hooks.PostToolUse.flatMap((g) => g.hooks).filter((h) => h.command.includes(WEBSEARCH_ENVELOPE_SCRIPT))

  it('the envelope command is python3 -I -S, and stays a plain command (not the fail-closed gate builder)', () => {
    expect(webSearchEnvelopeCommand()).toBe(`python3 -I -S "${ABS}"`)
    expect(webSearchEnvelopeCommand()).not.toContain('governance-kapu')
  })

  it('the live agent form (managed group, old absolute path) becomes the isolated one: one envelope, no duplicate', () => {
    const s = { hooks: { PostToolUse: [
      { matcher: 'Bash', hooks: [{ type: 'command', command: 'true' }] },
      { matcher: 'WebSearch|WebFetch', hooks: [{ type: 'command', command: `python3 "${ABS}"`, timeout: 10 }] },
    ] as G[] } }
    expect(injectWebSearchEnvelope(s)).toBe(true)
    expect(envelopes(s).map((h) => h.command)).toEqual([`python3 -I -S "${ABS}"`])
    expect(s.hooks.PostToolUse[0]).toEqual({ matcher: 'Bash', hooks: [{ type: 'command', command: 'true' }] })
    expect(injectWebSearchEnvelope(s)).toBe(false) // second start: nothing to do
  })

  it('an operator group in the documented old form gains -I -S in place: matcher, place and $CLAUDE_PROJECT_DIR kept', () => {
    const docs = 'python3 "$CLAUDE_PROJECT_DIR/scripts/hooks/browser-content-notice.py"'
    const own = { type: 'command', command: 'python3 "/x/own-audit.py"' }
    const s = { hooks: { PostToolUse: [{ matcher: 'mcp__playwright__browser_.*|WebSearch|WebFetch', hooks: [{ type: 'command', command: docs, timeout: 10 }, own] }] as G[] } }
    expect(injectWebSearchEnvelope(s)).toBe(true)
    expect(s.hooks.PostToolUse).toEqual([{ matcher: 'mcp__playwright__browser_.*|WebSearch|WebFetch', hooks: [
      { type: 'command', command: 'python3 -I -S "$CLAUDE_PROJECT_DIR/scripts/hooks/browser-content-notice.py"', timeout: 10 }, own] }])
    expect(injectWebSearchEnvelope(s)).toBe(false)
  })

  it('an envelope command in any other form is not touched (only the shipped and documented forms are upgraded)', () => {
    for (const other of [
      `python3 -u "${ABS}"`,
      `/usr/bin/python3 "${ABS}"`,
      `python3 "${ABS}" --extra`,
    ]) {
      const s = { hooks: { PostToolUse: [{ matcher: '.*', hooks: [{ type: 'command', command: other }] }] as G[] } }
      injectWebSearchEnvelope(s)
      expect(s.hooks.PostToolUse[0].hooks[0].command, other).toBe(other)
    }
  })

  it('the retired claude-usage entry is removed in every shipped form and any install root; an emptied group goes', () => {
    const live = (root: string) => `bash -c '[ -f ${root}/scripts/hooks/claude-usage.py ] && exec python3 ${root}/scripts/hooks/claude-usage.py; exit 0'`
    const keep = { type: 'command', command: 'python3 -I -S "/r/scripts/hooks/other.py"' }
    const hooks: Record<string, unknown> = {
      UserPromptSubmit: [
        { hooks: [{ type: 'command', command: '/bin/echo first' }] },
        { hooks: [{ type: 'command', command: live('/Users/x/ClaudeClaw'), timeout: 45 }] },
        { hooks: [{ type: 'command', command: 'python3 "$CLAUDE_PROJECT_DIR/scripts/hooks/claude-usage.py"' }, keep] },
      ],
      Stop: [{ hooks: [{ type: 'command', command: live('/opt/other root') }] }], // a root with a space: not a shipped form
    }
    expect(removeRetiredHookCommands(hooks)).toBe(true)
    expect(hooks.UserPromptSubmit).toEqual([
      { hooks: [{ type: 'command', command: '/bin/echo first' }] },
      { hooks: [keep] },
    ])
    expect((hooks.Stop as G[])[0].hooks).toHaveLength(1)
    expect(removeRetiredHookCommands(hooks)).toBe(false)
  })

  it('an operator\'s own hook that merely names a claude-usage.py stays', () => {
    const own = [
      'python3 /home/me/tools/claude-usage.py',
      "bash -c '[ -f /a/scripts/hooks/claude-usage.py ] && exec python3 /b/scripts/hooks/claude-usage.py; exit 0'", // two roots
      'python3 -I -S "$CLAUDE_PROJECT_DIR/scripts/hooks/claude-usage.py"',
    ]
    const hooks: Record<string, unknown> = { UserPromptSubmit: own.map((command) => ({ hooks: [{ type: 'command', command }] })) }
    const before = JSON.stringify(hooks)
    expect(removeRetiredHookCommands(hooks)).toBe(false)
    expect(JSON.stringify(hooks)).toBe(before)
  })

  it('ensureAgentHooks runs the retired-entry pass on every start', () => {
    const src = read('src/web/agent-scaffold.ts')
    const body = src.slice(src.indexOf('export function ensureAgentHooks('))
    expect(body.slice(0, body.indexOf('for (const [event, handlers] of Object.entries(tplHooks))'))).toContain('removeRetiredHookCommands(existingHooks)')
  })

  it('every sibling import in a scripts/hooks python file comes after a sys.path edit (-I drops the script dir)', () => {
    const dir = join(PROJECT_ROOT, 'scripts', 'hooks')
    const lib = join(PROJECT_ROOT, 'scripts', 'lib')
    const siblings = new Set([...readdirSync(dir), ...readdirSync(lib)].filter((n) => n.endsWith('.py')).map((n) => n.slice(0, -3)))
    const loose: string[] = []
    let imports = 0
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.py'))) {
      const lines = read(join('scripts', 'hooks', f)).split('\n')
      const firstPathEdit = lines.findIndex((l) => /\bsys\.path\.(?:insert|append)\(/.test(l) && !l.trim().startsWith('#'))
      lines.forEach((line, i) => {
        const m = line.match(/^\s*(?:import\s+([\w.]+)|from\s+([\w.]+)\s+import\b)/)
        if (!m) return
        const mod = (m[1] ?? m[2]).split('.')[0]
        if (!siblings.has(mod)) return
        imports++
        if (firstPathEdit < 0 || firstPathEdit > i) loose.push(`${f}:${i + 1}: ${line.trim()}`)
      })
    }
    expect(imports).toBeGreaterThan(30)
    expect(loose).toEqual([])
  })
})
