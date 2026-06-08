// Pure helpers mirroring the inline implementations in web/app.js's openAgentPty.
// Signatures match how the browser code constructs values: location.host already
// combines hostname:port, so we accept a single hostPort string.

export function buildPtyWsUrl(
  protocol: string,
  hostPort: string,
  ticket: string,
  cols: number,
  rows: number,
): string {
  const wsScheme = protocol === 'https:' ? 'wss:' : 'ws:'
  return `${wsScheme}//${hostPort}/ws/agent-pty?ticket=${encodeURIComponent(ticket)}&cols=${cols}&rows=${rows}`
}

export function buildResizeMsg(cols: number, rows: number): string {
  return JSON.stringify({ type: 'resize', cols, rows })
}

export function ptyCloseCodeMsg(code: number): string {
  if (code === 4401) return '\u274C Expired or invalid ticket'
  if (code === 4404) return '\u274C Agent is not running'
  if (code === 4429) return '\u274C Too many concurrent viewers'
  return `\u274C Connection closed (code: ${code})`
}
