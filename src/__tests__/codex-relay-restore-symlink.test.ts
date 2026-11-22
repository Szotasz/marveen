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

// The relay appends one JSON line per decided request; used only as the durable proof that a
// tick ran and decided the directory entry (the claim -> restore bounce itself is over in well
// under a millisecond, far too fast to observe at the requests/ name directly).
type AuditLine = { id: string | null; decision: string; reason: string | null }
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

// What lstat found at the requests/ name, for the failure message of the gate poll below.
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

describe('relay restoreClaimed never links back a symlink', () => {
  it('unlinks a claimed symlink without putting anything back at the requests/ name and never hard-links its outside target', async () => {
    const work = mkdtempSync(join(tmpdir(), 'marveen-relay-sym-'))
    const relayDir = join(work, 'relay')
    const requestsDir = join(relayDir, 'requests')
    const claimedRoot = join(relayDir, 'claimed')
    const requestFile = join(requestsDir, NAME)
    const tokenFile = join(work, 'agent.token')
    const auditPath = join(work, 'audit.log')
    const movedDir = join(work, 'moved-away') // where the non-empty directory is renamed in step 2
    const outsideTarget = join(work, 'secret.txt') // OUTSIDE the relay dir: the symlink's target
    const secret = `secret-${randomBytes(16).toString('hex')}`
    writeFileSync(tokenFile, `tok-${randomBytes(16).toString('hex')}\n`)
    writeFileSync(outsideTarget, secret)
    const seen: Seen[] = []
    const server: Server = createServer((req, res) => {
      let body = ''
      req.on('data', c => { body += c })
      req.on('end', () => {
        seen.push({ method: req.method, url: req.url, body })
        res.setHeader('content-type', 'application/json')
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
    try {
      await waitFor(() => (existsSync(join(relayDir, 'relay.ready')) ? true : null))

      // Step 1: a NON-EMPTY directory at requests/<name>.json. The relay claims it, cannot remove it
      // (rmdir fails on non-empty), denies it once -- the audit line is the durable proof a tick ran
      // and decided this entry -- and RESTORES it: the directory rests at its requests/ name again.
      mkdirSync(requestFile)
      writeFileSync(join(requestFile, 'keep.txt'), 'kept')
      await waitFor(() => (readAuditLines(auditPath).some(l => l.decision === 'denied' && l.reason === 'invalid') ? true : null))
      await waitFor(() => {
        try { return lstatSync(requestFile).isDirectory() ? true : null } catch { return null }
      })

      // Step 2: a writer renames the directory away and swaps in a symlink to an OUTSIDE file. The
      // relay re-claims the resting directory on every tick (claim -> rmdir fails -> restore, a
      // sub-millisecond synchronous bounce), so the rename can race that bounce and find the name
      // momentarily gone; a short retry lands right after a restore.
      for (let attempt = 0; ; attempt++) {
        try {
          renameSync(requestFile, movedDir)
          break
        } catch (err) {
          if (attempt >= 200 || (err as { code?: string }).code !== 'ENOENT') throw err
          await new Promise(resolve => setTimeout(resolve, 5))
        }
      }
      symlinkSync(outsideTarget, requestFile)

      // Step 3: the relay must settle the swapped entry by unlinking the claimed copy ONLY. The
      // poll demands all three facts at once; with the unfixed code the symlink is put back at the
      // requests/ name on EVERY tick (on macOS as a hard link to the target, on Linux as the symlink
      // itself), so this never settles and the poll times out -- the expected red on unfixed code.
      const deadline = Date.now() + 20_000
      for (;;) {
        const goneFromRequests = !lstatExists(requestFile)
        const noClaimedCopy = claimedCopies(claimedRoot, NAME).length === 0
        const targetAlone = statSync(outsideTarget).nlink === 1
        if (goneFromRequests && noClaimedCopy && targetAlone) break
        if (Date.now() >= deadline) {
          throw new Error(
            `relay never settled the swapped ${NAME}: lstat(requests/${NAME}) => ${describeEntry(requestFile)}; ` +
            `claimed copies: ${claimedCopies(claimedRoot, NAME).join(', ') || 'none'}; ` +
            `outside target nlink=${statSync(outsideTarget).nlink}`,
          )
        }
        await new Promise(resolve => setTimeout(resolve, 50))
      }
      // Later ticks must not bring anything back either: stuckDirs forgets the name once it is gone
      // from requests/, and after that nothing may ever reappear there.
      await new Promise(resolve => setTimeout(resolve, 600))

      expect(lstatExists(requestFile)).toBe(false) // the gate: nothing rests at the requests/ name
      expect(claimedCopies(claimedRoot, NAME)).toEqual([]) // the claimed copy is gone too
      expect(statSync(outsideTarget).nlink).toBe(1) // no hard link to the outside target was made ...
      expect(readFileSync(outsideTarget, 'utf8')).toBe(secret) // ... and its content is unchanged
      expect(seen).toHaveLength(0) // nothing was forwarded at all, in particular not for this entry
    } finally {
      child.kill('SIGTERM')
      await exited(child)
      await new Promise(resolve => server.close(resolve))
      rmSync(work, { recursive: true, force: true })
    }
  }, 60_000)
})
