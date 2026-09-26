import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile, execFileSync, spawnSync } from 'node:child_process'
import { promisify } from 'node:util'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, cpSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The post-checkout guard alert must be JSON-ENCODED, never shell-interpolated.
//
// Both values it reports are attacker-influenceable, and neither is as tame as
// a refname looks:
//   * BRANCH   -- git check-ref-format ACCEPTS a double quote in a branch name
//                 (it rejects space, colon, backslash and '[', but not '"').
//   * TOPLEVEL -- a directory name has none of those restrictions, so a quote
//                 AND a colon can both appear in the repository path.
//
// Hand-built `-d "{\"content\":\"$BRANCH\"}"` therefore fails in two measured
// ways. A quote in the BRANCH closes the JSON string early and the body stops
// parsing: the dashboard rejects it and the branch-switch alert is LOST -- the
// silent non-enforcement this guard exists to prevent. A quote plus a colon in
// the PATH is worse: it closes `content` and opens a SECOND `to` key, and a
// JSON parser takes the last one, so the alert is delivered to an agent the
// attacker names, carrying text the attacker wrote.
//
// What does NOT happen, measured, and asserted below so the claim stays
// honest: the shell does not re-evaluate a variable's VALUE, so a command
// substitution in a branch name is not executed by this shape. The first test
// pins that behaviour (it held before this fix too); the other two are the
// regression, and both were red on the hand-built payload.

const execFileAsync = promisify(execFile)

const ROOT = process.cwd()
const SCRIPT = 'install-prod-tree-guard-hook.sh'
const ALERT_TO = 'alert-recipient'
const FORGED_TO = 'other-recipient'

// realpath, not the raw temp path: on macOS `os.tmpdir()` is a SYMLINK
// (/var/... -> /private/var/...), and the hook only fires when
// `git rev-parse --show-toplevel` (physical) equals the resolved
// git-common-dir parent (which keeps the caller's logical path). Measured:
// from the unresolved path the hook exited silently and the harness captured
// nothing -- all four cases went red, including the positive control, with
// the script untouched. A gate that reports the bug it was pointed at while
// measuring nothing is worse than no gate.
const stage = realpathSync(mkdtempSync(join(tmpdir(), 'prodguard-')))

/** Raw request bodies, exactly as they left the hook. */
let captured: string[] = []
let server: Server
let origin = ''

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      captured.push(Buffer.concat(chunks).toString('utf-8'))
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
/** A throwaway git repo with the installer under scripts/, at an arbitrary
 *  directory name -- the hostile-path case needs to choose that name. */
function makeRepo(dirName: string): string {
  const repo = join(stage, `${dirName}-${n++}`)
  mkdirSync(join(repo, 'scripts'), { recursive: true })
  mkdirSync(join(repo, 'store'), { recursive: true })
  execFileSync('git', ['-C', repo, 'init', '-q', '-b', 'develop'])
  writeFileSync(join(repo, 'x.txt'), 'x')
  execFileSync('git', ['-C', repo, 'add', '.'])
  execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'])
  cpSync(join(ROOT, 'scripts', SCRIPT), join(repo, 'scripts', SCRIPT))
  writeFileSync(join(repo, 'store', '.dashboard-token'), 'probe-token\n')
  // The SENDER now comes from the install's .env and from nowhere else, so a
  // fixture that expects a POST has to have an install identity. Without it
  // the hook refuses before curl, and every case here would measure silence.
  writeFileSync(join(repo, '.env'), 'MAIN_AGENT_ID=payload-proba\n')
  const r = spawnSync('/bin/bash', [join(repo, 'scripts', SCRIPT)], { cwd: repo, encoding: 'utf-8', timeout: 20000 })
  expect(r.status).toBe(0)
  return repo
}

/** Switch to `branch` (creating it) and return the alert body the hook sent.
 *
 *  ASYNC ON PURPOSE: the checkout must not be run with `spawnSync`. The capture
 *  server lives in this same worker, and a synchronous child blocks the event
 *  loop that has to answer it -- the kernel accepts the connection, node never
 *  reads it, and the hook's `curl -m 5` dies on its timeout with the body
 *  unread. Measured: every case red at ~5.5s each, positive control included,
 *  against an unmodified script. */
async function switchTo(repo: string, branch: string): Promise<string> {
  captured = []
  execFileSync('git', ['-C', repo, 'branch', branch])
  // Never fails the checkout: the hook is best-effort by contract.
  await execFileAsync('git', ['-C', repo, 'checkout', '-q', branch], {
    timeout: 20000,
    env: { ...process.env, MARVEEN_DASHBOARD_ORIGIN: origin, MARVEEN_GUARD_ALERT_TO: ALERT_TO },
  })
  for (let i = 0; i < 100 && captured.length === 0; i++) await new Promise((r) => setTimeout(r, 20))
  expect(captured.length).toBe(1)
  return captured[0]
}

describe('prod-tree-guard post-checkout alert: the payload is encoded, not interpolated', () => {
  it('POSITIVE CONTROL: an ordinary branch name is delivered, parseable, to the configured recipient', async () => {
    const body = await switchTo(makeRepo('plain'), 'feature-ordinary')
    const parsed = JSON.parse(body)
    expect(parsed.to).toBe(ALERT_TO)
    expect(parsed.content).toContain('feature-ordinary')
  })

  it('a command substitution in the branch name is NOT executed -- it is reported verbatim', async () => {
    // `$(echo)` expands to the empty string if it ever ran, so the literal
    // surviving in the body is the oracle, with no local value in the
    // assertion. Held before this fix as well: a variable's value is not
    // re-evaluated by the shell. Pinned so a future rewrite (eval, or a
    // generated hook built with an unquoted heredoc) cannot introduce it.
    const body = await switchTo(makeRepo('subst'), 'probe-$(echo)-end')
    expect(JSON.parse(body).content).toContain('probe-$(echo)-end')
  })

  it('a DOUBLE QUOTE in the branch name leaves the body parseable (the alert is not lost)', async () => {
    const body = await switchTo(makeRepo('quoted'), 'probe-"-end')
    const parsed = JSON.parse(body)
    expect(parsed.to).toBe(ALERT_TO)
    expect(parsed.content).toContain('probe-"-end')
  })

  it('a repository PATH holding a quote and a colon cannot open a second "to" key', async () => {
    // The shape that hijacks delivery: the path closes `content` and starts a
    // key the parser prefers over the real one.
    const repo = makeRepo(`p","to":"${FORGED_TO}","content":"FORGED`)
    const body = await switchTo(repo, 'feature-ordinary')
    const parsed = JSON.parse(body)
    expect(parsed.to).toBe(ALERT_TO)
    expect(parsed.to).not.toBe(FORGED_TO)
    expect(parsed.content).toContain('post-checkout hook')
  })
})
