// restoreClaimed() must never LINK a claimed SYMLINK back to its requests/ name (RELAYSYMLINK1122).
// Node's linkSync(existing, new) FOLLOWS a symlink at existing on macOS, so the unfixed restore puts
// a HARD LINK to the symlink's TARGET at the requests/<name>.json name: the outside file's content
// becomes readable inside the spool and its nlink bumps to 2. On Linux link() does not follow the
// source, but the unfixed restore still re-creates the symlink at the requests/ name on every tick,
// so the swapped entry never goes away there either. The repro below drives the exact path the
// reviewer measured: a non-empty directory at requests/<name>.json is claimed (rename moves
// directories fine), cannot be removed (rmdir fails on non-empty), is denied once and RESTORED --
// then a writer renames the directory away and puts a symlink to an OUTSIDE file in its place, and
// the next claim hands that symlink to restoreClaimed. The fixed relay unlinks the claimed copy only
// and leaves the requests/ name free; nothing is ever forwarded for the entry.
//
// Nothing in this test is a race. The daemon is single-threaded: it lists requests/, then handles the
// listed names one after another in name order, and it PARKS inside a handler while it awaits the
// dashboard's answer (no spool access until the answer arrives). Two marker requests, named to sort
// just before and just after the swapped entry, hold the daemon still at the two moments that matter:
//   0-park.json  -- while the daemon awaits this answer, the writer swaps the entry at the requests/
//                   name; the daemon listed the OLD entry and this name in the same tick, so the
//                   swapped one is decided as soon as the answer arrives
//   a.json       -- the daemon decides the swapped entry: claim, open refuses a symlink, restore
//   b-park.json  -- while the daemon awaits this answer, the test looks at the spool: the decision is
//                   complete and the tick is not over yet
// The second marker is written after the first, so the daemon either listed both in one tick, or
// handles it in a LATER tick -- after the swapped entry either way. At the second park the unfixed
// restore has put the symlink back (it does so on every tick) and the fixed one has unlinked the
// claimed copy, whatever the scheduling: no settle window, no sample count, no dependence on how
// fast the test process runs. A third marker, written only afterwards, shows that a LATER tick
// brings nothing back.
// The run must also end with exactly ONE decision line for the entry (an unfixed restore's link is
// denied and unlinked by the daemon's own next tick), and nothing may appear half-made under the
// relay's eyes: the fixture directory and every marker are staged outside the spool and renamed in.
import { describe, it, expect } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { type AddressInfo } from 'node:net'
import { randomBytes } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const RELAY_MJS = fileURLToPath(new URL('../../scripts/codex-relay/relay.mjs', import.meta.url))
const AGENT = 'relay-agent'
// A plain name, deliberately not a dashboard request: only filesystem state decides this scenario.
const NAME = 'a.json'
// Marker requests: valid dashboard calls that the test's own server answers. Their names sort right
// before and right after NAME, so the daemon meets them around the swapped entry.
const PARK_BEFORE = { id: '0-park', marker: 'relay-symlink-park-before' }
const PARK_AFTER = { id: 'b-park', marker: 'relay-symlink-park-after' }
const LATER = { id: 'c-later', marker: 'relay-symlink-later-tick' }

// lstat, not existsSync: a (dangling or live) symlink at the path counts as STILL THERE.
function lstatExists(path: string): boolean {
  try { lstatSync(path); return true } catch { return false }
}

async function waitFor<T>(probe: () => T | null | undefined | false, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = probe()
    if (value) return value as T
    if (Date.now() >= deadline) throw new Error('waitFor timed out')
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}

function exited(child: ChildProcess): Promise<number | null> {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode)
  return new Promise(resolve => child.on('exit', code => resolve(code)))
}

// The relay appends one JSON line per decided request. A line is the durable proof of a decision
// (the claim -> restore bounce itself is over in well under a millisecond, far too fast to observe
// at the requests/ name directly), and a FORWARDED line with status 200 is the proof that the daemon
// really stood in that dashboard call: the park the test acted in.
type AuditLine = { id: string | null; decision: string; reason: string | null; status?: number }
function readAuditLines(path: string): AuditLine[] {
  try {
    return readFileSync(path, 'utf8').split('\n').filter(line => line !== '').map(line => JSON.parse(line) as AuditLine)
  } catch {
    return [] /* not written yet */
  }
}

// Every daemon claims into claimed/<pid>/; a leftover copy of NAME would rest somewhere in there.
function claimedCopies(claimedRoot: string, name: string): string[] {
  let pids: string[]
  try { pids = readdirSync(claimedRoot) } catch { return [] }
  const found: string[] = []
  for (const pid of pids) {
    const dir = join(claimedRoot, pid)
    try {
      if (lstatSync(dir).isDirectory() && readdirSync(dir).includes(name)) found.push(join(dir, name))
    } catch { /* raced with the relay's own cleanup */ }
  }
  return found
}

// What lstat found at the requests/ name, for the failure message of the verdict below.
function describeEntry(path: string): string {
  try {
    const st = lstatSync(path)
    if (st.isSymbolicLink()) return 'still a symlink: the lstat gate is missing in restoreClaimed'
    if (st.isDirectory()) return 'still a directory'
    if (st.isFile()) return `still a regular file (nlink=${st.nlink})`
    return 'still there (unknown kind)'
  } catch {
    return 'gone'
  }
}

type Seen = { method?: string; url?: string; body: string }
// What the spool looked like while the daemon stood still at the second park.
type Sample = { entry: string; claimed: string[]; targetNlink: number }

describe('relay restoreClaimed never links back a symlink', () => {
  it('unlinks a claimed symlink without putting anything back at the requests/ name and never hard-links its outside target', async () => {
    const work = mkdtempSync(join(tmpdir(), 'marveen-relay-sym-'))
    const relayDir = join(work, 'relay')
    const requestsDir = join(relayDir, 'requests')
    const claimedRoot = join(relayDir, 'claimed')
    const requestFile = join(requestsDir, NAME)
    const tokenFile = join(work, 'agent.token')
    const auditPath = join(work, 'audit.log')
    const movedDir = join(work, 'moved-away') // where the non-empty directory is renamed by the first park
    const outsideTarget = join(work, 'secret.txt') // OUTSIDE the relay dir: the symlink's target
    const secret = `secret-${randomBytes(16).toString('hex')}`
    writeFileSync(tokenFile, `tok-${randomBytes(16).toString('hex')}\n`)
    writeFileSync(outsideTarget, secret)
    const outbox = join(work, 'outbox') // staging area OUTSIDE the relay dir, invisible to the daemon
    mkdirSync(outbox)
    const publish = (name: string, text: string): void => {
      writeFileSync(join(outbox, name), text)
      renameSync(join(outbox, name), join(requestsDir, name))
    }

    const seen: Seen[] = []
    let swapped = false
    let parkError: string | null = null
    let sample: Sample | null = null
    const server: Server = createServer((req, res) => {
      let body = ''
      req.on('data', c => { body += c })
      req.on('end', () => {
        seen.push({ method: req.method, url: req.url, body })
        res.setHeader('content-type', 'application/json')
        // The daemon stands still until res.end(): everything below runs while it is parked.
        try {
          if (body.includes(PARK_BEFORE.marker)) {
            // First park. The directory rests at its requests/ name here -- the relay is not in a
            // bounce -- so the swap is plain: rename the directory away, put the symlink in its place.
            renameSync(requestFile, movedDir)
            symlinkSync(outsideTarget, requestFile)
            swapped = true
          } else if (body.includes(PARK_AFTER.marker)) {
            // Second park: the daemon has decided the swapped entry in this tick and cannot touch the
            // spool again until this answer arrives.
            if (!swapped) throw new Error('the second park arrived before the swap')
            sample = {
              entry: describeEntry(requestFile),
              claimed: claimedCopies(claimedRoot, NAME),
              targetNlink: statSync(outsideTarget).nlink,
            }
          }
        } catch (err) {
          parkError = err instanceof Error ? err.message : String(err)
        }
        res.end(JSON.stringify({ ok: true }))
      })
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const dashboardUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const child = spawn(process.execPath, [
      RELAY_MJS,
      '--agent', AGENT, '--relay-dir', relayDir, '--token-file', tokenFile,
      '--dashboard-url', dashboardUrl, '--audit-log', auditPath,
    ], { stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.on('data', () => {})
    child.stderr.on('data', () => {})
    const lineOf = (id: string): AuditLine | null => readAuditLines(auditPath).find(l => l.id === id) ?? null
    // A park is proven by its audit line: forwarded, and answered 200 (a timed-out call is no park).
    const parkedAndAnswered = async (id: string): Promise<void> => {
      // 35 s: the daemon's own dashboard timeout is 30 s, so even a timed-out park lands its line by then.
      const line = await waitFor(() => lineOf(id), 35_000)
      if (line.decision !== 'forwarded' || line.status !== 200) throw new Error(`marker ${id} was not forwarded with a 200: ${JSON.stringify(line)}`)
    }
    try {
      await waitFor(() => (existsSync(join(relayDir, 'relay.ready')) ? true : null))

      // Step 1: a NON-EMPTY directory at requests/<name>.json. The relay claims it, cannot remove it
      // (rmdir fails on non-empty), denies it once -- the audit line is the durable proof a tick ran
      // and decided this entry -- and RESTORES it: the directory rests at its requests/ name again
      // between ticks, and the name is on the relay's list of stuck entries (staged and renamed in).
      const stagedDir = join(outbox, 'staged-dir')
      mkdirSync(stagedDir)
      writeFileSync(join(stagedDir, 'keep.txt'), 'kept')
      renameSync(stagedDir, requestFile)
      await waitFor(() => (readAuditLines(auditPath).some(l => l.decision === 'denied' && l.reason === 'invalid') ? true : null))
      await waitFor(() => {
        try { return lstatSync(requestFile).isDirectory() ? true : null } catch { return null }
      })

      // Step 2: the first marker parks the daemon right before it reaches the entry (0-park sorts
      // before a.json), and its park is where the writer swaps the entry. The second marker is
      // written right after the first.
      const marker = (m: { id: string; marker: string }) => JSON.stringify({
        id: m.id, method: 'POST', path: '/api/daily-log', body: { agent_id: AGENT, content: m.marker },
      })
      publish(`${PARK_BEFORE.id}.json`, marker(PARK_BEFORE))
      publish(`${PARK_AFTER.id}.json`, marker(PARK_AFTER))

      // Step 3: the verdict was taken at the second park, while the daemon stood still.
      await parkedAndAnswered(PARK_AFTER.id)

      // Step 4: a LATER tick brings nothing back. This marker is written only now, so a tick that
      // STARTS after the one that decided the swapped entry lists and handles it.
      publish(`${LATER.id}.json`, marker(LATER))
      await parkedAndAnswered(LATER.id)

      if (parkError) throw new Error(`the park hook failed: ${parkError}`)
      // The cast is for the type checker only: the assignment happens inside the server callback,
      // which its control-flow analysis does not follow.
      const verdict = sample as Sample | null
      if (!verdict) throw new Error('no verdict was taken at the second park')
      expect(verdict.entry,
        `relay never settled the swapped ${NAME} (sampled while the daemon was parked): lstat(requests/${NAME}) => ${verdict.entry}; ` +
        `claimed copies: ${verdict.claimed.join(', ') || 'none'}; outside target nlink=${verdict.targetNlink}`).toBe('gone') // the gate: nothing rests at the requests/ name
      expect(verdict.claimed).toEqual([]) // the claimed copy is gone too
      expect(verdict.targetNlink).toBe(1) // no hard link to the outside target was made

      // Durable: the same after the tick completed and a later tick ran (stuckDirs forgets the name
      // once it is gone from requests/, and there is no claimed copy left to put back).
      expect(lstatExists(requestFile)).toBe(false)
      expect(claimedCopies(claimedRoot, NAME)).toEqual([])
      expect(statSync(outsideTarget).nlink).toBe(1)
      expect(readFileSync(outsideTarget, 'utf8')).toBe(secret) // ... and its content is unchanged
      // Exactly one decision for the entry, the step-1 denial: an unfixed restore that links the
      // target back has its own next tick deny and unlink that link (a second line), so this count
      // fails the unfixed daemon however the ticks split the two markers.
      expect(readAuditLines(auditPath).filter(l => l.id === NAME.replace(/\.json$/, ''))).toHaveLength(1)
      // Nothing was forwarded for the entry: the dashboard saw exactly the three markers, in name order.
      const which = (s: Seen): string => [PARK_BEFORE, PARK_AFTER, LATER].find(m => s.body.includes(m.marker))?.id ?? `other: ${s.method} ${s.url}`
      expect(seen.map(which)).toEqual([PARK_BEFORE.id, PARK_AFTER.id, LATER.id])
    } finally {
      child.kill('SIGTERM')
      await exited(child)
      await new Promise(resolve => server.close(resolve))
      rmSync(work, { recursive: true, force: true })
    }
  }, 120_000)
})
