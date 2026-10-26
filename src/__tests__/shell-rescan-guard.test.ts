// shell-rescan-guard.py: a PreToolUse gate that refuses a Bash command whose own
// text the shell will re-scan (a backtick in double quotes, $( ) in an inline
// interpreter payload, an unquoted heredoc with ` or $( ), eval, ${v@P}).
//
// Every case runs the real hook as a process, the way the harness does, with its
// log and state redirected into a temp directory.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

const GUARD = join(process.cwd(), 'scripts', 'hooks', 'shell-rescan-guard.py')
const BT = String.fromCharCode(96) // a backtick, kept out of this file's own literals

let dir = ''
let env: NodeJS.ProcessEnv = {}
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rescan-guard-'))
  env = { ...process.env, SHELL_RESCAN_GUARD_LOG: join(dir, 'guard.log'), SHELL_RESCAN_GUARD_STATE_DIR: join(dir, 'state') }
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

function run(payload: unknown): { code: number | null; out: string } {
  const r = spawnSync('python3', [GUARD], { input: typeof payload === 'string' ? payload : JSON.stringify(payload), env, encoding: 'utf-8', timeout: 20_000 })
  return { code: r.status, out: r.stdout }
}
const bash = (command: string, session = 's1') => run({ tool_name: 'Bash', tool_input: { command }, session_id: session })
const denied = (r: { code: number | null; out: string }) => r.code === 0 && r.out.includes('"permissionDecision": "deny"')
const allowed = (r: { code: number | null; out: string }) => r.code === 0 && r.out.trim() === ''
const logLines = () => existsSync(join(dir, 'guard.log'))
  ? readFileSync(join(dir, 'guard.log'), 'utf-8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>)
  : []

describe('the five refused shapes, each with the safe form next to it', () => {
  it('E: a backtick inside double quotes is refused; inside single quotes it is data', () => {
    expect(denied(bash(`echo "see ${BT}id${BT} here"`))).toBe(true)
    expect(allowed(bash(`echo 'see ${BT}id${BT} here'`))).toBe(true)
  })

  it('A: $( ) inside an inline interpreter payload is refused; on its own it is an everyday idiom', () => {
    expect(denied(bash('python3 -c "print(\'$(id)\')"'))).toBe(true)
    expect(allowed(bash('curl -H "X: $(cat token-file)" http://localhost/x'))).toBe(true)
  })

  it('B: an unquoted heredoc whose body has a backtick or $( ) is refused; a quoted heredoc is inert', () => {
    expect(denied(bash(`cat > f.txt <<EOF\nnote ${BT}date${BT}\nEOF`))).toBe(true)
    expect(allowed(bash(`cat > f.txt <<'EOF'\nnote ${BT}date${BT}\nEOF`))).toBe(true)
    expect(denied(bash('cat > f.txt <<EOF\nwho $(id)\nEOF'))).toBe(true)
    expect(allowed(bash("cat > f.txt <<'EOF'\nwho $(id)\nEOF"))).toBe(true)
    // a $( ) inside $(( )) in the body still runs; plain arithmetic is fine
    expect(denied(bash('cat > f.txt <<EOF\nn=$(( $(id -u) + 1 ))\nEOF'))).toBe(true)
    expect(allowed(bash('cat > f.txt <<EOF\nn=$(( 2 + 1 ))\nEOF'))).toBe(true)
  })

  it('B: two heredocs on one line: each body follows its own header, and the line after both bodies is scanned', () => {
    expect(denied(bash(`cat <<FIRST <<SECOND\nsafe\nFIRST\ndanger ${BT}id${BT}\nSECOND`))).toBe(true)
    expect(allowed(bash(`cat <<'FIRST' <<'SECOND'\n${BT}id${BT}\nFIRST\n$(id)\nSECOND`))).toBe(true)
    expect(denied(bash(`cat <<'FIRST' <<'SECOND'\nx\nFIRST\ny\nSECOND\neval "$x"`))).toBe(true)
    // a document is read once: two lines after it, the second is still a command
    expect(denied(bash(`cat <<'EOF'\nx\nEOF\necho ok\neval "$x"`))).toBe(true)
  })

  it('A: interpreter options that take an operand do not hide the payload after them', () => {
    expect(denied(bash('python3 -W ignore -c "print(\'$(id)\')"'))).toBe(true)
    expect(denied(bash('python3 -X dev -c "print(\'$(id)\')"'))).toBe(true)
    expect(denied(bash('node --require ./x.js -e "console.log(\'$(id)\')"'))).toBe(true)
    expect(denied(bash('bash -o pipefail -c "echo $(id)"'))).toBe(true)
    expect(denied(bash('python3 --check-hash-based-pycs always -c "print(\'$(id)\')"'))).toBe(true)
  })

  it('A: the interpreter stays armed to the end of the command; only -- ends its options', () => {
    // no table of which options take an operand: after -m too, an inline flag still counts
    expect(denied(bash('python3 -m http.server -c "$(id)"'))).toBe(true)
    // control: an option that is not an inline flag arms nothing
    expect(allowed(bash('python3 tool.py -rf "$(id)"'))).toBe(true)
    // control: after --, -c is the script's own argument
    expect(allowed(bash('python3 -- script.py -c "$(id)"'))).toBe(true)
    // but a -- right after the inline flag is not the payload: bash runs the next word
    expect(denied(bash('bash -c -- "echo $(id)"'))).toBe(true)
  })

  it('A: a shell reads options after -c, so the payload is its first non-option word (RESCANMINOR1026)', () => {
    expect(denied(bash('bash -c -x "echo $(id)"'))).toBe(true)
    expect(denied(bash('bash -c -o pipefail "echo $(id)"'))).toBe(true)
    expect(denied(bash('sh -c -x "echo $(id)"'))).toBe(true)
    expect(denied(bash('sh -c -o errexit "echo $(id)"'))).toBe(true)
    expect(denied(bash('bash -c +x "echo $(id)"'))).toBe(true)
    expect(denied(bash('bash -c -xo pipefail "echo $(id)"'))).toBe(true)
    expect(denied(bash('bash -c -ox pipefail "echo $(id)"'))).toBe(true)
    expect(denied(bash('bash -c -x -- "echo $(id)"'))).toBe(true)
    expect(denied(bash('bash -c - "echo $(id)"'))).toBe(true)
    expect(denied(bash('bash -lc -e "echo $(id)"'))).toBe(true)
    // after the payload, -x is an argument of the script, not an option before it
    expect(allowed(bash("bash -c 'echo hi' -x \"$(id)\""))).toBe(true)
    // -e on a shell is not -c: the slot closes on the next word, so -x fills it
    expect(allowed(bash('bash -e -x "$(id)/run.sh"'))).toBe(true)
    // same, and -o after the payload takes no operand
    expect(allowed(bash("bash -c 'echo hi' -o \"$(id)\""))).toBe(true)
  })

  it('A: the word after -- fills the slot and ends the options; the gaps around -- are pinned (RESCANMINOR1026)', () => {
    // M1: after -- nothing is an option any more, so the later -c/-e arms nothing
    expect(allowed(bash('python3 -E -- script.py -c "$(id)"'))).toBe(true)
    expect(allowed(bash('bash -e -- script.sh -c "$(id)"'))).toBe(true)
    expect(allowed(bash('perl -p -- f.pl -e "$(id)"'))).toBe(true)
    expect(denied(bash('bash -c -- "echo ' + BT + 'id' + BT + '"'))).toBe(true)
    expect(denied(bash('sh -c -- "echo $(id)"'))).toBe(true)
    // python3 and perl take -- itself as the code, so "$(id)" is only sys.argv[1];
    // refusing it is a deliberate over-check, pinned here so that a change to it
    // is a decision, not an accident
    expect(denied(bash('python3 -c -- "$(id)"'))).toBe(true)
    // the payload after -- is still checked
    expect(denied(bash('bash -c -- "$(id)" -c "$(id)"'))).toBe(true)
    // after the payload that followed --, a later -c arms nothing
    expect(allowed(bash('bash -c -- "echo hi" -c "$(id)"'))).toBe(true)
  })

  it('A: php -B and -R run code, so they are inline flags -- for php only (RESCANMINOR1026)', () => {
    expect(denied(bash('php -R "echo \'$(id)\';"'))).toBe(true)
    expect(denied(bash('php -B "echo \'$(id)\';"'))).toBe(true)
    // glued to its payload
    expect(denied(bash('php -R"echo \'$(id)\';"'))).toBe(true)
    // controls: the same letters on python3 are ordinary options
    expect(allowed(bash('python3 -B "$(id)/x.py"'))).toBe(true)
    expect(allowed(bash('python3 -R "$(id)/x.py"'))).toBe(true)
  })

  it('more payload shapes: clustered and glued flags, env, and a nested quote inside $( )', () => {
    expect(denied(bash('bash -lc "echo $(id)"'))).toBe(true)
    expect(denied(bash('env python3 -c "print(\'$(id)\')"'))).toBe(true)
    expect(denied(bash('python3 -c"print(\'$(id)\')"'))).toBe(true)
    expect(denied(bash('python3 -c "x = $(echo "$HOME")"'))).toBe(true)
    expect(denied(bash('\\eval "$CMD"'))).toBe(true)
    expect(denied(bash('node "--eval=console.log(\'$(id)\')"'))).toBe(true)
    expect(denied(bash('php -r "echo \'$(id)\';"'))).toBe(true)
    expect(denied(bash('node -p "\'$(id)\'"'))).toBe(true)
    expect(denied(bash('node --print "\'$(id)\'"'))).toBe(true)
  })

  it('left alone on purpose: a here-string, `command -v eval`, and a single-quoted shell payload (the stated blind spot)', () => {
    expect(allowed(bash('cat <<< "$(id)"'))).toBe(true)
    expect(allowed(bash('command -v eval'))).toBe(true)
    expect(allowed(bash("bash -c 'echo $(id)'"))).toBe(true)
  })

  it("$'...' (ANSI-C quoting) with an escaped quote does not hide the rest of the command", () => {
    expect(denied(bash("echo $'it\\'s' ; eval \"$x\""))).toBe(true)
  })

  it('C: eval in command position is refused; the word eval as an argument is not', () => {
    expect(denied(bash('eval "$CMD"'))).toBe(true)
    expect(denied(bash('coproc eval "$CMD"'))).toBe(true)
    expect(allowed(bash('grep -n eval notes.txt'))).toBe(true)
  })

  it('D: ${v@P} is refused; a plain ${v} is not', () => {
    expect(denied(bash('echo "${PROMPT@P}"'))).toBe(true)
    expect(allowed(bash('echo "${PROMPT}"'))).toBe(true)
  })

  it('a backtick inside $(( )) in double quotes still runs and is refused; an escaped backtick is literal text', () => {
    expect(denied(bash(`echo "$(( ${BT}id -u${BT} + 1 ))"`))).toBe(true)
    expect(allowed(bash(`echo "literal \\${BT}id\\${BT} text"`))).toBe(true)
  })

  it('a $(( )) nested past the depth limit does not hide a backtick after it', () => {
    expect(denied(bash(`echo "${'$(( '.repeat(3000)}1${' ))'.repeat(3000)} ${BT}id${BT}"`))).toBe(true)
  })

  it('the denial names the rule and the remedy, and the decision is logged', () => {
    const r = bash(`echo "x ${BT}id${BT}"`)
    expect(r.out).toContain('E_BACKTICK_IN_DQ')
    expect(r.out).toContain("<<'VEGE'")
    expect(logLines().at(-1)).toMatchObject({ decision: 'deny', rules: ['E_BACKTICK_IN_DQ'] })
  })
})

describe('escape and backstop', () => {
  it('a "# rescan-ok: <why>" COMMENT lets it through and logs the reason; the same text inside quoted data does not', () => {
    expect(allowed(bash(`echo "x ${BT}id${BT}" # rescan-ok: deliberate`))).toBe(true)
    expect(logLines().at(-1)).toMatchObject({ decision: 'allow-escape', reason: 'deliberate' })
    expect(denied(bash(`echo "x ${BT}id${BT} # rescan-ok: smuggled"`))).toBe(true)
  })

  it('the escape comment after a heredoc header counts; the same heredoc without it is refused', () => {
    expect(allowed(bash('cat > f.txt <<EOF # rescan-ok: deliberate\nnote $(date)\nEOF'))).toBe(true)
    expect(logLines().at(-1)).toMatchObject({ decision: 'allow-escape', reason: 'deliberate' })
    expect(denied(bash('cat > f.txt <<EOF\nnote $(date)\nEOF'))).toBe(true)
  })

  it('the same command is refused three times, let through once, then refused again (the key is forgotten)', () => {
    const cmd = `echo "loop ${BT}id${BT}"`
    expect([1, 2, 3].map(() => denied(bash(cmd)))).toEqual([true, true, true])
    expect(allowed(bash(cmd))).toBe(true)
    expect(logLines().at(-1)).toMatchObject({ decision: 'backstop-allow' })
    expect(denied(bash(cmd))).toBe(true)
  })

  it('an actively retried command keeps its count when the state is full of other keys', () => {
    const cmd = `echo "kept ${BT}id${BT}"`
    const key = createHash('sha256').update(cmd).digest('hex')
    const state = join(dir, 'state')
    spawnSync('mkdir', ['-p', state])
    // the retried command first (count 2), then 250 other keys after it
    const rows = [`${key} 2`, ...Array.from({ length: 250 }, (_, i) => `${createHash('sha256').update(String(i)).digest('hex')} 1`)]
    writeFileSync(join(state, 'rt'), rows.join('\n') + '\n')
    expect(denied(bash(cmd, 'rt'))).toBe(true)   // third refusal, the count moves to the end
    expect(allowed(bash(cmd, 'rt'))).toBe(true)  // and so it is still there: released
  })

  it('a lone surrogate in the command (valid JSON, not valid UTF-8) is still refused, not a crash', () => {
    const raw = '{"tool_name":"Bash","tool_input":{"command":"echo \\"x ' + BT + 'id' + BT + ' \\ud800\\""},"session_id":"sur"}'
    expect(denied(run(raw))).toBe(true)
  })

  it('the backstop counts per session: another session starts from zero', () => {
    const cmd = `echo "per ${BT}id${BT}"`
    for (let i = 0; i < 3; i++) bash(cmd, 'a')
    expect(allowed(bash(cmd, 'a'))).toBe(true)
    expect(denied(bash(cmd, 'b'))).toBe(true)
  })

  it('without writable state it stops enforcing rather than refuse forever (no backstop, no enforcement)', () => {
    writeFileSync(join(dir, 'state'), 'a file where the state directory should be')
    expect(allowed(bash(`echo "x ${BT}id${BT}"`))).toBe(true)
    expect(logLines().at(-1)).toMatchObject({ decision: 'state-unavailable-allow' })
  })
})

describe('fail-open on anything it does not understand (exit 0, never a traceback)', () => {
  for (const [name, payload] of [
    ['not JSON', 'not json'],
    ['a JSON number', 42],
    ['tool_input as a string', { tool_name: 'Bash', tool_input: 'x', session_id: 's' }],
    ['a numeric session id', { tool_name: 'Bash', tool_input: { command: 'echo hi' }, session_id: 42 }],
    ['another tool', { tool_name: 'Write', tool_input: { command: `echo "${BT}id${BT}"` }, session_id: 's' }],
    ['an empty command', { tool_name: 'Bash', tool_input: { command: '' }, session_id: 's' }],
  ] as Array<[string, unknown]>) {
    it(name, () => { expect(allowed(run(payload))).toBe(true) })
  }

  it('a numeric session id is still enforced (hashed, not dropped)', () => {
    expect(denied(run({ tool_name: 'Bash', tool_input: { command: `echo "${BT}id${BT}"` }, session_id: 42 }))).toBe(true)
  })
})

describe('the block survives a failed denial write', () => {
  // The decision must not depend on the success of saying it. With stdout closed
  // the JSON denial cannot be written; exit 0 would then mean ALLOW. The hook falls
  // back to exit 2 (the other blocking protocol). os._exit, because a sys.exit(2)
  // is overridden to 120 by the interpreter's own failing stdout flush.
  function runWithBrokenStdout(command: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const p = spawn('python3', [GUARD], { stdio: ['pipe', 'pipe', 'pipe'], env })
      p.stdout.destroy()
      let settled = false
      const t = setTimeout(() => { if (!settled) { settled = true; p.kill('SIGKILL'); reject(new Error('timeout')) } }, 30_000)
      p.on('close', (code) => { if (!settled) { settled = true; clearTimeout(t); resolve(code ?? -1) } })
      p.on('error', (e) => { if (!settled) { settled = true; clearTimeout(t); reject(e) } })
      p.stdin.on('error', () => {})
      p.stdin.end(JSON.stringify({ tool_name: 'Bash', tool_input: { command }, session_id: 'emit' }))
    })
  }

  it('exits 2 (block) when it cannot write the denial', async () => {
    expect(await runWithBrokenStdout(`echo "emit ${BT}id${BT}"`)).toBe(2)
  }, 40_000)

  it('still exits 0 for a clean command, so the fallback cannot block by accident', async () => {
    expect(await runWithBrokenStdout('echo clean')).toBe(0)
  }, 40_000)
})

it('writes its log and state where the environment says, not into the checkout', () => {
  bash(`echo "x ${BT}id${BT}"`)
  expect(existsSync(join(dir, 'guard.log'))).toBe(true)
  expect(existsSync(join(dir, 'state'))).toBe(true)
})
