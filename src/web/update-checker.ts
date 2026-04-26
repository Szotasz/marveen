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

    // 2) list commits between current and latest via the compare endpoint
    const cmpRes = await fetch(`https://api.github.com/repos/${remote}/compare/${current}...${status.latest}`, {
      headers: { 'Accept': 'application/vnd.github+json', 'User-Agent': 'marveen-update-check' },
    })
    if (cmpRes.ok) {
      const cmp = await cmpRes.json() as {
        ahead_by?: number
        commits?: { sha: string; commit: { message: string; author: { name: string; date: string } } }[]
      }
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
    } else if (cmpRes.status === 404) {
      // Local HEAD not on the remote (detached local commit / different base).
      status.error = 'Local HEAD not found on GitHub -- different fork or unpushed commits?'
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
