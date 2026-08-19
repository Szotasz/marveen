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

// Recently dispatched scheduled prompt bodies live at most this long. A stranded
// remnant is cleared within seconds/minutes of the dispatch that produced it, so
// a short TTL keeps the match window tight and prevents a long-past body from
// authorizing a clear of some unrelated later parked line.
export const DISPATCHED_PROMPT_TTL_MS = 15 * 60 * 1000 // 15 minutes

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

// True iff the parked text is a substring of some non-expired recorded scheduled
// body (catching a stranded FRAGMENT of a longer dispatched prompt). The parked
// text must clear SCHED_MATCH_MIN_LEN after normalization to be eligible.
export function matchesDispatchedScheduledPrompt(parked: string): boolean {
  const norm = normalize(parked)
  if (norm.length < SCHED_MATCH_MIN_LEN) return false
  const now = Date.now()
  pruneExpired(now)
  for (const rec of recorded) {
    if (rec.body.includes(norm)) return true
  }
  return false
}

// Test-only: clear all recorded state so each test starts from a clean buffer.
export function __resetDispatchedScheduledPromptsForTest(): void {
  recorded.length = 0
}
