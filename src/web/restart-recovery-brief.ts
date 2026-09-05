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
