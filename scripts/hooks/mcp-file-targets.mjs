// Which local paths an MCP tool call reaches (MCPWRITEGATE1104).
//
// The path gates (db-write-gate.mjs, self-pace-gate.mjs) judge the native file
// tools by their file_path. An MCP tool that writes, moves or downloads a local
// file reaches the same paths through its own arguments, under its own name.
// This module only TELLS the gates which paths a call names and how; every
// decision (which path is protected, for whom) stays in the gate, on its own
// real-path engine. Pure on purpose: it imports nothing, so both gates can load
// it without an import cycle, and a gate can answer "no path here" before it
// loads anything heavy.
//
// The class comes from the TOOL name, never from the server name (Dani 68004):
// a file-writing tool on a server called anything at all is still a writer.
//   mover  -- move/rename/copy/delete...: a whole tree can go, so a gate also
//             denies a path that is a protected path's ANCESTOR (as the Bash
//             branch does for mv/cp/rm);
//   writer -- write/edit/save/download/export/mkdir...;
//   other  -- everything else (read, send, search, a calendar create...).
//
// Path candidates are every string leaf of tool_input, at any depth, with no
// key list: a renamed or nested key cannot hide a path. A leaf counts when it
// looks like a path (a slash, a leading ~ or a file:// URI). For the 'other'
// class a leaf with whitespace is prose, not a path.
//
// A KNOWN writer whose path argument is missing (the server would fall back to
// a default location we cannot see) reports missingPath: the gates deny it.

const MAX_DEPTH = 32
const MAX_LEAVES = 20000

const MOVER_WORDS = new Set(['move', 'mv', 'rename', 'copy', 'cp', 'delete', 'remove', 'rm', 'unlink', 'rmdir', 'trash'])
const WRITER_WORDS = new Set(['write', 'edit', 'save', 'download', 'export', 'mkdir', 'append', 'put', 'patch', 'overwrite', 'touch',
  // Dani 68192 (1): create_file / update_file / replace_in_file named no writer word before
  'update', 'replace', 'insert', 'set', 'modify', 'upsert'])
// "create" alone is not a writer (create_event, create_draft); "create" with a file or directory word is
const DIR_WORDS = new Set(['directory', 'dir', 'folder', 'file', 'files'])

// Known writers, by tool name (lower case). `file`: keys whose value is the written file. `dir`: keys whose value is
// a directory a file lands in under a name the call may not give (`name` keys give it when present). `required`: the
// path argument without which the server writes to a default place.
const KNOWN = new Map([
  ['write_file', { file: ['path'], required: true }],
  ['edit_file', { file: ['path'], required: true }],
  ['create_directory', { file: ['path'], required: true }],
  ['move_file', { file: ['source', 'destination'], required: true, mover: true }],
  // the Gmail server: savePath defaults to its own cwd, filename to the attachment's own name (the sender chose it)
  ['download_attachment', { dir: ['savePath'], name: ['filename'], required: true }],
  // the Drive server: localPath is a file OR a directory (the name then comes from Drive)
  ['downloadfile', { file: ['localPath'], dir: ['localPath'], required: true }],
  // Meshy: save_to is a file; the textures land next to it under their own names; no save_to = meshy_output/ in the cwd
  ['meshy_download_model', { file: ['save_to'], dirOf: ['save_to'], required: true }],
])

// A channel plugin's download_attachment (MCPWRITEGATE1104 regression, Iris 70079) shares the Gmail tool's name but
// takes no path at all: it writes into the plugin's own inbox under a name the plugin builds (Slack:
// <ts>_<sanitised name>, Telegram: <time>-<unique id>.<ext>, Discord the same shape, Gromzo: a file per
// attachment_id), measured on the installed plugin sources 2026-11-05. Google Chat (PELENKAGCHAT1113): file_id only,
// written to <state dir>/inbox/<time>-<sanitised tail of the id>, read from the plugin source (not installed here)
// at buglime/claude-channel-googlechat 3421b382a, src/tools.ts handleDownload, 2026-11-13. Its missing path is not a
// default we cannot see, so `required` does not apply to it. Only the REQUIRED rule is lifted, and only for these server + tool pairs:
// the class stays the tool name's (a writer), every path-looking leaf is still judged, and the same tool on any other
// server (the Gmail server under any name, an unknown server) still needs its path.
const INBOX_DOWNLOADERS = new Set([
  'plugin_slack-channel_slack__download_attachment',
  'plugin_telegram_telegram__download_attachment',
  'plugin_discord_discord__download_attachment',
  'plugin_gromzo-channel_gromzo__download_attachment',
  'plugin_googlechat_googlechat__download_attachment',
])
const writesOwnInbox = (server, tool) => INBOX_DOWNLOADERS.has(`${server}__${tool}`.toLowerCase())

// mcp__<server>__<tool>: the tool is the part after the LAST "__" (a plugin server name carries "__"-free segments,
// e.g. mcp__plugin_telegram_telegram__reply); everything between "mcp__" and it is the server.
export function parseMcpName(toolName) {
  const s = String(toolName ?? '')
  if (!/^mcp__/i.test(s)) return null
  const rest = s.slice(5)
  const i = rest.lastIndexOf('__')
  if (i <= 0 || i + 2 >= rest.length) return null
  return { server: rest.slice(0, i), tool: rest.slice(i + 2) }
}

// The words of a tool name: snake, kebab, dots and camelCase, lower case.
export function toolWords(tool) {
  return String(tool ?? '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase())
}

export function toolClass(tool) {
  const words = toolWords(tool)
  if (KNOWN.get(String(tool).toLowerCase())?.mover) return 'mover'
  if (words.some((w) => MOVER_WORDS.has(w))) return 'mover'
  if (words.some((w) => WRITER_WORDS.has(w))) return 'writer'
  if (words.includes('create') && words.some((w) => DIR_WORDS.has(w))) return 'writer'
  return 'other'
}

function fileUriPath(s) {
  if (!/^file:\/\//i.test(s)) return s
  try { return decodeURIComponent(s.replace(/^file:\/\/(?:localhost)?/i, '')) } catch { return s.replace(/^file:\/\//i, '') }
}

// A writer's or a mover's leaf with no whitespace is a candidate even with no slash (Dani 68192 (2)): a bare
// '.mcp.json' is a path relative to the cwd. For the other class (read, send) a leaf needs a slash or a leading ~.
//
// A bare leaf (no slash, no ~) counts only when it can name something guarded: it has a dot (`.mcp.json`,
// `settings.json`, `.env`), or it is the name of a guarded directory. Every candidate costs a real-path walk in each
// gate, and a real write carries thousands of plain values (sheet cells, message ids, labels): measured 2026-11-04
// on a 10k-cell sheet update, 3.8 s p50 / 4.5 s p95 with every bare leaf a candidate, against the gates' 5 s
// decision deadline. A plain number is never a path.
const BARE_GUARDED_NAMES = new Set(['store', 'scripts', 'hooks', 'plugins', 'agents', 'skills', 'local-hooks',
  'scheduled-tasks', 'marveen-local-plugins'])
function looksLikePath(s, cls) {
  if (!s) return false
  if (/^file:\/\//i.test(s)) return true
  if (s.includes('/') || s.startsWith('~')) return cls !== 'other' || !/\s/.test(s)
  if (cls === 'other' || /\s/.test(s) || /^[-+]?\d+(?:[.,]\d+)?$/.test(s)) return false
  return s.includes('.') || BARE_GUARDED_NAMES.has(s.toLowerCase())
}

// Every string leaf, depth- and count-bounded (a deadline guard). Past the bound the call is reported `truncated`:
// the gates treat a writer/mover that was not fully read as a deny.
function leaves(input) {
  const out = []
  let truncated = false
  const walk = (v, depth) => {
    if (out.length >= MAX_LEAVES) { truncated = true; return }
    if (typeof v === 'string') { out.push(v); return }
    if (v == null || typeof v !== 'object') return
    if (depth >= MAX_DEPTH) { truncated = true; return }
    for (const x of Array.isArray(v) ? v : Object.values(v)) walk(x, depth + 1)
  }
  walk(input, 0)
  return { values: out, truncated }
}

function keyNorm(k) { return String(k).replace(/[^A-Za-z0-9]/g, '').toLowerCase() }
function pick(input, keys) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return []
  const want = new Set(keys.map(keyNorm))
  return Object.entries(input).filter(([k, v]) => want.has(keyNorm(k)) && typeof v === 'string' && v.trim()).map(([, v]) => v)
}

const posixDirname = (p) => {
  const s = p.replace(/\/+$/, '')
  const i = s.lastIndexOf('/')
  return i < 0 ? '.' : i === 0 ? '/' : s.slice(0, i)
}

// -> null for a non-MCP tool; else { server, tool, cls, targets: [{ path, dir }], missingPath, truncated }.
// `dir: true` marks a directory a file lands in under a name this call does not fix: the gates judge it as "may a
// protected file appear directly in it", and a mover's paths as "is it a protected path or its ancestor".
export function mcpFileTargets(toolName, toolInput) {
  const parsed = parseMcpName(toolName)
  if (!parsed) return null
  const cls = toolClass(parsed.tool)
  const known = KNOWN.get(parsed.tool.toLowerCase())
  const targets = []
  const seen = new Set()
  const add = (path, dir) => {
    const p = fileUriPath(String(path))
    const k = `${dir ? 'd' : 'f'}\u0000${p}`
    if (!p || seen.has(k)) return
    seen.add(k)
    targets.push({ path: p, dir })
  }
  let missingPath = false
  if (known) {
    const files = known.file ? pick(toolInput, known.file) : []
    const dirs = known.dir ? pick(toolInput, known.dir) : []
    const names = known.name ? pick(toolInput, known.name) : []
    // a known mover's own keys are trees too (Dani 68192 (3)): a whole directory can go
    for (const f of files) add(f, !!known.mover)
    for (const d of dirs) {
      add(d, true)
      // a given name is joined (a "../" in it is resolved by the gate, not trusted); no name = the sender's name
      for (const n of names) add(`${d.replace(/\/+$/, '')}/${n}`, false)
    }
    for (const f of known.dirOf ? pick(toolInput, known.dirOf) : []) add(posixDirname(f), true)
    if (known.required && files.length === 0 && dirs.length === 0 && !writesOwnInbox(parsed.server, parsed.tool)) missingPath = true
  }
  // ...and every path-looking leaf, whatever its key (known or not): nothing a renamed key carries is skipped
  const { values, truncated } = leaves(toolInput)
  for (const v of values) if (looksLikePath(v, cls)) add(v, cls === 'mover')
  // The bare leaves looksLikePath left out (no dot, not a guarded name, not a number), for a writer or a mover:
  // a gate judges them only while a measured base is INSIDE a guarded directory (Dani 68255, Samu 68259), where any
  // bare name is a path into it ('evil' from scripts/hooks, 'pre-commit' from .git/hooks).
  const bare = cls === 'other' ? [] : [...new Set(values.filter((v) => v && !/\s|\//.test(v) && !v.startsWith('~')
    && !/^[-+]?\d+(?:[.,]\d+)?$/.test(v) && !looksLikePath(v, cls)))]
  // every leaf naming the dashboard DB by name, whatever the class (Dani 68192 (1)): judged for every caller
  const dbNamed = values.some((v) => /(?:^|\/)claudeclaw\.db(?:-wal|-shm|-journal)?$/i.test(fileUriPath(v.trim())))
  return { server: parsed.server, tool: parsed.tool, cls, known: !!known, targets, missingPath, truncated, dbNamed, bare }
}
