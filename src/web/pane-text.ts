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
