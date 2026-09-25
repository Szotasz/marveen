// After a watchdog restart the agent comes back on a FRESH session: the plugin
// loads again, but the conversation is gone. The agent has no way to know it
// was in the middle of something, so it sits at an empty prompt while its
// uncommitted branch and its in_progress card wait for it (card 3a64403b,
// follow-up to PR #612).
//
// This module builds the one message that closes that gap, and decides when
// NOT to send one.
//
// THE RULE THAT MAKES THIS SAFE: no facts, no message. A brief is only worth
// injecting when there is something concrete to resume -- uncommitted work in
// the agent's own directory, or a card it had taken. An agent restarted while
// genuinely idle gets nothing, because injecting "you were doing nothing"
// into a fresh prompt is noise the agent then has to answer.
//
// The text is deliberately a STATEMENT OF FACTS plus one instruction to check
// them, not a command to resume. The facts are collected around a restart --
// a moment when the fleet's own state can be stale -- so the agent verifies
// before acting, exactly as it would after any handoff.

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { logger } from '../logger.js'
import { listKanbanCards } from '../db.js'
import { agentDir } from './agent-config.js'

/** A file the agent left modified in its working directory. */
export interface DirtyFile {
  /** git status --short XY code, e.g. ' M', '??', 'A '. */
  code: string
  path: string
}

export interface RecoveryFacts {
  agent: string
  /** Branch the agent's working directory is on, null when undeterminable. */
  branch: string | null
  /** Uncommitted entries from `git status --short`, already capped by the caller. */
  dirty: DirtyFile[]
  /** True when the dirty list was truncated, so the brief can say so. */
  dirtyTruncated: boolean
  /** Cards this agent had in_progress at restart time. */
  inProgress: { id: string; title: string }[]
}

/** Longest brief we are willing to type into a fresh prompt. */
export const RECOVERY_BRIEF_MAX_CHARS = 1200

/**
 * Build the recovery brief, or null when there is nothing to say.
 *
 * Pure: no git, no database, no tmux. The caller gathers the facts; this
 * decides whether they are worth a message and how to word it.
 */
export function buildRecoveryBrief(facts: RecoveryFacts): string | null {
  const hasDirty = facts.dirty.length > 0
  const hasCards = facts.inProgress.length > 0
  // The whole point of the guard: an idle agent is not interrupted.
  if (!hasDirty && !hasCards) return null

  const lines: string[] = [
    '[recovery-brief] Ujraindultal, es ez egy FRISS session: az elozo beszelgetesed nincs meg.',
    'Amit a restart pillanataban a rendszer latott rolad:',
  ]

  if (hasCards) {
    lines.push('')
    lines.push(facts.inProgress.length === 1 ? 'Folyamatban levo kartyad:' : 'Folyamatban levo kartyaid:')
    for (const c of facts.inProgress) lines.push(`  - ${c.id}: ${c.title}`)
  }

  if (hasDirty) {
    lines.push('')
    const where = facts.branch ? `a(z) ${facts.branch} agon` : 'a munkakonyvtaradban'
    lines.push(`Commitolatlan valtozasok ${where}:`)
    for (const f of facts.dirty) lines.push(`  ${f.code} ${f.path}`)
    if (facts.dirtyTruncated) lines.push('  ... (a lista levagva)')
  }

  lines.push('')
  lines.push(
    'Ezek MERESEK a restart pillanatabol, nem utasitas: ellenorizd oket (git status, kanban), ' +
    'mielott barmit folytatnal. Ha kozben mar lezarult, ne kezdd ujra.',
  )

  const text = lines.join('\n')
  return text.length > RECOVERY_BRIEF_MAX_CHARS
    ? text.slice(0, RECOVERY_BRIEF_MAX_CHARS - 1).trimEnd() + '…'
    : text
}

/**
 * Parse `git status --short` output into entries.
 *
 * Kept separate (and pure) so the brief can be tested against real git output
 * without running git.
 */
export function parseGitStatusShort(out: string, max: number): { dirty: DirtyFile[]; truncated: boolean } {
  const rows = out.split('\n').map((l) => l.replace(/\s+$/, '')).filter((l) => l.trim() !== '')
  const dirty: DirtyFile[] = []
  for (const row of rows.slice(0, max)) {
    // Format: XY<space>path -- the code is the first two columns, verbatim,
    // because ' M' (worktree) and 'M ' (staged) mean different things.
    const code = row.slice(0, 2)
    const path = row.slice(3).trim()
    if (path) dirty.push({ code, path })
  }
  return { dirty, truncated: rows.length > max }
}


// How many changed files the brief lists before it says "and more". A restart
// after a long spell can leave dozens; the brief is a pointer, not a diff.
export const RECOVERY_BRIEF_MAX_FILES = 12

// Wait before typing the brief into the fresh session. The restart paths
// schedule modal dismissal and a plugin-unlock probe of their own; this sits
// after both so the brief does not race a dialog or the probe's keystrokes.
// The sender still waits for idle -- this delay is about ORDER, not hope.
export const RECOVERY_BRIEF_DELAY_MS = 90_000

/**
 * Collect what the fleet knew about an agent at restart time.
 *
 * Every failure is swallowed into a null/empty field: a brief is a
 * convenience, and a restart must never fail because a directory is missing
 * or git is unhappy.
 */
export function gatherRecoveryFacts(agent: string): RecoveryFacts {
  let branch: string | null = null
  let dirty: RecoveryFacts['dirty'] = []
  let dirtyTruncated = false
  try {
    const dir = agentDir(agent)
    if (existsSync(join(dir, '.git'))) {
      try {
        branch = execFileSync('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'], { timeout: 5000 }).toString().trim() || null
      } catch { /* detached HEAD or no repo -- the brief works without a branch */ }
      const out = execFileSync('git', ['-C', dir, 'status', '--short'], { timeout: 5000 }).toString()
      const parsed = parseGitStatusShort(out, RECOVERY_BRIEF_MAX_FILES)
      dirty = parsed.dirty
      dirtyTruncated = parsed.truncated
    }
  } catch (err) {
    logger.debug({ err, agent }, 'recovery-brief: git facts unavailable')
  }

  let inProgress: RecoveryFacts['inProgress'] = []
  try {
    inProgress = listKanbanCards()
      .filter((c) => c.assignee === agent && c.status === 'in_progress' && c.archived_at == null)
      .map((c) => ({ id: c.id, title: c.title }))
  } catch (err) {
    logger.debug({ err, agent }, 'recovery-brief: kanban facts unavailable')
  }

  return { agent, branch, dirty, dirtyTruncated, inProgress }
}

/** How the brief reaches the session. Injected so this module never has to
 * import the process layer that calls it. */
export type BriefSender = (session: string, text: string) => Promise<unknown>

/**
 * After a fresh restart, tell the new session what it was in the middle of.
 *
 * Fire-and-forget: scheduled, never awaited by the restart path, and every
 * failure is logged rather than raised. A restart that succeeded must not be
 * reported as failed because a courtesy message could not be typed.
 */
export function scheduleRecoveryBrief(
  agent: string,
  session: string,
  send: BriefSender,
  // Injected so a test can hand in facts instead of needing a real agent
  // directory, a real git repo and a real database row. Without this seam the
  // only reachable case is "no facts, no message", which cannot show that the
  // send path works at all.
  gather: (agent: string) => RecoveryFacts = gatherRecoveryFacts,
): void {
  setTimeout(() => {
    void (async () => {
      try {
        const facts = gather(agent)
        const brief = buildRecoveryBrief(facts)
        if (!brief) {
          logger.info({ agent, session }, 'recovery-brief: nothing in flight, staying quiet')
          return
        }
        const res = await send(session, brief)
        logger.info(
          { agent, session, res, cards: facts.inProgress.length, dirty: facts.dirty.length },
          'recovery-brief sent after restart',
        )
      } catch (err) {
        logger.warn({ err, agent, session }, 'recovery-brief could not be delivered')
      }
    })()
  }, RECOVERY_BRIEF_DELAY_MS).unref?.()
}
