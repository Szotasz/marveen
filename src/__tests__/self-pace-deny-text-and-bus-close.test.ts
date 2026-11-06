/**
 * What the deny text says, and which bus messages the gate lets through:
 *
 * (1) The deny text names the operation that was blocked. It used to be one static text that said "se /api/schedules
 *     iras ..." for EVERY denial, which misled on a DELETE (the flag opens the create POST) and on a tmux send-keys.
 * (2) A bus message that only MENTIONS the schedule API in its text is not a schedule write. The fleet's own closing
 *     recipe builds the JSON body with a fixed python snippet inside `--data-binary "$(python3 -c '...' '<text>')"`
 *     and feeds curl its Authorization header through `printf ... | curl -K -`. Measured in a throwaway container: the plain
 *     `--data-binary '{...}'`, `-d "{...}"` and heredoc forms pass, but the recipe form is denied (with and without
 *     the flag) as soon as the result text names the endpoint: the quoted substitution is not a plain word, and a
 *     `-K` config makes the whole segment count. Both are narrowed to exactly the recipe, and nothing else.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  gateDecision,
  gateMessage,
  resolveJsonDumpSubst,
  // @ts-expect-error: plain .mjs hook script, no types
} from '../../scripts/self-pace-gate.mjs'
import { PROJECT_ROOT } from '../config.js'

const GATE = join(PROJECT_ROOT, 'scripts', 'self-pace-gate.mjs')
const FLAG = '--allow-schedule-write'
const S = 'http://localhost:3420/api/schedules'
const M = 'http://localhost:3420/api/messages/123'
const TXT = 'ATVEVE: a POST /api/schedules kell nekem, nem a PUT'

let root: string
let tok: string
let OPTS: Record<string, unknown>
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'busclose-'))
  mkdirSync(join(root, 'store'), { recursive: true })
  tok = join(root, 'store', '.dashboard-token')
  writeFileSync(tok, 'abc123\n')
  OPTS = { projectRoot: root, selfAgent: 'probe' }
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

const decide = (command: string, flag: boolean) =>
  gateDecision('Bash', { command }, flag ? { ...OPTS, allowScheduleWrite: true } : OPTS)
const allowBoth = (command: string) => {
  expect(decide(command, false).deny, `without: ${command}`).toBe(false)
  expect(decide(command, true).deny, `with: ${command}`).toBe(false)
}
const denyBoth = (command: string) => {
  expect(decide(command, false).deny, `without: ${command}`).toBe(true)
  expect(decide(command, true).deny, `with: ${command}`).toBe(true)
}

const SAFE = `import json,sys; print(json.dumps({"status":"done","result":sys.argv[1]}))`
const cfg = () => `printf 'header = "Authorization: Bearer %s"\\n' "$(cat ${tok})" | `
const sub = (code: string, ...args: string[]) => `"$(python3 -c '${code}' ${args.map((a) => `'${a}'`).join(' ')})"`
const recipe = (url: string, text: string, code = SAFE, py = 'python3') =>
  `${cfg()}curl -sS --fail-with-body -K - -X PUT "${url}" -H "Content-Type: application/json" --data-binary "$(${py} -c '${code}' '${text}')"`
const hdr = () => `-H "Authorization: Bearer $(cat ${tok})"`

describe('a bus message that only names the schedule API is not a schedule write', () => {
  it('the fleet closing recipe passes when the result text names the endpoint, with and without the flag', () => {
    allowBoth(recipe(M, TXT))
    allowBoth(recipe(M, TXT, SAFE, '/usr/bin/python3'))
    allowBoth(recipe(M, `${TXT} es a /api/schedules/5 DELETE`))
    allowBoth(recipe(M, TXT, `import json,sys; print(json.dumps({"status":"done","result":sys.argv[1]}, ensure_ascii=False))`))
    allowBoth(`${cfg()}curl -sS --fail-with-body -K - -X POST "http://localhost:3420/api/messages" -H "Content-Type: application/json" --data-binary ${
      sub(`import json,sys; print(json.dumps({"from":"worker","to":"lead","content":sys.argv[1]}))`, TXT)}`)
    allowBoth(`${cfg()}curl -sS --fail-with-body -K - -X PUT "${M}" -H "Content-Type: application/json" -d ${sub(SAFE, TXT)}`)
  })

  it('the control (text without the endpoint) and the other message carriers keep passing', () => {
    allowBoth(recipe(M, 'rendben'))
    allowBoth(`curl -sS --fail-with-body -X PUT ${M} ${hdr()} -H "Content-Type: application/json" --data-binary '{"status":"done","result":"${TXT}"}'`)
    allowBoth(`curl -sS -X PUT ${M} ${hdr()} -H "Content-Type: application/json" --data-binary @- <<'JSON'\n{"status":"done","result":"${TXT}"}\nJSON`)
    allowBoth(`curl -sS -X PUT ${M} ${hdr()} -H "Content-Type: application/json" -d "{\\"status\\":\\"done\\",\\"result\\":\\"${TXT}\\"}"`)
  })

  it('a config, a URL or a body that really reaches the schedule API stays denied', () => {
    // the stdin config names the schedule API and a method
    denyBoth(`printf 'url = "${S}/5"\\nrequest = "DELETE"\\n' | curl -sS -K -`)
    // the recipe, but the URL is the schedule API
    denyBoth(recipe(`${S}/5`, 'x'))
    denyBoth(recipe(S, TXT))
    // the message data carries an executed call on the schedule API
    denyBoth(`curl -sS -X PUT ${M} ${hdr()} --data-binary "$(curl -sS -X DELETE ${S}/5)"`)
    denyBoth(`${cfg()}curl -sS -K - -X PUT "${M}" --data-binary "$(python3 -c 'import urllib.request as u; u.urlopen(u.Request("${S}/5", method="DELETE"))')"`)
    // a config FILE is not the stdin header
    denyBoth(`curl -sS -K /tmp/x.cfg -X PUT ${M} --data-binary '{"result":"${TXT}"}'`)
  })

  it('only the exact printf header may feed `-K -`: another producer, another format or a second -K keeps the text in the judgement', () => {
    denyBoth(`echo 'x' | curl -sS --fail-with-body -K - -X PUT "${M}" -H "Content-Type: application/json" --data-binary ${sub(SAFE, TXT)}`)
    denyBoth(`printf 'header = "Authorization: Bearer %s"\\nurl = "${S}/5"\\n' "$(cat ${tok})" | curl -sS -K - -X PUT "${M}" --data-binary ${sub(SAFE, TXT)}`)
    denyBoth(`printf 'header = "X: %s"\\n' "$(cat ${tok})" | curl -sS -K - -X PUT "${M}" --data-binary ${sub(SAFE, TXT)}`)
    denyBoth(`${cfg()}curl -sS -K - -K /tmp/x.cfg -X PUT "${M}" --data-binary ${sub(SAFE, TXT)}`)
    denyBoth(`${cfg()}curl -sS --config /tmp/x.cfg -X PUT "${M}" --data-binary ${sub(SAFE, TXT)}`)
  })

  it('only the fixed json.dumps snippet is data: any other python code, any non-literal argument, or a URL position is not', () => {
    denyBoth(recipe(M, TXT, `import json,sys; print(json.dumps({"status":"done","result":open("/etc/hosts").read(),"x":sys.argv[1]}))`))
    denyBoth(recipe(M, TXT, `import os,sys; os.system(sys.argv[1])`))
    denyBoth(recipe(M, TXT, `import json,sys; print(json.dumps({"result":sys.argv[1]})); import os`))
    // a double-quoted or unquoted argument can expand: not provably data
    denyBoth(`${cfg()}curl -sS -K - -X PUT "${M}" --data-binary "$(python3 -c '${SAFE}' "${TXT}")"`)
    denyBoth(`${cfg()}curl -sS -K - -X PUT "${M}" --data-binary "$(python3 -c '${SAFE}' '${TXT}' $HOME)"`)
    // the snippet is data only as the VALUE of a data option, never as a URL
    denyBoth(`curl -q -s "$(python3 -c '${SAFE}' '${S}')"`)
    denyBoth(`curl -q -s -H "X: $(python3 -c '${SAFE}' '${S}')" ${M}`)
  })

  it('a schedule write next to a message that names the endpoint stays denied', () => {
    denyBoth(`${recipe(M, TXT)}; curl -X DELETE ${S}/5`)
    denyBoth(`curl -X DELETE ${S}/5; ${recipe(M, TXT)}`)
  })
})

describe('the deny text names the blocked operation', () => {
  const msg = (toolName: string, toolInput: unknown, flag = false) =>
    gateMessage(toolName, toolInput, flag ? { ...OPTS, allowScheduleWrite: true } : OPTS) as string
  const bash = (command: string, flag = false) => msg('Bash', { command }, flag)

  it('every text stays a governance hard-gate text', () => {
    for (const t of [bash(`curl -X DELETE ${S}/5`, true), bash('tmux send-keys -t x Enter'), msg('ScheduleWakeup', {})]) {
      expect(t).toContain('governance hard-gate')
    }
  })

  it('with the flag, a DELETE / PUT / sub-route says what it was and that only the create POST is open', () => {
    const del = bash(`curl -X DELETE ${S}/5`, true)
    expect(del).toContain('DELETE')
    expect(del).toContain('uj utemezes')
    expect(del).not.toContain('se /api/schedules iras')
    expect(bash(`curl -X PUT ${S}/5 -d @x.json`, true)).toContain('PUT')
    expect(bash(`curl -X POST ${S}/daily/toggle`, true)).toContain('/toggle')
    expect(bash(`curl -X POST ${S}/daily/run`, true)).toContain('/run')
    const other = bash(`python3 -c "import urllib.request as u; u.urlopen(u.Request('${S}', data=b'{}'))"`, true)
    expect(other).toContain('kliens')
    expect(other).toContain('uj utemezes')
  })

  it('with the flag, the hint teaches the shape that is open: -q first (T1)', () => {
    for (const command of [`curl -X POST ${S} -d @x.json`, `curl -q -X DELETE ${S}/5`, `curl -q -X POST ${S}/daily/run`]) {
      expect(bash(command, true), command).toContain('curl -q -X POST')
    }
  })

  it('without the flag, a schedule API write says the grant is missing', () => {
    const t = bash(`curl -X POST ${S} -d @x.json`)
    expect(t).toContain('/api/schedules')
    expect(t).toContain('SELF_PACE_SCHEDULE_WRITERS')
  })

  it('a denial that is not about the API never talks about the API', () => {
    for (const [t, marker] of [
      [bash('tmux send-keys -t agent-dev2 Enter', true), 'tmux send-keys'],
      [bash('cp x.db store/claudeclaw.db', true), 'claudeclaw.db'],
      [bash(`sqlite3 store/claudeclaw.db "INSERT INTO scheduled_tasks(name) VALUES('x')"`, true), 'utemezes-tabla'],
      [bash('node dist/web/schedule-registry-cli.js register evil', true), 'schedule-registry-cli'],
      [bash('echo "{}" > ~/.claude/scheduled_tasks.json', true), 'scheduled_tasks.json'],
      [bash('echo x > ~/.claude/scheduled-tasks/x/SKILL.md', true), 'scheduled-tasks'],
      [bash('(crontab -l; echo "*/5 * * * * claude -p poll") | crontab -', true), 'crontab'],
      [bash('claude /loop "keep polling"', true), '/loop'],
      [msg('ScheduleWakeup', {}), 'ScheduleWakeup'],
      [msg('CronCreate', {}), 'CronCreate'],
      [msg('Write', { file_path: '/home/agent/.claude/scheduled_tasks.json', content: '{}' }), 'scheduled_tasks.json'],
    ] as Array<[string, string]>) {
      expect(t, marker).toContain(marker)
      expect(t, `${marker}: the API claim`).not.toContain('/api/schedules')
    }
  })

  it('an unclassified denial falls back to the generic text, never to an empty one', () => {
    const t = bash('echo hello')
    expect(t).toContain('governance hard-gate')
    expect(t.length).toBeGreaterThan(200)
  })

  it('the spawned hook prints the operation text, flagged and unflagged', () => {
    const run = (args: string[], payload: unknown) => {
      const out = execFileSync(process.execPath, [GATE, ...args], { input: JSON.stringify(payload), timeout: 15_000 }).toString()
      return out ? JSON.parse(out) : null
    }
    const del = run([FLAG], { tool_name: 'Bash', tool_input: { command: `curl -X DELETE ${S}/5` } })
    expect(del.hookSpecificOutput.permissionDecision).toBe('deny')
    expect(del.hookSpecificOutput.permissionDecisionReason).toContain('DELETE')
    const tmux = run([FLAG], { tool_name: 'Bash', tool_input: { command: 'tmux send-keys -t agent-dev2 Enter' } })
    expect(tmux.hookSpecificOutput.permissionDecisionReason).toContain('tmux send-keys')
    expect(tmux.hookSpecificOutput.permissionDecisionReason).not.toContain('/api/schedules')
    const plain = run([], { tool_name: 'Bash', tool_input: { command: `curl -X POST ${S} -d @x.json` } })
    expect(plain.hookSpecificOutput.permissionDecisionReason).toContain('SELF_PACE_SCHEDULE_WRITERS')
  })
})

/**
 * Three findings about the downloader and the closing-recipe rules:
 *
 * (A) The downloader-writes-the-database rule (downloaderWritesFile) only ran on a segment that names the
 *     database and NOT a schedule route. A curl whose DATA mentions the schedule API made the segment "strong", the db
 *     branch never ran, and `curl -o store/claudeclaw.db URL -d '/api/schedules'` passed.
 * (B) The closing recipe still false-denied when its result text named the endpoint AND a method / data
 *     option or `tmux send-keys`: the naive layer (safeCommand) never resolved the fixed json.dumps snippet.
 * (C) -w/--write-out (%output{file}), --hsts and --alt-svc write a file too.
 */
const DB = 'store/claudeclaw.db'
describe('a downloader writing the database is denied whatever the data says', () => {
  it('-o / --output / -sSo with a schedule-API mention in the data stays denied, with and without the flag', () => {
    denyBoth(`curl -sS -o ${DB} http://example.com/x -d 'see /api/schedules'`)
    denyBoth(`curl -sS -o ${DB} http://example.com/x -d 'x scheduled-tasks'`)
    denyBoth(`curl -sS --output ${DB} http://example.com/x --data-binary 'see /api/schedules'`)
    denyBoth(`curl -sSo ${DB} http://example.com/x -d 'see /api/schedules'`)
    denyBoth(`curl -sS -D ${DB} http://example.com/x -d 'see /api/schedules'`)
    denyBoth(`curl -sS -c ${DB} http://example.com/x -d 'see /api/schedules'`)
  })

  it('the same without the mention stays denied (the existing rule)', () => {
    denyBoth(`curl -sS -o ${DB} http://example.com/x`)
  })

  it('a message whose data merely names the database and the schedule API stays allowed', () => {
    allowBoth(`curl -s -X POST http://localhost:3420/api/notes -d 'see claudeclaw.db and /api/schedules'`)
    allowBoth(recipe(M, 'kopiztam a claudeclaw.db-t'))
    allowBoth(recipe(M, `${TXT}, a claudeclaw.db marad`))
  })
})

describe('the closing recipe passes whatever its result text names', () => {
  it('a method, a data option or tmux send-keys in the result text', () => {
    allowBoth(recipe(M, 'curl -X DELETE /api/schedules/5'))
    allowBoth(recipe(M, 'ATVEVE: PUT /api/schedules/5 -X PUT'))
    allowBoth(recipe(M, 'curl /api/schedules -d x --data-binary y'))
    allowBoth(recipe(M, 'tmux send-keys -t agent Enter'))
    allowBoth(recipe(M, 'a /api/schedules es a tmux send-keys -t x nem kell'))
  })

  it('a real call next to the recipe stays denied', () => {
    denyBoth(`${recipe(M, 'tmux send-keys -t x')}; tmux send-keys -t x Enter`)
    denyBoth(`tmux send-keys -t x Enter; ${recipe(M, 'tmux send-keys -t x')}`)
    denyBoth(`${recipe(M, 'curl -X DELETE /api/schedules/5')}; curl -X DELETE ${S}/5`)
  })
})

describe('-w / --write-out / --hsts / --alt-svc can name a file', () => {
  it('each is denied when the segment names the database', () => {
    denyBoth(`curl -sS -w '%output{${DB}}x' http://example.com/x`)
    denyBoth(`curl -sS --write-out '%output{${DB}}x' http://example.com/x`)
    denyBoth(`curl -sS --hsts ${DB} http://example.com/x`)
    denyBoth(`curl -sS --alt-svc ${DB} http://example.com/x`)
  })
})

/**
 * The recipe rewrite and heredocs:
 *
 * (1) The closing-recipe rewrite (resolveJsonDumpSubst) ran on the raw command BEFORE stripHeredocBodies, so a recipe-
 *     shaped substitution INSIDE the body of an interpreter-owned heredoc (python3 - <<EOF, node, bash) was rewritten to a
 *     single-quoted data word and blanked: the real `tmux send-keys` inside the body vanished from the naive layer (a
 *     regression of the 2026-08-05 detection). The rewrite must only run outside heredoc bodies.
 * (2) A db-writing check on a segment whose command path is not trusted (name === '') judged the residue, which
 *     drops the message word of scripts/agent-msg.sh, so the database name in that word was never looked at.
 */
describe('the recipe rewrite stops at the first heredoc operator', () => {
  const body = (code: string) =>
    `x -d "$(python3 -c '${SAFE.replace('"result":sys.argv[1]', '"a":sys.argv[1]')}' 'q\n${code}\nz')"`
  const TMUX = `subprocess.run(["tmux","send-keys","-t","agent","hi","Enter"])`

  it('an interpreter-owned heredoc body that carries a recipe-shaped substitution and a real tmux call stays denied', () => {
    denyBoth(`python3 - <<'PY'\n${body(TMUX)}\nPY`)
    denyBoth(`python3 - <<PY\n${body(TMUX)}\nPY`)
    denyBoth(`bash <<'SH'\n${body('tmux send-keys -t agent hi Enter')}\nSH`)
    denyBoth(`node - <<'JS'\n${body(TMUX)}\nJS`)
  })

  it('whatever the shell does with the body, no rewrite happens after the first operator', () => {
    // unterminated, and the second heredoc on a line
    denyBoth(`python3 - <<'PY'\n${body(TMUX)}\n`)
    denyBoth(`cat <<'A' | python3 - <<'B'\ntext\nA\n${body(TMUX)}\nB`)
    // a line continuation joins the two lines: the second heredoc is on the first one
    denyBoth(`cat <<'A' >/dev/null && \\\npython3 - <<'B'\nA\n${body(TMUX)}\nB`)
    // a line continuation INSIDE the operator: the shell joins `<\` + newline + `<` into `<<`
    denyBoth(`python3 - <\\\n<'PY'\n${body(TMUX)}\nPY`)
    // an operator in a quote or a comment before the real one
    denyBoth(`echo '<<Z'\npython3 - <<'B'\nZ = 0\nZ\n${body(TMUX)}\nB`)
    // delimiters the plain pattern does not know: escaped, dotted, dashed, quoted expansion
    denyBoth(`python3 - <<\\EOF\n${body(TMUX)}\nEOF`)
    denyBoth(`python3 - <<'a.b'\n${body(TMUX)}\na.b`)
    denyBoth(`python3 - <<"END-1"\n${body(TMUX)}\nEND-1`)
    // a terminator the shell does not accept (trailing blank, <<- with spaces)
    denyBoth(`python3 - <<'PY'\nPY = 0\nPY \n${body(TMUX)}\nPY`)
    denyBoth(`python3 - <<-'PY'\n  PY\n${body(TMUX)}\n\tPY`)
  })

  it('a data heredoc keeps passing, and so does a recipe in front of it', () => {
    allowBoth(`cat > /tmp/probe-note.txt <<'EOF'\n${body(TMUX)}\nEOF`)
    allowBoth(recipe(M, 'tmux send-keys -t agent Enter'))
    // accepted over-deny of the structural allowlist, a file-writing heredoc next to the recipe
    denyBoth(`${recipe(M, 'tmux send-keys -t agent Enter')}\ncat > /tmp/probe-note.txt <<'EOF'\nplain text\nEOF`)
  })

  it('a here-string is not a heredoc', () => {
    // accepted over-deny of the structural allowlist, a here-string next to the recipe
    denyBoth(`cat <<< 'hello'\n${recipe(M, 'tmux send-keys -t agent Enter')}`)
  })

  it('known limit: a recipe AFTER a heredoc is not resolved, so a text naming the surface is denied (fail closed)', () => {
    denyBoth(`cat > /tmp/probe-note.txt <<'EOF'\nplain text\nEOF\n${recipe(M, 'tmux send-keys -t agent Enter')}`)
    allowBoth(`cat > /tmp/probe-note.txt <<'EOF'\nplain text\nEOF\n${recipe(M, 'rendben')}`)
  })
})

describe('an untrusted command path naming the database is judged on the whole segment', () => {
  it('scripts/agent-msg.sh reached by a relative or foreign path, with the database in the message word', () => {
    denyBoth(`scripts/agent-msg.sh probe lead 'cp x store/claudeclaw.db'`)
    denyBoth(`/tmp/x/scripts/agent-msg.sh probe lead 'see store/claudeclaw.db'`)
  })

  it('a message without the database name keeps passing', () => {
    allowBoth(`scripts/agent-msg.sh probe lead 'rendben'`)
  })
})

/**
 * Two more shapes of the recipe rewrite:
 *
 * (1) An ESCAPED `<` right before a heredoc: the shell reads `\<<<'PY'` as a literal `<` word plus a real `<<'PY'`
 *     heredoc, but the cut pattern saw `<<<` (a here-string) and found no operator, so the rewrite ran inside the body.
 * (2) The recipe rewrite turns the result text into a single-quoted word, which is only inert for a consumer that treats it
 *     as data. `eval` re-reads the json.dumps output as shell, and a `$(...)` / backtick in the text then runs; before the
 *     rewrite the double-quoted substitution stayed visible to the naive layer. The rewrite must not apply to a text
 *     carrying `$` or a backtick.
 */
describe('an escaped < before a heredoc, and a substitution in the recipe text', () => {
  const body = (code: string) =>
    `x -d "$(python3 -c '${SAFE.replace('"result":sys.argv[1]', '"a":sys.argv[1]')}' 'q\n${code}\nz')"`
  const TMUX = `subprocess.run(["tmux","send-keys","-t","agent","hi","Enter"])`

  it('an escaped < in front of what looks like a here-string is a literal word, the heredoc after it is real', () => {
    denyBoth(`python3 - \\<<<'PY'\n${body(TMUX)}\nPY`)
    // an escaped backslash is not an escape of the <: the here-string is real, the cut may only over-cut (fail closed)
    denyBoth(`python3 - \\\\<<<'PY'\n${body(TMUX)}\nPY`)
  })

  it('a real here-string still is not a heredoc', () => {
    // accepted over-deny of the structural allowlist, a here-string next to the recipe
    denyBoth(`cat <<< 'hello'\n${recipe(M, 'tmux send-keys -t agent Enter')}`)
  })

  it('a $(...) or a backtick in the recipe text is never resolved away (an eval would run it)', () => {
    denyBoth(`eval x -d "$(python3 -c '${SAFE}' 'q $(tmux send-keys -t agent hi Enter) z')"`)
    denyBoth(`eval x -d "$(python3 -c '${SAFE}' 'q \`tmux send-keys -t agent hi Enter\` z')"`)
  })

  it('a newline between the recipe arguments is a command separator inside $( ), so the words after it run', () => {
    // the shell runs the quoted words after the newline as a SEPARATE command; folding them into one inert data word hid them
    denyBoth(`curl -sS -X PUT ${M} --data-binary "$(python3 -c '${SAFE}' 'ok'\n'tmux' 'send-keys' '-t' 'worker' 'hi' 'Enter')"`)
    denyBoth(`curl -sS -X PUT ${M} --data-binary "$(python3 -c '${SAFE}' 'ok'\n'curl' '-X' 'POST' '${S}' '-d' 'x')"`)
    // a TAB is only a word separator: the later words stay arguments of python3, so the recipe is still data
    allowBoth(`curl -sS -X PUT ${M} --data-binary "$(python3 -c '${SAFE}' 'ok'\t'tmux send-keys')"`)
  })

  it('the rewrite only runs where the shell is at the top level: a quote that CLOSES an earlier word leaves the substitution unquoted', () => {
    // the `"` in front of `$(` closes the word `"x -d "`, so the $( ) output is split into words and RUNS
    denyBoth(`bash -c 'shift 3; "$@"' "x -d "$(python3 -c '${SAFE}' 'q tmux send-keys -t worker hi Enter z')""`)
    // (NOT asserted here, measured in a throwaway container, and again on 2026-11-01 on the factory develop 99c24402 (after the
    // factory's own $(...) body recursion, #2366) and on this branch: the same shape with `crontab -r` in the text, and even a
    // plain `$(echo crontab -r)` and an unquoted `x -d $(echo crontab -r)`, are ALLOW in both, and were before the recipe rewrite existed: the output of an unquoted
    // substitution is executed by the shell but is not visible to the gate. That blind spot is older than this card and not the
    // rewrite's doing; the rewrite is only required not to HIDE what the gate sees without it -- the tmux text above.)
    // inside another substitution or a double-quoted word the flag is not at the top level: no rewrite, judged as before
    denyBoth(`echo "$(curl -sS --data-binary "$(python3 -c '${SAFE}' 'q tmux send-keys z')")"`)
    // a newline after the flag ends the command: the quoted substitution is a COMMAND NAME, not the flag's value
    denyBoth(`curl -sS -X PUT ${M} --data-binary\n"$(python3 -c '${SAFE}' 'q tmux send-keys z')"`)
    // the plain recipe, with quoted words and a pipe in front of it, is still resolved
    allowBoth(recipe(M, 'tmux send-keys -t agent Enter'))
  })

  it('a # comment in front of the recipe does not unbalance the quote scan', () => {
    // an apostrophe in a comment must not make the scan believe a quote is open: the recipe after it is still at the top level
    allowBoth(`# it's a note\n${recipe(M, 'tmux send-keys -t agent Enter')}`)
    allowBoth(`echo ok # don't "worry"\n${recipe(M, 'tmux send-keys -t agent Enter')}`)
    // ... and a comment never HIDES the closing-quote exploit that follows it
    denyBoth(`# don't\nbash -c 'shift 3; "$@"' "x -d "$(python3 -c '${SAFE}' 'q tmux send-keys -t worker hi Enter z')""`)
  })

  it('the plain closing recipe naming the surface still passes', () => {
    allowBoth(recipe(M, 'tmux send-keys -t agent Enter'))
    allowBoth(recipe(M, 'ATVEVE: a POST /api/schedules kell nekem'))
  })
})

/**
 * The owner of the data option and a shadowed python3:
 *
 * The recipe rewrite ran for the value of ANY `-d` / `--data*` option, whoever owns the option, and ignored a shadowed
 * python3. The rewritten word is blanked by stripDataPayloads, so a `tmux send-keys` carried in the recipe text was
 * invisible to the naive layer even where the "data" is code: (a) a non-curl consumer that executes the value of its -d,
 * (b) a command that first defines `python3` as a function (so the "fixed json.dumps snippet" is whatever the function
 * does with its arguments). The PR's own guarantee ("no other expression can run", "tmux send-keys stays denied") broke.
 *
 * The rewrite now runs only when the option's owner is a curl at the START of its shell segment, and when nothing
 * outside the recipe defines or redirects a command (function, alias, hash, PATH, source, eval).
 */
describe('the recipe rewrite needs a curl owner and an unshadowed python3', () => {
  const TMUX_TXT = 'tmux send-keys -t agent hi Enter'
  const rec = (py = 'python3') => `--data-binary ${sub(SAFE, TMUX_TXT).replace('python3', py)}`

  it('(a) a non-curl consumer of -d / --data-binary is not a recipe owner', () => {
    denyBoth(`python3 -c 'import sys; exec(sys.argv[2])' -d ${sub(SAFE, TMUX_TXT)}`)
    denyBoth(`python3 -c 'import sys; exec(sys.argv[2])' ${rec()}`)
    denyBoth(`sh -c 'sh -c "$2"' x -d ${sub(SAFE, TMUX_TXT)}`)
    denyBoth(`mytool --data ${sub(SAFE, TMUX_TXT)}`)
    denyBoth(`x -d ${sub(SAFE, TMUX_TXT)}`)
  })

  it('(a) the owner is the command of the SAME segment: a curl in an earlier segment does not lend its name', () => {
    denyBoth(`curl -sS ${M}; python3 -c 'import sys; exec(sys.argv[2])' -d ${sub(SAFE, TMUX_TXT)}`)
    denyBoth(`curl -sS ${M} | python3 -c 'import sys; exec(sys.argv[2])' -d ${sub(SAFE, TMUX_TXT)}`)
    denyBoth(`curl -sS ${M} && python3 -c 'import sys; exec(sys.argv[2])' -d ${sub(SAFE, TMUX_TXT)}`)
    denyBoth(`curl -sS ${M}\npython3 -c 'import sys; exec(sys.argv[2])' -d ${sub(SAFE, TMUX_TXT)}`)
    // `&>` and `<&` are redirections, not separators either
    allowBoth(`curl -sS &>/dev/null -X PUT ${M} -H "Content-Type: application/json" ${rec()}`)
    allowBoth(`curl -sS <&0 -X PUT ${M} -H "Content-Type: application/json" ${rec()}`)
    // a redirection `2>&1` is no separator: curl still owns the option
    allowBoth(`curl -sS 2>&1 -X PUT ${M} -H "Content-Type: application/json" ${rec()}`)
  })

  it('(a) a wrapper in front of curl is not a recipe owner (fail closed)', () => {
    denyBoth(`env curl -sS -X PUT ${M} ${rec()}`)
    denyBoth(`command curl -sS -X PUT ${M} ${rec()}`)
    denyBoth(`{ curl -sS -X PUT ${M} ${rec()}; }`)
    denyBoth(`FOO=1 curl -sS -X PUT ${M} ${rec()}`)
    // the name must be exactly curl: a longer word or a foreign path is another program
    denyBoth(`curlx -sS -X PUT ${M} ${rec()}`)
    denyBoth(`/tmp/curl -sS -X PUT ${M} ${rec()}`)
  })

  it('(b) a shadowed python3 is not the fixed snippet (each form and keyword on its own)', () => {
    denyBoth(`python3() { /tmp/evil "$@"; }; curl -sS -X PUT ${M} ${rec()}`)
    denyBoth(`python3 () { /tmp/evil "$@"; }\ncurl -sS -X PUT ${M} ${rec()}`)
    denyBoth(`/usr/bin/python3() { /tmp/evil "$@"; }; curl -sS -X PUT ${M} ${rec('/usr/bin/python3')}`)
    denyBoth(`function python3 { /tmp/evil "$@"; }; curl -sS -X PUT ${M} ${rec()}`)
    denyBoth(`alias python3=/tmp/evil; curl -sS -X PUT ${M} ${rec()}`)
    denyBoth(`shopt -s expand_aliases; curl -sS -X PUT ${M} ${rec()}`)
    denyBoth(`hash -p /tmp/evil/python3 python3; curl -sS -X PUT ${M} ${rec()}`)
    denyBoth(`export PATH=/tmp/evil:$PATH; curl -sS -X PUT ${M} ${rec()}`)
    denyBoth(`source /tmp/defs.sh; curl -sS -X PUT ${M} ${rec()}`)
    denyBoth(`. /tmp/defs.sh; curl -sS -X PUT ${M} ${rec()}`)
    denyBoth(`eval 'ls'; curl -sS -X PUT ${M} ${rec()}`)
    denyBoth(`unalias python3; curl -sS -X PUT ${M} ${rec()}`)
    denyBoth(`enable -n true; curl -sS -X PUT ${M} ${rec()}`)
    denyBoth(`builtin cd /tmp; curl -sS -X PUT ${M} ${rec()}`)
    denyBoth(`typeset -x FOO=1; curl -sS -X PUT ${M} ${rec()}`)
    denyBoth(`declare -x FOO=1; curl -sS -X PUT ${M} ${rec()}`)
    denyBoth(`readonly FOO=1; curl -sS -X PUT ${M} ${rec()}`)
    denyBoth(`BASH_ENV=/tmp/evil; curl -sS -X PUT ${M} ${rec()}`)
    denyBoth(`ENV=/tmp/evil; curl -sS -X PUT ${M} ${rec()}`)
    // a dot-command after a separator, not only at the start
    denyBoth(`ls; . /tmp/defs.sh; curl -sS -X PUT ${M} ${rec()}`)
    denyBoth(`ls\n. /tmp/defs.sh\ncurl -sS -X PUT ${M} ${rec()}`)
    // the module lookup is redirected the same way (PYTHONPATH / PYTHONHOME make `import json` load another file)
    denyBoth(`export PYTHONPATH=/tmp/evil; curl -sS -X PUT ${M} ${rec()}`)
    denyBoth(`PYTHONHOME=/tmp/evil; curl -sS -X PUT ${M} ${rec()}`)
  })

  it('(b) curl itself shadowed by a function is not a curl owner', () => {
    denyBoth(`curl() { /tmp/evil "$@"; }; curl -sS -X PUT ${M} ${rec()}`)
  })

  it('the real recipe keeps passing: curl at the start of its segment, in every position the fleet writes it', () => {
    allowBoth(recipe(M, TMUX_TXT))
    allowBoth(recipe(M, TMUX_TXT, SAFE, '/usr/bin/python3'))
    allowBoth(`${cfg()}/usr/bin/curl -sS --fail-with-body -K - -X PUT "${M}" -H "Content-Type: application/json" ${rec()}`)
    allowBoth(`echo start\n${recipe(M, TMUX_TXT)}`)
    // a comment line ends at its newline: the curl on the next line starts its own segment
    allowBoth(`# it's a note\ncurl -sS -X PUT ${M} ${rec()}`)
    allowBoth(`echo ok # note\ncurl -sS -X PUT ${M} ${rec()}`)
    allowBoth(`cd /tmp && ${recipe(M, TMUX_TXT)}`)
    allowBoth(`${cfg()}\\\n  curl -sS --fail-with-body -K - -X PUT "${M}" \\\n  -H "Content-Type: application/json" \\\n  ${rec()}`)
    allowBoth(`${cfg().trimEnd()}\n  curl -sS --fail-with-body -K - -X PUT "${M}" ${rec()}`)
    // the multi-line form the sub-agent papers carry (measured 2026-11-06). The
    // command-level continuations resolve; the recipe itself must sit on one line: a continuation INSIDE `$(python3 -c '...' \
    // '<arg>')` is not recognised as the recipe (also not before #2354 v4, measured on the v3 gate), so that form is judged as
    // written -- it passes as long as its text names no protected surface, and is denied when it does (pinned below)
    const head = `printf 'header = "Authorization: Bearer %s"\\n' "$(cat ${tok})" \\\n  | curl -sS --fail-with-body -K - -X PUT "${M}" \\\n      -H "Content-Type: application/json" \\\n      --data-binary `
    const fleet = `${head}"$(python3 -c '${SAFE}' '${TMUX_TXT}')"`
    expect(resolveJsonDumpSubst(fleet, OPTS), `not rewritten: ${fleet}`).not.toBe(fleet)
    allowBoth(fleet)
    const split = (text: string) => `${head}"$(python3 -c '${SAFE}' \\\n        '${text}')"`
    expect(resolveJsonDumpSubst(split('ATVEVE'), OPTS)).toBe(split('ATVEVE'))
    allowBoth(split('ATVEVE, nem vegeredmeny'))
    denyBoth(split(TMUX_TXT))
  })

  it('T2: after a line continuation a # inside a word is no comment, so the quote it carries is real', () => {
    // the shell removes `\\<newline>`, so `x\\<newline>#'` is the one word `x#'`: it OPENS a single quote that swallows the
    // recipe's own quotes. Reading the # as a comment start put the recipe at the top level and rewrote (hid) its text.
    const R = `${cfg()}curl -sS --fail-with-body -K - -X PUT "${M}" ${rec()}`
    denyBoth(`echo x\\\n#'\n${R}`)
    denyBoth(`echo x\\\n#"\n${R}`)
    denyBoth(`echo x\\\n#$(\n${R}`)
    // the file treats a CRLF after the backslash as a continuation as well (fail closed); an odd run of backslashes ends in one
    denyBoth(`echo x\\\r\n#'\n${R}`)
    denyBoth(`echo x\\\\\\\n#'\n${R}`)
    // a continuation that follows a blank leaves the # at the START of a word: a real comment, the recipe is still resolved
    allowBoth(`echo x \\\n# a note\n${R}`)
    allowBoth(`echo x\n# a note\n${R}`)
    // an escaped backslash is no continuation: the newline is a real one and the # that follows starts a comment
    // accepted over-deny of the structural allowlist, an escape (`\\\\`) in a word is no plain form
    denyBoth(`echo x\\\\\n# a note\n${R}`)
    // an apostrophe in such a comment: the rewrite resolves the recipe, and since the develop gate reads an unquoted # at a word
    // start as a comment (GATECOMMENTQUOTE1104, #2524) its raw-command shell-code scan no longer takes that apostrophe for an
    // unterminated quote either: a real comment hides nothing, so the command passes. (This test adjustment follows #2524; the
    // gate itself is not loosened: the deny rows above, where the # is part of a word and the quote is real, stay denied.)
    for (const c of [`echo x \\\n# it's a note\n${R}`, `echo x\n# it's a note\n${R}`]) {
      expect(resolveJsonDumpSubst(c, OPTS), `not rewritten: ${JSON.stringify(c)}`).not.toBe(c)
      allowBoth(c)
    }
    // accepted over-deny of the structural allowlist, the escaped backslash in front of the comment line
    const esc = `echo x\\\\\n# it's a note\n${R}`
    expect(resolveJsonDumpSubst(esc, OPTS)).toBe(esc)
    denyBoth(esc)
  })

  it('words that only look like a shadow, inside the recipe text, change nothing', () => {
    allowBoth(recipe(M, `${TMUX_TXT} function python3 alias hash PATH PYTHONPATH source eval () {}`))
    // two recipes in one command: the words in one result text are no shadow for the other (every valid recipe is cut out)
    // accepted over-deny of the structural allowlist, two chained recipes (two curl without -q)
    denyBoth(`${recipe(M, `PATH ${TMUX_TXT}`)}; ${recipe(M, `function ${TMUX_TXT}`)}`)
    // ... but only a VALID recipe is cut out: another python code in the command is not inert text
    denyBoth(`${recipe(M, 'function x', 'import os; os.getcwd()')}; ${recipe(M, TMUX_TXT)}`)
  })
})

/**
 * Owner scan, command words and the python3 interpreter:
 *
 * (1) `>|` is a clobbering REDIRECTION, not a command separator: in `python3 -c '...' >|curl -d "$(...)"` the -d belongs to python3,
 *     but the segment scan started a new segment at the `|` and took the file name `curl` for the owner.
 * (2) The shadow check matched keywords in the RAW text, so a shell builtin split by quotes or an escape (`ha""sh`, `h\ash`) or built
 *     by an expansion (`$x`) went unseen. The command word of every top-level segment must be a plain literal word, or the
 *     rewrite is not applied (fail closed).
 * (3) `python3 -I -c` is accepted as the recipe's interpreter as well as the bare `python3 -c`.
 *
 * Every deny case also asserts the rewrite function itself leaves the command unchanged: the deny must come from the
 * rule under test, not from some other reason.
 */
describe('owner scan, command words, python3 -I', () => {
  const TMUX_TXT = 'tmux send-keys -t agent hi Enter'
  const BT = String.fromCharCode(96)
  const rec = (py = 'python3') => `--data-binary ${sub(SAFE, TMUX_TXT).replace('python3', py)}`
  const REC = () => `${cfg()}curl -sS --fail-with-body -K - -X PUT "${M}" ${rec()}`
  const kept = (command: string) => {
    expect(resolveJsonDumpSubst(command, OPTS), `rewritten: ${command}`).toBe(command)
    denyBoth(command)
  }
  const resolved = (command: string) => {
    expect(resolveJsonDumpSubst(command, OPTS), `not rewritten: ${command}`).not.toBe(command)
    allowBoth(command)
  }

  it('(1) `>|` is a redirection: the file name after it owns nothing', () => {
    kept(`python3 -c 'import sys; exec(sys.argv[2])' >|curl -d ${sub(SAFE, TMUX_TXT)}`)
    kept(`python3 -c 'import sys; exec(sys.argv[2])' >|/usr/bin/curl --data-binary ${sub(SAFE, TMUX_TXT)}`)
    kept(`echo x >|curl -sS -X PUT ${M} ${rec()}`)
    // ... and a line continuation inside the operator does not make it a separator either (`>\<newline>|`, `>\<newline>&`)
    kept(`python3 -c 'import sys; exec(sys.argv[2])' >\\\n|curl -d ${sub(SAFE, TMUX_TXT)}`)
    kept(`python3 -c 'import sys; exec(sys.argv[2])' >\\\n&curl -d ${sub(SAFE, TMUX_TXT)}`)
    // a real separator after the redirection still gives curl its own segment
    // #2354 v4: a redirection that writes a file is no plain form (a file written in front of the recipe can replace python3)
    kept(`ls >|/tmp/probe-out.txt\ncurl -sS -X PUT ${M} ${rec()}`)
    kept(`ls >|/tmp/probe-out.txt; curl -sS -X PUT ${M} ${rec()}`)
  })

  it('(2) a builtin or function keyword split by quotes, an escape or a continuation is still a shadow', () => {
    const EVIL = `/tmp/evil/python3 python3`
    kept(`ha""sh -p ${EVIL}; curl -sS -X PUT ${M} ${rec()}`)
    kept(`ha''sh -p ${EVIL}; curl -sS -X PUT ${M} ${rec()}`)
    kept(`h\\ash -p ${EVIL}; curl -sS -X PUT ${M} ${rec()}`)
    kept(`'ha''sh' -p ${EVIL}; curl -sS -X PUT ${M} ${rec()}`)
    kept(`"ha""sh" -p ${EVIL}; curl -sS -X PUT ${M} ${rec()}`)
    kept(`h\\\nash -p ${EVIL}; curl -sS -X PUT ${M} ${rec()}`)
    kept(`$'h\\x61sh' -p ${EVIL}; curl -sS -X PUT ${M} ${rec()}`)
    kept(`fu""nction python3 { /tmp/evil "$@"; }; curl -sS -X PUT ${M} ${rec()}`)
    kept(`ev""al 'ls'; curl -sS -X PUT ${M} ${rec()}`)
    kept(`s""ource /tmp/defs.sh; curl -sS -X PUT ${M} ${rec()}`)
    kept(`"." /tmp/defs.sh; curl -sS -X PUT ${M} ${rec()}`)
    // a command name that is built, not spelled
    kept(`x=ha""sh; $x -p ${EVIL}; curl -sS -X PUT ${M} ${rec()}`)
    kept(`$(echo ha""sh) -p ${EVIL}; curl -sS -X PUT ${M} ${rec()}`)
    kept(`${BT}echo ha""sh${BT} -p ${EVIL}; curl -sS -X PUT ${M} ${rec()}`)
    kept(`h$e""ash -p ${EVIL}; curl -sS -X PUT ${M} ${rec()}`)
    // a split variable NAME as an argument (the keyword regex alone reads the raw text)
    kept(`export PA""TH=/tmp/evil:/usr/bin; curl -sS -X PUT ${M} ${rec()}`)
    kept(`printf -v PA""TH %s /tmp/evil; curl -sS -X PUT ${M} ${rec()}`)
    kept(`read -r PY""THONPATH <<< /tmp/evil; curl -sS -X PUT ${M} ${rec()}`)
    kept(`export BA""SH_ENV=/tmp/x; curl -sS -X PUT ${M} ${rec()}`)
    // a CR before the newline is NOT a continuation in the shell: the backslash escapes the CR and the newline ends the command
    kept(`true \\\r\nh""ash -p ${EVIL}\ncurl -sS -X PUT ${M} ${rec()}`)
    kept(`true \\\r\nec""ho hi\ncurl -sS -X PUT ${M} ${rec()}`)
  })

  it('(2) the command word is found behind an env assignment, a control keyword, a pipe, a brace group', () => {
    const EVIL = `/tmp/evil/python3 python3`
    kept(`FOO=1 h""ash -p ${EVIL}; curl -sS -X PUT ${M} ${rec()}`)
    kept(`time h""ash -p ${EVIL}; curl -sS -X PUT ${M} ${rec()}`)
    kept(`! h""ash -p ${EVIL}; curl -sS -X PUT ${M} ${rec()}`)
    kept(`if true; then h""ash -p ${EVIL}; fi; curl -sS -X PUT ${M} ${rec()}`)
    kept(`true && h""ash -p ${EVIL} && curl -sS -X PUT ${M} ${rec()}`)
    kept(`true | h""ash -p ${EVIL}\ncurl -sS -X PUT ${M} ${rec()}`)
    kept(`{ h""ash -p ${EVIL}; }; curl -sS -X PUT ${M} ${rec()}`)
    // a dot-command behind a control keyword, a wrapper builtin, `time -p`, a `case` arm: the scan cannot see the real command
    kept(`if true; then . /tmp/defs.sh; fi; curl -sS -X PUT ${M} ${rec()}`)
    kept(`command h""ash -p ${EVIL}; curl -sS -X PUT ${M} ${rec()}`)
    kept(`command ec""ho hi; curl -sS -X PUT ${M} ${rec()}`)
    kept(`time -p h""ash -p ${EVIL}; curl -sS -X PUT ${M} ${rec()}`)
    kept(`time -p ec""ho hi; curl -sS -X PUT ${M} ${rec()}`)
    kept(`case x in x) h""ash -p ${EVIL} ;; esac; curl -sS -X PUT ${M} ${rec()}`)
    kept(`case x in x) ec""ho hi ;; esac; curl -sS -X PUT ${M} ${rec()}`)
    // an ESCAPED > or < is a literal character: the & / | after it is a real separator, so what follows it is a command word
    kept(`echo \\>& h""ash -p ${EVIL}; curl -sS -X PUT ${M} ${rec()}`)
    kept(`echo \\<& h""ash -p ${EVIL}; curl -sS -X PUT ${M} ${rec()}`)
    kept(`echo \\>| h""ash -p ${EVIL}\ncurl -sS -X PUT ${M} ${rec()}`)
    // a comment that NAMES a split keyword is not resolved either: the unquoted copy of the whole outside text is checked (conservative)
    kept(`# h""ash is only a comment\n${REC()}`)
    // a redirection in front of the command word hides the name from this scan: not resolved
    kept(`>/tmp/probe-out.txt h""ash -p ${EVIL}; curl -sS -X PUT ${M} ${rec()}`)
  })

  // structural allowlist: only the plain forms around the recipe resolve -- the allowlisted commands, the
  // structure keywords, comments and literal redirections; an assignment, another command, an expansion or an escape does not
  it('(2) plain command words, comments and keywords around the real recipe change nothing; assignments and other commands are not rewritten (v4)', () => {
    resolved(REC())
    kept(`X=1\n${REC()}`)
    kept(`FOO=bar; ${REC()}`)
    resolved(`if true; then ${REC()}; fi`)
    resolved(`# only a comment, it's fine\n${REC()}`)
    // the token read only in the header printf and a curl -H value; in an echo it is no plain form
    kept(`echo "$(cat ${tok})" > /dev/null\n${REC()}`)
    resolved(`cd /tmp && ${REC()}`) // `cd <literal path> &&` is a plain form
    // the skip words keep the real recipe resolved: `!` and a brace group are no unknown command name
    resolved(`! false; ${REC()}`)
    resolved(`{ ${REC()}; }`)
    kept(`[[ -f /tmp/probe-flag ]] && ${REC()}`)
    kept(`[ -f /tmp/probe-flag ] && ${REC()}`)
    kept(`if [[ -f /tmp/probe-flag ]]; then ${REC()}; fi`)
    kept(`: "\${X:-a}"; ${REC()}`)
    kept(`( cd /tmp ) && ${REC()}`)
    // `>|`, `&>` and `<&` stay redirections when their target is quoted: the quoted word is no command name
    kept(`ls >|"/tmp/probe a b"\n${REC()}`) // v4: writes a file
    kept(`ls &>"/tmp/probe a b"; ${REC()}`) // v4: writes a file
    kept(`cat <&"\${FD:-0}" >/dev/null; ${REC()}`)
    // an escaped > before & is a literal: the real recipe behind the backgrounding & is its own segment
    kept(`echo \\>& curl -sS -X PUT ${M} ${rec()}`)
    resolved(`${REC()} 2>&1 | cat`)
  })

  it('(3) python3 -I -c is the recipe interpreter as well as python3 -c', () => {
    resolved(`${cfg()}curl -sS --fail-with-body -K - -X PUT "${M}" ${rec('python3 -I')}`)
    resolved(`${cfg()}curl -sS --fail-with-body -K - -X PUT "${M}" ${rec('/usr/bin/python3 -I')}`)
    resolved(`${cfg()}curl -sS --fail-with-body -K - -X PUT "${M}" ${rec('python3')}`)
    // the same owner and shadow rules apply to the isolated form
    kept(`python3 -c 'import sys; exec(sys.argv[2])' -d ${sub(SAFE, TMUX_TXT).replace('python3', 'python3 -I')}`)
    kept(`python3() { /tmp/evil "$@"; }; curl -sS -X PUT ${M} ${rec('python3 -I')}`)
    kept(`ha""sh -p /tmp/evil/python3 python3; curl -sS -X PUT ${M} ${rec('python3 -I')}`)
    // only -I: another interpreter option is not the recipe
    kept(`${cfg()}curl -sS --fail-with-body -K - -X PUT "${M}" ${rec('python3 -S')}`)
    kept(`${cfg()}curl -sS --fail-with-body -K - -X PUT "${M}" ${rec('python3 -I -S')}`)
  })
})

/**
 * Word boundaries, built variable names and the for-do body:
 *
 * (1) The word scan took a `#` for a comment start with the JS `\s` class, but the shell's blanks are the space and the tab only: after
 *     a CR, a VT, a FF or a Unicode space the `#` opens no comment, and what the scan skipped as comment text is a command (or a quote).
 * (2) A variable NAME that a builtin takes as an ARGUMENT (export, read, printf -v, mapfile, readarray, getopts) can be built by an
 *     ANSI-C quote, an empty expansion or a brace expansion; the keyword regex reads the text with the quotes and backslashes removed
 *     only. The name of every such argument must be a plain literal word, or the rewrite is not applied (fail closed).
 * (3) `for v do BODY; done` has no `;` in front of the `do`, so the scan took the body for arguments of `for`.
 */
describe('blank-only word boundaries, built variable names, the for-do body', () => {
  const TMUX_TXT = 'tmux send-keys -t agent hi Enter'
  const BT = String.fromCharCode(96)
  const rec = (py = 'python3') => `--data-binary ${sub(SAFE, TMUX_TXT).replace('python3', py)}`
  const REC = () => `${cfg()}curl -sS --fail-with-body -K - -X PUT "${M}" ${rec()}`
  const EVIL = '/tmp/evil/python3 python3'
  const kept = (command: string) => {
    expect(resolveJsonDumpSubst(command, OPTS), `rewritten: ${JSON.stringify(command)}`).toBe(command)
    denyBoth(command)
  }
  const resolved = (command: string) => {
    expect(resolveJsonDumpSubst(command, OPTS), `not rewritten: ${JSON.stringify(command)}`).not.toBe(command)
    allowBoth(command)
  }

  // characters the JS `\s` class counts as white space but the shell does NOT split words on
  const NOT_BLANK: [string, string][] = [
    ['CR', '\r'],
    ['VT', '\v'],
    ['FF', '\f'],
    ['NBSP', '\u00a0'],
    ['ideographic space', '\u3000'],
    ['line separator', '\u2028'],
  ]

  it.each(NOT_BLANK)('(1) after a %s a # is no comment: the split command word behind it is still scanned', (_n, ch) => {
    kept(`true${ch}# ;ec""ho hi\n${REC()}`)
    kept(`echo hi${ch}# ;h$e""ash -p ${EVIL}\n${REC()}`)
  })

  it.each(NOT_BLANK.slice(0, 4))('(1) after a %s a # opens no comment: the quote behind it is real and swallows the recipe', (_n, ch) => {
    kept(`echo x${ch}#'\n${REC()}`)
    kept(`echo x${ch}#"\n${REC()}`)
  })

  // the quote the # opens is closed by a later quote, so the command-word scan finds nothing unterminated: only the top-level scan
  // (wordStartAt) can tell that the recipe sits inside the quote the shell opened (the overlap with the scan above is cut)
  it.each(NOT_BLANK.slice(0, 4))('(1) after a %s a # opens no comment: the top-level scan alone keeps the recipe untouched', (_n, ch) => {
    const command = `echo x${ch}#'\n${REC()}; echo '`
    expect(resolveJsonDumpSubst(command, OPTS), `rewritten: ${JSON.stringify(command)}`).toBe(command)
  })

  it('(1) after a space or a tab a # still opens a comment: the recipe behind it resolves', () => {
    resolved(`echo ok # ;ec""ho hi\n${REC()}`)
    resolved(`echo ok\t# ;ec""ho hi\n${REC()}`)
    resolved(`true\n# ;ec""ho hi\n${REC()}`)
    resolved(`echo ok\n# a note\n${REC()}`)
    // an apostrophe in the comment: resolved by the rewrite, and passed by the gate's raw-command shell-code scan, which reads
    // the # comment as a comment since #2524 (GATECOMMENTQUOTE1104): a test adjustment, not a loosening of the gate
    const apostrophe = `echo ok\n# it's a note\n${REC()}`
    expect(resolveJsonDumpSubst(apostrophe, OPTS), `not rewritten: ${JSON.stringify(apostrophe)}`).not.toBe(apostrophe)
    allowBoth(apostrophe)
  })

  // a variable name an argument-taking builtin gets, built by something the keyword regex does not undo
  const NAMES: [string, string][] = [
    ['export, ANSI-C hex escape', "export $'PA\\x54H=/tmp/evil:/usr/bin'"],
    ['export, ANSI-C octal escape', "export $'PA\\124H=/tmp/evil:/usr/bin'"],
    ['export, ANSI-C piece inside a name', "export BA$'S'H_ENV=/tmp/x"],
    ['export, ANSI-C PYTHONPATH', "export $'PY\\x54HONPATH=/tmp/evil'"],
    ['export, empty parameter expansion', 'export PA${x}TH=/tmp/evil:/usr/bin'],
    ['export, empty command substitution', 'export PA$(:)TH=/tmp/evil:/usr/bin'],
    ['export, empty backticks', `export PA${BT}:${BT}TH=/tmp/evil:/usr/bin`],
    ['export, brace expansion', 'export PA{,}TH=/tmp/evil:/usr/bin'],
    ['export, a name built from a variable', 'n=PA; export ${n}TH=/tmp/evil'],
    ['printf -v', 'printf -v PA${x}TH %s /tmp/evil:/usr/bin'],
    ['printf -vNAME (attached)', 'printf -vPA${x}TH %s /tmp/evil'],
    ['read', 'read -r PY${x}THONPATH <<< /tmp/evil'],
    ['mapfile', 'mapfile -t PA${x}TH <<< /tmp/evil'],
    ['readarray', 'readarray -t PA${x}TH <<< /tmp/evil'],
    ['getopts', 'getopts a PA${x}TH'],
    // a closing redirection (`>&-`, `<&-`) has no target, so the NEXT word is still an argument
    ['export behind a closing redirection', 'export >&- PA${x}TH=/tmp/evil:/usr/bin'],
    ['printf behind a closing redirection (the -v too)', 'printf 2>&- -v PA${x}TH %s /tmp/evil'],
    ['read behind an input-closing redirection', 'read <&- PA${x}TH'],
    ['export behind an input-closing redirection', 'export <&- PA${x}TH=/tmp/evil:/usr/bin'],
    // the value of mapfile/readarray -C is a CALLBACK the shell evaluates, whatever it says (an option value is no name,
    // but this one is code); and a `--` in front of the getopts operands is no operand, so the name is not the second word
    ['mapfile -C callback that exports a built name', "mapfile -C 'export PA${x}TH=/tmp/evil:/usr/bin;:' -c 1 a <<< x"],
    ['mapfile -tC (cluster) callback', "mapfile -tC 'export PA${x}TH=/tmp/evil;:' -c 1 a <<< x"],
    ['readarray -C callback', "readarray -C 'export PA${x}TH=/tmp/evil;:' -c 1 a <<< x"],
    ['mapfile -C export, the data is the here-string target', 'mapfile -C export -c 1 a <<< "PA${x}TH=/tmp/evil"'],
    ['getopts -- in front of the operands', 'getopts -- x PA${x}TH -x'],
    // the OPTION word of printf / getopts is decided after quote removal and expansion, not by its raw text
    // (the getopts rows carry no trailing option-looking operand: the older dash rule would deny that on its own)
    ['printf, the -v option quoted', 'printf "-v" PA${x}TH %s /tmp/evil'],
    ['printf, the -v option split by a quote', 'printf -"v"PA${x}TH %s /tmp/evil'],
    ['printf, the -v option from a variable', 'd=-v; printf $d PA${x}TH %s /tmp/evil'],
    ['printf, the -v option from a brace expansion', 'printf {-v,PA${x}TH} %s /tmp/evil'],
    ['printf, the -v option escaped', 'printf \\-v PA${x}TH %s /tmp/evil'],
    ['printf, the -v option as an ANSI-C word', "printf $'-v' PA${x}TH %s /tmp/evil"],
    ['printf, the -v option behind an empty quote', 'printf ""-v PA${x}TH %s /tmp/evil'],
    ['getopts, the -- quoted', 'getopts "--" x PA${x}TH'],
    ['getopts, the -- escaped', 'getopts \\-- x PA${x}TH'],
    ['getopts, the -- from a brace expansion', 'getopts {--,} x PA${x}TH'],
    ['getopts, the -- from a variable', 'd=--; getopts $d x PA${x}TH'],
    // a word that starts with a letter still falls apart when it carries an unquoted expansion or a glob: the name moves one place on
    ['getopts, the option string splits into several words', "x=' PA'; y='TH -a'; getopts a$x$y"],
    ['getopts, the option string is a glob', 'getopts P* -a'],
    // the per-command state is reset at every new command word: nothing a former command left behind may excuse the next one
    ['state: the printf format of a former printf', 'printf %s x; printf -v PA${x}TH %s /tmp/evil'],
    ['state: the getopts position of a former getopts', 'getopts ab: o; getopts ab: PA${x}TH'],
    ['state: the option value a former read waits for', 'read -d; read PA${x}TH <<< x'],
    // the literal callback rows that only the -C rule (not the value check) can deny
    ['mapfile -tC with a literal callback', 'mapfile -tC export -c 1 a <<< "PA${x}TH=/tmp/evil"'],
    ['readarray -C with a literal callback', 'readarray -C export -c 1 a <<< "PA${x}TH=/tmp/evil"'],
    // a literal name that sticks to its option has no word boundary in front of it: \bPATH\b does not see it
    ['printf -vPATH (attached literal)', 'printf -vPATH %s /tmp/evil:/usr/bin'],
    ['printf -vBASH_ENV (attached literal)', 'printf -vBASH_ENV %s /tmp/x'],
    ['read -aPATH (attached literal)', 'read -aPATH <<< /tmp/evil:/usr/bin'],
    ['read -raPATH (attached literal, cluster)', 'read -raPATH <<< /tmp/evil:/usr/bin'],
    ['read -a PATH split by an expansion', 'read -a PA${x}TH <<< /tmp/evil'],
    // the option word itself is built: an `a` written as an ANSI-C escape still makes the rest of the word the array name (the name is
    // built too: a literal one would be seen by the keyword regex, which the quote in front of it gives a word boundary)
    ['read, option letter built by an ANSI-C escape', "read -$'\\x61'PA${x}TH <<< /tmp/evil"],
    // a printf %n conversion stores into the variable its argument names, and arithmetic evaluation assigns
    // to a name too; both take a name built at run time, which no keyword regex sees
    ['printf %n, the name built', 'printf %s%n x PA${x}TH'],
    ['printf %n behind --', 'printf -- %s%n x PA${x}TH'],
    ['printf %n with a width, single-quoted format', "printf '%5n' PA${x}TH"],
    ['printf %n, double-quoted format', 'printf "a%n" PA${x}TH'],
    ['printf %n behind -v', 'printf -v OUT %s%n x PA${x}TH'],
    ['printf, the format from a variable', 'f=%n; printf "$f" PA${x}TH'],
    ['printf, an unquoted escaped format', 'printf %\\n PA${x}TH'],
    ['let', 'let PA${x}TH=1'],
    ['arithmetic command', '(( PA${x}TH=1 ))'],
    ['arithmetic expansion', 'echo $(( PA${x}TH=1 ))'],
    ['old arithmetic expansion', 'echo $[ PA${x}TH=1 ]'],
    ['[[ -eq ]] operand', '[[ 1 -eq PA${x}TH=1 ]]'],
    ['array subscript', 'a[PA${x}TH=1]=x'],
    ['substring offset', 'echo "${HOME:PA${x}TH=1}"'],
    ['a variable whose VALUE assigns, read by an arithmetic for', 'k=PA${x}TH=1; for ((i=0;i<k;i++)) do :; done'],
    ['a variable whose VALUE assigns, read by [[ -eq ]]', 'k=PA${x}TH=1; [[ k -eq 1 ]]'],
    // an integer attribute evaluates every later assignment; declare / typeset are on the keyword list (INVARIANS)
    ['declare -i, the value assigns', 'declare -i n; k=PA${x}TH=1; n=k'],
    ['typeset -i, the value assigns', 'typeset -i n; k=PA${x}TH=1; n=k'],
    // v3: a name held in a variable reaches subscript arithmetic (or PATH itself) without any `name[` in the text
    ['indirect expansion of a built subscript name', 'p=PA; s="[${p}TH=1]"; n=a$s; : "${!n}"'],
    ['[[ -v ]] on a built subscript name', 'p=PA; s="[${p}TH=1]"; n=a$s; [[ -v $n ]]'],
    ['test -v on a built subscript name', 'p=PA; s="[${p}TH=1]"; n=a$s; test -v "$n"'],
    ['[ -v ] on a built subscript name', 'p=PA; s="[${p}TH=1]"; n=a$s; [ -v "$n" ]'],
    ['unset of a built subscript name', 'p=PA; s="[${p}TH=1]"; n=a$s; unset "$n"'],
    ['wait -p into a built name', 'p=PA; sleep 0 & wait -p "${p}TH" $!'],
    ["printf %n with the ' flag", 'printf "%s%\'n" x PA${x}TH'],
    // `%%` is taken out pair by pair, so an odd run still ends in a conversion
    ['printf %n behind an escaped percent', "printf '%%%n' PA${x}TH"],
    // #2354 v4: the deny lists kept missing a form; the structural allowlist closes these (and the class)
    ["test $'-v' on a built subscript name", `p=PA; s="[\${p}TH=1]"; n=a$s; test $'-v' "$n"`],
    ['[ -v ] with the option from a variable', `p=PA; s="[\${p}TH=1]"; n=a$s; o=-v; [ $o "$n" ]`],
    ['[ -v ] with the option from a brace expansion', `p=PA; s="[\${p}TH=1]"; n=a$s; [ {-v,} "$n" ]`],
    ["wait $'-p' into a built name", `p=PA; sleep 0 & wait $'-p' "\${p}TH" $!`],
    ['prompt expansion ${x@P} of a subscript', `l='['; p=PA; x="\\\${a$l\${p}TH=1]}"; : "\${x@P}"`],
    ['PS4 with set -x', `l='['; p=PA; PS4="\\\${a$l\${p}TH=1]}"; set -x`],
    ['jobs -x runs a builtin in this shell', `p=PA; jobs -x export "\${p}TH=/tmp/evil"`],
  ]

  // #2354 v4: each rule of the allowlist on its own (the rest of the command is plain), and the plain recipe forms that stay open
  it('(5) v4: only the plain forms are rewritten, one rule per row', () => {
    kept(`cd /tmp/evil; ${REC()}`) // `cd` only as `cd <literal path> &&` (v5)
    // `cd <literal path> && <recipe>` resolves; an option, an expansion, a quote, a redirection or another
    // separator behind it does not
    resolved(`cd /tmp/probe-dir && ${REC()}`)
    kept(`cd -P /tmp && ${REC()}`)
    kept(`cd "$HOME" && ${REC()}`)
    kept(`cd '/tmp' && ${REC()}`)
    kept(`cd /tmp >/dev/null && ${REC()}`)
    kept(`cd /tmp || ${REC()}`)
    kept(`cd /tmp /x && ${REC()}`)
    // a comment line on its own (no line continuation in front of it) resolves
    resolved(`# a note\n${REC()}`)
    kept(`jobs -x echo x; ${REC()}`) // another command
    kept(`echo "\${HOME@P}"; ${REC()}`) // an expansion inside double quotes
    kept(`echo a{b,c}; ${REC()}`) // a brace in a word
    kept(`printf >/tmp/o '%s' x; ${REC()}`) // printf: the format must come first
    kept(`echo x\\ y; ${REC()}`) // an escape
    // nothing in front of the recipe may write a file (it could replace the python3 the recipe runs)
    kept(`printf '%s' x > /tmp/bin/python3; ${REC()}`)
    kept(`echo x >> /tmp/bin/python3; ${REC()}`)
    kept(`curl -sS -o /tmp/bin/python3 http://127.0.0.1:9/x; ${REC()}`)
    kept(`curl -sSo/tmp/bin/python3 http://127.0.0.1:9/x; ${REC()}`)
    kept(`curl -sS --output /tmp/bin/python3 http://127.0.0.1:9/x; ${REC()}`)
    kept(`curl -sS -K /tmp/x.cfg http://127.0.0.1:9/x; ${REC()}`) // a config file can name an output
    // the same with -q first, so only the curl option rule (not the one-curl-without-q rule) decides (v5: mutant MW)
    kept(`curl -q -sS -o /tmp/bin/python3 http://127.0.0.1:9/x; ${REC()}`)
    kept(`curl -q -sS -K /tmp/x.cfg http://127.0.0.1:9/x; ${REC()}`)
    // `-K -` only from EXACTLY the recipe's header printf; another printf can carry an `output` line
    kept(`printf 'output = "/tmp/bin/python3"\\n' | curl -q -sS -K - http://127.0.0.1:9/x; ${REC()}`)
    kept(`printf 'header = "Authorization: Bearer %s"\\nurl = "http://127.0.0.1:9/"\\n' "$(cat ${tok})" | curl -q -sS -K - http://127.0.0.1:9/x; ${REC()}`)
    kept(`printf 'header = "Authorization: Bearer %s"\\n' "$(cat ${tok})" x | curl -q -sS -K - http://127.0.0.1:9/x; ${REC()}`)
    // `> 1` and `> -` are file names, a number or `-` is a descriptor only behind `>&` / `<&`; a config
    // from stdin only from the printf piped right into curl, never from a file
    kept(`printf '%s' x > 1; ${REC()}`)
    kept(`echo x > -; ${REC()}`)
    kept(`echo x >& /tmp/bin/python3; ${REC()}`)
    kept(`curl -sS -K - < /tmp/x.cfg http://127.0.0.1:9/x; ${REC()}`)
    kept(`curl -sS -K - http://127.0.0.1:9/x; ${REC()}`)
    // no config from an inherited descriptor; at most one curl that may read a ~/.curlrc
    kept(`${cfg()}curl -sS --fail-with-body -K - 0<&3 -X PUT "${M}" ${rec()}`)
    kept(`curl -sS http://127.0.0.1:9/x; ${REC()}`)
    resolved(`curl -q -s http://127.0.0.1:9/x; ${REC()}`)
    resolved(`echo ok > /dev/null 2>&1; ${REC()}`)
    resolved(REC())
    resolved(`curl -sS --fail-with-body -X PUT "${M}" ${hdr()} -H "Content-Type: application/json" ${rec()}`)
    resolved(`echo ok; ${REC()}`)
  })

  // #2354 v6: the header printf feeds `-K -` only when it reads an ACCEPTED token file
  // (acceptedTokenFile, the check stdinAuthHeaderOnly makes on the recipe's own curl): a relative path, `cat -`, or the
  // accepted per-agent path holding more than one token line could put an `output` or `url` line into the config of a curl
  // in front of the recipe. One row per test, so each row fails on its own.
  const TOKEN_SOURCES: [string, string | null, string | null][] = [
    ['a relative path', 'store/.dashboard-token', null],
    ['cat -', '-', null],
    ['a multi-line token file', null, 'abc\noutput=/tmp/bin/python3\n'],
    ['a CR-LF token file', null, 'abc\r\n'],
  ]
  it.each(TOKEN_SOURCES)('(6) v6: the header printf reading %s does not feed `-K -`', (_n, path, content) => {
    const agentTok = join(root, 'agents', 'probe', '.dashboard-token')
    mkdirSync(join(root, 'agents', 'probe'), { recursive: true })
    if (content !== null) writeFileSync(agentTok, content)
    try {
      kept(`printf 'header = "Authorization: Bearer %s"\\n' "$(cat ${path ?? agentTok})" | curl -q -sS -K - http://127.0.0.1:9/x; ${REC()}`)
    } finally {
      rmSync(agentTok, { force: true })
    }
  })
  // INVARIANS: the calling agent's own token file is accepted, in every place the rewrite runs (opts reaches all of them)
  it('(6) v6: the recipe with the per-agent token file still resolves', () => {
    const agentTok = join(root, 'agents', 'probe', '.dashboard-token')
    mkdirSync(join(root, 'agents', 'probe'), { recursive: true })
    writeFileSync(agentTok, 'def456\n')
    try {
      resolved(`printf 'header = "Authorization: Bearer %s"\\n' "$(cat ${agentTok})" | curl -sS --fail-with-body -K - -X PUT "${M}" ${rec()}`)
    } finally {
      rmSync(agentTok, { force: true })
    }
  })
  // a valid token in an existing file at an absolute path that is not an accepted one
  it('(7) v7: the header printf reading a valid token from a path that is not accepted does not feed `-K -`', () => {
    const other = join(root, 'other', '.dashboard-token')
    mkdirSync(join(root, 'other'), { recursive: true })
    writeFileSync(other, 'abc123\n')
    try {
      kept(`printf 'header = "Authorization: Bearer %s"\\n' "$(cat ${other})" | curl -q -sS -K - http://127.0.0.1:9/x; ${REC()}`)
    } finally {
      rmSync(other, { force: true })
    }
  })
  // curl gets its words after the shell's quote removal, so a quoted writing or config option is
  // that option. One row per test.
  const QUOTED_CURL_OPTIONS: string[] = [
    `'-o' /tmp/bin/python3`,
    `"-o" /tmp/bin/python3`,
    `-'o' /tmp/bin/python3`,
    `'--output' /tmp/bin/python3`,
    `'--output-dir' /tmp/bin`,
    `'-D' /tmp/bin/python3`,
    `"-K" /tmp/x.cfg`,
    `'--config' /tmp/x.cfg`,
    `"-K" -`,
  ]
  it.each(QUOTED_CURL_OPTIONS)('(7) v7: a quoted curl option is the option: %s', (opt) => {
    kept(`curl -q -sS ${opt} http://127.0.0.1:9/x; ${REC()}`)
  })
  // the token read stands only as the header printf's second word or a curl -H value, and only
  // from an accepted token file; anywhere else its run-time content could be a curl option or a URL
  it('(7) v7: the token read outside the header printf and a curl -H value is not plain', () => {
    const other = join(root, 'other', '.dashboard-token')
    mkdirSync(join(root, 'other'), { recursive: true })
    writeFileSync(other, 'abc123\n')
    try {
      kept(`curl -q -sS "$(cat ${tok})" http://127.0.0.1:9/x; ${REC()}`) // a URL / option word
      kept(`echo "$(cat ${tok})"; ${REC()}`) // another command
      kept(`curl -q -sS -X "$(cat ${tok})" http://127.0.0.1:9/x; ${REC()}`) // another option's value
      kept(`curl -q -sS -H "X: $(cat store/.dashboard-token)" http://127.0.0.1:9/x; ${REC()}`) // a relative path in -H
      kept(`curl -q -sS -H "X: $(cat ${other})" http://127.0.0.1:9/x; ${REC()}`) // a path that is not accepted, in -H
      kept(`cat < "$(cat ${tok})"; ${REC()}`) // a redirection target
    } finally {
      rmSync(other, { force: true })
    }
  })
  // #2354 v8: the -H value is what curl pairs with -H, not the word behind a `-H` text; a `-H`
  // that is another option's value leaves the token read as a URL or an option. One row per test.
  const NOT_A_HEADER_VALUE: [string, string][] = [
    ['-X takes the -H', '-X -H'],
    ['-d takes the -H', '-d -H'],
    ['the first -H takes the second', '-H -H'],
    ['the --url value', '--url'],
  ]
  it.each(NOT_A_HEADER_VALUE)('(8) v8: the token read is no header value when %s', (_n, before) => {
    kept(`curl -q -sS ${before} "$(cat ${tok})" http://127.0.0.1:9/x; ${REC()}`)
  })
  // v8: an accepted token file whose content starts with `-` is no token (it could be read as an option)
  it('(8) v8: a token file starting with - does not feed `-K -`', () => {
    const agentTok = join(root, 'agents', 'probe', '.dashboard-token')
    mkdirSync(join(root, 'agents', 'probe'), { recursive: true })
    writeFileSync(agentTok, '-o/tmp/bin/python3\n')
    try {
      kept(`printf 'header = "Authorization: Bearer %s"\\n' "$(cat ${agentTok})" | curl -q -sS -K - http://127.0.0.1:9/x; ${REC()}`)
    } finally {
      rmSync(agentTok, { force: true })
    }
  })
  // INVARIANS: the documented token header on a curl in front of the recipe still resolves
  it('(7) v7: the accepted token file in a curl -H value still resolves', () => {
    resolved(`curl -q -sS -H "Authorization: Bearer $(cat ${tok})" http://127.0.0.1:9/x; ${REC()}`)
    resolved(`curl -q -sS --header "Authorization: Bearer $(cat ${tok})" http://127.0.0.1:9/x; ${REC()}`)
  })

  it.each(NAMES)('(2) %s: a built variable name is not resolved', (_n, c) => {
    kept(`${c}; curl -sS -X PUT ${M} ${rec()}`)
  })

  // #2354 v4: the name-taking builtins are no plain form, whatever their names and values; a printf without %n or -v still is
  it('(2) literal names, quoted values and redirections around the same builtins are not rewritten (v4); a plain printf is', () => {
    kept(`export FOO=bar; ${REC()}`)
    kept(`export FOO="a b" BAR='c d'; ${REC()}`)
    kept(`export FOO=$(date); ${REC()}`)
    kept(`export -n FOO; ${REC()}`)
    kept(`read -r LINE <<< "$HOME"; ${REC()}`)
    kept(`read -r LINE < /tmp/probe-in.txt; ${REC()}`)
    kept(`printf -v OUT %s "$HOME"; ${REC()}`)
    kept(`printf '%s\\n' "$HOME" > /dev/null; ${REC()}`)
    // a format without a %n conversion, and the parameter defaults that evaluate nothing, stay open
    resolved(`printf '%%n %s' x; ${REC()}`)
    resolved(`printf -- '%s\\n' x; ${REC()}`)
    kept(`printf "%s\\n" "$HOME"; ${REC()}`)
    kept(`echo "\${HOME:-/tmp}"; ${REC()}`)
    kept(`[[ -f /tmp/probe-flag ]] && echo y; ${REC()}`)
    kept(`[ -f /tmp/probe-flag ] && echo y; ${REC()}`)
    resolved(`printf '%%%%n %s' x; ${REC()}`)
    kept(`printf %s "$HOME" 2>&1 >/dev/null; ${REC()}`)
    kept(`mapfile -t LINES < /tmp/probe-in.txt; ${REC()}`)
    kept(`export FOO=bar >/dev/null 2>&1; ${REC()}`)
    // harmless forms that carry a quote or an option value are no variable name (fail closed was too wide here)
    kept(`read -r -d '' X <<< "$HOME"; ${REC()}`)
    kept(`read -p "Name: " x; ${REC()}`)
    kept(`read -rp "Name: " x; ${REC()}`)
    kept(`read -n1 -t 5 x; ${REC()}`)
    kept(`read -aARR <<< "$HOME"; ${REC()}`)
    kept(`read -a ARR <<< "$HOME"; ${REC()}`)
    kept(`getopts "ab:" opt "$@"; ${REC()}`)
    kept(`mapfile -t -d '' LINES < /tmp/probe-in.txt; ${REC()}`)
    kept(`export FOO+=x; ${REC()}`)
    // after the format word nothing is an option any more, and a quoted format is no option word
    kept(`printf "%s\\n" "$HOME" > /dev/null; ${REC()}`)
    resolved(`printf -- '%s' x; ${REC()}`)
    resolved(`printf %s -v; ${REC()}`)
    kept(`printf '%s' -v PA\${x}TH; ${REC()}`)
    kept(`getopts ab: opt; ${REC()}`)
    kept(`getopts 'ab:' opt; ${REC()}`)
    kept(`getopts :ab: opt "$@"; ${REC()}`)
    kept(`mapfile -t -c 1 -n 3 LINES < /tmp/probe-in.txt; ${REC()}`)
    kept(`export FOO=bar >&-; ${REC()}`)
    kept(`printf 2>&- -v OUT %s x; ${REC()}`)
    kept(`printf -vOUT %s "$HOME"; ${REC()}`)
    // a name that merely ENDS like a protected one is no protected name when it stands on its own
    kept(`export GOPATH=/tmp/go; ${REC()}`)
  })

  it('(3) the body of `for v do ...; done` is command position', () => {
    kept(`for v do $'h\\x61sh' -p ${EVIL}; done; curl -sS -X PUT ${M} ${rec()}`)
    kept(`for v do ec""ho hi; done; curl -sS -X PUT ${M} ${rec()}`)
    // the arithmetic header: since #2354 v2 the ARITH_EVAL_RX denies this row first, so it no longer measures the for-do
    // recognition; the two `for v do` rows above do (mutant: the `cmd === 'for' && w === 'do'` line removed)
    kept(`for ((i=0;i<1;i++)) do ec""ho hi; done; curl -sS -X PUT ${M} ${rec()}`)
    // the forms with a `;` or a newline in front of the `do` were already read right
    kept(`for v in a b; do ec""ho hi; done; curl -sS -X PUT ${M} ${rec()}`)
    kept(`for v\ndo ec""ho hi\ndone\ncurl -sS -X PUT ${M} ${rec()}`)
  })

  // #2354 v4: a loop is no plain form
  it('(3) a `for` loop around the real recipe is not rewritten (v4)', () => {
    kept(`for v do echo $v; done; ${REC()}`)
    kept(`for v in a b; do echo $v; done; ${REC()}`)
    // an arithmetic for is arithmetic evaluation, which can assign PATH through a variable's value
    // (`k='PATH=1'; for ((i=0;i<k;i++))`): not rewritten any more
    expect(resolveJsonDumpSubst(`for ((i=0;i<1;i++)) do echo $i; done; ${REC()}`, OPTS)).toBe(`for ((i=0;i<1;i++)) do echo $i; done; ${REC()}`)
  })
})

/**
 * Three more shapes got past the name checks, and each fix invited another one, so the rule is FAIL-CLOSED instead of an
 * enumeration:
 *
 * (1) the unquoted option string of getopts may carry a `?` glob (`getopts ?ATH`), which moves the variable name one place on;
 * (2) a name part that is no identifier (`export =$y$z`, `export 1=$y`, `export a-b=$y`) was taken for a literal, so its unquoted value
 *     split into new NAME arguments (`export = PATH=...`);
 * (3) the VALUE word of a read / mapfile option (`read -p $x NAME`) was skipped unchecked, and an unquoted expansion or glob there
 *     splits into several words, the later ones being names.
 *
 * What the parser cannot identify for sure is denied: a name must be a plain identifier, an option value a plain literal or a quoted
 * word that cannot split. The tables below are shapes of the UNKNOWN, not a list of known attacks.
 */
describe('a name or an option value the parser cannot identify is denied (fail-closed)', () => {
  const TMUX_TXT = 'tmux send-keys -t agent hi Enter'
  const rec = () => `--data-binary ${sub(SAFE, TMUX_TXT)}`
  const REC = () => `${cfg()}curl -sS --fail-with-body -K - -X PUT "${M}" ${rec()}`
  const TAIL = () => `curl -sS -X PUT ${M} ${rec()}`
  const kept = (command: string) => {
    expect(resolveJsonDumpSubst(command, OPTS), `rewritten: ${JSON.stringify(command)}`).toBe(command)
    denyBoth(command)
  }
  const resolved = (command: string) => {
    expect(resolveJsonDumpSubst(command, OPTS), `not rewritten: ${JSON.stringify(command)}`).not.toBe(command)
    allowBoth(command)
  }

  // (1) the option string of getopts: a `?` is a glob, and the glob may match a file name in the working directory
  const GETOPTS_GLOBS: [string, string][] = [
    ['a ? in front of a name', 'getopts ?ATH'],
    ['a ? inside the option string', 'getopts a?'],
    ['a ? with an operand behind it', 'getopts a? x'],
    ['a lone ?', 'getopts ? x'],
    // no overlap with the name rule (the name is a plain identifier): only the option-string rule can deny these
    ['a * inside the option string', 'getopts a* x'],
    ['a lone *', 'getopts * x'],
    // already denied before this round: the controls of the same family
    ['a bracket glob', 'getopts [a]b x'],
    ['a brace expansion', 'getopts a{b,c} x'],
  ]
  it.each(GETOPTS_GLOBS)('(1) getopts, %s: the option string may glob', (_n, c) => {
    kept(`${c}; ${TAIL()}`)
  })

  // (2) a name part that is no identifier: the unquoted value behind the `=` splits into more arguments, which are names
  const BAD_NAMES: [string, string][] = [
    ['export, an empty name part', 'y=" PA"; z="TH=/tmp/evil:/usr/bin"; export =$y$z'],
    ['export, an empty name part, one variable', 'export =$y'],
    ['export, a name that starts with a digit', 'export 1=$y'],
    ['export, a name with a dash', 'export a-b=$y'],
    ['export, a lone dash', 'export -=$y'],
    ['export, a cluster that is no export option', 'export -x=$y'],
    ['read, an empty name part', 'read =$y$z'],
    ['read, a name that starts with a digit', 'read 1'],
    ['read, a name with a dash', 'read -r a-b'],
    ['mapfile, a name with a dash', 'mapfile a-b <<< x'],
    ['readarray, a name that starts with a digit', 'readarray 1x <<< x'],
    ['printf -v, a name that starts with a digit', 'printf -v 1x %s x'],
    ['printf -v, a name with a dash', 'printf -v a-b %s x'],
    ['printf -v attached, an empty name part', 'printf -v=$y %s x'],
    ['getopts, a name that starts with a digit', 'getopts a 1x'],
    ['getopts, a name with a dash', 'getopts a a-b'],
  ]
  it.each(BAD_NAMES)('(2) %s: not an identifier, not resolved', (_n, c) => {
    kept(`${c}; ${TAIL()}`)
  })

  // (3) the value word of an option that takes one
  const VALUE_OPTS = [
    'read -d', 'read -p', 'read -n', 'read -N', 'read -t', 'read -u',
    'mapfile -d', 'mapfile -n', 'mapfile -O', 'mapfile -s', 'mapfile -u', 'mapfile -c', 'readarray -n',
  ]
  const SPLITTING_VALUES = ['$x', '${x}', '$(echo 1)', '`echo 1`', '`x`', '{1,2}', '*', '?', '[1]', '"a"$x"b"', "'a'$x'b'", '$x"y"',
    // a double-quoted word still splits (or vanishes) when its expansion is a list: "$@", "${a[@]}", "${!P@}"; the rest are not plain scalars
    '"$@"', '"${a[@]}"', '"${!P@}"', '"$*"', '"$(echo 1)"', '"`echo 1`"', '"$1"', '"${x:-a}"', '"a\\b"',
  ]
  const VALUE_CASES: [string, string][] = VALUE_OPTS.flatMap((o) => SPLITTING_VALUES.map((v): [string, string] => [o, v]))
  it.each(VALUE_CASES)('(3) %s followed by %s: a value that may split, or that the parser cannot identify, is not resolved', (o, v) => {
    // no protected name is written out in the text (the keyword regex would deny that on its own): only the structure can tell
    kept(`x='1 FOO'; ${o} ${v} ARR <<< /tmp/evil:/usr/bin; ${TAIL()}`)
  })

  // the quoted list expansions as the value word, with the protected name built by the positional parameters
  // or an array (no protected name is written out in the text), and the empty "$@" that shifts the next option's value into a name place
  it('(3) a quoted list expansion as the option value: the later pieces are names', () => {
    kept(`set -- a $'PA\\x54H'; read -d "$@" <<< /tmp/evil:/usr/bin; ${TAIL()}`)
    kept(`set -- a $'PA\\x54H'; read -p "$@" <<< /tmp/evil:/usr/bin; ${TAIL()}`)
    kept(`set -- 0 $'PA\\x54H'; read -u "$@" <<< /tmp/evil:/usr/bin; ${TAIL()}`)
    kept(`read -a a <<< $'x PA\\x54H'; mapfile -d "\${a[@]}" <<< /tmp/evil; ${TAIL()}`)
    kept(`read -d "\${!P@}" x <<< y; ${TAIL()}`)
    kept(`read -d "$@" -p "$x" NAME; ${TAIL()}`)
  })

  // #2354 v4: read / mapfile are no plain form, whatever their option values
  it('(3) a literal or a quoted option value is not rewritten either (v4)', () => {
    kept(`read -p "Name: " x; ${REC()}`)
    kept(`read -p "$x" y; ${REC()}`)
    kept(`read -p "\${x}" y; ${REC()}`)
    kept(`read -p "Name $x: " y; ${REC()}`)
    kept(`read -p '$x' y; ${REC()}`)
    kept(`read -d '' x <<< "$HOME"; ${REC()}`)
    kept(`read -n 3 y <<< "$HOME"; ${REC()}`)
    kept(`read -t 0.5 y <<< "$HOME"; ${REC()}`)
    kept(`read -u 3 y; ${REC()}`)
    kept(`mapfile -t -O 2 ARR < /tmp/probe-in.txt; ${REC()}`)
    kept(`mapfile -d , ARR <<< x; ${REC()}`)
    kept(`mapfile -n 3 -s 1 ARR < /tmp/probe-in.txt; ${REC()}`)
  })

  // (4) the general rule: whatever shape stands in the NAME position and is no plain identifier is denied, for every builtin that takes a name
  const UNKNOWN_SHAPES = [
    '$n', '${n}', '"$n"', '$(echo n)', '`echo n`', '{a,b}', '?', '*', '[a]', "'n'", '"n"', "$'n'", '=n', '1', 'a-b', 'a.b', 'a/b', '~', '%n', 'a,b',
  ]
  const NAME_SLOTS: [string, (s: string) => string][] = [
    ['export', (s) => `export ${s}`],
    ['export with a value', (s) => `export ${s}=1`],
    ['read', (s) => `read ${s}`],
    ['read -r', (s) => `read -r ${s}`],
    ['mapfile', (s) => `mapfile ${s} <<< x`],
    ['mapfile -t', (s) => `mapfile -t ${s} <<< x`],
    ['readarray', (s) => `readarray ${s} <<< x`],
    ['getopts', (s) => `getopts a ${s}`],
    ['printf -v', (s) => `printf -v ${s} %s x`],
    ['printf -v attached', (s) => `printf -v${s} %s x`],
  ]
  const SLOT_CASES: [string, string, string][] = NAME_SLOTS.flatMap(([n, f]) => UNKNOWN_SHAPES.map((s): [string, string, string] => [n, s, f(s)]))
  it.each(SLOT_CASES)('(4) %s with the name %s: an unknown shape is denied', (_n, _s, c) => {
    kept(`n=x; ${c}; ${TAIL()}`)
  })

  // #2354 v4: export / read / mapfile / getopts / printf -v are no plain form
  it('(4) plain identifiers in the same slots, and the export options, are not rewritten (v4)', () => {
    kept(`export FOO; ${REC()}`)
    kept(`export _a1=2 B_2=3; ${REC()}`)
    kept(`export -p; ${REC()}`)
    kept(`export -n FOO; ${REC()}`)
    kept(`export -f fn; ${REC()}`)
    kept(`export -- FOO=1; ${REC()}`)
    kept(`read -r _a1 b2 <<< "$HOME"; ${REC()}`)
    kept(`mapfile -t arr_1 < /tmp/probe-in.txt; ${REC()}`)
    kept(`getopts ab: opt_1; ${REC()}`)
    kept(`printf -v out_1 %s x; ${REC()}`)
  })
})

/**
 * Fail-closed cases next to a `trap`, the deny side of the recipe rewrite, and the downloader option values:
 *
 * (a) A `trap` body is shell code that runs in THIS shell inside one quoted word, so a body that builds the name PATH out of
 *     pieces (`p=PA;t=TH;export "$p$t=..."`) is invisible to the shadow regex, and the python3 of the recipe may then be a
 *     different program. The rewrite must not run next to a `trap`: the command is judged as written.
 * (b) The deny side of the semantic line: a command substitution that stands next to a valid recipe is still decided as a
 *     command of its own. The bodies used here (a write of the database file) are denied by that recursion and by nothing else.
 * (c) The downloader rule reads the word after a value-taking option as that option's value (`--data -o` is data, not a switch).
 */
describe('the recipe rewrite fails closed next to a trap, the bodies are still decided', () => {
  const trap = (ev: string) => `trap 'p=PA;t=TH;export "$p$t=/tmp/x:/usr/bin"' ${ev}`

  it('a trap body that builds PATH out of pieces: the recipe is not rewritten and its text is judged as written', () => {
    for (const ev of ['DEBUG', 'EXIT', 'ERR']) denyBoth(`${trap(ev)}; ${recipe(M, TXT)}`)
    // after the recipe, and a double-quoted body
    denyBoth(`${recipe(M, TXT)}; ${trap('DEBUG')}`)
    denyBoth(`trap "p=PA;t=TH;export \\"\\$p\\$t=/tmp/x:/usr/bin\\"" DEBUG; ${recipe(M, TXT)}`)
    // the literal spelling was denied before as well (the word PATH)
    denyBoth(`trap 'PATH=/tmp/x:$PATH' DEBUG; ${recipe(M, TXT)}`)
    // the control: without the trap the same recipe passes, and the word `trap` in the recipe's own result text is data
    allowBoth(recipe(M, TXT))
    allowBoth(recipe(M, `${TXT} trap x DEBUG`))
  })

  it('a substitution next to the recipe is decided as a command of its own (denied only by that recursion)', () => {
    const rec = `${cfg()}curl -sS -K - -X PUT "${M}" --data-binary ${sub(SAFE, TXT)}`
    denyBoth(`${rec} -d "$(cp /tmp/x ${DB})"`)
    denyBoth(`${rec} -d "$(curl -sS -o ${DB} http://example.com/x)"`)
    denyBoth(`${rec}; echo "$(cp /tmp/x ${DB})"`)
    denyBoth(`${rec} "$(cp /tmp/x ${DB})"`)
    // accepted over-deny of the structural allowlist, a substitution next to the recipe, harmless or not
    denyBoth(`${rec} -d "$(date)"`)
    denyBoth(`${rec}; echo "$(date)"`)
  })

  it('the word after a value-taking curl option is its value, not a switch; a real output option still denies', () => {
    for (const opt of ['data', 'data-ascii', 'data-binary', 'data-raw', 'data-urlencode', 'header', 'request', 'user-agent', 'json']) {
      allowBoth(`curl -sS ${M} --${opt} -o 'x ${DB}'`)
    }
    // a real output option, an attached value, an abbreviation (not skipped: fail closed) and `=` forms keep denying
    denyBoth(`curl -sS ${M} --data x -o ${DB}`)
    denyBoth(`curl -sS ${M} -d x -o ${DB}`)
    denyBoth(`curl -sS ${M} -dx -o ${DB}`)
    denyBoth(`curl -sS ${M} --dat -o 'x ${DB}'`)
    denyBoth(`curl -sS ${M} --data=x --output ${DB}`)
    denyBoth(`curl -sS -o ${DB} ${M} --data -o`)
  })
})
