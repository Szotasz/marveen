import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Exit-code invariant for every shipped hook, by event class.
//
// Claude Code reads hook exit codes with OPPOSITE failure semantics per event:
//
//   - PreToolUse / Stop gates: exit 2 blocks, exit 0 allows -- and exit 1 is a
//     NON-BLOCKING error: the action proceeds while the gate looks like it ran.
//     A gate that crashes on malformed input therefore fails OPEN silently
//     (the outgoing-copy-gate did exactly this: a non-dict tool_input crashed
//     it with exit 1 and the send ran unchecked).
//   - UserPromptSubmit (and the replay hooks): ANY non-zero blocks the prompt.
//     A hook that crashes non-zero on malformed input makes the agent DEAF --
//     the 2026-07 stale-hook-path incident class.
//
// So the invariant is per class: gates must never exit 1; prompt-path hooks
// must exit 0 on input they cannot understand. This suite feeds every
// registered hook the two malformed shapes (unparseable stdin, non-dict
// tool_input) and pins the codes, so a refactor that swaps a guard's failure
// mode fails CI instead of shipping a silent fail-open or a deaf agent.

const ROOT = join(__dirname, '..', '..')
const SCRATCH = mkdtempSync(join(tmpdir(), 'hook-exit-inv-'))

const BAD_STDIN = 'this is not json'
const nonDict = (tool: string) => JSON.stringify({ tool_name: tool, tool_input: ['not-a-dict'] })

interface HookCase {
  script: string
  runner: 'python3' | 'node'
  /** 'gate' = PreToolUse/Stop (exit 1 forbidden); 'prompt' = block-on-nonzero events (must exit 0). */
  cls: 'gate' | 'prompt'
  /** tool_name used for the non-dict payload (gates key on it). */
  tool?: string
}

const HOOKS: HookCase[] = [
  // PreToolUse gates
  { script: 'scripts/hooks/outgoing-copy-gate.py', runner: 'python3', cls: 'gate', tool: 'mcp__x__send_email' },
  { script: 'scripts/hooks/egress-gate.mjs', runner: 'node', cls: 'gate', tool: 'WebFetch' },
  { script: 'scripts/email-send-gate.mjs', runner: 'node', cls: 'gate', tool: 'mcp__x__send_email' },
  { script: 'scripts/self-pace-gate.mjs', runner: 'node', cls: 'gate', tool: 'Bash' },
  // Stop guard
  { script: 'scripts/hooks/telegram-reply-guard.py', runner: 'python3', cls: 'gate', tool: 'Stop' },
  // Prompt-path hooks (UserPromptSubmit / SessionStart / PostToolUse wiring)
  { script: 'scripts/hooks/staleness-guard.py', runner: 'python3', cls: 'prompt', tool: 'Bash' },
  { script: 'scripts/hooks/channel-inbox-drain.py', runner: 'python3', cls: 'prompt', tool: 'Bash' },
  { script: 'scripts/hooks/inbox-drain.py', runner: 'python3', cls: 'prompt', tool: 'Bash' },
  { script: 'scripts/hooks/telegram-reply-directive.py', runner: 'python3', cls: 'prompt', tool: 'Bash' },
  { script: 'scripts/hooks/voice-reply-directive.py', runner: 'python3', cls: 'prompt', tool: 'Bash' },
  { script: 'scripts/hooks/ledger-capture.py', runner: 'python3', cls: 'prompt', tool: 'Bash' },
  { script: 'scripts/hooks/ledger-replay.py', runner: 'python3', cls: 'prompt', tool: 'Bash' },
  { script: 'scripts/hooks/taskstate-replay.py', runner: 'python3', cls: 'prompt', tool: 'Bash' },
  { script: 'scripts/hooks/ledger-outbound.py', runner: 'python3', cls: 'prompt', tool: 'Bash' },
  { script: 'scripts/hooks/tool-log-capture.py', runner: 'python3', cls: 'prompt', tool: 'Bash' },
]

// script -> payload kind -> why the violation is tolerated FOR NOW. The stale
// check below fails the build once the underlying fix lands, so an entry
// cannot outlive the bug it excuses.
const EXPECTED_VIOLATIONS: Record<string, { kind: 'non-dict' | 'bad-stdin'; reason: string }> = {}

function runHook(h: HookCase, input: string): number {
  try {
    execFileSync(h.runner, [join(ROOT, h.script)], {
      input,
      timeout: 15_000,
      stdio: ['pipe', 'ignore', 'ignore'],
      // Isolate side-effectful hooks from the checkout's real store.
      env: { ...process.env, LEDGER_DB_PATH: join(SCRATCH, 'ledger.db') },
    })
    return 0
  } catch (err) {
    const status = (err as { status?: number }).status
    return typeof status === 'number' ? status : -1
  }
}

function invariantHolds(cls: HookCase['cls'], code: number): boolean {
  return cls === 'gate' ? code !== 1 : code === 0
}

describe('hook exit-code invariant (fail-open / deaf-agent guard)', () => {
  for (const h of HOOKS) {
    const cases: Array<{ kind: 'bad-stdin' | 'non-dict'; input: string }> = [
      { kind: 'bad-stdin', input: BAD_STDIN },
      { kind: 'non-dict', input: nonDict(h.tool ?? 'Bash') },
    ]
    for (const c of cases) {
      const expected = EXPECTED_VIOLATIONS[h.script]
      const isExcused = expected?.kind === c.kind
      it(`${h.script} [${h.cls}] on ${c.kind}${isExcused ? ' (excused, fix in flight)' : ''}`, () => {
        const code = runHook(h, c.input)
        if (isExcused) {
          // Stale-excuse check: the moment the fix lands this starts holding,
          // and the entry must be deleted so the invariant becomes binding.
          expect(invariantHolds(h.cls, code),
            `expected violation no longer occurs -- delete the EXPECTED_VIOLATIONS entry for ${h.script}`,
          ).toBe(false)
          return
        }
        expect(invariantHolds(h.cls, code),
          h.cls === 'gate'
            ? `gate exited 1 (non-blocking error): the action would proceed UNCHECKED`
            : `prompt-path hook exited ${code}: any non-zero here blocks the prompt (deaf agent)`,
        ).toBe(true)
      })
    }
  }

  it('every expected violation refers to a hook in the matrix', () => {
    const known = new Set(HOOKS.map((h) => h.script))
    expect(Object.keys(EXPECTED_VIOLATIONS).filter((s) => !known.has(s))).toEqual([])
  })
})
