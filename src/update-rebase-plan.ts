// AUTOUPDATEDIVERG1110 2nd PR: what an owner-approved update of a DIVERGED install would do, for the dashboard's
// dialog and for an agent that asks the owner. READ-ONLY (Dani F3): no fetch, no ref is written. The upstream
// commit comes from `git ls-remote` (reads the remote, writes nothing); without a network it falls back to the
// last fetched origin/<branch> and says how old that is. update.sh fetches again before its consume and
// recomputes the binding there, so a plan that went stale ends in hash_mismatch: refused, the GO unspent.
//
// The binding is the same string the shell computes (scripts/lib/update-rebase-go.sh update_rebase_hash):
//   sha256("update_rebase\nbranch=<b>\nhead=<HEAD>\ntarget=<upstream>\n")
// update-rebase-plan.test.ts pins that both sides give the same hash for the same three values.
import { createHash } from 'node:crypto'

export const UPDATE_REBASE_CATEGORY = 'update_rebase'
/** The consume window of an approved row (routes/approvals CATEGORY_CONSUME_DEFAULT_WINDOW_S): 30 minutes. */
export const UPDATE_REBASE_WINDOW_S = 1800
const SHA_RE = /^[0-9a-f]{40}$/

export function rebaseHash(branch: string, head: string, target: string): string {
  return createHash('sha256').update(`update_rebase\nbranch=${branch}\nhead=${head}\ntarget=${target}\n`).digest('hex')
}

export interface RebaseCommit { sha: string; subject: string }
export interface RebasePlan {
  /** true when the install has local commits AND the upstream has commits it lacks. */
  diverged: boolean
  branch: string
  head: string
  target: string
  /** 'ls-remote' = read from the remote now; 'local-ref' = the last fetch (see localRefAgeS). */
  targetSource: 'ls-remote' | 'local-ref'
  localRefAgeS: number | null
  ahead: number
  /** null when the target commit is not in the local object store yet (not fetched). */
  behind: number | null
  /** The local commits a rebase would replay, newest first, at most 50. */
  commits: RebaseCommit[]
  /** Why the run would fail for sure (and so must not be approved), or null. */
  willFail: string | null
  hash: string
  windowS: number
}
export type RebasePlanResult = { ok: true; plan: RebasePlan } | { ok: false; reason: string }

export interface PlanGitRunner {
  /** git <args> in the install; rejects on a non-zero exit. */
  out(args: string[], timeoutMs: number): Promise<string>
  /** Seconds since the last fetch (FETCH_HEAD mtime), or null. */
  fetchAgeS(): number | null
}

async function tryOut(git: PlanGitRunner, args: string[], timeoutMs = 5000): Promise<string | null> {
  try { return (await git.out(args, timeoutMs)).trim() } catch { return null }
}

export async function computeRebasePlan(git: PlanGitRunner): Promise<RebasePlanResult> {
  const branch = await tryOut(git, ['rev-parse', '--abbrev-ref', 'HEAD'])
  if (!branch || branch === 'HEAD') return { ok: false, reason: 'detached-head' }
  const head = await tryOut(git, ['rev-parse', '--verify', '-q', 'HEAD^{commit}'])
  if (!head || !SHA_RE.test(head)) return { ok: false, reason: 'no-head' }
  const localRef = await tryOut(git, ['rev-parse', '--verify', '-q', `refs/remotes/origin/${branch}^{commit}`])
  const remote = await tryOut(git, ['ls-remote', '--exit-code', 'origin', `refs/heads/${branch}`], 15000)
  const remoteSha = remote ? remote.split(/\s+/)[0] : null
  const target = remoteSha && SHA_RE.test(remoteSha) ? remoteSha : localRef
  if (!target || !SHA_RE.test(target)) return { ok: false, reason: 'no-upstream' }
  const targetSource: RebasePlan['targetSource'] = remoteSha && SHA_RE.test(remoteSha) ? 'ls-remote' : 'local-ref'

  // The local commits are what HEAD has beyond the last known upstream (the stale local ref is an ancestor of the
  // fresh one, so this is the same set, as long as the upstream did not absorb them).
  const base = localRef ? await tryOut(git, ['merge-base', head, localRef]) : null
  const ahead = base ? Number(await tryOut(git, ['rev-list', '--count', `${base}..${head}`]) ?? '0') : 0
  const log = base ? (await tryOut(git, ['log', '--format=%H%x09%s', '-n', '50', `${base}..${head}`])) ?? '' : ''
  const commits = log.split('\n').filter(Boolean).map((l) => { const i = l.indexOf('\t'); return { sha: l.slice(0, i), subject: l.slice(i + 1) } })
  const hasTarget = (await tryOut(git, ['cat-file', '-e', `${target}^{commit}`])) !== null
  const behind = hasTarget ? Number(await tryOut(git, ['rev-list', '--count', `${head}..${target}`]) ?? '0') : null
  const upstreamMoved = behind !== null ? behind > 0 : target !== localRef
  const diverged = ahead > 0 && upstreamMoved

  // Same rule as the shell pre-filter (update_rebase_will_fail): package.json changed locally without the lock.
  let willFail: string | null = null
  if (base) {
    const files = ((await tryOut(git, ['diff', '--name-only', base, head])) ?? '').split('\n')
    if (files.includes('package.json') && !files.includes('package-lock.json')) willFail = 'local-dependency-without-lock'
  }
  return {
    ok: true,
    plan: {
      diverged, branch, head, target, targetSource, localRefAgeS: git.fetchAgeS(), ahead, behind, commits, willFail,
      hash: rebaseHash(branch, head, target), windowS: UPDATE_REBASE_WINDOW_S,
    },
  }
}
