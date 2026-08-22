// SCHEDCONTENTMATCH (Balogh-safe scheduler-content-match): a bounded, in-memory
// record of the scheduled-task prompt BODIES we recently typed into a session's
// input box. Its ONLY consumer is clearStaleParkedInput's MAIN_CHANNELS_SESSION
// branch, which normally NEVER auto-clears the main box (a parked line could be
// a real human/inter-agent reply -- the 2026-06-30 "Balogh" near-miss). The one
// exception this module enables: when a stranded parked line on the main box is
// provably a fragment of one of OUR OWN dispatched scheduled prompts, it is
// system-generated text that can NEVER be a real inbound reply, so it is SAFE to
// auto-clear instead of silencing the channel unattended overnight.
//
// Hard invariant: ONLY scheduled-task prompt bodies are ever recorded here --
// never inbound channel messages, never inter-agent messages. A parked line that
// is not a substring of a recorded body must never match.

import { SCHEDULED_TASK_PREAMBLE } from '../prompt-safety.js'

// Recently dispatched scheduled prompt bodies live at most this long.
//
// SCHEDCONTENTMATCH v2 (2026-08-22): raised 15min -> 2h after a 78-minute main-box
// wedge (2026-08-21 07:19-08:37) whose remnant fell out of the 15-minute window
// long before anything looked at it. The TTL is no longer a correctness boundary:
// the time-INDEPENDENT config-prompt corpus below now decides the same matches on
// its own, so the record path is a fast path/optimization (it also covers the
// pre-check-prefixed body, which the raw config prompt does not contain).
export const DISPATCHED_PROMPT_TTL_MS = 2 * 60 * 60 * 1000 // 2 hours

// Ring-buffer capacity: a handful of scheduled tasks can dispatch in a short
// burst; 32 is comfortably above any realistic in-flight count while staying
// bounded (no unbounded growth from a hot-looping runner).
const DISPATCHED_PROMPT_CAP = 32

// A recorded body shorter than this carries no signal -- ignore it so trivial
// or empty prompts can never authorize a clear.
const MIN_RECORD_LEN = 20

// The normalized PARKED text must be at least this long to be eligible to match.
// A REAL stranded wedge remnant is long (hundreds of chars -- a mid-slice of a
// full scheduled envelope), so a high floor loses none of them; it only removes
// the risk that a SHORT parked line (e.g. a brief real inbound reply, 12-39
// chars) coincidentally lands as a substring of some long recorded body. In the
// rare event a genuinely short scheduled remnant strands, it simply gets the
// safe default (escalate-only) instead of an auto-clear -- never the reverse.
// (Masha adversarial-review hardening, 2026-08-19: raised 12 -> 40.)
export const SCHED_MATCH_MIN_LEN = 40

interface RecordedPrompt {
  body: string // normalized
  at: number // Date.now() at record time
}

const recorded: RecordedPrompt[] = []

// SCHEDCONTENTMATCH v2: the TIME-INDEPENDENT half of the corpus -- the scheduled
// task CONFIG prompt bodies currently on disk, refreshed by the schedule runner
// on every poll. Two gaps in the record-only design made the 2026-08-21 wedge
// survive 78 minutes:
//   (a) TTL: a wedge can stand for hours; the record that authorized clearing it
//       expired long before anyone looked.
//   (b) skipIfBusy=true ticks are dropped BEFORE dispatch, so a body that never
//       dispatched was never recorded -- yet its text can still strand in the box
//       from an earlier attempt.
// A config prompt is the same class of text as a dispatched body: operator-authored
// system text (SKILL.md on disk / the bearer-gated schedule editor), NEVER an
// inbound channel or inter-agent message. Matching against it is therefore exactly
// as Balogh-safe as matching a record, and it holds regardless of elapsed time or
// process restarts (the set is re-read from disk each poll).
let configPrompts: string[] = []

// The dispatched text is SCHEDULED_TASK_PREAMBLE + prefix + wrapScheduledTask(body),
// so a fragment sliced out of the PREAMBLE is not a substring of any raw config
// prompt. The preamble is a static, operator-owned system constant, so it belongs
// in the time-independent corpus permanently (Masha adversarial pre-flag 87/1).
const STATIC_SYSTEM_CORPUS = [normalize(SCHEDULED_TASK_PREAMBLE)].filter(t => t.length >= MIN_RECORD_LEN)

// Replace the config-prompt corpus with the CURRENT scheduled-task prompt bodies.
// Called by the schedule runner each poll cycle with `task.prompt` for every task
// it just read from disk -- deliberately injected rather than read here, so this
// module stays IO-free and trivially testable. Bodies shorter than MIN_RECORD_LEN
// carry no signal and are dropped.
export function setScheduledTaskConfigPrompts(prompts: string[]): void {
  const next: string[] = []
  for (const p of prompts) {
    const norm = normalize(p)
    if (norm.length >= MIN_RECORD_LEN) next.push(norm)
  }
  configPrompts = next
}

// Trim, then collapse every run of internal whitespace (incl. newlines/tabs) to
// a single space. Applied identically to recorded bodies and to the parked text
// so a multi-line prompt that gets re-wrapped in the input box still matches.
function normalize(text: string): string {
  return text.trim().replace(/\s+/g, ' ')
}

function pruneExpired(now: number): void {
  // Drop everything past its TTL. Entries are appended in time order, so all
  // expired ones sit at the front; splice them off in one pass.
  let firstLive = 0
  while (firstLive < recorded.length && now - recorded[firstLive]!.at > DISPATCHED_PROMPT_TTL_MS) {
    firstLive++
  }
  if (firstLive > 0) recorded.splice(0, firstLive)
}

// Record a scheduled-task prompt body that is about to be (or has just been)
// typed into a session's input box. Call with the SAME text that gets typed.
export function recordDispatchedScheduledPrompt(body: string): void {
  const norm = normalize(body)
  if (norm.length < MIN_RECORD_LEN) return
  const now = Date.now()
  pruneExpired(now)
  recorded.push({ body: norm, at: now })
  // Keep the buffer bounded: drop the oldest overflow entries.
  if (recorded.length > DISPATCHED_PROMPT_CAP) {
    recorded.splice(0, recorded.length - DISPATCHED_PROMPT_CAP)
  }
}

// True iff the parked text is a substring of (a) some non-expired recorded
// dispatched body, or (b) a CURRENT scheduled-task config prompt / the static
// scheduled-task preamble -- catching a stranded FRAGMENT of a longer scheduled
// prompt however long it has been standing. The parked text must clear
// SCHED_MATCH_MIN_LEN after normalization to be eligible.
export function matchesDispatchedScheduledPrompt(parked: string): boolean {
  const norm = normalize(parked)
  if (norm.length < SCHED_MATCH_MIN_LEN) return false
  const now = Date.now()
  pruneExpired(now)
  for (const rec of recorded) {
    if (rec.body.includes(norm)) return true
  }
  // Time-independent half: the scheduled-task CONFIG prompts on disk plus the
  // static scheduled-task preamble. No TTL applies here -- an hours-old wedge
  // whose text is provably one of our own scheduled bodies is still provably
  // ours, and the Balogh invariant is unchanged (only a POSITIVE match ever
  // authorizes a clear; everything else keeps the escalate-only behaviour).
  for (const body of configPrompts) {
    if (body.includes(norm)) return true
  }
  for (const body of STATIC_SYSTEM_CORPUS) {
    if (body.includes(norm)) return true
  }
  return false
}

// Test-only: clear all recorded state so each test starts from a clean buffer.
export function __resetDispatchedScheduledPromptsForTest(): void {
  recorded.length = 0
  configPrompts = []
}
