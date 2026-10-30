/**
 * SCHEDWRITE1023: let named sub-agents write schedules through the dashboard
 * schedule surface, without exempting them from the rest of the self-pace gate.
 *
 * The setting SELF_PACE_SCHEDULE_WRITERS (comma-separated agent names, default
 * empty) adds `--allow-schedule-write` to the self-pace-gate hook command of the
 * listed non-main agents. With the flag, the gate stops denying ONE route: a curl POST
 * that creates a schedule (POST /api/schedules); PUT, PATCH, DELETE, the POST
 * sub-routes and other HTTP clients stay denied. The self-schedule store, the
 * scheduled-tasks directory, the registry tool, the schedule table SQL, the
 * dashboard database file and everything else it denies stay denied. With an empty
 * list, the generated hook commands are byte-identical to an install without the
 * setting.
 *
 * Same method as credential-gate-wiring.test.ts: the final settings file after
 * a re-render is asserted, not the inject function alone.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const writersSetting = vi.hoisted(() => ({ value: '' }))
vi.mock('../settings-store.js', async (orig) => {
  const actual = await orig<typeof import('../settings-store.js')>()
  return {
    ...actual,
    getEffectiveSettingValue: (key: string) =>
      key === 'SELF_PACE_SCHEDULE_WRITERS' ? writersSetting.value : actual.getEffectiveSettingValue(key),
  }
})

import {
  gateDecision,
  scheduleSurfaceDeny,
  dataResidue,
  shellWords,
  // @ts-expect-error: plain .mjs hook script, no types
} from '../../scripts/self-pace-gate.mjs'
import {
  injectSelfPaceGate,
  scheduleDoctrineText,
  ensureGovernanceGateCommands,
  writeAgentSettingsFromProfile,
  agentSettingsPath,
  agentRunsStrict,
} from '../web/agent-scaffold.js'
import {
  SELF_PACE_SCHEDULE_WRITE_FLAG,
  agentGetsScheduleWrite,
  parseScheduleWriters,
} from '../web/self-pace-schedule-writers.js'
import { loadProfileTemplate, type ProfileTemplate } from '../web/profiles.js'
import { MAIN_AGENT_ID, PROJECT_ROOT } from '../config.js'
import { AGENTS_BASE_DIR } from '../web/agent-config.js'

const GATE = join(PROJECT_ROOT, 'scripts', 'self-pace-gate.mjs')
const API_WRITE = 'curl -q -X POST http://localhost:3420/api/schedules -d @x.json'
const ON = { allowScheduleWrite: true }
const denyBoth = (command: string) => {
  expect(gateDecision('Bash', { command }, {}).deny, `without: ${command}`).toBe(true)
  expect(gateDecision('Bash', { command }, ON).deny, `with: ${command}`).toBe(true)
}

describe('the hook: the flag opens the schedule API write route and nothing else', () => {
  it('a schedule API write is denied without the flag (today\'s behavior)', () => {
    expect(gateDecision('Bash', { command: API_WRITE }).deny).toBe(true)
    expect(gateDecision('Bash', { command: API_WRITE }, {}).deny).toBe(true)
    expect(gateDecision('Bash', { command: API_WRITE }, { allowScheduleWrite: false }).deny).toBe(true)
  })

  it('the same write is allowed with the flag', () => {
    expect(gateDecision('Bash', { command: API_WRITE }, ON).deny).toBe(false)
  })

  it('only a literal true counts as the flag', () => {
    for (const v of ['true', 1, 'yes', {}, [], null, undefined]) {
      expect(gateDecision('Bash', { command: API_WRITE }, { allowScheduleWrite: v }).deny).toBe(true)
    }
  })

  it('the self-schedule store and the schedule directory stay denied WITH the flag too', () => {
    const store = { file_path: '/home/agent/.claude/scheduled_tasks.json', content: '{}' }
    const dirFile = { file_path: '/home/agent/.claude/scheduled-tasks/x/SKILL.md', content: 'x' }
    for (const opts of [{}, ON]) {
      expect(gateDecision('Write', store, opts).deny, 'Write store').toBe(true)
      expect(gateDecision('Edit', store, opts).deny, 'Edit store').toBe(true)
      expect(gateDecision('Write', dirFile, opts).deny, 'Write dir').toBe(true)
      expect(gateDecision('Bash', { command: 'echo "{}" > ~/.claude/scheduled_tasks.json' }, opts).deny, 'Bash store').toBe(true)
      expect(gateDecision('Bash', { command: 'echo x > ~/.claude/scheduled-tasks/x/SKILL.md' }, opts).deny, 'Bash dir').toBe(true)
      expect(gateDecision('Bash', { command: 'mkdir -p ~/.claude/scheduled-tasks/new && echo x > ~/.claude/scheduled-tasks/new/SKILL.md' }, opts).deny, 'Bash mkdir dir').toBe(true)
    }
  })

  it('the dashboard database file and the schedule table SQL stay denied with the flag; a read passes', () => {
    for (const command of [
      'cp x.db store/claudeclaw.db',
      'cp x.db /home/me/marveen/store/claudeclaw.db',
      'rm store/claudeclaw.db',
      'mv x.db store/claudeclaw.db',
      'truncate -s 0 store/claudeclaw.db',
      'dd if=x.db of=store/claudeclaw.db',
      'tee store/claudeclaw.db < x.db',
      'sqlite3 store/claudeclaw.db ".restore x.db"',
      'sqlite3 store/claudeclaw.db ".read evil.sql"',
      'sqlite3 store/claudeclaw.db "INSERT INTO scheduled_tasks(name) VALUES(\'x\')"',
      // the allowed API write must not carry a database file write along
      `${API_WRITE}; rm store/claudeclaw.db`,
      `${API_WRITE} && cp x.db store/claudeclaw.db`,
    ]) {
      expect(gateDecision('Bash', { command }, {}).deny, `without: ${command}`).toBe(true)
      expect(gateDecision('Bash', { command }, ON).deny, `with: ${command}`).toBe(true)
    }
    const read = { command: 'sqlite3 store/claudeclaw.db "SELECT name FROM scheduled_tasks"' }
    expect(gateDecision('Bash', read, {}).deny).toBe(false)
    expect(gateDecision('Bash', read, ON).deny).toBe(false)
  })

  it('the registry tool stays denied with the flag', () => {
    for (const command of [
      'node dist/web/schedule-registry-cli.js register evil',
      'npx tsx src/web/schedule-registry.ts unregister x',
    ]) {
      expect(gateDecision('Bash', { command }, {}).deny, `without: ${command}`).toBe(true)
      expect(gateDecision('Bash', { command }, ON).deny, `with: ${command}`).toBe(true)
    }
  })

  it('every self-pacing route stays denied with the flag', () => {
    for (const t of ['ScheduleWakeup', 'CronCreate', 'CronDelete', 'CronList', 'RemoteTrigger']) {
      expect(gateDecision(t, {}, ON).deny).toBe(true)
    }
    for (const command of [
      'tmux send-keys -t agent-dev2 Enter',
      'tmux \\\n  send-keys -t agent-dev2 Enter',
      '(crontab -l; echo "*/5 * * * * claude -p poll") | crontab -',
      'echo "claude -p go" | at now + 5 minutes',
      'launchctl submit -l self -- node respawn.mjs',
      'claude /loop "keep polling"',
    ]) {
      expect(gateDecision('Bash', { command }, ON).deny, command).toBe(true)
    }
  })

  it('the egress allowlist stays protected with the flag', () => {
    const root = mkdtempSync(join(tmpdir(), 'schedwrite-'))
    try {
      mkdirSync(join(root, 'store'), { recursive: true })
      const allowlistPath = join(root, 'store', 'egress-allowlist.json')
      writeFileSync(allowlistPath, '{}')
      const opts = { ...ON, allowlistPath, cwd: root }
      expect(gateDecision('Bash', { command: "echo '{}' > store/egress-allowlist.json" }, opts).deny).toBe(true)
      expect(gateDecision('Bash', { command: 'cat store/egress-allowlist.json' }, opts).deny).toBe(false)
      // the native file tools, with the flag
      expect(gateDecision('Write', { file_path: allowlistPath, content: '{}' }, opts).deny).toBe(true)
      expect(gateDecision('Edit', { file_path: allowlistPath, old_string: 'a', new_string: 'b' }, opts).deny).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('unrelated tool calls are unaffected in both directions', () => {
    for (const opts of [{}, ON]) {
      expect(gateDecision('Bash', { command: 'git status && ls -la' }, opts).deny).toBe(false)
      expect(gateDecision('Read', {}, opts).deny).toBe(false)
    }
  })
})

describe('the flag opens a curl POST that creates a schedule, not the other operations', () => {
  const U = 'http://localhost:3420/api/schedules'

  it('the create POST, in every curl spelling that proves the method, is allowed with the flag and denied without', () => {
    for (const command of [
      `curl -q -X POST ${U} -d @x.json`,
      `curl -q -s -X POST ${U} -H 'Content-Type: application/json' -d '{"name":"daily","cron":"0 9 * * *"}'`,
      `curl -q -sS --request POST ${U} --data-binary @x.json`,
      `curl -q --request=POST ${U} -d @x.json`,
      `curl -q -XPOST ${U} -d @x.json`,
      `curl -q --json @x.json ${U}`,
      `curl -q ${U} -d @x.json`,
      `curl --disable -X POST ${U} -d @x.json`,
      `/usr/bin/curl -q -X POST ${U} -d @x.json`,
    ]) {
      expect(gateDecision('Bash', { command }, {}).deny, `without: ${command}`).toBe(true)
      expect(gateDecision('Bash', { command }, ON).deny, `with: ${command}`).toBe(false)
    }
  })

  it('the documented token header (absolute path of the token file) is accepted; a relative path is not', () => {
    const root = mkdtempSync(join(tmpdir(), 'schedwrite-tok-'))
    try {
      mkdirSync(join(root, 'store'), { recursive: true })
      const tok = join(root, 'store', '.dashboard-token')
      writeFileSync(tok, 'abc123\n')
      const opts = { ...ON, projectRoot: root }
      const post = (path: string) =>
        `curl -q -X POST ${U} -H "Authorization: Bearer $(cat ${path})" -H 'Content-Type: application/json' -d @x.json`
      expect(gateDecision('Bash', { command: post(tok) }, opts).deny).toBe(false)
      expect(gateDecision('Bash', { command: post('store/.dashboard-token') }, opts).deny).toBe(true)
      expect(gateDecision('Bash', { command: post(tok) }, { projectRoot: root }).deny).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('PUT, PATCH and DELETE on the schedule API stay denied with the flag', () => {
    for (const command of [
      `curl -q -X PUT ${U}/daily -d @x.json`,
      `curl -q -XPUT ${U}/daily -d @x.json`,
      `curl -q --request=PUT ${U}/daily -d @x.json`,
      `curl -q -X PATCH ${U}/daily -d @x.json`,
      `curl -q -X DELETE ${U}/daily`,
      `curl -q --request DELETE ${U}/pending/3`,
      `curl -q -X DELETE ${U} -d @x.json`,
      `curl -q -T x.json ${U}/daily`,
      `curl -q --upload-file x.json ${U}/daily`,
      // curl uses the LAST -X: the POST in front must not launder the DELETE behind it
      `curl -q -X POST ${U} -d @x.json -X DELETE`,
      `curl -q -X DELETE ${U}/daily -X POST`,
      // a method that is not the exact string POST is not provably a POST
      `curl -q -X post ${U} -d @x.json`,
      `curl -q -X 'POST ' ${U} -d @x.json`,
      // the method can ride in a header
      `curl -q -X POST ${U} -H 'X-HTTP-Method-Override: DELETE' -d @x.json`,
    ]) denyBoth(command)
  })

  it('the POST sub-routes and anything but the create route stay denied with the flag', () => {
    for (const command of [
      `curl -q -X POST ${U}/daily/toggle`,
      `curl -q -X POST ${U}/daily/run`,
      `curl -q -X POST ${U}/expand-prompt -d @x.json`,
      `curl -q -X POST ${U}/ -d @x.json`,
      `curl -q -X POST '${U}?x=1' -d @x.json`,
      `curl -q -X POST http://localhost:3420//api//schedules -d @x.json`,
      `curl -q -X POST http://localhost:3420/api/x/schedules -d @x.json`,
      `curl -q -X POST ${U} ${U}/daily -d @x.json`,
    ]) denyBoth(command)
  })

  it('T1: the create POST needs -q as the FIRST argument, or a curlrc could add a method or a file output', () => {
    // ~/.curlrc is read before the command line; only -q / --disable as the very first argument skips it
    for (const command of [
      `curl -X POST ${U} -d @x.json`,
      `curl -s -X POST ${U} -H 'Content-Type: application/json' -d '{"name":"daily","cron":"0 9 * * *"}'`,
      `curl -sS --request POST ${U} --data-binary @x.json`,
      `curl --json @x.json ${U}`,
      `curl ${U} -d @x.json`,
      `/usr/bin/curl -X POST ${U} -d @x.json`,
      // -q anywhere but first is not honoured by curl
      `curl -s -q -X POST ${U} -d @x.json`,
      `curl -X POST -q ${U} -d @x.json`,
      // a -q in the DATA is not the option
      `curl -X POST ${U} -d '-q'`,
    ]) denyBoth(command)
  })

  it('every other HTTP client stays denied with the flag: its method is not provable from the text', () => {
    for (const command of [
      `python3 -c "import urllib.request as u; u.urlopen(u.Request('${U}/daily', data=b'{}', method='PUT'))"`,
      `python3 -c "import urllib.request as u; u.urlopen(u.Request('${U}', data=b'{}'))"`,
      `node -e "fetch('${U}', {method: 'POST', body: '{}'})"`,
      `wget --method=DELETE ${U}/daily`,
      `wget --post-data='{}' ${U}`,
      `http PUT ${U}/daily name=x`,
    ]) denyBoth(command)
  })

  it('a POST that carries a side channel is not the plain create form', () => {
    for (const command of [
      `curl -q -X POST ${U} -d @x.json -o out.json`,
      `curl -q -X POST ${U} -d @x.json -D hdr.txt`,
      `curl -q -X POST ${U} -d @x.json -c jar.txt`,
      `curl -q -K - -X POST ${U}`,
      `curl -q --config x.cfg ${U} -d @x.json`,
      `curl -q -X POST ${U} -F file=@x.json`,
      `curl -q -X POST ${U} -d @x.json -x http://127.0.0.1:9`,
      // a second request in the same command is judged on its own
      `curl -q -X POST ${U} -d @x.json; curl -X DELETE ${U}/daily`,
      `curl -q -X POST ${U} -d @x.json && curl -T y.json ${U}/daily`,
      // an expansion makes the word count unknown
      `curl -q -X $M ${U} -d @x.json`,
      // the API is the ONLY surface reference the create form may carry
      `curl -q -X POST ${U} -H 'X-Where: ~/.claude/scheduled-tasks/x' -d @x.json`,
      `curl -q -X POST ${U} -H 'X-Where: store/claudeclaw.db' -d @x.json`,
    ]) denyBoth(command)
  })

  it('a GET on the schedule API passes with and without the flag (unchanged)', () => {
    for (const command of [`curl -q -s ${U}`, `curl -q -s ${U}/summary`]) {
      expect(gateDecision('Bash', { command }, {}).deny, `without: ${command}`).toBe(false)
      expect(gateDecision('Bash', { command }, ON).deny, `with: ${command}`).toBe(false)
    }
  })

  it('a request that is neither the plain GET (-q first) nor a POST is not opened by the flag', () => {
    for (const command of [`curl -s ${U}`, `curl ${U}`, `curl -q -G ${U} -d x=1`]) denyBoth(command)
  })
})

describe('a downloader cannot write the dashboard database file', () => {
  const DB = 'store/claudeclaw.db'
  const X = 'http://example.com/x'

  it('curl and wget file-output options naming the database are denied, with and without the flag', () => {
    for (const command of [
      `curl -o ${DB} ${X}`,
      `curl -s -o ${DB} ${X}`,
      `curl -sSo ${DB} ${X}`,
      `curl -sSLo ${DB} ${X}`,
      `curl -o${DB} ${X}`,
      `curl --output ${DB} ${X}`,
      `curl --output=${DB} ${X}`,
      `curl --out ${DB} ${X}`,
      `curl -D ${DB} ${X}`,
      `curl --dump-header ${DB} ${X}`,
      `curl -c ${DB} ${X}`,
      `curl --cookie-jar ${DB} ${X}`,
      `curl --trace ${DB} ${X}`,
      `curl -O http://example.com/${DB}`,
      `curl --remote-name http://example.com/${DB}`,
      `curl -K ${DB} ${X}`,
      `wget -O ${DB} ${X}`,
      `wget -qO ${DB} ${X}`,
      `wget --output-document=${DB} ${X}`,
      `wget -o ${DB} ${X}`,
      `wget -P store http://example.com/claudeclaw.db`,
      `/usr/bin/curl -o ${DB} ${X}`,
    ]) denyBoth(command)
  })

  it('a downloader that only MENTIONS the database file, or only reads, is not a write', () => {
    for (const command of [
      `curl -s -X POST http://localhost:3420/api/notes -d 'see claudeclaw.db'`,
      `curl -sS http://localhost:3420/api/health -H 'X-Note: claudeclaw.db'`,
      // -XDELETE is the method, not -D; -dobject is data, not -o
      `curl -sS -XDELETE http://localhost:3420/api/notes/1 -H 'X-Note: claudeclaw.db'`,
      `curl -sS -d 'o=${DB}' http://localhost:3420/api/notes`,
    ]) {
      expect(gateDecision('Bash', { command }, {}).deny, `without: ${command}`).toBe(false)
      expect(gateDecision('Bash', { command }, ON).deny, `with: ${command}`).toBe(false)
    }
  })
})

describe('the security surface (db-write-gate) does not see the schedule-write flag', () => {
  const SECURITY = { surface: 'security' }
  const WITH_FLAG = { surface: 'security', allowScheduleWrite: true }
  const SQL = `sqlite3 store/claudeclaw.db "UPDATE approvals SET status=1"`

  it('a schedule create POST is no business of the security surface, with or without the flag', () => {
    expect(scheduleSurfaceDeny(API_WRITE, SECURITY)).toBe(false)
    expect(scheduleSurfaceDeny(API_WRITE, WITH_FLAG)).toBe(false)
  })

  it('an SQL write on a security table stays denied with the flag', () => {
    expect(scheduleSurfaceDeny(SQL, SECURITY)).toBe(true)
    expect(scheduleSurfaceDeny(SQL, WITH_FLAG)).toBe(true)
  })

  it('the create form does not carry an SQL write past the security surface', () => {
    for (const command of [
      `${API_WRITE}; ${SQL}`,
      `${API_WRITE} && ${SQL}`,
      `curl -q -X POST http://localhost:3420/api/schedules -d "UPDATE approvals SET status=1"`,
      `curl -q -o store/claudeclaw.db http://localhost:3420/api/schedules`,
    ]) {
      expect(scheduleSurfaceDeny(command, WITH_FLAG), command).toBe(scheduleSurfaceDeny(command, SECURITY))
    }
    expect(scheduleSurfaceDeny(`${API_WRITE}; ${SQL}`, WITH_FLAG)).toBe(true)
  })

  // The security surface keeps the decisions it had before this change; the schedule surface's own rules (the
  // downloader rule, the token-header config on stdin) do not reach it.
  it('the stdin token-header config is not read as data-free on the security surface', () => {
    const root = mkdtempSync(join(tmpdir(), 'schedwrite-sec-'))
    try {
      mkdirSync(join(root, 'store'), { recursive: true })
      const tok = join(root, 'store', '.dashboard-token')
      writeFileSync(tok, 'abc123\n')
      const head = `printf 'header = "Authorization: Bearer %s"\\n' "$(cat ${tok})"`
      const post = (body: string) => `${head} | curl -K - -X POST http://localhost:3420/api/messages -d '${body}'`
      for (const extra of [{}, { allowScheduleWrite: true }]) {
        const opts = { surface: 'security', projectRoot: root, ...extra }
        expect(scheduleSurfaceDeny(post('{"content":"UPDATE approvals SET status=1"}'), opts)).toBe(true)
        // a mention of the database file in a message is no write, as before
        expect(scheduleSurfaceDeny(post('{"content":"see store/claudeclaw.db"}'), opts)).toBe(false)
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('the bus recipe\'s json.dumps text is not rewritten away on the security surface: a text naming a security table stays denied', () => {
    const root = mkdtempSync(join(tmpdir(), 'schedwrite-sec-bus-'))
    try {
      mkdirSync(join(root, 'store'), { recursive: true })
      const tok = join(root, 'store', '.dashboard-token')
      writeFileSync(tok, 'abc123\n')
      const dumps = (text: string) =>
        `--data-binary "$(python3 -c 'import json,sys; print(json.dumps({"status":"done","result":sys.argv[1]}))' '${text}')"`
      const header = `-H "Authorization: Bearer $(cat ${tok})" -H 'Content-Type: application/json'`
      const config = `printf 'header = "Authorization: Bearer %s"\\n' "$(cat ${tok})" |`
      const recipes = (text: string) => [
        `curl -q -s -X PUT http://localhost:3420/api/messages/12 ${header} ${dumps(text)}`,
        `${config} curl -K - -X PUT http://localhost:3420/api/messages/12 ${dumps(text)}`,
      ]
      for (const extra of [{}, { allowScheduleWrite: true }]) {
        const opts = { surface: 'security', projectRoot: root, ...extra }
        for (const text of ['UPDATE approvals SET status=1', 'see store/claudeclaw.db']) {
          for (const command of recipes(text)) expect(scheduleSurfaceDeny(command, opts), command).toBe(true)
        }
        // a text that names nothing of the surface is no reference at all
        for (const command of recipes('all done')) expect(scheduleSurfaceDeny(command, opts), command).toBe(false)
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('the downloader rule is the schedule surface\'s: the security surface decides a curl -o as before', () => {
    expect(scheduleSurfaceDeny(`curl -q -s -o store/claudeclaw.db http://x/`, SECURITY)).toBe(false)
    expect(scheduleSurfaceDeny(`curl -q -s -o store/claudeclaw.db http://x/`, WITH_FLAG)).toBe(false)
    expect(gateDecision('Bash', { command: `curl -q -s -o store/claudeclaw.db http://x/` }, {}).deny).toBe(true)
  })

  it('dataResidue keeps a curl with a config file whole unless the caller proved the stdin header', () => {
    const text = `curl -K - -X POST http://localhost:3420/api/messages -d 'store/claudeclaw.db'`
    const words = shellWords(text)
    const seg = { own: text, bodies: [], text }
    expect(dataResidue(seg, words, 'curl', SECURITY)).toBe(text)
    expect(dataResidue(seg, words, 'curl', undefined)).toBe(text)
    expect(dataResidue(seg, words, 'curl', undefined, true)).not.toBe(text)
  })
})

describe('the hook entrypoint (spawned)', () => {
  const run = (args: string[], payload: unknown) => {
    const out = execFileSync(process.execPath, [GATE, ...args], {
      input: JSON.stringify(payload),
      timeout: 15_000,
    }).toString()
    return out ? JSON.parse(out) : null
  }
  const bash = (command: string) => ({ tool_name: 'Bash', tool_input: { command } })

  it('without the flag, a schedule API write gets the governance deny', () => {
    const res = run([], bash(API_WRITE))
    expect(res.hookSpecificOutput.permissionDecision).toBe('deny')
    expect(res.hookSpecificOutput.permissionDecisionReason).toContain('governance hard-gate')
  })

  it('with the flag on argv, the same write passes', () => {
    expect(run([SELF_PACE_SCHEDULE_WRITE_FLAG], bash(API_WRITE))).toBeNull()
  })

  it('with the flag, a self-pacing route is still denied', () => {
    const res = run([SELF_PACE_SCHEDULE_WRITE_FLAG], bash('tmux send-keys -t agent-dev2 Enter'))
    expect(res.hookSpecificOutput.permissionDecision).toBe('deny')
    const wake = run([SELF_PACE_SCHEDULE_WRITE_FLAG], { tool_name: 'ScheduleWakeup', tool_input: {} })
    expect(wake.hookSpecificOutput.permissionDecision).toBe('deny')
  })
})

describe('parseScheduleWriters', () => {
  it('splits, trims, and keeps valid names', () => {
    expect(parseScheduleWriters(' assistant , ops-1,a.b_c ').names).toEqual(['assistant', 'ops-1', 'a.b_c'])
  })

  it('an empty or missing value grants nothing', () => {
    for (const v of ['', '  ', ',,', undefined, null]) {
      expect(parseScheduleWriters(v as string).names).toEqual([])
    }
  })

  it('an invalid element is skipped and reported, never turned into a grant', () => {
    const r = parseScheduleWriters('good, bad name,-lead, ../x,' + 'x'.repeat(51) + ',ok2')
    expect(r.names).toEqual(['good', 'ok2'])
    expect(r.invalid).toHaveLength(4)
  })
})

describe('agentGetsScheduleWrite', () => {
  it('grants a listed sub-agent only', () => {
    expect(agentGetsScheduleWrite('assistant', ['assistant'])).toBe(true)
    expect(agentGetsScheduleWrite('other', ['assistant'])).toBe(false)
    expect(agentGetsScheduleWrite('assistant', [])).toBe(false)
  })

  it('never applies to the main agent, even when listed', () => {
    expect(agentGetsScheduleWrite(MAIN_AGENT_ID, [MAIN_AGENT_ID])).toBe(false)
  })
})

describe('injectSelfPaceGate with the flag', () => {
  const innerCommand = (s: Record<string, unknown>): string => {
    const pre = (s.hooks as Record<string, unknown>).PreToolUse as Array<Record<string, unknown>>
    expect(pre).toHaveLength(1)
    return (pre[0].hooks as Array<{ command: string }>)[0].command
  }

  it('the default call keeps the command free of the flag', () => {
    const s: Record<string, unknown> = {}
    injectSelfPaceGate(s)
    expect(innerCommand(s)).not.toContain(SELF_PACE_SCHEDULE_WRITE_FLAG)
    const t: Record<string, unknown> = {}
    injectSelfPaceGate(t, false)
    expect(innerCommand(t)).toBe(innerCommand(s))
  })

  it('scheduleWrite=true rides inside the invocation, right after the script path', () => {
    const s: Record<string, unknown> = {}
    injectSelfPaceGate(s, true)
    const cmd = innerCommand(s)
    expect(cmd).toContain(`self-pace-gate.mjs" ${SELF_PACE_SCHEDULE_WRITE_FLAG};`)
    expect(cmd.endsWith(` ${SELF_PACE_SCHEDULE_WRITE_FLAG}`)).toBe(false)
  })

  it('re-applying toggles cleanly in both directions', () => {
    const s: Record<string, unknown> = {}
    injectSelfPaceGate(s, true)
    injectSelfPaceGate(s, false)
    expect(innerCommand(s)).not.toContain(SELF_PACE_SCHEDULE_WRITE_FLAG)
    injectSelfPaceGate(s, true)
    expect(innerCommand(s)).toContain(SELF_PACE_SCHEDULE_WRITE_FLAG)
  })
})

describe('the rendered settings file and the startup migration', () => {
  const TEST_AGENT = 'schedwrite-probe'
  const settingsFor = (n: string) => agentSettingsPath(n)
  // never render MAIN_AGENT_ID: its settings path is the owner's live file.
  const agentRoot = (n: string) => join(AGENTS_BASE_DIR, n)
  const BASE: ProfileTemplate = loadProfileTemplate('default')

  function cleanup(): void {
    const root = agentRoot(TEST_AGENT)
    if (!existsSync(root)) return
    if (!root.startsWith(join(AGENTS_BASE_DIR, TEST_AGENT))) {
      throw new Error(`refusing: ${root} is outside the agents base dir`)
    }
    if (existsSync(join(root, 'CLAUDE.md')) || existsSync(join(root, 'HANDOFF.md'))) {
      throw new Error(`refusing: ${root} looks like a live agent, not a test checkout`)
    }
    rmSync(root, { recursive: true, force: true })
  }

  beforeEach(() => { writersSetting.value = ''; cleanup() })
  afterEach(() => { writersSetting.value = ''; cleanup() })

  type Settings = { hooks: { PreToolUse: Array<{ matcher: string; hooks: Array<{ command: string }> }> } }
  const paceEntries = (s: string) =>
    (JSON.parse(s) as Settings).hooks.PreToolUse.filter((e) => JSON.stringify(e).includes('self-pace-gate.mjs'))

  function render(fresh = true): string {
    if (fresh) cleanup()
    mkdirSync(join(agentRoot(TEST_AGENT), '.claude'), { recursive: true })
    writeAgentSettingsFromProfile(TEST_AGENT, BASE)
    return readFileSync(settingsFor(TEST_AGENT), 'utf-8')
  }

  it('an empty list renders the unflagged command, and the migration leaves it alone', () => {
    const before = render()
    const entries = paceEntries(before)
    expect(entries).toHaveLength(1)
    expect(entries[0].hooks[0].command).not.toContain(SELF_PACE_SCHEDULE_WRITE_FLAG)
    expect(ensureGovernanceGateCommands(TEST_AGENT, BASE)).toBe(false)
    expect(readFileSync(settingsFor(TEST_AGENT), 'utf-8')).toBe(before)
  })

  it('a listed agent gets exactly one flagged self-pace entry, and nothing else moves', () => {
    const off = render()
    writersSetting.value = `other,${TEST_AGENT}`
    const on = render()
    const entries = paceEntries(on)
    expect(entries).toHaveLength(1)
    expect(entries[0].hooks[0].command).toContain(SELF_PACE_SCHEDULE_WRITE_FLAG)
    // on minus the flag equals off: the switch changes the one command only
    expect(on.split(` ${SELF_PACE_SCHEDULE_WRITE_FLAG}`).join('')).toBe(off)
  })

  it('an agent that is not on the list stays unflagged while another is listed', () => {
    writersSetting.value = 'someone-else'
    expect(paceEntries(render())[0].hooks[0].command).not.toContain(SELF_PACE_SCHEDULE_WRITE_FLAG)
  })

  it('the migration applies a grant that arrived after the agent was scaffolded', () => {
    render()
    writersSetting.value = TEST_AGENT
    expect(ensureGovernanceGateCommands(TEST_AGENT, BASE)).toBe(true)
    const entries = paceEntries(readFileSync(settingsFor(TEST_AGENT), 'utf-8'))
    expect(entries).toHaveLength(1)
    expect(entries[0].hooks[0].command).toContain(SELF_PACE_SCHEDULE_WRITE_FLAG)
    expect(ensureGovernanceGateCommands(TEST_AGENT, BASE)).toBe(false)
  })

  it('the migration removes the flag when the agent leaves the list (revocation)', () => {
    writersSetting.value = TEST_AGENT
    render()
    writersSetting.value = ''
    expect(ensureGovernanceGateCommands(TEST_AGENT, BASE)).toBe(true)
    const entries = paceEntries(readFileSync(settingsFor(TEST_AGENT), 'utf-8'))
    expect(entries).toHaveLength(1)
    expect(entries[0].hooks[0].command).not.toContain(SELF_PACE_SCHEDULE_WRITE_FLAG)
  })

  it('the flagged pace gate and the db-write-gate share one settings file; the migration repairs the one that is missing', () => {
    writersSetting.value = TEST_AGENT
    const on = render()
    const dbEntries = (s: string) =>
      (JSON.parse(s) as Settings).hooks.PreToolUse.filter((e) => JSON.stringify(e).includes('db-write-gate.mjs'))
    expect(dbEntries(on)).toHaveLength(1)
    const settings = JSON.parse(on) as Settings
    settings.hooks.PreToolUse = settings.hooks.PreToolUse.filter((e) => !JSON.stringify(e).includes('db-write-gate.mjs'))
    writeFileSync(settingsFor(TEST_AGENT), JSON.stringify(settings, null, 2))
    expect(ensureGovernanceGateCommands(TEST_AGENT, BASE)).toBe(true)
    const after = readFileSync(settingsFor(TEST_AGENT), 'utf-8')
    expect(dbEntries(after)).toHaveLength(1)
    const entries = paceEntries(after)
    expect(entries).toHaveLength(1)
    expect(entries[0].hooks[0].command).toContain(SELF_PACE_SCHEDULE_WRITE_FLAG)
    expect(ensureGovernanceGateCommands(TEST_AGENT, BASE)).toBe(false)
  })

  // The doctrine of a strict agent forbids the schedule write, so its hook must not open
  // the route either - the grant never reaches a strict profile, listed or not.
  const STRICT: ProfileTemplate = loadProfileTemplate('developer-junior')

  it('the strict fixture profile is strict', () => {
    expect(agentRunsStrict(TEST_AGENT, STRICT)).toBe(true)
    expect(agentRunsStrict(TEST_AGENT, BASE)).toBe(false)
  })

  function renderStrict(): string {
    cleanup()
    mkdirSync(join(agentRoot(TEST_AGENT), '.claude'), { recursive: true })
    writeAgentSettingsFromProfile(TEST_AGENT, STRICT)
    return readFileSync(settingsFor(TEST_AGENT), 'utf-8')
  }

  it('a strict agent that is listed renders the unflagged command: the hook does not open the route', () => {
    writersSetting.value = TEST_AGENT
    const entries = paceEntries(renderStrict())
    expect(entries).toHaveLength(1)
    expect(entries[0].hooks[0].command).not.toContain(SELF_PACE_SCHEDULE_WRITE_FLAG)
  })

  it('a strict agent that is listed is left alone by the migration (nothing to flag)', () => {
    writersSetting.value = TEST_AGENT
    const before = renderStrict()
    expect(ensureGovernanceGateCommands(TEST_AGENT, STRICT)).toBe(false)
    expect(readFileSync(settingsFor(TEST_AGENT), 'utf-8')).toBe(before)
  })

  it('the migration removes a flag that a now-strict agent still carries', () => {
    writersSetting.value = TEST_AGENT
    expect(paceEntries(render())[0].hooks[0].command).toContain(SELF_PACE_SCHEDULE_WRITE_FLAG)
    expect(ensureGovernanceGateCommands(TEST_AGENT, STRICT)).toBe(true)
    const entries = paceEntries(readFileSync(settingsFor(TEST_AGENT), 'utf-8'))
    expect(entries).toHaveLength(1)
    expect(entries[0].hooks[0].command).not.toContain(SELF_PACE_SCHEDULE_WRITE_FLAG)
    expect(ensureGovernanceGateCommands(TEST_AGENT, STRICT)).toBe(false)
  })

  it('an invalid name in the list grants nothing', () => {
    writersSetting.value = `bad name,../${TEST_AGENT},-${TEST_AGENT}`
    expect(paceEntries(render())[0].hooks[0].command).not.toContain(SELF_PACE_SCHEDULE_WRITE_FLAG)
  })

  it('the migration never touches the main agent', () => {
    writersSetting.value = MAIN_AGENT_ID
    expect(ensureGovernanceGateCommands(MAIN_AGENT_ID)).toBe(false)
  })

  it('the only code paths to the flag are behind the predicate (pinned in source)', () => {
    const src = readFileSync(join(PROJECT_ROOT, 'src', 'web', 'agent-scaffold.ts'), 'utf-8')
    expect(src).toContain('injectSelfPaceGate(existing, agentGetsScheduleWriteFlag(name, profile))')
    expect(src).toContain('agentGetsGovernanceGates(name) && agentGetsScheduleWriteFlag(name, profile)')
    expect(src).toContain('injectSelfPaceGate(settings, scheduleWrite)')
    expect(src.match(/injectSelfPaceGate\((existing|settings),/g)).toHaveLength(2)
  })
})

describe('the sub-agent doctrine paragraph', () => {
  it('the default agent keeps the categorical ban', () => {
    const t = scheduleDoctrineText(false)
    expect(t).toContain('Ütemezést NEM hozhatsz létre')
    expect(t).not.toContain('CSAK a dashboard ütemező API-n')
  })

  it('a listed agent is told the one route that is open, and what stays closed', () => {
    const t = scheduleDoctrineText(true)
    expect(t).toContain('CSAK a dashboard ütemező API-n')
    expect(t).toContain('/api/schedules')
    expect(t).not.toContain('Ütemezést NEM hozhatsz létre')
    for (const closed of ['scheduled-tasks', 'scheduled_tasks.json', 'SQLite', 'schedule-registry', 'ScheduleWakeup']) {
      expect(t).toContain(closed)
    }
  })
})
