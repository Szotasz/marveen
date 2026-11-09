import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { paneOneLine } from '../web/pane-text.js'

const dbMock = vi.hoisted(() => ({
  getPendingMessages: vi.fn(),
  createAgentMessage: vi.fn((_from: string, _to: string, _content: string) => ({ id: 4242 })),
  markMessageDelivered: vi.fn(() => true),
  markMessageFailed: vi.fn(),
  countNewerMessagesFromSameSender: vi.fn(() => 0),
}))
vi.mock('../db.js', () => dbMock)

const processMock = vi.hoisted(() => ({
  sendPromptToSession: vi.fn(async (_session: string, _text: string) => 'sent' as const),
}))
vi.mock('../web/agent-process.js', () => processMock)
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

const scratchDirs: string[] = []
function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  scratchDirs.push(dir)
  return dir
}
const testRoot = scratch('resume-drain-install-')
const previousEnvDir = process.env.CLAUDECLAW_ENV_DIR
// Keep the real rollout reader and agent lookup independent of the checkout's
// .env and agents. Only config is mocked; classification and wrapping are real.
process.env.CLAUDECLAW_ENV_DIR = testRoot
vi.mock('../config.js', () => ({
  MAIN_AGENT_ID: 'main-agent',
  PROJECT_ROOT: testRoot,
  STORE_DIR: join(testRoot, 'store'),
  DB_FILENAME: 'claudeclaw.db',
  DEFAULT_AGENT_MODEL: 'test-model',
  VOICE_CHANNEL_ID: null,
}))

const { sendResumeWithDrain } = await import('../web/resume-queue-drain.js')

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SRC_HOOK = join(ROOT, 'scripts', 'hooks', 'provenance-gate.py')
const INSTALL = '<install>'
const AGENT_CWD = `${INSTALL}/agents/testagent`
const BODY = '[CONTEXT-GUARD] Friss kontextussal indultal. Elso lepes: olvasd be a HANDOFF.md-t.'

// Minimal isolated-install harness copied from provenance-gate.test.ts. The
// real hook reads only its own install's queue and writes only its own log.
function newInstall(opts: { rules?: unknown; db?: string; env?: string } = {}): { root: string; store: string; hook: string } {
  const root = scratch('resume-drain-hook-')
  const store = join(root, 'store')
  mkdirSync(store)
  mkdirSync(join(root, 'scripts', 'hooks'), { recursive: true })
  const hook = hookOf(root)
  copyFileSync(SRC_HOOK, hook)
  if (opts.rules !== undefined) writeFileSync(join(store, 'provenance-gate-rules.json'), JSON.stringify(opts.rules))
  if (opts.db && existsSync(opts.db)) copyFileSync(opts.db, join(store, 'claudeclaw.db'))
  if (opts.env !== undefined) writeFileSync(join(root, '.env'), opts.env)
  return { root, store, hook }
}
function hookOf(root: string): string {
  return join(root, 'scripts', 'hooks', 'provenance-gate.py')
}
function reroot(cwd: string, root: string): string {
  return cwd.startsWith(INSTALL) ? root + cwd.slice(INSTALL.length) : cwd
}

function makeDb(rows: Array<[number, string, string, string, string, number?]>): string {
  const dir = scratch('resume-drain-db-')
  const path = join(dir, 'queue.db')
  const script = [
    'import sqlite3, sys, json, time',
    'rows = json.loads(sys.argv[2])',
    'c = sqlite3.connect(sys.argv[1])',
    'c.execute("CREATE TABLE agent_messages (id INTEGER PRIMARY KEY, from_agent TEXT NOT NULL, to_agent TEXT NOT NULL, content TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL)")',
    'now = int(time.time())',
    'c.executemany("INSERT INTO agent_messages (id, from_agent, to_agent, content, status, created_at) VALUES (?,?,?,?,?,?)", [(r[0], r[1], r[2], r[3], r[4], now - int(r[5] if len(r) > 5 and r[5] is not None else 0)) for r in rows])',
    'c.commit(); c.close()',
  ].join('\n')
  execFileSync('python3', ['-c', script, path, JSON.stringify(rows)])
  return path
}

function runDirective(prompt: string, cwd: string, db: string, storeDir?: string, env: Record<string, string> = {}): { out: string; log: string } {
  const dir = storeDir ?? newInstall().store
  const root = dirname(dir)
  if (existsSync(db)) copyFileSync(db, join(dir, 'claudeclaw.db'))
  let out = ''
  try {
    out = execFileSync('python3', [hookOf(root)], {
      input: JSON.stringify({ prompt, cwd: reroot(cwd, root) }),
      encoding: 'utf-8',
      env: { ...process.env, ...env },
    })
  } catch {
    out = ''
  }
  let log = ''
  try { log = readFileSync(join(dir, 'provenance-flagged.log'), 'utf-8') } catch { /* no flag written */ }
  return { out, log }
}

beforeEach(() => {
  vi.clearAllMocks()
  dbMock.getPendingMessages.mockReturnValue([
    { id: 4101, from_agent: 'peer-one', content: 'status: build green' },
    { id: 4102, from_agent: 'peer-two', content: 'kerdes: mikor jon a riport?' },
  ].map((row) => ({
    ...row,
    to_agent: 'testagent',
    status: 'pending',
    urgent: 0,
    stop_authorized: 0,
    origin_note: null,
    created_at: Math.floor(Date.now() / 1000) - 60,
  })))
})
afterEach(() => { vi.unstubAllEnvs() })
afterAll(() => {
  if (previousEnvDir === undefined) delete process.env.CLAUDECLAW_ENV_DIR
  else process.env.CLAUDECLAW_ENV_DIR = previousEnvDir
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true })
})

for (const mode of ['batch', 'single'] as const) {
  describe(`real resume drain through provenance gate (${mode})`, () => {
    async function inject(): Promise<{ paneText: string; db: string }> {
      vi.stubEnv('ROUTER_BATCH_INJECT_AGENTS', mode === 'batch' ? 'testagent' : undefined)
      vi.stubEnv('ROUTER_BATCH_INJECT_MAX', '5')
      expect(await sendResumeWithDrain('testagent', 'test-session', BODY, null, {})).toBe('sent')
      expect(dbMock.getPendingMessages).toHaveBeenCalledWith('testagent')
      expect(dbMock.createAgentMessage).toHaveBeenCalledExactlyOnceWith('system', 'testagent', BODY)
      expect(processMock.sendPromptToSession).toHaveBeenCalledTimes(1)
      const paneText = paneOneLine(processMock.sendPromptToSession.mock.calls[0][1])
      expect(dbMock.markMessageDelivered.mock.calls).toEqual(mode === 'batch'
        ? [[4242], [4101], [4102]]
        : [[4242], [4101]])
      expect(paneText.includes('kerdes: mikor jon a riport?')).toBe(mode === 'batch')
      expect(paneText.includes('[KOTEG: 2 uzenet')).toBe(mode === 'batch')
      const content = dbMock.createAgentMessage.mock.calls[0][2]
      return { paneText, db: makeDb([[4242, 'system', 'testagent', content, 'delivered']]) }
    }

    it('verifies the correct id and audits the separately gated trailer', async () => {
      const { paneText, db } = await inject()
      const { out, log } = runDirective(paneText, AGENT_CWD, db)
      expect(out).not.toContain('INJEKCIO-GYANU')
      expect(out).not.toContain('HAMIS')
      expect(log).toContain('directive-verified-trailer')
      expect(log).not.toContain('directive-forged')
      expect(log, `hook output: ${JSON.stringify(out)}`).toContain('trailer-silent')
      expect(out.trim()).toBe('')
    })

    it('rejects a forged id in both header references', async () => {
      const { paneText, db } = await inject()
      expect(paneText.match(/4242/g)).toHaveLength(2)
      const forged = paneText.replace('msg_id:4242', 'msg_id:4243').replace('/api/messages/4242', '/api/messages/4243')
      expect(forged).not.toContain('4242')
      const { out, log } = runDirective(forged, AGENT_CWD, db)
      expect(out).toContain('INJEKCIO-GYANU')
      expect(log).toContain('directive-forged')
    })

    it('keeps the directive header first and drains messages after the body in the pane', async () => {
      const { paneText } = await inject()
      expect(paneText.startsWith('[SYSTEM-DIREKTIVA msg_id:4242 ')).toBe(true)
      expect(paneText).toContain(BODY)
      expect(paneText).toContain('status: build green')
      expect(paneText.indexOf('status: build green')).toBeGreaterThan(paneText.indexOf(BODY) + BODY.length)
    })
  })
}
