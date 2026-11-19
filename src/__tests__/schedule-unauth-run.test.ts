import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { sessionAuthFailedSince } from '../web/delivery-integrity.js'
import { checkTaskAuthFailure } from '../web/schedule-runner.js'
import { projectsDirFor } from '../web/active-model.js'

// DOCKERUNAUTHRUN1118: a scheduled prompt typed into a session that is NOT logged in must not end as a
// successful run. Measured 2026-11-18 on a fresh Docker install without a Claude login (srv2127946, container
// marveen-marveen-1, Claude Code 2.1.311): memoria-heartbeat fired at 21:30:09Z and task_runs row 10 closed
// status fired / outcome done / delivery intact, while the pane showed
//   ⎿  Not logged in · Please run /login
//   ✻ Worked for 0s · done 9:30 PM
// The transcript rows of that turn are below, verbatim except the typed prompt's text (2185 chars there; here the
// test's own prompt stands in for it) and the usage object (all zeros there, left out here).

const TYPED_AT = Date.parse('2026-11-18T21:30:08.900Z')

const MEASURED_USER = {
  parentUuid: '0aa03ad5-8afe-49fe-b161-c77472cdc087', isSidechain: false, promptId: '483df4bc-3fae-4132-a304-c1fd74d8eeff',
  type: 'user', message: { role: 'user', content: 'SCHEDULED TASK NOTICE -- [Heartbeat: memoria-heartbeat] <scheduled-task source="scheduled-task:memoria-heartbeat"> ... </scheduled-task>' },
  uuid: 'dc76dc56-9b30-4db6-b8bb-2daef22d7a84', timestamp: '2026-11-18T21:30:09.266Z', permissionMode: 'bypassPermissions',
  origin: { kind: 'human' }, promptSource: 'typed', turnOrigin: 'human', turnPosition: { promptIndex: 2, turnIndex: 2 },
  userType: 'external', entrypoint: 'cli', cwd: '/opt/marveen', sessionId: '19504962-ffad-42e0-bc12-ed9a432bb395', version: '2.1.311', gitBranch: 'HEAD',
}

const MEASURED_AUTH_REPLY = {
  parentUuid: '38674b1d-bf0b-45cc-86de-e9784860133f', isSidechain: false, type: 'assistant', uuid: 'ec4d93f1-cc42-47bb-b2a3-5f4465b355cb',
  timestamp: '2026-11-18T21:30:09.580Z',
  message: {
    diagnostics: null, id: 'e42df91f-f0b1-4be9-b5d9-b12e032ff538', container: null, model: '<synthetic>', role: 'assistant',
    stop_details: null, stop_reason: 'stop_sequence', stop_sequence: '', type: 'message',
    content: [{ type: 'text', text: 'Not logged in · Please run /login' }], context_management: null,
  },
  error: 'authentication_failed', isApiErrorMessage: true, perTurnEffort: 'medium', session_id: '19504962-ffad-42e0-bc12-ed9a432bb395',
  userType: 'external', entrypoint: 'cli', cwd: '/opt/marveen', sessionId: '19504962-ffad-42e0-bc12-ed9a432bb395', version: '2.1.311', gitBranch: 'HEAD',
}

const MEASURED_TURN_DURATION = {
  parentUuid: 'ec4d93f1-cc42-47bb-b2a3-5f4465b355cb', isSidechain: false, type: 'system', subtype: 'turn_duration', durationMs: 355,
  messageCount: 23, timestamp: '2026-11-18T21:30:09.586Z', uuid: 'a98478b7-c731-4b1d-afaa-be2736fe8f8c', isMeta: false,
  userType: 'external', entrypoint: 'cli', cwd: '/opt/marveen', sessionId: '19504962-ffad-42e0-bc12-ed9a432bb395', version: '2.1.311', gitBranch: 'HEAD',
}

// The same structured pair with another wording, seen in this host's own transcripts (a Cloudflare 403 the CLI
// files as an authentication failure): the session could not work either.
const AUTH_REPLY_403 = {
  ...MEASURED_AUTH_REPLY, uuid: 'b0000000-0000-4000-8000-000000000403', apiErrorStatus: 403,
  message: { ...MEASURED_AUTH_REPLY.message, content: [{ type: 'text', text: 'Please run /login · API Error: 403 Attention Required! | Cloudflare' }] },
}

const line = (o: unknown) => JSON.stringify(o) + '\n'
const at = (o: object, timestamp: string) => ({ ...o, timestamp })
const realReply = (timestamp: string) => ({
  type: 'assistant', isSidechain: false, timestamp, message: { model: 'claude-opus-5-5', role: 'assistant', content: [{ type: 'text', text: 'Heartbeat kesz.' }] },
})
const rateLimitReply = (timestamp: string) => ({
  ...MEASURED_AUTH_REPLY, timestamp, error: 'rate_limit', apiErrorStatus: 429,
  message: { ...MEASURED_AUTH_REPLY.message, content: [{ type: 'text', text: "You've hit your weekly limit" }] },
})

describe('sessionAuthFailedSince: the transcript of a not-logged-in session', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'unauth-run-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })
  const write = (rows: string) => writeFileSync(join(dir, 's.jsonl'), rows)

  it('THE MEASURED TURN: typed prompt, synthetic "Not logged in" reply, turn_duration -> true', () => {
    write(line(MEASURED_USER) + line(MEASURED_AUTH_REPLY) + line(MEASURED_TURN_DURATION))
    expect(sessionAuthFailedSince([dir], TYPED_AT)).toBe(true)
  })

  it('the measured file order: the reply row can sit ABOVE its prompt row (21:15 boot turn); timestamps decide', () => {
    write(line(at(MEASURED_AUTH_REPLY, '2026-11-18T21:30:09.580Z')) + line(MEASURED_TURN_DURATION) + line(MEASURED_USER))
    expect(sessionAuthFailedSince([dir], TYPED_AT)).toBe(true)
  })

  it('the same structured pair with another wording (403 Cloudflare) -> true', () => {
    write(line(MEASURED_USER) + line(AUTH_REPLY_403))
    expect(sessionAuthFailedSince([dir], TYPED_AT)).toBe(true)
  })

  it('NEGATIVE: a logged-in session that answered -> false', () => {
    write(line(MEASURED_USER) + line(realReply('2026-11-18T21:30:12.000Z')) + line(MEASURED_TURN_DURATION))
    expect(sessionAuthFailedSince([dir], TYPED_AT)).toBe(false)
  })

  it('NEGATIVE: any real reply in the window -> false (the run worked, the login was lost only afterwards)', () => {
    write(line(MEASURED_USER) + line(realReply('2026-11-18T21:30:12.000Z')) + line(at(MEASURED_AUTH_REPLY, '2026-11-18T21:31:00.000Z')))
    expect(sessionAuthFailedSince([dir], TYPED_AT)).toBe(false)
  })

  it('NEGATIVE: a usage-limit refusal is an API error but not an authentication failure -> false', () => {
    write(line(MEASURED_USER) + line(rateLimitReply('2026-11-18T21:30:09.580Z')))
    expect(sessionAuthFailedSince([dir], TYPED_AT)).toBe(false)
  })

  it('NEGATIVE: an old authentication failure from before typing began does not count', () => {
    write(line(at(MEASURED_AUTH_REPLY, '2026-11-18T21:15:59.365Z')) + line(MEASURED_USER))
    expect(sessionAuthFailedSince([dir], TYPED_AT)).toBe(false)
  })

  it('NEGATIVE: a sidechain (sub-agent) authentication failure is not the session reply', () => {
    write(line(MEASURED_USER) + line({ ...MEASURED_AUTH_REPLY, isSidechain: true }))
    expect(sessionAuthFailedSince([dir], TYPED_AT)).toBe(false)
  })

  it('NEGATIVE: no reply yet, a missing directory, malformed lines -> false, never a throw', () => {
    write(line(MEASURED_USER) + 'not json "assistant"\n')
    expect(sessionAuthFailedSince([dir], TYPED_AT)).toBe(false)
    expect(sessionAuthFailedSince([join(dir, 'nope')], TYPED_AT)).toBe(false)
  })
})

describe('checkTaskAuthFailure (the sweep decision)', () => {
  const base = { typedAt: TYPED_AT, workingDir: '/opt/marveen', configDirs: ['/cfg/a', undefined, '/cfg/a'] as ReadonlyArray<string | undefined> }

  it('reads the transcript dirs of every config root, once each, since typing began', () => {
    let seen: { dirs: readonly string[]; since: number } | null = null
    expect(checkTaskAuthFailure(base, (dirs, since) => { seen = { dirs, since }; return true })).toBe(true)
    expect(seen!.since).toBe(TYPED_AT)
    expect(seen!.dirs).toEqual([projectsDirFor('/opt/marveen', '/cfg/a'), projectsDirFor('/opt/marveen', undefined)])
  })

  it('no typedAt (remote agent, worksource run) -> false without reading', () => {
    let read = false
    expect(checkTaskAuthFailure({ ...base, typedAt: undefined }, () => { read = true; return true })).toBe(false)
    expect(read).toBe(false)
  })

  it('a reader that throws -> false: the run keeps its old ending', () => {
    expect(checkTaskAuthFailure(base, () => { throw new Error('EACCES') })).toBe(false)
  })

  it('end to end on disk: the measured turn under the projects dir of the agent config root -> true', () => {
    const root = mkdtempSync(join(tmpdir(), 'unauth-run-e2e-'))
    try {
      const pdir = projectsDirFor('/opt/marveen', root)
      mkdirSync(pdir, { recursive: true })
      writeFileSync(join(pdir, '19504962-ffad-42e0-bc12-ed9a432bb395.jsonl'), line(MEASURED_USER) + line(MEASURED_AUTH_REPLY) + line(MEASURED_TURN_DURATION))
      expect(checkTaskAuthFailure({ ...base, configDirs: [root] })).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('the sweep records it (source-level: the sweep needs live tmux)', () => {
  const RUNNER = readFileSync(join(__dirname, '../web/schedule-runner.ts'), 'utf-8')
  const DB = readFileSync(join(__dirname, '../db.ts'), 'utf-8')
  const sweepIdx = RUNNER.indexOf('const decision = decideTaskTimeout(entry, state, now, {')
  const unauthIdx = RUNNER.indexOf("if (decision === 'done' && checkTaskAuthFailure(entry)) {", sweepIdx)
  const doneIdx = RUNNER.indexOf("} else if (decision === 'done' || decision === 'abandoned') {", sweepIdx)
  // code lines only: the branch comment names settleOnceAfterRun to say why it is not called
  const branch = RUNNER.slice(unauthIdx, doneIdx).split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')

  it("a 'done' close on a not-logged-in session takes its own branch, ahead of the done/abandoned one", () => {
    expect(sweepIdx).toBeGreaterThan(0)
    expect(unauthIdx).toBeGreaterThan(sweepIdx)
    expect(doneIdx).toBeGreaterThan(unauthIdx)
    // after the delivery verdict is taken, so the delivery column still says what arrived
    expect(RUNNER.indexOf('checkTaskDeliveryIntegrity(entry, closing)', sweepIdx)).toBeLessThan(unauthIdx)
  })

  it("the branch closes the run as 'unauth', warns, and drops the entry; it never counts as a once-task success", () => {
    expect(branch).toContain("markTaskRunCompleted(entry.runId, 'unauth', now)")
    expect(branch).toContain('recorded as unauth, NOT as done')
    expect(branch).toContain('taskInflightMap.delete(key)')
    expect(branch).not.toContain('settleOnceAfterRun')
    expect(branch).not.toContain('markTaskRunCompleted(entry.runId, decision, now)')
  })

  it("'unauth' is a TaskRunOutcome", () => {
    expect(DB).toMatch(/export type TaskRunOutcome = 'done' \| 'abandoned' \| 'lost' \| 'interrupted' \| 'unauth'/)
  })
})
