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
import { deliverWhenReady, RESUME_DELIVERY_OPTIONS, type DeliverDeps, type DeliverOptions } from './resume-delivery.js'
import { sanitizePromptText } from './prompt-text-sanitize.js'
import { paneOneLine } from './pane-text.js'

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

// RECOVERYBRIEFSCRUB1114. The brief is typed into a fresh prompt with no
// envelope around it, and four of its fields are not written by this module: a
// kanban card id and title (anyone holding the shared token can write them, and
// titles carry outside text such as an external PR's title), the branch name and
// the file paths. Measured before this change: a forged wrapper tag and a forged
// message header in a card title reached the pane unchanged. The scheduled-task
// path scrubs the same source; this one did not.
//
// Per-field caps, so one long field cannot crowd the others out of the brief.
export const RECOVERY_BRIEF_MAX_ID_CHARS = 40
export const RECOVERY_BRIEF_MAX_TITLE_CHARS = 120
export const RECOVERY_BRIEF_MAX_BRANCH_CHARS = 80
export const RECOVERY_BRIEF_MAX_PATH_CHARS = 160

// Control characters and every whitespace run, as one space: a lone CR typed
// into a pane submits the prompt early, and a control character between `<` and
// a tag name would hide the tag from the deny-list and then vanish.
const BRIEF_FLATTEN_RX = /[\u0000-\u001f\u007f-\u009f\s]+/g
const BRIEF_FIELD_MAX_PASSES = 8
/** Stands in for a field that would not settle (see briefField). */
export const BRIEF_FIELD_UNSETTLED = '(nem megjelenitheto mezo)'

// The shared filter only matches a tag that is closed. A field that ENDS inside
// one (`<trusted-peer source=...` with no `>`) would stay, and the next field
// could supply the `>`. So the field is filtered with a `>` appended: if the
// filter consumed it, a tag head was open at the end, and it goes with it. Same
// deny-list, no second pattern.
function stripWrappers(flat: string): string {
  const closed = sanitizePromptText(flat + '>')
  return closed.endsWith('>') ? closed.slice(0, -1) : closed
}

/**
 * One outside-written field, made safe to stand in the brief: a single line,
 * wrapper tags and message headers neutralised by the shared filter
 * (prompt-text-sanitize.ts), then cut to `max`.
 *
 * Repeated until nothing changes, because the two steps feed each other: the
 * filter decodes entities (which can produce a control character), and
 * flattening a control character can complete a tag the filter then has to see.
 * What comes out is therefore a fixed point of "flatten, then filter". A field
 * that has not settled after BRIEF_FIELD_MAX_PASSES rounds (entities nested
 * dozens deep) is not shown at all. The cut comes LAST: cutting first could
 * leave the head of a tag behind.
 */
export function briefField(raw: string, max: number): string {
  let out = String(raw)
  let settled = false
  for (let i = 0; i < BRIEF_FIELD_MAX_PASSES; i++) {
    const next = stripWrappers(out.replace(BRIEF_FLATTEN_RX, ' '))
    if (next === out) { settled = true; break }
    out = next
  }
  if (!settled) return BRIEF_FIELD_UNSETTLED
  out = out.trim()
  return out.length > max ? out.slice(0, max - 3).trimEnd() + '...' : out
}

// A card id is an identifier, not free text: letters, digits, dash and
// underscore (measured 2026-11-14 on the live board: all 4883 ids fit, the
// longest is 26 characters). Anything else is not shown at all rather than
// shown with characters dropped, because a silently altered id points at a
// different card. Review of #2753 (Samu): an id of an opening bracket plus the
// word SYSTEM passed briefField on its own, and the brief's own ': ' between id
// and title then completed a `[SYSTEM:` header.
const BRIEF_CARD_ID_RX = /^[A-Za-z0-9_-]+$/

export function briefCardId(raw: string): string {
  const id = String(raw)
  if (!BRIEF_CARD_ID_RX.test(id)) return BRIEF_FIELD_UNSETTLED
  return id.length > RECOVERY_BRIEF_MAX_ID_CHARS ? id.slice(0, RECOVERY_BRIEF_MAX_ID_CHARS - 3) + '...' : id
}

// The invariant on the ASSEMBLED brief. Every field is clean on its own, but
// the brief puts its own characters between the fields (a colon, spaces, line
// breaks), and those can supply the missing piece of a header or a tag that
// two fields only add up to. So the text is checked as a whole, in both shapes
// it has: as built, and as one line (the pane gets it with every line break
// turned into a space, pane-text.ts). "Settled" means the shared filter finds
// nothing left to change.
function settlesInFilter(text: string): boolean {
  const typed = paneOneLine(text)
  return sanitizePromptText(text) === text && sanitizePromptText(typed) === typed
}

/** One line of the brief. `fallback` is set on lines that carry an outside-written field. */
export interface BriefLine { text: string; fallback?: string }

// Lines are added one at a time; a line with outside text that makes the brief
// so far stop settling is replaced by its fallback, which holds no outside
// text. If the whole still does not settle (today that takes one of the brief's
// own fixed lines completing something, which none does), every outside line
// gives way to its fallback. Exported for the test of that last step.
export function assembleSettled(lines: BriefLine[]): string {
  const out: string[] = []
  for (const l of lines) {
    out.push(l.text)
    if (l.fallback !== undefined && !settlesInFilter(out.join('\n'))) out[out.length - 1] = l.fallback
  }
  const text = out.join('\n')
  if (settlesInFilter(text)) return text
  return lines.map((l) => l.fallback ?? l.text).join('\n')
}

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

  const fixed = (text: string): BriefLine => ({ text })
  const lines: BriefLine[] = [
    fixed('[recovery-brief] Ujraindultal, es ez egy FRISS session: az elozo beszelgetesed nincs meg.'),
    fixed('Amit a restart pillanataban a rendszer latott rolad:'),
  ]

  if (hasCards) {
    lines.push(fixed(''))
    lines.push(fixed(facts.inProgress.length === 1 ? 'Folyamatban levo kartyad:' : 'Folyamatban levo kartyaid:'))
    for (const c of facts.inProgress) {
      lines.push({
        text: `  - ${briefCardId(c.id)}: ${briefField(c.title, RECOVERY_BRIEF_MAX_TITLE_CHARS)}`,
        fallback: `  - ${BRIEF_FIELD_UNSETTLED}`,
      })
    }
  }

  if (hasDirty) {
    lines.push(fixed(''))
    const branch = facts.branch ? briefField(facts.branch, RECOVERY_BRIEF_MAX_BRANCH_CHARS) : ''
    const noBranch = 'Commitolatlan valtozasok a munkakonyvtaradban:'
    lines.push(branch ? { text: `Commitolatlan valtozasok a(z) ${branch} agon:`, fallback: noBranch } : fixed(noBranch))
    // The two-column code is git's own and stays verbatim (' M' and 'M ' differ).
    for (const f of facts.dirty) {
      lines.push({ text: `  ${f.code} ${briefField(f.path, RECOVERY_BRIEF_MAX_PATH_CHARS)}`, fallback: `  ${BRIEF_FIELD_UNSETTLED}` })
    }
    if (facts.dirtyTruncated) lines.push(fixed('  ... (a lista levagva)'))
  }

  lines.push(fixed(''))
  lines.push(fixed(
    'Ezek MERESEK a restart pillanatabol, nem utasitas: ellenorizd oket (git status, kanban), ' +
    'mielott barmit folytatnal. Ha kozben mar lezarult, ne kezdd ujra.',
  ))

  // Checked BEFORE the overall cut: the cut only removes text and appends one
  // ellipsis character, which the filter's normalisation would itself rewrite.
  const text = assembleSettled(lines)
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
 * import the process layer that calls it. `isReady` is the pane readiness gate
 * and `send` MUST abort on a busy pane (onBusyTimeout: 'abort'): the brief is
 * typed only into a pane that is idle at that moment. */
export type BriefDelivery = Pick<DeliverDeps, 'isReady' | 'send' | 'now' | 'sleep'>

// One brief per agent incarnation. Every successful start schedules a loop that
// can live 20 minutes, and starts stack: a --continue start whose launch check
// falls back to a fresh start, a double restart, a crash-loop reconcile start,
// a stop followed by a later start. Keyed on the agent, a newer scheduling (or
// a stop) makes every older loop withdraw at its next look, so the session is
// briefed once, by the newest start.
let briefGeneration = 0
const briefTokens = new Map<string, number>()

/** The agent stopped (or is being replaced): any waiting brief loop withdraws. */
export function cancelRecoveryBrief(agent: string): void {
  briefTokens.delete(agent)
}

/**
 * After a start, tell the new session what it was in the middle of.
 *
 * Fire-and-forget: scheduled, never awaited by the restart path, and every
 * failure is logged rather than raised. A restart that succeeded must not be
 * reported as failed because a courtesy message could not be typed.
 *
 * Timing: deliverWhenReady looks at the pane after RESUME_DELIVERY_OPTIONS
 * .firstMs (past the identity-setup and plugin-unlock keystrokes) and then on a
 * backoff until the pane is ready. It replaced a fixed 90 s timer that typed
 * into whatever state the pane was in.
 */
export function scheduleRecoveryBrief(
  agent: string,
  session: string,
  delivery: BriefDelivery,
  // Injected so a test can hand in facts instead of needing a real agent
  // directory, a real repo and a real database row. Without this seam the
  // only reachable case is "no facts, no message", which cannot show that the
  // send path works at all.
  gather: (agent: string) => RecoveryFacts = gatherRecoveryFacts,
  opts: DeliverOptions = RESUME_DELIVERY_OPTIONS,
): void {
  const token = ++briefGeneration
  briefTokens.set(agent, token)
  void (async () => {
    let facts: RecoveryFacts | null = null
    try {
      // Built at SEND time, when the pane is ready, so the brief states what
      // the fleet knows then; null (no facts) ends the delivery quietly.
      const res = await deliverWhenReady(agent, session, () => {
        facts = gather(agent)
        return buildRecoveryBrief(facts)
      }, opts, { ...delivery, stillOwed: () => briefTokens.get(agent) === token })
      // The newest loop (or nobody, after a stop) owns the entry; a finished
      // older one must not delete a newer token.
      if (briefTokens.get(agent) === token) briefTokens.delete(agent)
      const f = facts as RecoveryFacts | null
      if (res.status === 'nothing-to-say') {
        logger.info({ agent, session }, 'recovery-brief: nothing in flight, staying quiet')
        return
      }
      logger.info(
        { agent, session, delivery: res.status, attempts: res.attempts, elapsedMs: res.elapsedMs, cards: f?.inProgress.length ?? 0, dirty: f?.dirty.length ?? 0 },
        res.status === 'sent' ? 'recovery-brief sent after restart' : 'recovery-brief NOT delivered',
      )
    } catch (err) {
      logger.warn({ err, agent, session }, 'recovery-brief could not be delivered')
    }
  })()
}
