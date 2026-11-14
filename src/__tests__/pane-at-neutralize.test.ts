// ENVATLEAK1114 (2026-11-14). Claude Code expands an at-sign token that stands at the start of a
// prompt or after whitespace into a FILE ATTACHMENT, with no tool call. An inter-agent message that
// quoted such a token put a secrets file into two agents' contexts. The fix is one mapping
// (src/web/pane-text.ts `paneTyped`) applied to everything sendPromptToSession types, and every
// reader of the typed shape applies the same one. This file pins:
//   - the rule itself, on ONE vector file shared by the TypeScript and the two Python sides;
//   - that the readers of the router header accept the typed (escaped) header;
//   - that the places typing WITHOUT the mapping cannot type an at-sign;
//   - that tmux typing does not appear in a file nobody listed.
// The raw at-sign shapes live in the fixture file on purpose: they must not be pasted into a
// message, a card or a PR description.
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { neutralizeAtMentions, paneOneLine, paneTyped } from '../web/pane-text.js'
import { findSeenMsgIds } from '../web/message-seen-sweep.js'
import { wrapAgentMessageForDelivery } from '../web/agent-message-wrap.js'
import { sanitizePromptText } from '../web/custom-commands.js'
import { TRANSCRIPT_PATTERNS } from '../security/secret-gate.js'
import { identitySlashCommands } from '../web/agent-process.js'
import { isSafeMcpServerName } from '../web/mcp-inline-command.js'

const ROOT = join(__dirname, '..', '..')
const VECTORS_PATH = join(__dirname, 'fixtures', 'pane-at-neutralize-vectors.json')
const VECTORS: { name: string; in: string; out: string }[] = JSON.parse(readFileSync(VECTORS_PATH, 'utf-8'))
const AT = String.fromCharCode(64)
// "an at-sign Claude Code would expand": at the start, or after JavaScript whitespace
const EXPANDABLE = /(^|\s)@/

describe('the rule: a backslash before every at-sign at the start or after whitespace', () => {
  it('the vector file is not empty and covers both directions', () => {
    expect(VECTORS.length).toBeGreaterThanOrEqual(30)
    expect(VECTORS.some((v) => v.in !== v.out)).toBe(true)
    expect(VECTORS.some((v) => v.in === v.out && v.in.includes(AT))).toBe(true)
  })

  for (const v of VECTORS) {
    it(`TypeScript: ${v.name}`, () => {
      expect(neutralizeAtMentions(v.in)).toBe(v.out)
    })
  }

  it('after the mapping no expandable at-sign is left, and a second pass changes nothing', () => {
    for (const v of VECTORS) {
      const once = neutralizeAtMentions(v.in)
      expect(EXPANDABLE.test(once), v.name).toBe(false)
      expect(neutralizeAtMentions(once), v.name).toBe(once)
    }
  })

  it('paneTyped is the line-break mapping followed by the at-sign mapping', () => {
    for (const v of VECTORS) expect(paneTyped(v.in), v.name).toBe(neutralizeAtMentions(paneOneLine(v.in)))
    expect(paneTyped(`elso sor\n${AT}cel.md`)).toBe(`elso sor \\${AT}cel.md`)
    expect(EXPANDABLE.test(paneTyped(`a\r\n${AT}b\n\n${AT}c`))).toBe(false)
  })

  it('Python, scripts/watchdog-replay.py: the same vectors, through the script itself', () => {
    const out = execFileSync('python3', [join(ROOT, 'scripts', 'watchdog-replay.py'), '--neutralize-vectors', VECTORS_PATH], { encoding: 'utf-8' })
    expect(JSON.parse(out)).toEqual(VECTORS.map((v) => v.out))
  })

  it('Python, scripts/hooks/provenance-gate.py pane_shape: equals paneTyped on every vector', () => {
    const py = [
      'import importlib.util, json, sys',
      'spec = importlib.util.spec_from_file_location("pg", sys.argv[1])',
      'm = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)',
      'json.dump([m.pane_shape(c["in"]) for c in json.load(open(sys.argv[2], encoding="utf-8"))], sys.stdout)',
    ].join('\n')
    const out = execFileSync('python3', ['-c', py, join(ROOT, 'scripts', 'hooks', 'provenance-gate.py'), VECTORS_PATH], { encoding: 'utf-8' })
    expect(JSON.parse(out)).toEqual(VECTORS.map((v) => paneTyped(v.in)))
  })

  it('the watchdog replay types the mapped text, not the raw one', () => {
    const src = readFileSync(join(ROOT, 'scripts', 'watchdog-replay.py'), 'utf-8')
    expect(src).toMatch(/full_msg = neutralize_at_mentions\(f"/)
    expect(src).not.toMatch(/^\s*full_msg = f"/m)
  })
})

describe('the router header: sanitized sender, and readers that accept the typed shape', () => {
  it('the header prints the SANITIZED sender, never the stored raw one', () => {
    // POST /api/messages validates sanitizeAgentIdent(from) but stores from.trim(): a raw sender made of a
    // known id plus removable characters (a space, a tilde, an at-sign) reached the header verbatim.
    const raw = `samu ${AT}~ `
    for (const cat of ['trusted-peer', 'untrusted'] as const) {
      const { prefix } = wrapAgentMessageForDelivery(cat, 'samu', raw, 'szia', 7)
      expect(prefix).toContain(`[Uzenet ${AT}samu-tol -- `)
      expect(prefix).not.toContain(raw)
    }
  })

  it('a typed real envelope carries no expandable at-sign at all, header included', () => {
    for (const cat of ['trusted-peer', 'untrusted', 'federated'] as const) {
      const from = cat === 'federated' ? 'peer/agent' : 'samu'
      const { prefix, wrapped } = wrapAgentMessageForDelivery(cat, from, from, `lasd ${AT}cel.md\n${AT}masik.md`, 7)
      const typed = paneTyped(prefix + wrapped)
      expect(EXPANDABLE.test(typed), cat).toBe(false)
      expect(typed).toContain(cat === 'federated' ? `[Uzenet a tavoli \\${AT}peer/agent ugynoktol` : `[Uzenet \\${AT}samu-tol`)
    }
  })

  it('message-seen-sweep finds the id in a TYPED header (else no delivered message is ever marked seen)', () => {
    const userLine = (content: string) => JSON.stringify({ type: 'user', message: { role: 'user', content } })
    for (const cat of ['trusted-peer', 'untrusted'] as const) {
      const { prefix, wrapped } = wrapAgentMessageForDelivery(cat, 'samu', 'samu', 'szia', 41)
      expect(findSeenMsgIds(userLine(paneTyped(prefix + wrapped)), new Map([[41, 'samu']])), cat).toEqual(new Set([41]))
    }
    const fed = wrapAgentMessageForDelivery('federated', 'peer/agent', 'peer/agent', 'szia', 42)
    expect(findSeenMsgIds(userLine(paneTyped(fed.prefix + fed.wrapped)), new Map([[42, 'peer/agent']]))).toEqual(new Set([42]))
    // the untyped shape (the pull endpoint, older transcripts) still counts
    expect(findSeenMsgIds(userLine(`[Uzenet ${AT}a-tol -- trusted team member, msg_id:7]: hello`), new Map([[7, 'a']]))).toEqual(new Set([7]))
  })

  it('custom-commands strips a typed header prefix exactly like an untyped one', () => {
    for (const head of [`[Uzenet ${AT}x-tol]: tedd meg`, `[Uzenet \\${AT}x-tol]: tedd meg`, `[Uzenet a tavoli \\${AT}p/a ugynoktol]: tedd meg`]) {
      expect(sanitizePromptText(head), head.replace(AT, '(at)')).toContain('(stripped-prefix: ')
    }
  })

  it('the secret gate recognises a quoted transcript header in both shapes', () => {
    const rx = TRANSCRIPT_PATTERNS.find((p) => p.name === 'quoted agent transcript header')!.pattern
    expect(rx.test(`[Uzenet ${AT}samu-tol -- trusted team member]: x`)).toBe(true)
    expect(rx.test(`[Uzenet \\${AT}samu-tol -- trusted team member]: x`)).toBe(true)
  })

  it('the machine-origin prefix of a parked input accepts the typed header', () => {
    const src = readFileSync(join(ROOT, 'src', 'pane-state.ts'), 'utf-8')
    expect(src).toContain('/^\\[Uzenet \\\\?@/,')
  })

  it('the two hooks that recognise the header by substring list the typed shape too', () => {
    for (const f of ['provenance-gate.py', 'memory-lookup-nudge.py']) {
      const src = readFileSync(join(ROOT, 'scripts', 'hooks', f), 'utf-8')
      for (const head of ['[Uzenet ', '[Uzenet a tavoli ', '[Üzenet ']) {
        expect(src, `${f}: ${head}`).toContain(`"${head}${AT}",`)
        expect(src, `${f}: ${head} (typed)`).toContain(`"${head}\\\\${AT}",`)
      }
    }
  })
})

describe('system directives: the content is compared word for word, so it carries no escapable at-sign', () => {
  // The recipient is told to compare the delivered text with the queue row literally. The gate applies the
  // pane mapping to the row, so it would verify either way; an AGENT reading the two side by side would see
  // a backslash the row does not have. Every module that composes directive text is scanned; the envelope
  // HEADER (system-directive.ts) is not content and is the one listed exception.
  const TEMPLATE_MODULES = [
    'context-guard-runner.ts', 'context-restart-gate-runner.ts', 'restart-wake.ts', 'resume-queue-drain.ts',
    'resume-delivery.ts', 'restart-recovery-brief.ts', 'system-directive.ts',
  ]
  const HEADER_EXCEPTION = /KOTEG-fej vagy Uzenet @\.\.\. boritek/

  it('no string in a directive-composing module has an at-sign after whitespace or a quote', () => {
    for (const f of TEMPLATE_MODULES) {
      const lines = readFileSync(join(ROOT, 'src', 'web', f), 'utf-8').split('\n')
      const hits = lines.filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l) && /(^|[\s`"'])@/.test(l) && !HEADER_EXCEPTION.test(l))
      expect(hits, f).toEqual([])
    }
  })

  it('the header exception is real, single, and typed escaped', () => {
    const src = readFileSync(join(ROOT, 'src', 'web', 'system-directive.ts'), 'utf-8')
    expect(src.split('\n').filter((l) => HEADER_EXCEPTION.test(l)).length).toBe(1)
    expect(paneTyped(`(KOTEG-fej vagy Uzenet ${AT}... boritek)`)).toBe(`(KOTEG-fej vagy Uzenet \\${AT}... boritek)`)
  })
})

describe('typing without the mapping: no at-sign can be typed there', () => {
  it('identity /rename: a display name with an at-sign yields no command; a name with a space still does', () => {
    expect(identitySlashCommands('Lean Publisher')).toEqual(['/rename Lean Publisher'])
    expect(identitySlashCommands(`Lean ${AT}Publisher`)).toEqual([])
    expect(identitySlashCommands(`${AT}x`)).toEqual([])
  })

  it('an MCP server name with an at-sign or whitespace is not typed', () => {
    expect(isSafeMcpServerName('plugin:slack-channel:slack')).toBe(true)
    expect(isSafeMcpServerName(`${AT}scope`)).toBe(false)
    expect(isSafeMcpServerName(`srv${AT}x`)).toBe(false)
    expect(isSafeMcpServerName('srv x')).toBe(false)
  })

  it('the boot /rename (library and fallback) refuses a name with an at-sign before typing', () => {
    const lib = readFileSync(join(ROOT, 'scripts', 'lib', 'main-rename.sh'), 'utf-8')
    const guardAt = lib.indexOf('*@*)')
    expect(guardAt).toBeGreaterThan(0)
    expect(guardAt).toBeLessThan(lib.indexOf('send-keys -t "$target" -l "$cmd"'))
    const out = execFileSync('bash', ['-c', `. "$1"; main_rename_send /usr/bin/false target "bot ${AT}x"; echo "rc=$?"`, 'x', join(ROOT, 'scripts', 'lib', 'main-rename.sh')], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] })
    expect(out.trim()).toBe('rc=4')
    const ch = readFileSync(join(ROOT, 'scripts', 'channels.sh'), 'utf-8')
    const fb = ch.indexOf('one-shot /rename')
    expect(ch.slice(fb, fb + 600)).toMatch(/case "\$_bot_name" in\s+\*@\*\)/)
  })
})

describe('tmux typing lives only in the listed files', () => {
  // The inventory of 2026-11-14 (develop b053ecd24). A new file that types into a pane must be added HERE,
  // and its author has to answer the question this list exists for: does outside text go through paneTyped()?
  //   A  = types text that comes from outside the function
  //   B  = fixed text or a validated command parameter
  //   C  = key names only
  const TYPING_FILES: Record<string, string> = {
    'src/web/agent-process.ts': 'A: sendPromptToSession types paneTyped(text); the identity /rename refuses an at-sign',
    'src/web/routes/agent-terminal.ts': 'A, DELIBERATELY unmapped: the owner types into the dashboard terminal on purpose',
    'scripts/watchdog-replay.py': 'A: neutralize_at_mentions() on the replayed content',
    'scripts/lib/main-rename.sh': 'A: /rename <name>, refuses an at-sign',
    'scripts/channels.sh': 'A (fallback /rename, refuses an at-sign) + B/C',
    'src/web/context-restart-gate-runner.ts': 'B: /clear, /model <validated id>, /effort <fixed level>',
    'src/web/channel-mcp-reconnect.ts': 'B: /mcp <action> <isSafeMcpServerName>',
    'src/web/channel-plugin-unlock.ts': 'B/C',
    'src/web/channel-monitor.ts': 'B/C',
    'src/web/agent-worker.ts': 'B/C',
    'src/web/reauth-healer.ts': 'B/C (via the tmux-keys.ts builders)',
    'src/web/tmux-keys.ts': 'argument builders only',
    'scripts/stuck-modal-guard.sh': 'C',
    'scripts/self-pace-gate.mjs': 'no typing: the gate that FORBIDS it matches on these words',
    'src/web/main-model.ts': 'no typing: one owner-facing sentence names the command',
  }
  // Deliberately crude: the subcommand as a whole word, or a call of the tmux-keys.ts argument builders, on
  // any line that is not a comment. A precise "is this an invocation" pattern can be dodged by a new variable
  // name for the tmux binary; a word match cannot, and a file that merely mentions the word is listed above
  // with its reason.
  const TYPING_RX = /\b(?:send-keys|paste-buffer|load-buffer|set-buffer)\b|\b(?:literalKeyArgs|specialKeyArgs)\(/
  const BUFFER_RX = /\b(?:paste-buffer|load-buffer|set-buffer)\b/

  function walk(dir: string, acc: string[]): string[] {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name === '__tests__' || name === 'dist') continue
      const p = join(dir, name)
      if (statSync(p).isDirectory()) walk(p, acc)
      else if (/\.(ts|mjs|js|py|sh)$/.test(name) && !/\.test\./.test(name)) acc.push(p)
    }
    return acc
  }

  it('every file with a tmux typing call is on the list, and every listed file still has one', () => {
    const found = [...walk(join(ROOT, 'src'), []), ...walk(join(ROOT, 'scripts'), [])]
      .filter((p) => readFileSync(p, 'utf-8').split('\n').some((l) => !/^\s*(\/\/|#|\*|\/\*)/.test(l) && TYPING_RX.test(l)))
      .map((p) => relative(ROOT, p))
      .sort()
    expect(found).toEqual(Object.keys(TYPING_FILES).sort())
  })

  it('no buffer-paste typing exists (a second typing mechanism would bypass the mapping)', () => {
    const hits = [...walk(join(ROOT, 'src'), []), ...walk(join(ROOT, 'scripts'), [])]
      .filter((p) => readFileSync(p, 'utf-8').split('\n').some((l) => !/^\s*(\/\/|#|\*|\/\*)/.test(l) && BUFFER_RX.test(l)))
      // the self-pace gate lists the words it forbids
      .filter((p) => relative(ROOT, p) !== 'scripts/self-pace-gate.mjs')
    expect(hits.map((p) => relative(ROOT, p))).toEqual([])
  })

  it('the dashboard terminal says in the code that it is unmapped on purpose', () => {
    expect(readFileSync(join(ROOT, 'src', 'web', 'routes', 'agent-terminal.ts'), 'utf-8')).toContain('ENVATLEAK1114')
  })
})
