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
// The queue row keeps the ORIGINAL text; only what is typed changes.
const AT_AFTER_SPACE_RX = /(^|\s)@/g

export function neutralizeAtMentions(text: string): string {
  return text.replace(AT_AFTER_SPACE_RX, '$1\\@')
}

// What sendPromptToSession() actually types: one line, with no expandable
// at-sign. Every reader that compares a pane-delivered text with its source
// (scripts/hooks/provenance-gate.py `pane_shape`, the delivery-integrity
// `sentText`) must apply THIS function, not paneOneLine alone, or the typed and
// the compared shape drift apart again (see DIREKTIVASORTORES920 above).
export function paneTyped(text: string): string {
  return neutralizeAtMentions(paneOneLine(text))
}
