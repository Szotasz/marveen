import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile, execFileSync, spawnSync } from 'node:child_process'
import { promisify } from 'node:util'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, cpSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// The stand-in dashboard below decides who is a known SENDER with the SERVER'S OWN
// code, not a re-implementation: the same .env grammar (parseEnvContent, last
// occurrence wins) and the same list rule (parseSystemSenderIds over
// sanitizeAgentIdent) that src/web/routes/messages.ts uses.
import { parseEnvContent } from '../env-parse.js'
import { parseSystemSenderIds } from '../config.js'
import { sanitizeAgentIdent } from '../prompt-safety.js'

// WHO the post-checkout alert is sent AS and TO.
//
// The recipient and the stock 'marveen' fallback are develop's (#1569, pinned by
// #1633). What this file adds is the SENDER: the guard sends under its own name
// where SYSTEM_SENDER_IDS registers it, and under the install's main agent id
// where it does not. The recipient is never derived from the sender.
//
// The sibling file (prod-tree-guard-alert-payload.test.ts) covers HOW the body
// is encoded; every test there sets the environment variable, so none of them
// can see this. Hence a separate file.

const execFileAsync = promisify(execFile)

const ROOT = process.cwd()
const SCRIPT = 'install-prod-tree-guard-hook.sh'

// realpath for the same reason as the sibling file: on macOS os.tmpdir() is a
// symlink, and the hook only fires when the physical toplevel matches.
const stage = realpathSync(mkdtempSync(join(tmpdir(), 'prodguard-to-')))

let captured: string[] = []
let rejected: string[] = []
let server: Server
let origin = ''

/** The registered AGENTS this stand-in dashboard knows (a directory under agents/, or
 *  the main agent). Everything else is a stranger unless the SERVER'S reading of the
 *  repo's own .env lists it in SYSTEM_SENDER_IDS: `serverSenders` is set from the .env
 *  of the repo under test before each checkout.
 *
 *  `prod-tree-guard` is deliberately NOT in this set. It used to be, unconditionally,
 *  which made the case "the hook and the server read the list differently" invisible
 *  to the whole file (Sam, 2026-09-30): a hook that picked the guard from the wrong
 *  .env line still got HTTP 200 here. */
const KNOWN_AGENTS = new Set(['sajat-agens', 'idezett-agens', 'env-fajlbol', 'valtozobol', 'probanev', 'alert-recipient'])
let serverSenders = new Set<string>()
/** .env text per repo, so switchTo can hand the server the SAME file the hook reads. */
const envOf = new Map<string, string>()

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8')
      // THE SENDER IS CHECKED HERE BECAUSE PRODUCTION CHECKS IT. The real
      // dashboard answers 403 "unknown agent" to a `from` it does not know,
      // and a stand-in that accepts everything hides exactly the defect that
      // matters: a hardcoded sender name belonging to another install. With a
      // permissive stub, a hook that fixes the RECIPIENT and leaves the SENDER
      // hardcoded looks perfectly green here and fails only in production.
      let from = ''
      try { from = String((JSON.parse(raw) as { from?: unknown }).from ?? '') } catch { from = '' }
      if (!KNOWN_AGENTS.has(from) && !serverSenders.has(from)) {
        rejected.push(raw)
        res.writeHead(403, { 'Content-Type': 'application/json' })
        res.end(`{"error":"unknown agent '${from}'"}`)
        return
      }
      captured.push(raw)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end('{"id":1}')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('no port')
  origin = `http://127.0.0.1:${addr.port}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  rmSync(stage, { recursive: true, force: true })
})

let n = 0
/** A throwaway git repo with the installer under scripts/ and, optionally, a .env. */
function makeRepo(envContent?: string): string {
  const repo = join(stage, `repo-${n++}`)
  mkdirSync(join(repo, 'scripts'), { recursive: true })
  mkdirSync(join(repo, 'store'), { recursive: true })
  execFileSync('git', ['-C', repo, 'init', '-q', '-b', 'develop'])
  writeFileSync(join(repo, 'x.txt'), 'x')
  execFileSync('git', ['-C', repo, 'add', '.'])
  execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'])
  cpSync(join(ROOT, 'scripts', SCRIPT), join(repo, 'scripts', SCRIPT))
  writeFileSync(join(repo, 'store', '.dashboard-token'), 'probe-token\n')
  if (envContent !== undefined) writeFileSync(join(repo, '.env'), envContent)
  envOf.set(repo, envContent ?? '')
  const r = spawnSync('/bin/bash', [join(repo, 'scripts', SCRIPT)], { cwd: repo, encoding: 'utf-8', timeout: 20000 })
  expect(r.status).toBe(0)
  return repo
}

/** Switch branch and return what the hook sent and what it said.
 *
 *  ASYNC ON PURPOSE, see the sibling file: a synchronous child blocks the event
 *  loop that has to answer the hook's curl, and every case goes red on a
 *  5s timeout against an unmodified script.
 *
 *  `waitForPost` is false where the expectation is that NOTHING is sent: there
 *  is no event to wait for, so the wait is replaced by a fixed grace period --
 *  otherwise a silently-sent alert could arrive after the assertion and pass. */
async function switchTo(
  repo: string,
  branch: string,
  extraEnv: Record<string, string>,
  waitForPost = true,
): Promise<{ bodies: string[]; rejected: string[]; stderr: string }> {
  captured = []
  rejected = []
  serverSenders = parseSystemSenderIds(parseEnvContent(envOf.get(repo) ?? '')['SYSTEM_SENDER_IDS'], sanitizeAgentIdent)
  execFileSync('git', ['-C', repo, 'branch', branch])
  const { stderr } = await execFileAsync('git', ['-C', repo, 'checkout', '-q', branch], {
    timeout: 20000,
    env: { ...process.env, MARVEEN_DASHBOARD_ORIGIN: origin, ...extraEnv },
  })
  if (waitForPost) {
    for (let i = 0; i < 100 && captured.length === 0; i++) await new Promise((r) => setTimeout(r, 20))
  } else {
    await new Promise((r) => setTimeout(r, 600))
  }
  return { bodies: [...captured], rejected: [...rejected], stderr }
}

describe('prod-tree-guard post-checkout alert: the recipient comes from the install, not from a constant', () => {
  it('with no environment override, the alert goes to MAIN_AGENT_ID from the .env of the tree that fired', async () => {
    const repo = makeRepo('BOT_NAME=Probe\nMAIN_AGENT_ID=sajat-agens\nSERVICE_ID=probe\n')
    const { bodies } = await switchTo(repo, 'feature-ordinary', {})
    expect(bodies.length).toBe(1)
    expect(JSON.parse(bodies[0]).to).toBe('sajat-agens')
  })

  it('a quoted value in .env is read as the name, not with its quotes', async () => {
    const repo = makeRepo('MAIN_AGENT_ID="idezett-agens"\n')
    const { bodies } = await switchTo(repo, 'feature-ordinary', {})
    expect(bodies.length).toBe(1)
    expect(JSON.parse(bodies[0]).to).toBe('idezett-agens')
  })

  it('the environment variable redirects the RECIPIENT only -- the sender stays the install\'s own id', async () => {
    // The variable is named ALERT_TO, and that is all it may do. If it moved
    // the sender as well, a second tree pointing its alerts at another agent
    // would make them APPEAR TO COME FROM that agent -- the supervisory system
    // writing under someone else's name, which is the defect GATESENDER922
    // removed from the restart gate. Sam asked for this assertion; without it
    // the file measured the recipient in both directions and the sender in
    // neither.
    const repo = makeRepo('MAIN_AGENT_ID=env-fajlbol\n')
    const { bodies, rejected } = await switchTo(repo, 'feature-ordinary', { MARVEEN_GUARD_ALERT_TO: 'valtozobol' })
    expect(rejected).toEqual([])
    expect(bodies.length).toBe(1)
    const p = JSON.parse(bodies[0])
    expect(p.to).toBe('valtozobol')
    expect(p.from).toBe('env-fajlbol')
  })

  it('the SENDER is the install\'s own id too -- a hardcoded one is refused by the dashboard', async () => {
    // Measured 2026-09-25 (Sam): fixing the recipient while leaving
    // `"from":"marveen"` in place moves the failure instead of removing it --
    // the real dashboard answers 403 "unknown agent 'marveen'". And because
    // the installer rewrites this hook unconditionally, the first update after
    // a merge would have restored the broken sender.
    const repo = makeRepo('MAIN_AGENT_ID=sajat-agens\n')
    const { bodies, rejected } = await switchTo(repo, 'feature-ordinary', {})
    expect(rejected).toEqual([])
    expect(bodies.length).toBe(1)
    expect(JSON.parse(bodies[0]).from).toBe('sajat-agens')
  })

})

describe('prod-tree-guard post-checkout alert: the SENDER is read from SYSTEM_SENDER_IDS, not assumed', () => {
  // The review on #1584 asked for `from=prod-tree-guard` on the grounds that the
  // id "is already in SYSTEM_SENDER_IDS". Measured 2026-09-26 on this install it
  // is not: the .env has no SYSTEM_SENDER_IDS line at all, the config default is
  // an empty set, there is no agents/prod-tree-guard/ directory, and the live
  // dashboard answers HTTP 403 "unknown agent 'prod-tree-guard'" while the .env
  // MAIN_AGENT_ID is accepted. Hardcoding either answer is wrong for somebody:
  // the guard name silences installs that never registered it, and the main
  // agent id denies the honest sender to installs that did. So the hook reads
  // the list, and these cases pin both directions.

  it('with the guard registered, it sends under its OWN name', async () => {
    const repo = makeRepo('MAIN_AGENT_ID=sajat-agens\nSYSTEM_SENDER_IDS=prod-tree-guard\n')
    const { bodies, rejected } = await switchTo(repo, 'feature-ordinary', {})
    expect(rejected).toEqual([])
    expect(bodies.length).toBe(1)
    expect(JSON.parse(bodies[0]).from).toBe('prod-tree-guard')
  })

  it('the list is parsed the way the server parses it: commas, spaces, several entries', async () => {
    // Same normalisation as parseSystemSenderIds over sanitizeAgentIdent: split
    // on commas, trim, drop characters outside [A-Za-z0-9_-]. If this hook were
    // laxer than the server, it would pick a spelling the API then refuses --
    // the silent loss again, one layer down.
    const repo = makeRepo('MAIN_AGENT_ID=sajat-agens\nSYSTEM_SENDER_IDS=cortex, prod-tree-guard ,billing\n')
    const { bodies, rejected } = await switchTo(repo, 'feature-ordinary', {})
    expect(rejected).toEqual([])
    expect(bodies.length).toBe(1)
    expect(JSON.parse(bodies[0]).from).toBe('prod-tree-guard')
  })

  it('with a SYSTEM_SENDER_IDS that does NOT list the guard, the sender stays the install id', async () => {
    const repo = makeRepo('MAIN_AGENT_ID=sajat-agens\nSYSTEM_SENDER_IDS=cortex,billing\n')
    const { bodies, rejected } = await switchTo(repo, 'feature-ordinary', {})
    expect(rejected).toEqual([])
    expect(bodies.length).toBe(1)
    expect(JSON.parse(bodies[0]).from).toBe('sajat-agens')
  })

  it('with no SYSTEM_SENDER_IDS line at all -- this install -- the sender is the install id', async () => {
    // The configuration this host actually has. A regression here is the one
    // that would take the alert away from us specifically.
    const repo = makeRepo('BOT_NAME=Probe\nMAIN_AGENT_ID=sajat-agens\n')
    const { bodies, rejected } = await switchTo(repo, 'feature-ordinary', {})
    expect(rejected).toEqual([])
    expect(bodies.length).toBe(1)
    expect(JSON.parse(bodies[0]).from).toBe('sajat-agens')
  })

  it('THE GUARD IS NEVER THE RECIPIENT OF ITS OWN ALERT', async () => {
    // The trap this change had to avoid. The recipient line used to read
    // `${MARVEEN_GUARD_ALERT_TO:-$ALERT_FROM}`, which was harmless while the
    // sender could only be the main agent -- the two were the same value. Once
    // the sender can be the guard, that same line addresses the alert to the
    // guard itself: a mailbox with no reader, and the hook reports success.
    // If anyone restores the old fallback, this case goes red.
    const repo = makeRepo('MAIN_AGENT_ID=sajat-agens\nSYSTEM_SENDER_IDS=prod-tree-guard\n')
    const { bodies } = await switchTo(repo, 'feature-ordinary', {})
    expect(bodies.length).toBe(1)
    const p = JSON.parse(bodies[0])
    expect(p.from).toBe('prod-tree-guard')
    expect(p.to).toBe('sajat-agens')
    expect(p.to).not.toBe('prod-tree-guard')
  })

  it('a registered sender with no MAIN_AGENT_ID still goes out, to the stock recipient the develop logic falls back to', async () => {
    // The recipient half is develop's (#1569, pinned by #1633): no MAIN_AGENT_ID
    // means the stock 'marveen'. This case pins that the SENDER feature does not
    // disturb it -- the guard sends under its own name, and the recipient is
    // still resolved from MAIN_AGENT_ID and never from the sender.
    const repo = makeRepo('SYSTEM_SENDER_IDS=prod-tree-guard\n')
    const { bodies, rejected } = await switchTo(repo, 'feature-ordinary', {})
    expect(rejected).toEqual([])
    expect(bodies.length).toBe(1)
    const p = JSON.parse(bodies[0])
    expect(p.from).toBe('prod-tree-guard')
    expect(p.to).toBe('marveen')
  })

  // THE HOOK AND THE SERVER MUST READ THE LIST THE SAME WAY (Sam, 2026-09-30). The
  // hook used to read the FIRST SYSTEM_SENDER_IDS line (`head -1`), the server reads the
  // LAST (parseEnvContent). With two lines the hook then sent as `prod-tree-guard`
  // while the server had never registered it, and the alert was refused. Every case
  // below is judged by the stand-in dashboard using the server's own parse, so the
  // outcome is "delivered or refused", not "the hook printed what I expected".
  const fromOf = async (env: string) => {
    const repo = makeRepo(env)
    const { bodies, rejected } = await switchTo(repo, 'feature-ordinary', {})
    return { rejected, from: bodies.length ? (JSON.parse(bodies[0]).from as string) : null }
  }

  it('two SYSTEM_SENDER_IDS lines: the FIRST lists the guard, the LAST does not -> sends as the install id, and is accepted', async () => {
    const r = await fromOf('MAIN_AGENT_ID=sajat-agens\nSYSTEM_SENDER_IDS=prod-tree-guard\nSYSTEM_SENDER_IDS=cortex\n')
    expect(r.rejected).toEqual([])
    expect(r.from).toBe('sajat-agens')
  })

  it('two SYSTEM_SENDER_IDS lines: the FIRST does not list the guard, the LAST does -> sends as the guard, and is accepted', async () => {
    const r = await fromOf('MAIN_AGENT_ID=sajat-agens\nSYSTEM_SENDER_IDS=cortex\nSYSTEM_SENDER_IDS=prod-tree-guard\n')
    expect(r.rejected).toEqual([])
    expect(r.from).toBe('prod-tree-guard')
  })

  it('an indented line is read (the server trims every line)', async () => {
    const r = await fromOf('MAIN_AGENT_ID=sajat-agens\n  SYSTEM_SENDER_IDS=prod-tree-guard\n')
    expect(r.rejected).toEqual([])
    expect(r.from).toBe('prod-tree-guard')
  })

  it('spaces around the = are read (the server trims key and value)', async () => {
    const r = await fromOf('MAIN_AGENT_ID=sajat-agens\nSYSTEM_SENDER_IDS = prod-tree-guard\n')
    expect(r.rejected).toEqual([])
    expect(r.from).toBe('prod-tree-guard')
  })

  it('a commented-out line is NOT a registration', async () => {
    const r = await fromOf('MAIN_AGENT_ID=sajat-agens\n# SYSTEM_SENDER_IDS=prod-tree-guard\n')
    expect(r.rejected).toEqual([])
    expect(r.from).toBe('sajat-agens')
  })

  it('a quoted value is read without its quotes', async () => {
    const r = await fromOf('MAIN_AGENT_ID=sajat-agens\nSYSTEM_SENDER_IDS="cortex, prod-tree-guard"\n')
    expect(r.rejected).toEqual([])
    expect(r.from).toBe('prod-tree-guard')
  })

  it('CONTROL: the stand-in really refuses an unregistered guard (so "accepted" above is evidence, not a stub that accepts everything)', async () => {
    // Registered nowhere on the server side: an .env with no list at all. If the
    // hook ever sent as the guard here, this is the 403 that would show it.
    captured = []; rejected = []
    serverSenders = new Set()
    const probe = await fetch(`${origin}/api/messages`, { method: 'POST', body: JSON.stringify({ from: 'prod-tree-guard', to: 'sajat-agens', content: 'x' }) })
    expect(probe.status).toBe(403)
    expect(rejected.length).toBe(1)
  })

  it('a registered sender plus an override recipient does go out', async () => {
    // The mirror of the case above: the same install, one variable set. This
    // proves the refusal above is about a MISSING recipient, not about the
    // guard sender being rejected somewhere in the hook.
    const repo = makeRepo('SYSTEM_SENDER_IDS=prod-tree-guard\n')
    const { bodies, rejected } = await switchTo(repo, 'feature-ordinary', { MARVEEN_GUARD_ALERT_TO: 'valtozobol' })
    expect(rejected).toEqual([])
    expect(bodies.length).toBe(1)
    const p = JSON.parse(bodies[0])
    expect(p.from).toBe('prod-tree-guard')
    expect(p.to).toBe('valtozobol')
  })
})
