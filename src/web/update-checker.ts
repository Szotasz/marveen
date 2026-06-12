import { execFileSync } from 'node:child_process'
import { PROJECT_ROOT } from '../config.js'

export interface UpdateCommit {
  sha: string
  short: string
  message: string
  author: string
  date: string
}

export interface UpdateStatus {
  current: string
  latest: string
  behind: number
  commits: UpdateCommit[]
  remote: string
  lastChecked: number
  error?: string
  /** True when the local HEAD is not on the GitHub remote (a customised fork);
   * `behind`/`commits` are then computed from the upstream merge-base. */
  fork?: boolean
}

let updateStatusCache: UpdateStatus = {
  current: '',
  latest: '',
  behind: 0,
  commits: [],
  remote: 'Szotasz/marveen',
  lastChecked: 0,
}

export function getUpdateStatus(): UpdateStatus {
  return updateStatusCache
}

export function currentGitHead(): string {
  try {
    return execFileSync('/usr/bin/git', ['rev-parse', 'HEAD'], { cwd: PROJECT_ROOT, timeout: 3000, encoding: 'utf-8' }).trim()
  } catch {
    return ''
  }
}

export function parseGitHubRemote(): string {
  try {
    const url = execFileSync('/usr/bin/git', ['config', '--get', 'remote.origin.url'], { cwd: PROJECT_ROOT, timeout: 3000, encoding: 'utf-8' }).trim()
    // Normalize "git@github.com:Owner/Repo.git" or "https://github.com/Owner/Repo.git" to "Owner/Repo"
    const m = url.match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/i)
    if (m) return m[1]
  } catch { /* fall through */ }
  return 'Szotasz/marveen'
}

type GhCompare = {
  ahead_by?: number
  commits?: { sha: string; commit: { message: string; author: { name: string; date: string } } }[]
}

const GH_HEADERS = { 'Accept': 'application/vnd.github+json', 'User-Agent': 'marveen-update-check' }

// Fetch the GitHub compare of base...head. Returns the parsed body, the
// sentinel { notFound: true } on a 404 (base or head not on the remote), or
// null on any other failure.
async function fetchCompare(remote: string, base: string, head: string): Promise<GhCompare | { notFound: true } | null> {
  const res = await fetch(`https://api.github.com/repos/${remote}/compare/${base}...${head}`, { headers: GH_HEADERS })
  if (res.ok) return await res.json() as GhCompare
  if (res.status === 404) return { notFound: true }
  return null
}

// Map a GitHub compare body onto the status (behind count + newest-first commit
// list).
function applyCompare(status: UpdateStatus, cmp: GhCompare): void {
  status.behind = cmp.ahead_by ?? 0
  // GitHub returns commits oldest-first; flip to newest-first for the UI.
  const raw = (cmp.commits ?? []).slice().reverse()
  status.commits = raw.map(c => ({
    sha: c.sha,
    short: c.sha.slice(0, 7),
    message: (c.commit.message || '').split('\n')[0],
    author: c.commit.author?.name || '',
    date: c.commit.author?.date || '',
  }))
}

// Merge-base of local HEAD with the upstream tracking ref (origin/main, which
// parseGitHubRemote maps to the GitHub remote). For a customised fork this is
// the fork point -- an actual upstream commit -- so it can be compared on
// GitHub even though the local HEAD itself never landed there. Empty string
// when there is no local upstream ref.
function upstreamMergeBase(): string {
  try {
    return execFileSync('/usr/bin/git', ['merge-base', 'HEAD', 'origin/main'], { cwd: PROJECT_ROOT, timeout: 3000, encoding: 'utf-8' }).trim()
  } catch {
    return ''
  }
}

export async function refreshUpdateStatus(): Promise<UpdateStatus> {
  const current = currentGitHead()
  const remote = parseGitHubRemote()
  const status: UpdateStatus = {
    current,
    latest: '',
    behind: 0,
    commits: [],
    remote,
    lastChecked: Date.now(),
  }
  if (!current) {
    status.error = 'Not a git checkout'
    updateStatusCache = status
    return status
  }
  try {
    // 1) find HEAD of default branch (main) via the commits endpoint
    const latestRes = await fetch(`https://api.github.com/repos/${remote}/commits/main`, {
      headers: { 'Accept': 'application/vnd.github+json', 'User-Agent': 'marveen-update-check' },
    })
    if (!latestRes.ok) throw new Error(`GitHub /commits/main -> ${latestRes.status}`)
    const latestJson = await latestRes.json() as { sha?: string }
    if (!latestJson.sha) throw new Error('No sha on commits/main response')
    status.latest = latestJson.sha

    if (status.latest === current) {
      updateStatusCache = status
      return status
    }

    // 2) list commits between local HEAD and the remote latest via compare.
    const cmp = await fetchCompare(remote, current, status.latest)
    if (cmp && !('notFound' in cmp)) {
      applyCompare(status, cmp)
    } else if (cmp && 'notFound' in cmp) {
      // Local HEAD is not a commit on the GitHub remote -- the normal state of a
      // customised fork carrying local commits on top of upstream. Comparing the
      // raw HEAD 404s forever, surfacing as a permanent scary error. Fall back to
      // the upstream merge-base (our fork point, which IS an upstream commit) so
      // `behind`/`commits` reflect genuinely new upstream commits rather than the
      // fork divergence.
      status.fork = true
      const base = upstreamMergeBase()
      if (!base || base === status.latest) {
        // No local upstream ref, or the fork point already is the upstream tip:
        // nothing new upstream. A fork being ahead of upstream is expected, not
        // an error.
        status.behind = 0
      } else {
        const baseCmp = await fetchCompare(remote, base, status.latest)
        if (baseCmp && !('notFound' in baseCmp)) {
          applyCompare(status, baseCmp)
        } else {
          status.error = 'Local HEAD not found on GitHub -- different fork or unpushed commits?'
        }
      }
    }
  } catch (err) {
    status.error = err instanceof Error ? err.message : String(err)
  }
  updateStatusCache = status
  return status
}

// Polls the GitHub repo's main branch for new commits and compares to the
// local HEAD. Lets the dashboard show a "new version available" badge
// without anyone having to SSH in and run update.sh.
export function startUpdateChecker(): NodeJS.Timeout {
  // First check shortly after startup; then every 15 minutes.
  setTimeout(() => { refreshUpdateStatus().catch(() => {}) }, 10_000)
  return setInterval(() => { refreshUpdateStatus().catch(() => {}) }, 15 * 60_000)
}
