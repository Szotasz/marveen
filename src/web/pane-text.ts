// The ONE transformation a prompt undergoes between the caller and the tmux
// pane (DIREKTIVASORTORES920, 2026-09-20). sendPromptToSession() types the
// text into the pane as literal send-keys chunks, and a newline there would
// submit the prompt early, so every line break becomes a single space FIRST.
//
// Kept in its own tiny module because a second reader depends on knowing it
// exactly: scripts/hooks/provenance-gate.py verifies a system directive by
// comparing the pane-delivered body with the queue row, and it must apply this
// same mapping to the row. Measured 2026-09-20: the gate expected the caller's
// `header + "\n" + body` shape, the pane received `header + " " + body`, and
// every real directive since #1411 (3 of 3) was flagged forged over that one
// character. The gate's test was green throughout because it measured the
// pre-delivery artefact. If this mapping ever changes, change it HERE, and the
// hook test that feeds the gate through this function goes red with it.
export function paneOneLine(text: string): string {
  return text.replace(/\r?\n/g, ' ')
}

// ENVATLEAK1114 (2026-11-14): Claude Code expands an at-sign followed by a path
// into a FILE ATTACHMENT when the at-sign stands at the start of the prompt or
// right after whitespace -- with no tool call, so no PreToolUse hook and no
// approval gate ever sees it. An inter-agent message that merely QUOTED such a
// token put a secrets file into two agents' contexts that day. Measured on
// Claude Code 2.1.323 (150 canary cases, headless): the envelope, a fenced code
// block and a batch do not protect; relative, absolute, tilde, parent-dir and
// quoted paths all resolve; a directory attaches its listing; trailing
// punctuation does not stop it; the router's own `[Uzenet <at>sender-tol` header
// resolves too when a file of that name exists in the recipient's cwd. What
// DOES stop it is any non-whitespace character before the at-sign.
//
// So every at-sign at the start of the text or after whitespace gets a
// backslash in front of it, WHATEVER follows (the quoted-path form means the
// text after the at-sign cannot be pattern-matched safely). `\s` is the
// JavaScript whitespace class on purpose: U+00A0, U+2009, U+3000, U+FEFF and a
// lone CR all trigger the expansion (measured), U+200B does not. The backslash
// is visible, reversible and not a look-alike character. The mapping is
// idempotent: after it no at-sign follows whitespace, so re-typed pane text
// (stuck-input replay, parked input) is not escaped twice.
//
// TWO additions after review (Dani, #2743), both because what reaches the pane is
// not exactly the mapped text:
//
//   - A SEMICOLON counts like whitespace. The chunker that types the text
//     (computeTmuxChunk in agent-process.ts) appends a space to a chunk that
//     still ends in ';' after its slide is used up, because tmux drops a
//     trailing ';'. Nine semicolons right before an at-sign, aligned to a chunk
//     boundary, therefore reached the pane as `; ` + at-sign with no backslash
//     (measured on the pure functions: 2 of 200 offsets, and 40 of 40 deliveries
//     of a payload built for it). With the backslash after ';' too, the inserted
//     space is followed by a backslash. This is the ONLY place where the typed
//     stream gains a character before an at-sign: the chunker's other insertion
//     is a space before a chunk that starts with '-', and that space is followed
//     by the dash. src/__tests__/pane-at-neutralize.test.ts asserts the rule on
//     the concatenated CHUNKS, not on this function's output.
//   - Control characters never reach the pane (stripPaneControls, applied BEFORE
//     the at-sign step). A backspace or DEL typed before an at-sign could erase
//     the character in front of it and so turn it into an at-sign after
//     whitespace; a lone CR could submit the prompt early. Whether the TUI acts
//     on these today was NOT measured: none of them belongs in a message, so
//     they are removed rather than measured. The order matters: the at-sign step
//     runs on the text as it will be typed, so an at-sign that only FOLLOWS
//     whitespace once a control character is gone still gets its backslash.
//
// The queue row keeps the ORIGINAL text; only what is typed changes.
const AT_AFTER_BREAK_RX = /(^|[\s;])@/g

export function neutralizeAtMentions(text: string): string {
  return text.replace(AT_AFTER_BREAK_RX, '$1\\@')
}

// C0 without TAB (LF is gone by then, see paneOneLine), DEL, and C1. A lone CR
// becomes a space, like the line break it is; everything else is deleted.
const PANE_CONTROL_RX = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g

export function stripPaneControls(text: string): string {
  return text.replace(/\r/g, ' ').replace(PANE_CONTROL_RX, '')
}

// What sendPromptToSession() actually types: one line, no control character,
// no expandable at-sign, in THAT order. Every reader that compares a
// pane-delivered text with its source (scripts/hooks/provenance-gate.py
// `pane_shape`, the delivery-integrity `sentText`) must apply THIS function,
// not paneOneLine alone, or the typed and the compared shape drift apart again
// (see DIREKTIVASORTORES920 above).
export function paneTyped(text: string): string {
  return neutralizeAtMentions(stripPaneControls(paneOneLine(text)))
}
