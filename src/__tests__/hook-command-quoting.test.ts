import { describe, it, expect, afterEach } from 'vitest'
import { mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  HOOK_NODE_BIN,
  hookCommand,
  hookCommandWired,
  injectEmailSendGate,
  injectSelfPaceGate,
  injectEgressGate,
  ensureEgressGate,
  ensureGovernanceGateCommands,
} from '../web/agent-scaffold.js'
import { PROJECT_ROOT } from '../config.js'

// Review feedback on PR #803, pinned as tests:
//  1. every injector must write a QUOTED absolute interpreter path -- an
//     unquoted execPath with a space in it is split by `sh -c`, exit 127,
//     silently non-enforcing: the exact failure the PR closes, reintroduced;
//  2. the wired-already comparison must be the JSON-escaped one everywhere,
//     otherwise a backslash (Windows) path never settles and every boot
//     rewrites settings.json;
//  3. the ensure* migrations must be idempotent: second call returns false.

const TEST_AGENT = 'hookquoting-test-agent'
const testAgentDir = join(PROJECT_ROOT, 'agents', TEST_AGENT)

afterEach(() => {
  rmSync(testAgentDir, { recursive: true, force: true })
})

function ptuCommands(settings: Record<string, unknown>): string[] {
  const hooks = settings.hooks as Record<string, unknown>
  const ptu = hooks.PreToolUse as { hooks: { command: string }[] }[]
  return ptu.flatMap((e) => e.hooks.map((h) => h.command))
}

describe('hookCommand builder', () => {
  it('quotes BOTH the interpreter and the script path', () => {
    const cmd = hookCommand('/some/dir/gate.mjs')
    expect(cmd).toContain(`"${HOOK_NODE_BIN}" "/some/dir/gate.mjs"`)
  })

  // A missing interpreter must BLOCK, not fall through with 127. process.execPath
  // is a version-pinned path on brew, so a node upgrade can dangle it; without
  // this guard the gate goes silent again on a different route.
  it('blocks with a message when the interpreter is gone, instead of exiting 127', () => {
    const cmd = hookCommand('/some/dir/gate.mjs')
    expect(cmd).toMatch(/^test -x /)
    expect(cmd).toContain('exit 2')
    // the three things the operator needs: what is missing, that this blocks,
    // and the way out
    expect(cmd).toContain(HOOK_NODE_BIN)
    expect(cmd).toContain('BLOKKOL')
    expect(cmd).toContain('inditsd ujra a dashboardot')
  })
})

// A parancs nem a quoted interpreterrel KEZDODIK, hanem tartalmazza azt: elotte all
// egy `test -x <BIN> || { echo ...; exit 2; }` or, hogy egy elmozdult interpreter
// BLOKKOLJON, ne 127-tel csendben atengedjen. Az allitas ezert includes(), es a
// vedett tulajdonsag valtozatlan: abszolut, idezojelezett interpreter, soha nem
// csupasz `node`.
describe('injectors write a quoted absolute interpreter, never a bare node', () => {
  for (const [label, inject] of [
    ['injectEmailSendGate', injectEmailSendGate],
    ['injectSelfPaceGate', injectSelfPaceGate],
    ['injectEgressGate', injectEgressGate],
  ] as const) {
    it(label, () => {
      const s: Record<string, unknown> = {}
      inject(s)
      const commands = ptuCommands(s)
      expect(commands.length).toBeGreaterThan(0)
      for (const cmd of commands) {
        expect(cmd.includes(`"${HOOK_NODE_BIN}" "`)).toBe(true)
        expect(cmd).not.toMatch(/^node /)
      }
    })
  }
})

describe('hookCommandWired', () => {
  it('finds a freshly injected command (posix path)', () => {
    const s: Record<string, unknown> = {}
    injectEgressGate(s)
    const cmd = hookCommand(join(PROJECT_ROOT, 'scripts', 'hooks', 'egress-gate.mjs'))
    const ptuJson = JSON.stringify((s.hooks as Record<string, unknown>).PreToolUse)
    expect(hookCommandWired(ptuJson, cmd)).toBe(true)
  })

  it('settles on a backslash (Windows-style) path where the raw compare does not', () => {
    // Reproduces review point 1: the raw includes() disagrees with the
    // serialized form exactly where the escaped form matches.
    const cmd = '"C:\\Program Files\\nodejs\\node.exe" "C:\\marveen\\scripts\\hooks\\egress-gate.mjs"'
    const ptuJson = JSON.stringify([{ matcher: 'WebFetch', hooks: [{ type: 'command', command: cmd, timeout: 10 }] }])
    expect(hookCommandWired(ptuJson, cmd)).toBe(true)   // escaped compare: settles
    expect(ptuJson.includes(cmd)).toBe(false)           // raw compare: never settles
  })
})

describe('ensure* migrations are idempotent (true, then false)', () => {
  it('ensureEgressGate', () => {
    mkdirSync(join(testAgentDir, '.claude'), { recursive: true })
    expect(ensureEgressGate(TEST_AGENT)).toBe(true)
    expect(ensureEgressGate(TEST_AGENT)).toBe(false)
    const written = JSON.parse(readFileSync(join(testAgentDir, '.claude', 'settings.json'), 'utf-8'))
    for (const cmd of ptuCommands(written)) {
      expect(cmd.includes(`"${HOOK_NODE_BIN}" "`)).toBe(true)
    }
  })

  it('ensureGovernanceGateCommands upgrades a legacy bare-node entry, then settles', () => {
    mkdirSync(join(testAgentDir, '.claude'), { recursive: true })
    const legacy = {
      hooks: {
        PreToolUse: [
          { matcher: 'Bash|send_email', hooks: [{ type: 'command', command: `node ${join(PROJECT_ROOT, 'scripts', 'email-send-gate.mjs')}`, timeout: 10 }] },
          { matcher: 'Bash', hooks: [{ type: 'command', command: `node ${join(PROJECT_ROOT, 'scripts', 'self-pace-gate.mjs')}`, timeout: 10 }] },
        ],
      },
    }
    const settingsPath = join(testAgentDir, '.claude', 'settings.json')
    writeFileSync(settingsPath, JSON.stringify(legacy, null, 2))

    expect(ensureGovernanceGateCommands(TEST_AGENT)).toBe(true)
    expect(ensureGovernanceGateCommands(TEST_AGENT)).toBe(false)

    expect(existsSync(settingsPath)).toBe(true)
    const written = JSON.parse(readFileSync(settingsPath, 'utf-8'))
    const commands = ptuCommands(written)
    expect(commands.some((c) => c.includes('email-send-gate.mjs'))).toBe(true)
    expect(commands.some((c) => c.includes('self-pace-gate.mjs'))).toBe(true)
    for (const cmd of commands) {
      expect(cmd.includes(`"${HOOK_NODE_BIN}" "`)).toBe(true)
      expect(cmd).not.toMatch(/^node /)
    }
  })
})
