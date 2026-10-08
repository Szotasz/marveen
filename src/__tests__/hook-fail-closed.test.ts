import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  HOOK_NODE_BIN,
  hookCommand,
  pythonHookCommand,
  failClosedGateRun,
  gateDeadlineSec,
  GATE_FAIL_CLOSED_TAG,
  EMAIL_THREAD_REPLY_FLAG,
  injectEmailSendGate,
  injectSelfPaceGate,
  injectEgressGate,
  injectBashEgressParser,
  injectDestructiveGate,
} from '../web/agent-scaffold.js'
import { PROJECT_ROOT } from '../config.js'

// Card 723bbb70: a gate that is itself broken must BLOCK. Claude Code blocks a tool call only on exit 2
// (or a deny on stdout with exit 0); a SyntaxError in the gate file exits 1, which is a non-blocking error,
// so before this change a broken gate let every call through (af12a1d3 73814: rc 1 on all eight security
// hooks). The gate commands now keep 0 and 2 and turn every other status into 2, with the reason on stderr.

const HAS_TIMEOUT = spawnSync('/bin/sh', ['-c', 'command -v timeout'], { encoding: 'utf-8' }).status === 0
const SHELLS = ['/bin/sh', '/bin/bash']

let tmp: string
beforeAll(() => { tmp = mkdtempSync(join(tmpdir(), 'hook-fail-closed-')) })
afterAll(() => { rmSync(tmp, { recursive: true, force: true }) })

function run(shell: string, command: string, input = '{}', env: NodeJS.ProcessEnv = process.env, cwd = tmp) {
  const t0 = Date.now()
  const r = spawnSync(shell, ['-c', command], { input, env, cwd, encoding: 'utf-8', timeout: 30_000 })
  return { rc: r.status, signal: r.signal, stdout: r.stdout, stderr: r.stderr, ms: Date.now() - t0 }
}

function fakeGate(name: string, body: string): string {
  const p = join(tmp, name)
  writeFileSync(p, body)
  return p
}

describe('the fail-closed tail, on stand-in gates', () => {
  for (const shell of SHELLS) {
    describe(shell, () => {
      it('exit 0 stays 0, and the gate\'s stdout (a deny JSON) passes through untouched', () => {
        const deny = JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'x' } })
        const g = fakeGate('zero.mjs', `process.stdout.write(${JSON.stringify(deny)}); process.exit(0)`)
        const r = run(shell, hookCommand(g))
        expect(r.rc).toBe(0)
        expect(r.stdout).toBe(deny)
        expect(r.stderr).not.toContain(GATE_FAIL_CLOSED_TAG)
      })

      it('exit 2 stays 2, without the wrapper\'s message', () => {
        const g = fakeGate('two.py', 'import sys\nsys.stderr.write("tiltva\\n")\nsys.exit(2)\n')
        const r = run(shell, pythonHookCommand(g))
        expect(r.rc).toBe(2)
        expect(r.stderr).toContain('tiltva')
        expect(r.stderr).not.toContain(GATE_FAIL_CLOSED_TAG)
      })

      for (const code of [1, 3, 126]) {
        it(`exit ${code} becomes 2, and the reason names the status`, () => {
          const g = fakeGate(`exit${code}.mjs`, `process.exit(${code})`)
          const r = run(shell, hookCommand(g))
          expect(r.rc).toBe(2)
          expect(r.stderr).toContain(`${GATE_FAIL_CLOSED_TAG}: exit${code}.mjs:`)
          expect(r.stderr).toContain(`rc=${code}`)
        })
      }

      it('a syntax error in a node gate file: rc 2, the interpreter\'s own error stays on stderr', () => {
        const g = fakeGate('broken.mjs', 'const x = ;\n')
        const raw = run(shell, `"${HOOK_NODE_BIN}" "${g}"`)
        expect(raw.rc).toBe(1) // the fail-open status the wrapper exists for
        const r = run(shell, hookCommand(g))
        expect(r.rc).toBe(2)
        expect(r.stderr).toContain('SyntaxError')
        expect(r.stderr).toContain('rc=1')
      })

      it('a syntax error in a python gate file: rc 2', () => {
        const g = fakeGate('broken.py', 'x = (\n')
        expect(run(shell, `python3 "${g}"`).rc).toBe(1)
        const r = run(shell, pythonHookCommand(g))
        expect(r.rc).toBe(2)
        expect(r.stderr).toContain('SyntaxError')
        expect(r.stderr).toContain(GATE_FAIL_CLOSED_TAG)
      })

      it('a missing gate file blocks for node (1 -> 2) and for python (python3 itself exits 2)', () => {
        const n = run(shell, hookCommand(join(tmp, 'nincs-ilyen.mjs')))
        expect(n.rc).toBe(2)
        expect(n.stderr).toContain(GATE_FAIL_CLOSED_TAG)
        expect(run(shell, pythonHookCommand(join(tmp, 'nincs-ilyen.py'))).rc).toBe(2)
      })

      it('a gate killed by a signal blocks (137 -> 2)', () => {
        const g = fakeGate('killed.mjs', 'process.kill(process.pid, "SIGKILL")')
        const r = run(shell, hookCommand(g))
        expect(r.rc).toBe(2)
        expect(r.stderr).toContain('rc=137')
      })

      it('stdin reaches the gate and its stdout comes back, byte for byte, as in the raw call', () => {
        const g = fakeGate('echo.mjs', 'let s = ""; process.stdin.on("data", (d) => { s += d }); process.stdin.on("end", () => { process.stdout.write("len=" + s.length + ":" + s) })')
        const input = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'echo "a b" | wc -c' } })
        const raw = run(shell, `"${HOOK_NODE_BIN}" "${g}"`, input)
        const wrapped = run(shell, hookCommand(g), input)
        expect(wrapped.rc).toBe(0)
        expect(wrapped.stdout).toBe(raw.stdout)
        expect(wrapped.stdout).toBe(`len=${input.length}:${input}`)
      })

      it('an argument rides inside the invocation and reaches the gate (the thread-reply flag)', () => {
        const g = fakeGate('argv.mjs', 'process.stdout.write(JSON.stringify(process.argv.slice(2)))')
        const r = run(shell, hookCommand(g, [EMAIL_THREAD_REPLY_FLAG]))
        expect(r.rc).toBe(0)
        expect(JSON.parse(r.stdout)).toEqual([EMAIL_THREAD_REPLY_FLAG])
      })

      it.skipIf(!HAS_TIMEOUT)('a hung gate ends at the wrapper\'s deadline, inside the hook timeout, and blocks', () => {
        const g = fakeGate('hang.mjs', 'setTimeout(() => {}, 60_000)')
        const r = run(shell, hookCommand(g, [], 3)) // hook timeout 3 s -> the gate's deadline 1 s
        expect(r.rc).toBe(2)
        expect(r.stderr).toContain('rc=124')
        expect(r.ms).toBeLessThan(3000)
      })
    })
  }
})

describe('the builders', () => {
  it('the interpreter probe comes first and still blocks on its own; the run-and-map tail follows', () => {
    const cmd = hookCommand('/some/dir/gate.mjs')
    expect(cmd).toMatch(/^test -x /)
    expect(cmd).toContain(`"${HOOK_NODE_BIN}" "/some/dir/gate.mjs"`)
    expect(cmd.endsWith(failClosedGateRun(`"${HOOK_NODE_BIN}" "/some/dir/gate.mjs"`, 'gate.mjs', 10))).toBe(true)
    const py = pythonHookCommand('/some/dir/gate.py')
    expect(py).toMatch(/^command -v python3 >\/dev\/null 2>&1 \|\| /)
    expect(py.endsWith(failClosedGateRun('python3 "/some/dir/gate.py"', 'gate.py', 10))).toBe(true)
  })

  it('the deadline is two seconds inside the hook timeout, never below one second', () => {
    expect(gateDeadlineSec(10)).toBe(8)
    expect(gateDeadlineSec(15)).toBe(13)
    expect(gateDeadlineSec(2)).toBe(1)
    expect(hookCommand('/d/g.mjs', [], 15)).toContain('timeout -k 1 13 ')
  })

  it('refuses an argument or a label that would need shell quoting', () => {
    expect(() => hookCommand('/d/g.mjs', ['a b'])).toThrow()
    expect(() => hookCommand('/d/g.mjs', ['$(id)'])).toThrow()
    expect(() => failClosedGateRun('x', 'a b', 10)).toThrow()
  })

  it('every gate an injector writes for the agents carries the tail', () => {
    const s: Record<string, unknown> = {}
    injectEmailSendGate(s)
    injectSelfPaceGate(s)
    injectEgressGate(s)
    injectBashEgressParser(s)
    injectDestructiveGate(s)
    const ptu = ((s.hooks as Record<string, unknown>).PreToolUse as { hooks: { command: string }[] }[])
    const commands = ptu.flatMap((e) => e.hooks.map((h) => h.command))
    expect(commands.length).toBeGreaterThanOrEqual(5)
    for (const c of commands) {
      expect(c).toContain(GATE_FAIL_CLOSED_TAG)
      expect(c.endsWith('exit "$rc"')).toBe(true)
    }
    const flagged: Record<string, unknown> = {}
    injectEmailSendGate(flagged, true)
    const fcmd = ((flagged.hooks as Record<string, unknown>).PreToolUse as { hooks: { command: string }[] }[])[0].hooks[0].command
    expect(fcmd).toContain(`email-send-gate.mjs" ${EMAIL_THREAD_REPLY_FLAG};`)
    expect(fcmd.endsWith('exit "$rc"')).toBe(true)
  })
})

// The real gates, each on a disposable copy of scripts/ (they resolve their store/ and logs from their
// own location, so nothing here touches the install). Positive control: on an intact copy the wrapped
// command gives the SAME status and stdout as the raw interpreter call, for a set of inputs that
// includes denials. Negative test: a syntax error appended to the gate FILE, the wrapped command rc 2.
const NODE_GATES = ['email-send-gate.mjs', 'self-pace-gate.mjs', 'kanban-write-gate.mjs', 'digest-provenance-gate.mjs', 'hooks/egress-gate.mjs', 'hooks/bash-egress-parser.mjs']
const PY_GATES = ['hooks/outgoing-copy-gate.py', 'hooks/destructive-gate.py', 'hooks/email-approval-gate.py']

function inputs(root: string): string[] {
  const base = { hook_event_name: 'PreToolUse', session_id: 'hook-fail-closed-test', cwd: root }
  return [
    { ...base, tool_name: 'Bash', tool_input: { command: 'true' } },
    { ...base, tool_name: 'Bash', tool_input: { command: 'curl http://example.invalid/x' } },
    { ...base, tool_name: 'WebFetch', tool_input: { url: 'https://example.invalid/p', prompt: 'x' } },
    { ...base, tool_name: 'mcp__teszt__send_email', tool_input: { to: ['a@example.invalid'], subject: 's', body: 'b' } },
  ].map((o) => JSON.stringify(o))
}

describe('the real security gates on a disposable copy', () => {
  let root: string
  let env: NodeJS.ProcessEnv
  beforeAll(() => {
    root = join(tmp, 'install')
    mkdirSync(join(root, 'store'), { recursive: true })
    cpSync(join(PROJECT_ROOT, 'scripts'), join(root, 'scripts'), { recursive: true })
    mkdirSync(join(tmp, 'home'), { recursive: true })
    env = { ...process.env, HOME: join(tmp, 'home'), CLAUDE_PROJECT_DIR: root, PYTHONDONTWRITEBYTECODE: '1' }
  })

  function breakFile(rel: string): () => void {
    const p = join(root, 'scripts', rel)
    const orig = readFileSync(p)
    appendFileSync(p, rel.endsWith('.py') ? '\nx = (\n' : '\nconst = ;\n')
    return () => writeFileSync(p, orig)
  }

  for (const rel of [...NODE_GATES, ...PY_GATES]) {
    const py = rel.endsWith('.py')
    const build = (p: string) => (py ? pythonHookCommand(p) : hookCommand(p))
    const raw = (p: string) => (py ? `python3 "${p}"` : `"${HOOK_NODE_BIN}" "${p}"`)

    it(`${rel}: intact, the wrapped decisions equal the raw ones on every input`, () => {
      const p = join(root, 'scripts', rel)
      for (const input of inputs(root)) {
        const a = run('/bin/sh', raw(p), input, env, root)
        const b = run('/bin/sh', build(p), input, env, root)
        expect(a.rc === 0 || a.rc === 2, `${rel} raw rc ${a.rc}: ${a.stderr.slice(0, 300)}`).toBe(true)
        expect({ rc: b.rc, stdout: b.stdout }).toEqual({ rc: a.rc, stdout: a.stdout })
        expect(b.stderr).not.toContain(GATE_FAIL_CLOSED_TAG)
      }
    }, 60_000)

    it(`${rel}: a syntax error in the gate file blocks (rc 2), where the raw call let it through`, () => {
      const restore = breakFile(rel)
      try {
        const p = join(root, 'scripts', rel)
        const input = inputs(root)[0]
        const a = run('/bin/sh', raw(p), input, env, root)
        expect(a.rc).toBe(1)
        const b = run('/bin/sh', build(p), input, env, root)
        expect(b.rc).toBe(2)
        expect(b.stderr).toContain(GATE_FAIL_CLOSED_TAG)
      } finally {
        restore()
      }
    }, 60_000)
  }

  // The main agent's project settings carry the same tail around $CLAUDE_PROJECT_DIR paths. Its security
  // entries are run here exactly as written, with CLAUDE_PROJECT_DIR pointing at the copy.
  it('the main settings: every security PreToolUse entry blocks on a broken gate file, and equals the raw call when intact', () => {
    const settings = JSON.parse(readFileSync(join(PROJECT_ROOT, '.claude', 'settings.json'), 'utf-8'))
    const entries = (settings.hooks.PreToolUse as { matcher: string; hooks: { command: string }[] }[])
      .flatMap((e) => e.hooks.map((h) => ({ matcher: e.matcher, command: h.command })))
    const security = entries.filter((e) => /outgoing-copy-gate\.py|email-approval-gate\.py|egress-gate\.mjs/.test(e.command))
    expect(security.length).toBe(13)
    for (const e of security) {
      expect(e.command, e.matcher).toContain(GATE_FAIL_CLOSED_TAG)
      const rel = e.command.match(/scripts\/(hooks\/[a-z-]+\.(?:py|mjs))/)![1]
      const p = join(root, 'scripts', rel)
      const rawCmd = rel.endsWith('.py') ? `python3 "${p}"` : `node "${p}"`
      const input = inputs(root)[0]
      const a = run('/bin/sh', rawCmd, input, env, root)
      const b = run('/bin/sh', e.command, input, env, root)
      expect({ rc: b.rc, stdout: b.stdout }, e.matcher).toEqual({ rc: a.rc, stdout: a.stdout })
      const restore = breakFile(rel)
      try {
        expect(run('/bin/sh', e.command, input, env, root).rc, `${rel} ${e.matcher}`).toBe(2)
      } finally {
        restore()
      }
    }
    // the deliberately non-blocking helpers stay as they were
    for (const e of entries.filter((x) => /memory-frontmatter|channel-image-resize/.test(x.command))) {
      expect(e.command).not.toContain(GATE_FAIL_CLOSED_TAG)
    }
  }, 120_000)
})
