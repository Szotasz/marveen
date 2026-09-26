import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile, execFileSync, spawnSync } from 'node:child_process'
import { promisify } from 'node:util'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, cpSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// WHO the post-checkout alert is addressed to.
//
// The recipient used to be `${MARVEEN_GUARD_ALERT_TO:-marveen}` -- a name that
// belongs to one install and is wrong on every other one. That is not a loud
// failure: the dashboard accepts a POST addressed to a name nobody reads, so
// the branch-switch alert is lost while the hook reports success. The install's
// own .env is the authority now, the environment variable stays an override,
// and an unknown recipient is refused out loud instead of guessed.
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

/** The ids this stand-in dashboard knows. Everything else is a stranger. */
const KNOWN_AGENTS = new Set(['sajat-agens', 'idezett-agens', 'env-fajlbol', 'valtozobol', 'probanev', 'alert-recipient',
  // A deployment that HAS registered the guard in SYSTEM_SENDER_IDS. On this
  // install it is not registered, and the live dashboard answers 403 to it
  // (measured 2026-09-26) -- which is why the hook must read the list instead
  // of assuming either answer.
  'prod-tree-guard'])

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
      if (!KNOWN_AGENTS.has(from)) {
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

  it('with NO recipient anywhere, nothing is sent and the switch is reported on stderr instead', async () => {
    // The case that decides whether this change is a fix or a rename: if an
    // unknown recipient silently became some default name, the alert would be
    // lost exactly as before. Nothing may go out, and the person at the
    // terminal -- the one who caused the switch -- has to be told.
    const repo = makeRepo('BOT_NAME=Probe\n') // .env exists, MAIN_AGENT_ID does not
    const { bodies, rejected, stderr } = await switchTo(repo, 'feature-ordinary', {}, false)
    // BOTH LISTS, and that is the whole assertion. Measured 2026-09-25 (Sam):
    // `bodies` alone passes even when a POST DID go out, because the stub puts
    // an unknown-sender request in `rejected` instead. The check named after
    // the finding was not proving the finding.
    expect(rejected).toEqual([])
    expect(bodies).toEqual([])
    expect(stderr).toContain('[prod-tree-guard]')
    expect(stderr).toContain('MAIN_AGENT_ID')
    expect(stderr).toContain('feature-ordinary')
  })

  it('a recipient from the variable is NOT enough: with no MAIN_AGENT_ID there is no sender, so nothing goes out', async () => {
    // THE CASE THAT GUARDS THE GUARD. Measured 2026-09-25 (Sam): the sender
    // half of the refusal can be deleted and the whole suite stays 33/33
    // green -- the protection works and nothing watches it. On this exact
    // configuration the difference is the entire behaviour:
    //   fixed:   no POST, stderr "nincs feladhato riasztas ... MAIN_AGENT_ID"
    //   mutant:  POST goes out with from='' and an EMPTY stderr
    // and an empty `from` is HTTP 400 on the live API, so the alert is lost
    // while the hook reports success.
    //
    // `rejected` is not decoration here either: the stub answers 403 to an
    // empty sender, so without that assertion this case would go vacuously
    // true exactly like the two next to it did before today.
    const repo = makeRepo('BOT_NAME=Probe\n')   // a recipient, but no sender
    const { bodies, rejected, stderr } = await switchTo(
      repo, 'feature-ordinary', { MARVEEN_GUARD_ALERT_TO: 'valtozobol' }, false)
    expect(rejected).toEqual([])
    expect(bodies).toEqual([])
    expect(stderr).toContain('[prod-tree-guard]')
    expect(stderr).toContain('MAIN_AGENT_ID')
  })

  it('the same holds when there is no .env file at all', async () => {
    const repo = makeRepo() // no .env written
    const { bodies, rejected, stderr } = await switchTo(repo, 'feature-ordinary', {}, false)
    expect(rejected).toEqual([])
    expect(bodies).toEqual([])
    expect(stderr).toContain('[prod-tree-guard]')
    expect(stderr).toContain('feature-ordinary')
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

  it('a registered sender with NO recipient sends nothing and says so', async () => {
    // NEWLY REACHABLE, and the reason the "second half" of the refusal in the
    // hook stopped being dead code. The sender resolves (the guard is listed),
    // the recipient does not (no MAIN_AGENT_ID, no override). Before this
    // change that combination could not occur, because the recipient fell back
    // to the sender.
    const repo = makeRepo('SYSTEM_SENDER_IDS=prod-tree-guard\n')
    const { bodies, rejected, stderr } = await switchTo(repo, 'feature-ordinary', {}, false)
    expect(rejected).toEqual([])
    expect(bodies).toEqual([])
    expect(stderr).toContain('[prod-tree-guard]')
    expect(stderr).toContain('MAIN_AGENT_ID')
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
