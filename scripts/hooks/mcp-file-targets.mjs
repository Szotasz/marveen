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

const MAX_DEPTH = 6
const MAX_LEAVES = 256

const MOVER_WORDS = new Set(['move', 'mv', 'rename', 'copy', 'cp', 'delete', 'remove', 'rm', 'unlink', 'rmdir', 'trash'])
const WRITER_WORDS = new Set(['write', 'edit', 'save', 'download', 'export', 'mkdir', 'append', 'put', 'patch', 'overwrite', 'touch'])
// "create" alone is not a writer (create_event, create_draft); "create" with a directory word is
const DIR_WORDS = new Set(['directory', 'dir', 'folder'])

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

function looksLikePath(s, cls) {
  if (!s) return false
  if (/^file:\/\//i.test(s)) return true
  if (cls === 'other' && /\s/.test(s)) return false
  return s.includes('/') || s.startsWith('~')
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
    for (const f of files) add(f, false)
    for (const d of dirs) {
      add(d, true)
      // a given name is joined (a "../" in it is resolved by the gate, not trusted); no name = the sender's name
      for (const n of names) add(`${d.replace(/\/+$/, '')}/${n}`, false)
    }
    for (const f of known.dirOf ? pick(toolInput, known.dirOf) : []) add(posixDirname(f), true)
    if (known.required && files.length === 0 && dirs.length === 0) missingPath = true
  }
  // ...and every path-looking leaf, whatever its key (known or not): nothing a renamed key carries is skipped
  const { values, truncated } = leaves(toolInput)
  for (const v of values) if (looksLikePath(v, cls)) add(v, cls === 'mover')
  return { server: parsed.server, tool: parsed.tool, cls, known: !!known, targets, missingPath, truncated }
}
