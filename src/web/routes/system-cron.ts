import { execFile } from 'node:child_process'
import { logger } from '../../logger.js'
import { json } from '../http-helpers.js'
import { computeNextRun, isValidCronShape } from '../cron.js'
import { PLATFORM, type PlatformType } from '../../platform.js'
import type { RouteContext } from './types.js'

const CRONTAB_TIMEOUT = 5000
const MAX_OUTPUT = 256 * 1024

export interface SystemCronEntry {
  raw: string
  schedule: string
  command: string
  redirect?: string
  comment?: string
  nextRun?: number | null
}

export interface ScheduledJobsResult {
  entries: SystemCronEntry[]
  source: string
  error?: string
}

// A provider reads the OS-native scheduler for the current platform. Linux uses
// the user crontab; a macOS launchd provider (launchctl list /
// ~/Library/LaunchAgents) can slot in behind this same interface later without
// touching the route or the frontend. Keeping the read behind a provider is the
// whole point of the platform gate: on macOS a bare `crontab -l` is typically
// empty (the real scheduler is launchd), so a crontab-only view there would be
// misleading -- hence macOS gets NO provider (yet) rather than an empty list.
export interface ScheduledJobsProvider {
  readonly source: string
  list(): Promise<ScheduledJobsResult>
}

// A leading token that opens a shell redirection (`>>`, `2>&1`, `> /dev/null`,
// `&>`, `<`, ...). Cron commands routinely append `>> logfile 2>&1`; we split
// that off into its own field so the command column stays readable instead of
// carrying redirect noise. A normal argv token never starts this way.
const REDIRECT_TOKEN_RX = /^(?:&?\d*>>?|\d*>&\d*|<{1,2})/

// An environment assignment line inside a crontab (SHELL=, PATH=, MAILTO=,
// CRON_TZ=...). These are not schedules and must not be parsed as such. Cron
// entries start with a digit, `*`, or `@`, so a NAME=value line is
// unambiguous.
const ENV_ASSIGN_RX = /^[A-Za-z_][A-Za-z0-9_]*=/

// Split a command string into the executed command and any trailing shell
// redirection. Tokenises on whitespace and cuts at the first redirect token so
// `run.sh --flag >> /var/log/x 2>&1` yields command="run.sh --flag",
// redirect=">> /var/log/x 2>&1". Returns redirect undefined when there is none.
function splitRedirect(commandFull: string): { command: string; redirect?: string } {
  const tokens = commandFull.split(/\s+/)
  const idx = tokens.findIndex(tok => REDIRECT_TOKEN_RX.test(tok))
  if (idx === -1) return { command: commandFull }
  const command = tokens.slice(0, idx).join(' ').trim()
  const redirect = tokens.slice(idx).join(' ').trim()
  return { command, redirect: redirect || undefined }
}

// Best-effort next-run for a cron expression. `@reboot` and other forms
// cron-parser can't project return null rather than throwing, so the UI shows a
// blank next-run instead of the whole endpoint failing.
function safeNextRun(schedule: string): number | null {
  try {
    return computeNextRun(schedule)
  } catch {
    return null
  }
}

// Parse `crontab -l` output into structured entries. Comment lines (`# ...`)
// immediately above a job attach to it as `comment`; a blank line clears the
// pending comment so it never leaks onto an unrelated later job. Environment
// assignment lines are skipped. Malformed schedule lines are still returned
// (raw + command) rather than dropped, so nothing is silently hidden.
export function parseCrontab(output: string): SystemCronEntry[] {
  const entries: SystemCronEntry[] = []
  let pendingComments: string[] = []

  for (const rawLine of output.split('\n')) {
    const line = rawLine.trim()
    if (!line) { pendingComments = []; continue }
    if (line.startsWith('#')) {
      pendingComments.push(line.replace(/^#+\s?/, ''))
      continue
    }
    if (ENV_ASSIGN_RX.test(line)) continue

    let schedule: string
    let commandFull: string
    if (line.startsWith('@')) {
      const sp = line.indexOf(' ')
      if (sp === -1) { schedule = line; commandFull = '' }
      else { schedule = line.slice(0, sp); commandFull = line.slice(sp + 1).trim() }
    } else {
      // A line with >=6 whitespace tokens matches the 5-field shape
      // structurally even when the first five fields are not a valid cron
      // expression (e.g. a stray prose line). Validate the candidate so genuine
      // garbage surfaces as a malformed entry (empty schedule + full line as
      // command) instead of masquerading as a schedule.
      const m = line.match(/^(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(.*)$/)
      const candidate = m ? m[1].replace(/\s+/g, ' ') : ''
      if (m && isValidCronShape(candidate)) { schedule = candidate; commandFull = m[2].trim() }
      else { schedule = ''; commandFull = line }
    }

    const { command, redirect } = splitRedirect(commandFull)
    const comment = pendingComments.length ? pendingComments.join(' ') : undefined
    pendingComments = []

    entries.push({
      raw: line,
      schedule,
      command,
      ...(redirect ? { redirect } : {}),
      ...(comment ? { comment } : {}),
      nextRun: schedule ? safeNextRun(schedule) : null,
    })
  }

  return entries
}

function readCrontab(): Promise<{ output: string; empty: boolean; error?: string }> {
  return new Promise(resolve => {
    execFile('crontab', ['-l'], { timeout: CRONTAB_TIMEOUT, maxBuffer: MAX_OUTPUT, env: process.env }, (err, stdout, stderr) => {
      if (!err) return resolve({ output: stdout || '', empty: false })
      // `crontab -l` exits 1 with "no crontab for <user>" when the user simply
      // has no crontab -- that is an empty list, not a failure.
      const msg = (stderr || '') + (err.message || '')
      if (/no crontab for/i.test(msg)) return resolve({ output: '', empty: true })
      resolve({ output: '', empty: false, error: msg.trim() || 'crontab -l failed' })
    })
  })
}

const linuxCrontabProvider: ScheduledJobsProvider = {
  source: 'crontab -l',
  async list() {
    const r = await readCrontab()
    if (r.error) return { entries: [], source: this.source, error: r.error }
    return { entries: parseCrontab(r.output), source: this.source }
  },
}

// Select the scheduled-jobs provider for the running platform. macOS returns
// null ON PURPOSE (see ScheduledJobsProvider): a future macosLaunchdProvider
// plugs in here without any route/frontend change. `null` means "no view for
// this platform" -> the route reports available:false and the UI hides itself.
export function getScheduledJobsProvider(platform: PlatformType = PLATFORM): ScheduledJobsProvider | null {
  switch (platform) {
    case 'linux-server':
    case 'linux-gui':
      return linuxCrontabProvider
    case 'macos':
    default:
      return null
  }
}

export async function tryHandleSystemCron(ctx: RouteContext): Promise<boolean> {
  const { res, path, method } = ctx

  if (path === '/api/system-cron' && method === 'GET') {
    const provider = getScheduledJobsProvider()
    // Platform gate: no provider (macOS today) -> a clean, non-error payload the
    // frontend keys off to hide the menu item. Never 404/500 -- an honest
    // "not available here" is not a failure.
    if (!provider) {
      json(res, {
        available: false,
        platform: PLATFORM,
        entries: [],
        count: 0,
        reason: 'System-cron view is Linux-only; macOS schedules via launchd (not yet supported).',
      })
      return true
    }

    try {
      const result = await provider.list()
      if (result.error) logger.warn({ err: result.error }, 'Failed to read scheduled jobs')
      json(res, {
        available: true,
        platform: PLATFORM,
        entries: result.entries,
        count: result.entries.length,
        source: result.source,
        fetchedAt: Date.now(),
        ...(result.error ? { error: result.error } : {}),
      })
    } catch (err) {
      logger.warn({ err }, 'Unexpected error reading scheduled jobs')
      json(res, {
        available: true,
        platform: PLATFORM,
        entries: [],
        count: 0,
        source: provider.source,
        fetchedAt: Date.now(),
        error: 'Failed to read scheduled jobs',
      })
    }
    return true
  }

  return false
}
