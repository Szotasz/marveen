// Parse a single line of `claude mcp list` output into a structured entry.
//
// The CLI prints one line per registered MCP server, shaped like:
//
//   claude.ai Gmail: https://gmailmcp.googleapis.com/mcp/v1 - Connected
//   plugin:telegram:telegram: bun run --cwd /path ... - Connected
//   my-local-server: node /path/to/server.js - ! Needs authentication
//
// The name portion carries a source prefix that the dashboard's
// state-detection needs to normalise:
//
//   "claude.ai <Name>"      --> source='claude.ai', id=slug(<Name>)
//   "plugin:<pkg>:<slug>"   --> source='plugin',    id=<slug>
//   "<name>"                --> source='local',     id=slug(<name>)
//
// Normalisation strips the prefix, lowercases, and replaces runs of
// whitespace with a single hyphen so the id lines up with catalog
// entries whose `id` field is already slug-form ("gmail", "google-drive").

export type McpListSource = 'claude.ai' | 'plugin' | 'local'
export type McpListStatus = 'connected' | 'needs_auth' | 'failed' | 'unknown'

export interface McpListEntry {
  // Raw display name as printed by the CLI, e.g. "claude.ai Gmail".
  name: string
  // Slug used for matching against mcp-catalog.json ids, e.g. "gmail".
  normalizedId: string
  // Raw endpoint / command column from the CLI, for display only.
  endpoint: string
  status: McpListStatus
  source: McpListSource
}

// Status line suffix -> canonical status. The CLI format lives in the
// Claude Code repo and may gain variants; keep the mapping here so a
// single edit handles a future rename.
function parseStatus(raw: string): McpListStatus {
  const lower = raw.toLowerCase()
  if (lower.includes('connected')) return 'connected'
  if (lower.includes('needs authentication')) return 'needs_auth'
  if (lower.includes('failed')) return 'failed'
  return 'unknown'
}

export function slugify(raw: string): string {
  // Defensive normalisation. Catalog ids are already plain
  // [a-z0-9-]+, so this is a best-effort mapping for CLI names that
  // could contain dots, parens, or slashes ("Google (beta)",
  // "foo.bar"). Runs of non-alphanumerics collapse into a single
  // hyphen, and leading/trailing hyphens are trimmed so the slug
  // stays readable for the dashboard.
  return raw
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function classifyName(raw: string): { source: McpListSource; normalizedId: string } {
  const trimmed = raw.trim()
  // "plugin:<package>:<name>" -- the trailing segment is the actual
  // MCP id as it appears in enabledPlugins. `plugin:telegram:telegram`
  // collapses to `telegram`; `plugin:foo-bar:my-server` collapses to
  // `my-server`. If the input is malformed and has fewer than three
  // segments, fall back to the last segment we do have.
  if (trimmed.toLowerCase().startsWith('plugin:')) {
    const segments = trimmed.split(':')
    const last = segments[segments.length - 1] || trimmed
    return { source: 'plugin', normalizedId: slugify(last) }
  }
  // "claude.ai <Name>" -- case-insensitive prefix, single space.
  // Anything after the prefix is the human label ("Google Calendar",
  // "Gmail", etc.) and needs full slug normalisation to line up with
  // catalog ids ("google-calendar", "gmail").
  const CLAUDE_AI_PREFIX = /^claude\.ai\s+/i
  if (CLAUDE_AI_PREFIX.test(trimmed)) {
    const tail = trimmed.replace(CLAUDE_AI_PREFIX, '')
    return { source: 'claude.ai', normalizedId: slugify(tail) }
  }
  // Plain local-user / project entry.
  return { source: 'local', normalizedId: slugify(trimmed) }
}

export function parseMcpListLine(line: string): McpListEntry | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  // The CLI prints a leading "Checking MCP server health..." banner plus
  // occasional blank lines. Skip anything that is not a "name: endpoint - status"
  // triple; relying on the two separator tokens avoids having to enumerate
  // every banner variant the CLI may introduce.
  if (trimmed.startsWith('Checking')) return null

  // Shape: "<name>: <endpoint> - <status>". The name itself can contain
  // colons (e.g. "plugin:telegram:telegram"), so anchor on the first
  // ": " (colon + space) rather than the first ":" alone -- that
  // separator is stable because the CLI always prints one space after
  // the name's terminating colon. The endpoint may contain URL colons
  // (https://host:443/...) but rarely " - ", so the status split uses
  // lastIndexOf(' - ') to be safe against command-line endpoints that
  // happen to include dashes in flags.
  const firstSep = trimmed.indexOf(': ')
  if (firstSep <= 0) return null
  const lastSep = trimmed.lastIndexOf(' - ')
  if (lastSep <= firstSep) return null

  const rawName = trimmed.slice(0, firstSep).trim()
  const endpoint = trimmed.slice(firstSep + 2, lastSep).trim()
  const statusRaw = trimmed.slice(lastSep + 3).trim()

  if (!rawName || !endpoint || !statusRaw) return null

  const { source, normalizedId } = classifyName(rawName)
  if (!normalizedId) return null

  return {
    name: rawName,
    normalizedId,
    endpoint,
    status: parseStatus(statusRaw),
    source,
  }
}

// Parse the full CLI output and drop any lines that are not valid
// entries. Exposed separately so the caller can feed us either the
// raw string or pre-split lines without having to re-scan the banner.
export function parseMcpList(output: string): McpListEntry[] {
  const entries: McpListEntry[] = []
  for (const line of output.split('\n')) {
    const parsed = parseMcpListLine(line)
    if (parsed) entries.push(parsed)
  }
  return entries
}

// Decide the outcome of a single cache refresh attempt. Pure logic so the
// caller can unit-test the three intertwined rules:
//
//   1. parseable output + zero exit             -> update entries, no error
//   2. parseable output + non-zero exit         -> update entries, no error
//      (a connector failing its health check is the CLI's steady state)
//   3. no parseable output + either exit        -> keep previous entries,
//      surface the error so the UI can show a stale-data banner
export interface RefreshInput {
  // stdout of `claude mcp list`, possibly empty.
  stdout: string
  // Non-null if the child exited non-zero, timed out, or failed to launch.
  execError: Error | null
  // Entries that were in the cache before this refresh ran.
  previousEntries: McpListEntry[]
}

export interface RefreshOutcome {
  entries: McpListEntry[]
  error: string | undefined
  // True when the previous cache entries were retained because the
  // current run produced nothing usable.
  retainedStale: boolean
}

// Scrub absolute user paths out of error messages before the dashboard
// stores them. An ENOENT from `spawn` carries the full attempted
// binary path; fs errors ("ENOENT: no such file or directory, open
// '/Users/...'") arrive with the path inside quotes. This helper
// replaces a caller-supplied homedir with "~" and collapses any
// still-absolute path under the standard Unix roots into a
// "<path>/<basename>" sentinel.
//
// The homedir argument is explicit so this module stays free of node
// process side effects; callers pass os.homedir().
//
// Scope: darwin + Linux error shapes. Windows-style drive paths
// (C:\\Users\\...) are NOT scrubbed; Windows is not a supported
// deployment target for this dashboard today.
//
// Prefix class accepts anything that is NOT a path character, so
// quoted (' ... '), parenthesised ((...)), or bracketed forms all
// match. Root alternatives cover Users, home, root, private/var,
// var, opt, tmp -- the common Unix roots under which an error
// message's path could start.
// Trailing group is optional so bare roots ("/root", "/Users") also
// match and can be reduced to a placeholder. The root-match alternation
// uses a captured group so the post-processing step can tell whether
// it saw "/Users/foo" (the single segment is the username, must drop)
// versus "/Users/foo/config.json" (the basename is safe to keep).
//
// Prefix class excludes ONLY alphanumerics and tilde. That is loose on
// purpose: characters like `-`, `_`, `.`, `/` are common in log glue
// (e.g. "--flag=/Users/foo/x", "config./Users/foo/x",
// "//Users/foo/x" double-slash artefacts). Excluding only alpha+tilde
// means a path at any of those boundaries still matches. The tilde
// guard prevents re-matching a path that step 2 already turned into
// "~/..." form.
// Trailing lookahead `(?=\/|[\s:'")\]}]|$)` after the root alternative
// is critical: without it `/homes/alice/secret.json` matches `/home`
// (prefix of the root keyword), collapses just the prefix, and leaks
// `s/alice/secret.json` through the residue. The lookahead requires
// the root token to END cleanly (slash, whitespace-class char, or
// end-of-string), so `/homes`, `/Users-backup`, `/opts-archive`,
// `/tmpfs`, `/rooted` do NOT trigger a partial scrub.
const PATH_SCRUB_RX = /(^|[^A-Za-z0-9~])\/(Users|home|root|private\/var|var|opt|tmp)(?=\/|[\s:'")\]}]|$)((?:\/[^\s:'")\]}]*)?)/g

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function scrubPaths(msg: string, homeDir: string): string {
  if (!msg) return msg
  // Step 1 FIRST: scrub any absolute path under a known root (Users,
  // home, root, private/var, var, opt, tmp). This catches every foreign
  // homedir that happens to share a string prefix with the caller's own
  // (e.g. /Users/bobsmith when HOME=/Users/bob -- a naive substring
  // replace would leave "smith/secret" behind). The path-scrub fires
  // regardless of whether the path's user equals the caller's.
  let out = msg.replace(PATH_SCRUB_RX, (_match, prefix: string, _rootName: string, trail: string) => {
    // trail = '' / '/foo' / '/foo/x.json'. A zero- or one-segment trail
    // means the basename itself is the user / tmpdir id -- drop it so
    // the output carries nothing identifying.
    const segments = trail.split('/').filter(Boolean)
    if (segments.length < 2) return prefix + '<path>'
    return prefix + '<path>/' + segments[segments.length - 1]
  })
  // Step 2: replace the caller's homedir with "~" for any remaining
  // occurrences (homedirs OUTSIDE the known roots -- custom NFS mounts,
  // /opt/name, etc.). Anchor the replace to a path boundary so
  // /Users/bob does not swallow the 'smith' suffix of /Users/bobsmith
  // if that somehow slipped past step 1.
  if (homeDir && homeDir !== '/') {
    const rx = new RegExp(escapeRegex(homeDir) + `(?=[/\\s:'")\\]}]|$)`, 'g')
    out = out.replace(rx, '~')
  }
  return out
}

export function applyRefreshOutcome(input: RefreshInput): RefreshOutcome {
  const parsed = parseMcpList(input.stdout)
  if (parsed.length > 0) {
    // Whether exit was 0 or not, we have data. Only parse-time problems
    // should block a cache update.
    return { entries: parsed, error: undefined, retainedStale: false }
  }
  if (input.execError) {
    // Nothing to parse AND the CLI reported failure. Preserve the
    // previous entries so a transient error does not wipe the UI.
    return {
      entries: input.previousEntries,
      error: input.execError.message,
      retainedStale: input.previousEntries.length > 0,
    }
  }
  // Clean exit with an empty list: the user genuinely has no MCPs.
  return { entries: [], error: undefined, retainedStale: false }
}
