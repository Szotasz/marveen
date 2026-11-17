// K1 of the ROTSLACK1111 review (Dani 75718): a heartbeat output line is ONE line, whatever a field put into it holds.
//
// The rotation heartbeat (scripts/claude-plan-rotate-check.ts) prints structured lines -- ROTATE, NO_ALTERNATIVE,
// FLEET_*, and their SUBAGENT_ forms -- that the main agent's scheduled prompt reads line by line and acts on. A plan
// label is free text (claude-plans.ts only trims it), so a label holding a line break could:
//   - add a forged line of its own to that output (a fake ROTATE, read as an instruction -- a gap since V1);
//   - end the quoted heredoc the Slack signal is written in, when one of its lines is exactly the delimiter, so the
//     next line would run as a command in the main agent's shell (measured by the reviewer).
// Every C0/C1 control character and the Unicode line and paragraph separators become a space here, so the field can
// never break the line it is printed in.
const LINE_BREAKING = new RegExp('[\\u0000-\\u001F\\u007F-\\u009F\\u2028\\u2029]', 'g')

export function oneLineField(value: string): string {
  return value.replace(LINE_BREAKING, ' ')
}

/** True when a value holds a character oneLineField would replace (the plan routes refuse such a label, K1). */
export function breaksLine(value: string): boolean {
  return oneLineField(value) !== value
}
