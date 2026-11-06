/**
 * SCHEDWRITE1023, review of #2354 (point 1): the create handler takes `agent`, `targetSession` and `forceSend`
 * from the request body and the API does not know its caller. So `--allow-schedule-write` opens the create POST
 * only when the body is ONE literal, inline, single-quoted JSON object whose `agent` is the hook's own agent and
 * which sets neither `targetSession` nor `forceSend`. A body from a file or stdin, a substitution, or anything
 * else stays denied (fail closed). One row per condition; the agent check is guarded by a mutant (the plan).
 */
import { describe, it, expect } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  gateDecision,
  gateMessage,
  // @ts-expect-error: plain .mjs hook script, no types
} from '../../scripts/self-pace-gate.mjs'

const SELF = 'trinity'
const ON = { allowScheduleWrite: true, selfAgent: SELF }
const URL_ = 'http://localhost:3420/api/schedules'
const post = (data: string) => `curl -q -X POST ${URL_} -H 'Content-Type: application/json' ${data}`
const body = (o: Record<string, unknown>) => `-d '${JSON.stringify(o)}'`
const OWN = { agent: SELF, name: 'emlekezteto', prompt: 'x', schedule: '0 9 * * *' }
const allowed = (command: string, opts: object = ON) => gateDecision('Bash', { command }, opts).deny === false
const denied = (command: string, opts: object = ON) => gateDecision('Bash', { command }, opts).deny === true

describe('the create POST opens only with a literal inline body naming the hook\'s own agent', () => {
  it('B1: the own-agent literal body is allowed with the flag, denied without it', () => {
    expect(allowed(post(body(OWN)))).toBe(true)
    expect(denied(post(body(OWN)), { selfAgent: SELF })).toBe(true)
    for (const flag of ['--data', '--data-raw', '--data-binary', '--json']) {
      expect(allowed(post(`${flag} '${JSON.stringify(OWN)}'`)), flag).toBe(true)
    }
  })

  it('B2: another agent, the main agent, no agent, a case variant or a non-string agent is denied', () => {
    for (const agent of ['merlin', 'marveen', 'neo', 'TRINITY', 'trinity ', '']) {
      expect(denied(post(body({ ...OWN, agent }))), `agent=${JSON.stringify(agent)}`).toBe(true)
    }
    const { agent: _drop, ...noAgent } = OWN
    expect(denied(post(body(noAgent))), 'no agent').toBe(true)
    for (const agent of [null, 1, true, [SELF], { name: SELF }]) {
      expect(denied(post(body({ ...OWN, agent }))), `agent=${JSON.stringify(agent)}`).toBe(true)
    }
  })

  it('B3: a body that carries targetSession or forceSend is denied, whatever the value', () => {
    for (const extra of [{ targetSession: 'main' }, { targetSession: '' }, { targetSession: null },
      { forceSend: true }, { forceSend: false }, { forceSend: null }]) {
      expect(denied(post(body({ ...OWN, ...extra }))), JSON.stringify(extra)).toBe(true)
    }
    // an escaped key is the same key for JSON.parse (and for the dashboard)
    expect(denied(post(`-d '{"agent":"${SELF}","\\u0074argetSession":"x"}'`))).toBe(true)
  })

  it('B4: a body that names the agent key twice is denied, whichever value comes last', () => {
    expect(denied(post(`-d '{"agent":"${SELF}","agent":"merlin"}'`))).toBe(true)
    expect(denied(post(`-d '{"agent":"${SELF}","\\u0061gent":"merlin"}'`))).toBe(true)
    // the own name last: JSON.parse and the dashboard would keep it, the gate still denies (one agent key, no more)
    expect(denied(post(`-d '{"agent":"merlin","agent":"${SELF}"}'`))).toBe(true)
    expect(denied(post(`-d '{"agent":"merlin","\\u0061gent":"${SELF}"}'`))).toBe(true)
    expect(denied(post(`-d '{"agent":"${SELF}","agent":"${SELF}"}'`))).toBe(true)
    // a quoted "agent": inside a value is no second key
    expect(allowed(post(`-d '{"agent":"${SELF}","prompt":"\\"agent\\": x"}'`))).toBe(true)
  })

  it('B5: a body from a file or from stdin is denied', () => {
    expect(denied(post('-d @x.json'))).toBe(true)
    expect(denied(post('--data-binary @-') + ` <<'EOF'\n${JSON.stringify(OWN)}\nEOF`)).toBe(true)
    expect(denied(`printf '%s' '${JSON.stringify(OWN)}' | ${post('--data-binary @-')}`)).toBe(true)
  })

  it('B6: a substitution or an expansion in the body is denied (the gate cannot prove what curl sends)', () => {
    expect(denied(post('-d "$(cat x.json)"'))).toBe(true)
    expect(denied(`A=${SELF}; ${post(`-d "{\\"agent\\":\\"$A\\"}"`)}`)).toBe(true)
    // the bus recipe's json.dumps form: its argv text would look like the body, curl sends the python output
    const py = `"$(python3 -c 'import json,sys; print(json.dumps({"agent":"merlin","prompt":sys.argv[1]}))' '${JSON.stringify(OWN)}')"`
    expect(denied(post(`--data-binary ${py}`))).toBe(true)
    expect(denied(post(`-d "$(cat <<'EOF'\n${JSON.stringify(OWN)}\nEOF\n)"`))).toBe(true)
  })

  it('B7: a body that is not one JSON object, or two data options, is denied', () => {
    for (const d of [`-d 'nem json'`, `-d '[${JSON.stringify(OWN)}]'`, `-d '"${SELF}"'`, `-d 'null'`,
      `${body(OWN)} ${body(OWN)}`, `${body(OWN)} -d 'x=1'`]) {
      expect(denied(post(d)), d).toBe(true)
    }
    // a double-quoted body is not the literal single-quoted form (an expansion could hide in it)
    expect(denied(post(`-d "${JSON.stringify(OWN).replace(/"/g, '\\"')}"`))).toBe(true)
    // the =-joined and the attached forms are not the proved form either
    expect(denied(post(`--data='${JSON.stringify(OWN)}'`))).toBe(true)
    expect(denied(post(`-d'${JSON.stringify(OWN)}'`))).toBe(true)
  })

  it('B8: without a known own agent (no selfAgent, or an invalid name) nothing is opened', () => {
    expect(denied(post(body(OWN)), { allowScheduleWrite: true })).toBe(true)
    // no dot, the shape selfAgentFromProjectDir and acceptedTokenFile take
    for (const selfAgent of ['', 'a b', '../x', 7, 'a.b']) {
      expect(denied(post(body({ ...OWN, agent: selfAgent })), { allowScheduleWrite: true, selfAgent }), String(selfAgent)).toBe(true)
    }
  })

  it('B9: two create POSTs in one command are not opened (one proved body per command)', () => {
    expect(denied(`${post(body(OWN))}; ${post(body(OWN))}`)).toBe(true)
  })

  // The literal must be the body curl SENDS, not a matching text elsewhere.
  it('B10: a rewritten body next to a matching literal elsewhere (comment, echo) is denied', () => {
    const own = JSON.stringify(OWN)
    const py = `"$(python3 -c 'import json,sys; print(json.dumps({"agent":"merlin","prompt":sys.argv[1]}))' '${own}')"`
    expect(denied(`${post(`--data-binary ${py}`)} # -d '${own}'`)).toBe(true)
    expect(denied(`echo -d '${own}'; ${post(`--data-binary ${py}`)}`)).toBe(true)
    expect(denied(`${post(`-d "$(cat <<'EOF'\n${own}\nEOF\n)"`)} # -d '${own}'`)).toBe(true)
    // a file body next to a matching literal in a comment
    expect(denied(`${post('-d @x.json')} # -d '${own}'`)).toBe(true)
  })

  it('B11: quote concatenation, ANSI-C quoting and --data-urlencode are not the proved form', () => {
    const own = JSON.stringify(OWN)
    const cut = own.indexOf(SELF) + 2
    expect(denied(post(`-d '${own.slice(0, cut)}''${own.slice(cut)}'`))).toBe(true)
    expect(denied(post(`-d $'${own}'`))).toBe(true)
    expect(denied(post(`--data-urlencode '${own}'`))).toBe(true)
    expect(denied(post(`-G -d '${own}'`))).toBe(true)
    expect(denied(post(`-K cfg ${body(OWN)}`))).toBe(true)
    // a body-adding option next to the proved literal, and a substitution that becomes a NUL marker
    expect(denied(post(`--variable x=EXTRA --expand-data '{{x}}' ${body(OWN)}`))).toBe(true)
    expect(denied(post(`--expand-data '${own}'`))).toBe(true)
    expect(denied(post(`-d "{\\"agent\\":\\"${SELF}\\",\\"x\\":\\"$(date)\\"}"`))).toBe(true)
  })

  it('B12: the method stays proved: PUT, a method header, or a sub-route with the own body is denied', () => {
    const own = body(OWN)
    expect(denied(`curl -q -X PUT ${URL_}/1 ${own}`)).toBe(true)
    expect(denied(`curl -q -X POST ${URL_} -H 'X-HTTP-Method-Override: DELETE' ${own}`)).toBe(true)
    expect(denied(`curl -q -X POST ${URL_}/1/run ${own}`)).toBe(true)
    expect(denied(`curl -X POST ${URL_} ${own}`)).toBe(true) // -q not first: a curlrc could change it
  })

  // the literal must be the data word ITSELF. A twin of it elsewhere (comment, echo) used to cover a
  // data word in another quoting, whose text the gate reads but the shell changes before curl gets it.
  it('B13: a double-quoted, ${}-expanding or other-option data word next to a matching single-quoted twin is denied', () => {
    const tw = (v: string) => ` # -d '${v}'`
    // "$X" and "${X}" stay text for the gate inside double quotes; the shell expands them (X='","agent":"merlin')
    const dollar = `{"agent":"${SELF}","name":"$X"}`
    expect(denied(post(`-d "${dollar.replace(/"/g, '\\"')}"`) + tw(dollar))).toBe(true)
    const brace = `{"agent":"${SELF}","name":"\${X}"}`
    expect(denied(post(`-d "${brace.replace(/"/g, '\\"')}"`) + tw(brace))).toBe(true)
    expect(denied(`echo -d '${dollar}'; ${post(`-d "${dollar.replace(/"/g, '\\"')}"`)}`)).toBe(true)
    // inside double quotes the shell drops a backslash-newline; the gate joined it with a space, so the twin
    // '..."tar getSession"...' matched while curl sent "targetSession"
    const split = `{"agent":"${SELF}","tar getSession":"main"}`
    expect(denied(post(`-d "{\\"agent\\":\\"${SELF}\\",\\"tar\\\ngetSession\\":\\"main\\"}"`) + tw(split))).toBe(true)
    // --data-ascii (or any data option outside the five) is not the proved form, even single-quoted next to a twin
    const own = JSON.stringify(OWN)
    expect(denied(post(`--data-ascii '${own}'`) + tw(own))).toBe(true)
  })

  // an unquoted, backslash-escaped body is no literal: an unescaped ? (or any glob the gate does not
  // mark) can match a file whose NAME is another body.
  it('B14: an unquoted backslash-escaped data word next to a matching twin is denied (glob, escapes)', () => {
    const esc = (v: string) => v.replace(/[{}"]/g, (c) => '\\' + c)
    const glob = `{"agent":"${SELF}","tar?etSession":"main"}`
    expect(denied(post(`-d ${esc(glob)}`) + ` # -d '${glob}'`)).toBe(true)
    const own = JSON.stringify({ agent: SELF, name: 'emlekezteto' })
    expect(denied(post(`-d ${esc(own)}`) + ` # -d '${own}'`)).toBe(true)
  })

  // the create path takes no backslash-newline at all (the gate's join is not the shell's).
  it('B15: the own literal body in a curl continued with backslash-newline is denied', () => {
    const lines = `curl -q -X POST ${URL_} \\\n  -H 'Content-Type: application/json' \\\n  ${body(OWN)}`
    expect(denied(lines)).toBe(true)
    // the same command on one line passes (the row above is denied for the continuation only)
    expect(allowed(lines.replace(/ \\\n {2}/g, ' '))).toBe(true)
    // a raw line break inside the single-quoted body, or between commands, is no one-line command either
    expect(denied(post(`-d '{\n  "agent":"${SELF}",\n  "name":"x"\n}'`))).toBe(true)
    expect(denied(post(`-d '{"agent":"${SELF}","name":"x"}'\r`))).toBe(true)
    expect(denied(`true\n${post(body(OWN))}`)).toBe(true)
    // v3: the white space JS \s knows but bash does not split on (it stays in the word curl gets)
    for (const ch of ['\v', '\f', '\u00a0', '\u2028', '\ufeff']) {
      expect(denied(post(body(OWN)) + ch), JSON.stringify(ch)).toBe(true)
    }
  })

  it('B15b: a # and JSON escapes inside the single-quoted body are body bytes, not a comment or a shell escape', () => {
    expect(allowed(post(`-d '{"agent":"${SELF}","prompt":"a #b \\n c \\"q\\" \\\\"}'`))).toBe(true)
    expect(denied(post(`-d '{"agent":"merlin","prompt":"a #b"}'`))).toBe(true)
  })

  // structural allowlist: the create command is one plain curl, nothing in front of it or after it
  it('B17: no assignment, export, other command or expansion around the create curl (v4)', () => {
    expect(denied(`p=PA; export "\${p}TH=/tmp/evil:/usr/bin"; ${post(body(OWN))}`)).toBe(true) // PATH would pick the curl
    expect(denied(`true && ${post(body(OWN))}`)).toBe(true)
    expect(denied(`cd /tmp && ${post(body(OWN))}`)).toBe(true)
    expect(denied(`${post(body(OWN))}; echo done`)).toBe(true)
    // exactly ONE command, even when the other one is an allowed curl
    expect(denied(`${post(body(OWN))}; curl -q -s http://localhost:3420/api/health`)).toBe(true)
    expect(denied(`curl -q -s http://localhost:3420/api/health && ${post(body(OWN))}`)).toBe(true)
    expect(denied(post(`${body(OWN)} -K - < /tmp/x.cfg`))).toBe(true) // a config file on stdin
    // the maintainer's inline literal recipe itself still passes (B1, B1b carry the other spellings)
    expect(allowed(post(body(OWN)))).toBe(true)
  })

  // a listed agent's denied create says what the body has to be, not only the curl shape
  it('B16: the deny hint of a listed agent names the body rule', () => {
    const t = gateMessage('Bash', { command: post('-d @x.json') }, ON) as string
    expect(t).toContain('curl -q -X POST')
    expect(t).toContain('EGY egyszeres idezojeles inline JSON')
    expect(t).toContain('csak a sajat agent, egyszer, targetSession es forceSend nelkul')
    expect(t).toContain('egy sorban')
  })

  it('B1b: the documented token header works with the own literal body, not with another agent', () => {
    const root = mkdtempSync(join(tmpdir(), 'schedwrite-body-tok-'))
    try {
      mkdirSync(join(root, 'store'), { recursive: true })
      const tok = join(root, 'store', '.dashboard-token')
      writeFileSync(tok, 'abc123\n')
      const cmd = `curl -q -X POST ${URL_} -H "Authorization: Bearer $(cat ${tok})" -H 'Content-Type: application/json' ${body(OWN)}`
      expect(allowed(cmd, { ...ON, projectRoot: root })).toBe(true)
      expect(denied(cmd.replace(`agent":"${SELF}`, 'agent":"merlin'), { ...ON, projectRoot: root })).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
