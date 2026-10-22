// Inline (non-navigating) `/mcp` commands, as an alternative to walking the
// /mcp menu with blind arrow keys.
//
// The reconnect path types `/mcp reconnect <server>` instead of navigating the
// /mcp modal. To know what happened it has to read two things off the pane: the
// echo row of the submitted command and the reply the CLI prints under it.
//
// This module is pure (no imports, no tmux, no timers): callers own the tmux
// I/O and hand it pane captures. The reply literals are version-sensitive. They
// were read from the Claude Code CLI binary (2.1.205) and checked against real
// 2.1.291 captures in src/__tests__/fixtures/mcp-reconnect-cli-2.1.291/.
//
// Any input the CLI's /mcp router does not recognise (a bare `/mcp reconnect`,
// a typo in the action word) opens the full modal, so only the two verbs below
// are ever typed, always with a non-empty server name, and the classifier
// checks for the modal anyway. A reply that matches nothing classifies as
// 'unknown', which says nothing about the plugin: callers keep a fallback.

// The two router branches that are non-interactive. `disable` is deliberately
// absent: it is reachable in the same branch as `enable`, but nothing here
// should ever turn a channel plugin off.
export type McpInlineAction = 'enable' | 'reconnect'

export type McpInlineOutcome =
  // enable: the server was disabled and has been switched on. The CLI fires the
  // connect attempt WITHOUT awaiting it, so this means "enabled", NOT "connected".
  | 'enabled'
  // enable: no-op, the server was not in the disabled state.
  | 'already-enabled'
  // reconnect: the client was awaited and reported itself connected.
  | 'reconnected'
  // reconnect: ran to completion, server did not come up.
  | 'reconnect-failed'
  // reconnect: the server is disabled; `/mcp enable` must run first.
  // Captured on CLI 2.1.291 (fixture reconnect-plugin-disabled.txt):
  // `"X" is disabled — enable it in /mcp first`.
  | 'disabled'
  // reconnect: server wants an interactive auth flow; keystrokes cannot fix it.
  | 'needs-auth'
  // enable: server is waiting on human approval in the modal.
  | 'pending-approval'
  // Either verb: no server by that name. Usually a wrong plugin pane id.
  | 'not-found'
  // The full /mcp modal appeared. The command was not understood; the pane is
  // now parked and the caller MUST dismiss it.
  | 'dialog-open'
  // Nothing recognisable appeared. Says nothing about the plugin.
  | 'unknown'

// The modal title, read from the CLI binary.
const MCP_DIALOG_RX = /Manage MCP servers/

/**
 * Classify the text a `/mcp <action> <server>` command left behind.
 *
 * `newText` must be ONLY what appeared after the command was submitted (see
 * mcpCommandReply). Classifying the whole pane would happily match the reply of
 * a PREVIOUS attempt still sitting in the scrollback and report success for a
 * command that in fact produced nothing.
 *
 * Every branch is a literal read from the 2.1.205 binary; `serverName` is
 * required in the match wherever the CLI interpolates it, so a stale line about
 * a different server cannot satisfy us.
 */
export function classifyMcpInlineReply(
  newText: string,
  action: McpInlineAction,
  serverName: string,
): McpInlineOutcome {
  if (MCP_DIALOG_RX.test(newText)) return 'dialog-open'
  const name = escapeForRegex(serverName)

  // Shared by both verbs: `MCP server "X" not found`.
  // Tested before either verb's branch: on the reconnect path the error render
  // ALSO draws `Failed to reconnect to X` above this line (see the note below),
  // so a not-found reply reaching that test first would read as a plain
  // failure and hide the one cause the fallback cannot fix either -- a wrong
  // plugin pane id, where every retry is spent on a server that does not exist.
  if (new RegExp(`MCP server "${name}" not found`, 'i').test(newText)) return 'not-found'

  if (action === 'enable') {
    // `MCP server "X" is pending approval — approve it via /mcp first`.
    // The dash is U+2014 in the binary; match on the stable prefix instead so a
    // terminal that re-wraps or transliterates the line still classifies.
    if (new RegExp(`MCP server "${name}" is pending approval`, 'i').test(newText)) return 'pending-approval'
    // `MCP server "X" is already enabled`. Must be tested BEFORE the
    // success pattern -- `... is already enabled` also contains `... enabled`.
    if (new RegExp(`MCP server "${name}" is already enabled`, 'i').test(newText)) return 'already-enabled'
    // `MCP server "X" enabled`.
    if (new RegExp(`MCP server "${name}" enabled`, 'i').test(newText)) return 'enabled'
    return 'unknown'
  }

  // THE ORDER BELOW IS LOAD-BEARING, not stylistic. Do not sort these.
  //
  // Read from the reconnect view in the 2.1.205 binary. It keeps ONE error
  // string, and its error render is hardcoded:
  //
  //   if (error) return <>{"Failed to reconnect to " + serverName}
  //                       {"Error: " + error}</>
  //
  // while the branches set that error to four DIFFERENT things:
  //   not-found  -> setError(`MCP server "X" not found`)  + onComplete(same)
  //   needs-auth -> setError(`X requires authentication`) + onComplete(`... Use /mcp to authenticate.`)
  //   pending|failed|disabled -> setError(`Failed to reconnect to X`) + onComplete(same)
  //   catch      -> setError(<exception message>)         + onComplete(`Error: <message>`)
  //
  // So `Failed to reconnect to X` is on the pane for EVERY unhappy branch,
  // including needs-auth and not-found. It is the LEAST specific literal here
  // and must therefore be tested LAST; the not-found test above and the
  // needs-auth test below both run first for exactly this reason. Reordering
  // them collapses three distinguishable states into 'reconnect-failed' -- and
  // needs-auth is the one state where the caller's fallback is guaranteed
  // useless, because no keystroke sequence can complete an OAuth flow.
  //
  // The catch branch has no literal of its own that names the server, so it
  // lands on 'reconnect-failed' rather than 'unknown'. Both make a caller fall
  // back identically, and this is a deliberate consequence of the render above,
  // not an oversight to be "fixed" by matching a bare `Error:`, which carries
  // no server name and would match anything.
  //
  // `"X" is disabled` -> the 'disabled' outcome; see that union arm above for the
  // 2.1.291 line this reads.
  if (new RegExp(`"${name}" is disabled`, 'i').test(newText)) return 'disabled'
  // `Successfully reconnected to X`.
  if (new RegExp(`Successfully reconnected to ${name}`, 'i').test(newText)) return 'reconnected'
  // `X requires authentication. Use /mcp to authenticate.` (render also
  // shows the generic `Failed to reconnect to X` above it -- hence: first).
  if (new RegExp(`${name} requires authentication`, 'i').test(newText)) return 'needs-auth'
  // `Failed to reconnect to X` (its pending/failed/disabled cases, plus
  // the generic render line of every branch that did not match above).
  if (new RegExp(`Failed to reconnect to ${name}`, 'i').test(newText)) return 'reconnect-failed'
  return 'unknown'
}

function escapeForRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Server names we are willing to type into a pane.
 *
 * The name is interpolated into a keystroke (`send-keys -l`), so anything
 * outside this conservative class -- whitespace (which would split the
 * argument and fall through to the full modal), shell/quote metacharacters,
 * newlines -- is refused by the caller before anything is typed. Plugin pane
 * ids are `plugin:<plugin>:<server>` and pass today; this is the fence that
 * says a future exotic name has to be measured, not assumed.
 */
export function isSafeMcpServerName(name: string): boolean {
  return /^[A-Za-z0-9:._@-]+$/.test(name)
}

/**
 * One rendered echo of a submitted `/mcp <action> <server>` command.
 *
 * Captured on CLI 2.1.291 (fixtures dir, README.md): a submitted command
 * renders as `❯ /mcp reconnect okserver` -- U+276F, exactly ONE normal
 * space (U+0020), the command text, no leading whitespace. The LIVE input box
 * row instead renders `❯` followed by U+00A0 (NBSP), so requiring the exact
 * U+0020 separator is what tells a submitted echo from a command still sitting
 * in the box. Only trailing space/tab/NBSP is stripped (terminal padding).
 */
function isMcpCommandEcho(line: string, action: McpInlineAction, serverName: string): boolean {
  return line.replace(/[ \t ]+$/, '') === `❯ /mcp ${action} ${serverName}`
}

/**
 * How many `/mcp <action> <server>` echo lines the pane currently shows.
 *
 * The caller uses the COUNT, not a boolean: an older identical echo plus its
 * result can still be on screen from a previous attempt, so "the count grew"
 * is the proof that THIS command's result has been rendered.
 */
export function countMcpCommandEchoes(pane: string, action: McpInlineAction, serverName: string): number {
  return pane.split('\n').filter((line) => isMcpCommandEcho(line, action, serverName)).length
}

/**
 * The reply block of the NEWEST `/mcp <action> <server>` echo, or null.
 *
 * Captured shape (CLI 2.1.291, fixtures dir): the echo line is followed by the
 * result as `  ⎿  <text>`. This finds the LAST echo line, then the first
 * non-blank line after it; if that line is not the `⎿` result row the result
 * has not been rendered yet (the busy spinner, the "Reconnecting" panel) and
 * null is returned. The reply is the contiguous non-blank block starting at
 * the `⎿` line, ready for classifyMcpInlineReply.
 *
 * This is the reply of the NEWEST echo only -- but an older identical echo can
 * still be on screen, so the caller MUST also check that the echo count grew
 * (see countMcpCommandEchoes) before trusting this as OUR command's result.
 */
export function mcpCommandReply(pane: string, action: McpInlineAction, serverName: string): string | null {
  const lines = pane.split('\n')
  let echo = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    if (isMcpCommandEcho(lines[i] ?? '', action, serverName)) { echo = i; break }
  }
  if (echo < 0) return null
  // String.prototype.trim also strips U+00A0, so a padding-only line is blank.
  let result = -1
  for (let i = echo + 1; i < lines.length; i++) {
    if ((lines[i] ?? '').trim() !== '') { result = i; break }
  }
  if (result < 0) return null
  if (!(lines[result] ?? '').trimStart().startsWith('⎿')) return null
  let end = result
  while (end + 1 < lines.length && (lines[end + 1] ?? '').trim() !== '') end++
  return lines.slice(result, end + 1).join('\n')
}

/**
 * Is the reply of the NEWEST `/mcp <action> <server>` echo the latest exchange
 * on screen? An older identical echo can come INTO view while ours is not yet
 * rendered (a resize, or the "Reconnecting" panel replacing the input box), and
 * would then be the newest echo with its old reply. Everything that happened
 * after such an echo is still below it, and that always includes a submitted
 * prompt row (`❯` + U+0020) or an assistant/tool row (`⏺`). Behind our own
 * reply only blank padding, status lines and the live input box follow (true
 * on all final CLI 2.1.291 captures in the fixtures dir).
 */
export function mcpReplyIsLatest(pane: string, action: McpInlineAction, serverName: string): boolean {
  const lines = pane.split('\n')
  let echo = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    if (isMcpCommandEcho(lines[i] ?? '', action, serverName)) { echo = i; break }
  }
  if (echo < 0) return false
  let i = echo + 1
  while (i < lines.length && (lines[i] ?? '').trim() === '') i++
  while (i < lines.length && (lines[i] ?? '').trim() !== '') i++ // the reply block itself
  for (; i < lines.length; i++) {
    const line = lines[i] ?? ''
    if (line.startsWith('❯ ') || line.trimStart().startsWith('⏺')) return false
  }
  return true
}

// The /mcp dialog as drawn by CLI 2.1.291 (both dialog captures in the
// fixtures dir): a line that starts with a long run of U+2594 (the dialog's
// top rule), then a line that holds ONLY the title, then the server count.
const MCP_DIALOG_TITLE_LINE_RX = /^\s*Manage MCP servers\s*$/
const DIALOG_TOP_RULE_RX = /^\u2594{10,}/

/**
 * Does the LIVE part of the pane show the /mcp dialog itself? The title must be
 * a line of its own directly under the dialog's top rule (blank lines aside),
 * and no submitted-prompt row (`❯` + U+0020) or assistant/tool row (`⏺`) may
 * follow it. The same words quoted in the transcript (in a sentence, on a `⏺`
 * row or on its unmarked continuation line), with another modal such as a tool
 * permission prompt open below them, must not make that modal look like the
 * /mcp dialog.
 */
export function showsMcpDialogTitle(pane: string): boolean {
  const lines = pane.split('\n')
  let title = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    if (MCP_DIALOG_TITLE_LINE_RX.test(lines[i] ?? '')) { title = i; break }
  }
  if (title < 0) return false
  let above = title - 1
  while (above >= 0 && (lines[above] ?? '').trim() === '') above--
  if (above < 0 || !DIALOG_TOP_RULE_RX.test((lines[above] ?? '').trim())) return false
  for (let i = title + 1; i < lines.length; i++) {
    const line = lines[i] ?? ''
    if (line.startsWith('❯ ') || line.trimStart().startsWith('⏺')) return false
  }
  return true
}
