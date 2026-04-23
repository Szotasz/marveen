import { describe, it, expect } from 'vitest'
import {
  parseMcpListLine,
  parseMcpList,
  applyRefreshOutcome,
  scrubPaths,
  type McpListEntry,
} from '../mcp-list-parser.js'

describe('parseMcpListLine -- guard rails', () => {
  it('returns null for an empty line', () => {
    expect(parseMcpListLine('')).toBeNull()
  })

  it('returns null for whitespace-only', () => {
    expect(parseMcpListLine('   \t  ')).toBeNull()
  })

  it('returns null for the "Checking MCP server health..." banner', () => {
    expect(parseMcpListLine('Checking MCP server health...')).toBeNull()
    expect(parseMcpListLine('Checking MCP server health…')).toBeNull()
  })

  it('returns null when the colon separator is missing', () => {
    expect(parseMcpListLine('not a valid line at all')).toBeNull()
  })

  it('returns null when the status separator is missing', () => {
    expect(parseMcpListLine('name: endpoint only')).toBeNull()
  })
})

describe('parseMcpListLine -- claude.ai connectors', () => {
  it('parses a Gmail connector with slug normalisation', () => {
    const result = parseMcpListLine('claude.ai Gmail: https://gmailmcp.googleapis.com/mcp/v1 - Connected')
    expect(result).not.toBeNull()
    expect(result?.source).toBe('claude.ai')
    expect(result?.name).toBe('claude.ai Gmail')
    expect(result?.normalizedId).toBe('gmail')
    expect(result?.endpoint).toBe('https://gmailmcp.googleapis.com/mcp/v1')
    expect(result?.status).toBe('connected')
  })

  it('slugifies a two-word connector name', () => {
    const result = parseMcpListLine(
      'claude.ai Google Calendar: https://calendarmcp.googleapis.com/mcp/v1 - Connected',
    )
    expect(result?.normalizedId).toBe('google-calendar')
  })

  it('handles multiple spaces between words in the name', () => {
    const result = parseMcpListLine(
      'claude.ai Google   Drive: https://example.com/mcp - Connected',
    )
    expect(result?.normalizedId).toBe('google-drive')
  })

  it('parses a needs-auth status', () => {
    const result = parseMcpListLine(
      'claude.ai PostHog: https://mcp.posthog.com/mcp - ! Needs authentication',
    )
    expect(result?.status).toBe('needs_auth')
  })

  it('parses a failed status', () => {
    const result = parseMcpListLine(
      'claude.ai Broken: https://example.com - Failed to connect',
    )
    expect(result?.status).toBe('failed')
  })

  it('preserves URLs containing colons in the endpoint', () => {
    const result = parseMcpListLine(
      'claude.ai n8n: https://example.app.n8n.cloud/mcp-server/http - ! Needs authentication',
    )
    expect(result?.endpoint).toBe('https://example.app.n8n.cloud/mcp-server/http')
  })
})

describe('parseMcpListLine -- plugin entries', () => {
  it('parses a plugin:package:name entry to the trailing slug', () => {
    const result = parseMcpListLine(
      'plugin:telegram:telegram: bun run --cwd /path ... - Connected',
    )
    expect(result?.source).toBe('plugin')
    expect(result?.normalizedId).toBe('telegram')
  })

  it('handles a plugin entry with distinct package and server slugs', () => {
    const result = parseMcpListLine(
      'plugin:acme-bundle:my-server: node /path/server.js - Connected',
    )
    expect(result?.source).toBe('plugin')
    expect(result?.normalizedId).toBe('my-server')
  })

  it('uses the last colon-separated segment for a two-part plugin name', () => {
    // "plugin:telegram" only has one segment after the prefix. Take the
    // last segment ("telegram") as the id; it lines up with the canonical
    // three-part form "plugin:telegram:telegram" that the CLI actually
    // emits.
    const result = parseMcpListLine(
      'plugin:telegram: some-endpoint - Connected',
    )
    expect(result?.source).toBe('plugin')
    expect(result?.normalizedId).toBe('telegram')
  })
})

describe('parseMcpListLine -- local entries', () => {
  it('parses a plain local server name', () => {
    const result = parseMcpListLine('my-local-fs: /usr/local/bin/mcp-fs - Connected')
    expect(result?.source).toBe('local')
    expect(result?.normalizedId).toBe('my-local-fs')
  })

  it('slugifies a local name with whitespace', () => {
    const result = parseMcpListLine('My Local Server: node /x - Connected')
    expect(result?.source).toBe('local')
    expect(result?.normalizedId).toBe('my-local-server')
  })

  it('treats a "claude.ai" prefix case-insensitively', () => {
    // CLI output is lowercase in practice, but a capitalised variant
    // should still route to claude.ai source rather than being treated
    // as a weird local name with a dot in it.
    const result = parseMcpListLine('Claude.ai Gmail: endpoint - Connected')
    expect(result?.source).toBe('claude.ai')
    expect(result?.normalizedId).toBe('gmail')
  })
})

describe('parseMcpListLine -- slug normalisation', () => {
  it('strips parentheses and dots from the name', () => {
    // Defensive case: if the CLI ever reports "claude.ai foo.bar (beta)"
    // we should still produce a catalog-matchable slug.
    const result = parseMcpListLine('claude.ai foo.bar (beta): endpoint - Connected')
    expect(result?.normalizedId).toBe('foo-bar-beta')
  })

  it('collapses multiple non-alphanumeric runs into a single hyphen', () => {
    const result = parseMcpListLine('claude.ai A / B / C: endpoint - Connected')
    expect(result?.normalizedId).toBe('a-b-c')
  })

  it('trims leading and trailing hyphens after stripping', () => {
    const result = parseMcpListLine('claude.ai ...Name...: endpoint - Connected')
    expect(result?.normalizedId).toBe('name')
  })
})

describe('parseMcpList -- full output', () => {
  it('parses a realistic multi-line output and skips the banner', () => {
    const output = [
      'Checking MCP server health...',
      '',
      'claude.ai Gmail: https://gmailmcp.googleapis.com/mcp/v1 - Connected',
      'claude.ai Google Calendar: https://calendarmcp.googleapis.com/mcp/v1 - Connected',
      'plugin:telegram:telegram: bun run /path - Connected',
      'my-local: node /tmp/x - Failed to connect',
      '',
    ].join('\n')
    const result = parseMcpList(output)
    expect(result).toHaveLength(4)
    expect(result.map(r => r.normalizedId)).toEqual(['gmail', 'google-calendar', 'telegram', 'my-local'])
    expect(result.map(r => r.source)).toEqual(['claude.ai', 'claude.ai', 'plugin', 'local'])
  })

  it('returns an empty array for a banner-only output', () => {
    expect(parseMcpList('Checking MCP server health...\n\n')).toEqual([])
  })

  it('returns an empty array for an entirely empty output', () => {
    expect(parseMcpList('')).toEqual([])
  })
})

describe('applyRefreshOutcome -- cache update rules', () => {
  const SAMPLE: McpListEntry = {
    name: 'claude.ai Gmail',
    normalizedId: 'gmail',
    endpoint: 'https://gmailmcp.googleapis.com/mcp/v1',
    status: 'connected',
    source: 'claude.ai',
  }
  const sampleOutput =
    'Checking MCP server health...\n' +
    'claude.ai Gmail: https://gmailmcp.googleapis.com/mcp/v1 - Connected\n'

  it('returns parsed entries on clean exit with output', () => {
    const result = applyRefreshOutcome({
      stdout: sampleOutput,
      execError: null,
      previousEntries: [],
    })
    expect(result.entries).toHaveLength(1)
    expect(result.error).toBeUndefined()
    expect(result.retainedStale).toBe(false)
  })

  it('returns parsed entries even when exit is non-zero', () => {
    // The CLI returns exit 1 when any one server fails its health check.
    // As long as the stdout parses into entries, the dashboard treats
    // that as success -- the list is what the UI cares about.
    const result = applyRefreshOutcome({
      stdout: sampleOutput,
      execError: new Error('exit 1'),
      previousEntries: [],
    })
    expect(result.entries).toHaveLength(1)
    expect(result.error).toBeUndefined()
    expect(result.retainedStale).toBe(false)
  })

  it('retains previous entries when stdout is empty and exec failed', () => {
    const prev = [SAMPLE]
    const result = applyRefreshOutcome({
      stdout: '',
      execError: new Error('ENOENT: claude not found'),
      previousEntries: prev,
    })
    expect(result.entries).toBe(prev)
    expect(result.error).toBe('ENOENT: claude not found')
    expect(result.retainedStale).toBe(true)
  })

  it('retains empty list when previous was empty and exec failed', () => {
    const result = applyRefreshOutcome({
      stdout: '',
      execError: new Error('timeout'),
      previousEntries: [],
    })
    expect(result.entries).toEqual([])
    expect(result.error).toBe('timeout')
    // retainedStale reflects whether we held back real entries, not
    // whether we failed -- empty+empty is a failure with nothing to hold.
    expect(result.retainedStale).toBe(false)
  })

  it('returns empty list with no error on clean exit + banner-only output', () => {
    // The user genuinely has no MCPs configured.
    const result = applyRefreshOutcome({
      stdout: 'Checking MCP server health...\n\n',
      execError: null,
      previousEntries: [SAMPLE],
    })
    expect(result.entries).toEqual([])
    expect(result.error).toBeUndefined()
    expect(result.retainedStale).toBe(false)
  })
})

describe('scrubPaths -- sensitive-path removal', () => {
  const HOME = '/Users/testuser'

  it('returns empty input unchanged', () => {
    expect(scrubPaths('', HOME)).toBe('')
  })

  it('collapses a path under the caller homedir to <path>/<basename>', () => {
    // Round-13 behaviour change: known-root paths always collapse to
    // <path>/<basename>, regardless of whether they match the caller's
    // homedir. The earlier "~/..." shape would have kept the middle
    // segments, but lost no more identity either. The collapsed form
    // is simpler and consistent with how foreign-user paths render.
    expect(scrubPaths('spawn /Users/testuser/.bun/bin/claude ENOENT', HOME))
      .toBe('spawn <path>/claude ENOENT')
  })

  it('collapses a /Users path that is NOT the current homedir', () => {
    // Another user on a shared host must not leak through.
    const result = scrubPaths('Cannot find /Users/otheruser/config.json', HOME)
    expect(result).toContain('<path>/config.json')
    expect(result).not.toContain('otheruser')
  })

  it('collapses a /home (linux) path', () => {
    const result = scrubPaths('ENOENT /home/bob/.cache/claude', HOME)
    expect(result).toContain('<path>/claude')
    expect(result).not.toContain('bob')
  })

  it('collapses a /tmp path', () => {
    const result = scrubPaths('tmp: /tmp/mcp-list-abc123/ok', HOME)
    expect(result).toContain('<path>/ok')
  })

  it('leaves simple messages without paths unchanged', () => {
    expect(scrubPaths('exit 1', HOME)).toBe('exit 1')
    expect(scrubPaths('timeout after 30s', HOME)).toBe('timeout after 30s')
  })

  it('handles repeated occurrences of the homedir', () => {
    // Both occurrences collapse via the path-scrub regex (known root
    // + trail). Homedir replace never gets to fire here, which is
    // the intended round-13 behaviour.
    const result = scrubPaths('/Users/testuser/a and /Users/testuser/b', HOME)
    expect(result).toBe('<path>/a and <path>/b')
  })

  it('handles empty homedir gracefully (no replacement, raw path still scrubbed)', () => {
    const result = scrubPaths('ENOENT /Users/foo/x', '')
    expect(result).toContain('<path>/x')
  })

  it('handles homedir === / gracefully (no-op on homedir step)', () => {
    // If homedir resolves to "/", split().join() would produce a
    // nonsense result; the guard should skip the homedir step entirely.
    const result = scrubPaths('spawn /Users/foo/claude ENOENT', '/')
    expect(result).toContain('<path>/claude')
    expect(result).not.toContain('/Users/foo')
  })

  it('scrubs quoted absolute paths (fs ENOENT shape)', () => {
    // Realistic fs error format: "... open '/Users/foo/x.json'".
    const result = scrubPaths(
      "ENOENT: no such file or directory, open '/Users/foo/x.json'",
      HOME,
    )
    expect(result).toContain('<path>/x.json')
    expect(result).not.toContain('/Users/foo')
  })

  it('scrubs parenthesised absolute paths', () => {
    const result = scrubPaths('(/Users/foo/config.json) failed', HOME)
    expect(result).toContain('<path>/config.json')
    expect(result).not.toContain('/Users/foo')
  })

  it('scrubs a /root path (root-user home)', () => {
    const result = scrubPaths('ENOENT /root/.claude/config', HOME)
    expect(result).toContain('<path>/config')
    expect(result).not.toContain('/root/')
  })

  it('drops the basename when it IS the username (bare /Users/foo)', () => {
    // Regression: earlier version returned "<path>/foo" which kept the
    // exact identifier the scrub was supposed to hide. With two or fewer
    // segments under a known root the basename is the user, so drop it.
    const result = scrubPaths('ENOENT /Users/someuser', HOME)
    expect(result).toContain('<path>')
    expect(result).not.toContain('someuser')
  })

  it('drops the basename for bare /home/<user>', () => {
    const result = scrubPaths('EACCES /home/bob', HOME)
    expect(result).toContain('<path>')
    expect(result).not.toContain('/bob')
  })

  it('handles a bare /root with no trailing path', () => {
    const result = scrubPaths('ENOENT /root', HOME)
    expect(result).toContain('<path>')
    expect(result).not.toContain('/root')
  })

  it('keeps the basename when there are two or more segments past the root', () => {
    // "/Users/foo/config.json" -- 'foo' is still the username but
    // 'config.json' is the useful piece, so the path collapses to
    // "<path>/config.json".
    const result = scrubPaths('ENOENT /Users/someuser/config.json', HOME)
    expect(result).toContain('<path>/config.json')
    expect(result).not.toContain('someuser')
  })

  it('scrubs paths whose user shares a prefix with the caller homedir', () => {
    // Round-13 regression: earlier substring-replace turned
    // "/Users/bobsmith/secret.json" with HOME=/Users/bob into
    // "~smith/secret.json", leaking the suffix. The path-scrub
    // regex now runs BEFORE the homedir replace, so /Users/bobsmith
    // gets normalised regardless.
    const result = scrubPaths('ENOENT /Users/bobsmith/secret.json', '/Users/bob')
    expect(result).toContain('<path>/secret.json')
    expect(result).not.toContain('bobsmith')
    expect(result).not.toContain('smith')
  })

  it('scrubs a path with a double slash prefix', () => {
    // "//Users/foo/x" arose from naive path joins in the wild. The
    // regex must still catch it rather than let the extra slash
    // disable the match.
    const result = scrubPaths('stat //Users/foo/secret.txt', HOME)
    expect(result).toContain('<path>/secret.txt')
    expect(result).not.toContain('/Users/foo')
  })

  it('scrubs a path preceded by a hyphen / underscore / dot', () => {
    // Shell / log glue: "--flag=/Users/foo/x", "config./Users/foo/x",
    // "var_/Users/foo/x". All should still be scrubbed.
    expect(scrubPaths('--flag=/Users/foo/x', HOME)).toContain('<path>/x')
    expect(scrubPaths('config./Users/foo/x', HOME)).toContain('<path>/x')
    expect(scrubPaths('var_/Users/foo/x', HOME)).toContain('<path>/x')
    expect(scrubPaths('--flag=/Users/foo/x', HOME)).not.toContain('/foo')
  })

  it('collapses a path that starts with a tilde (post-replace form, unlikely input)', () => {
    // Not a realistic input -- just confirming the regex does not
    // re-match after '~' because '~' is in the prefix-char exclusion.
    const result = scrubPaths('spawn ~/.bun/bin/claude ENOENT', HOME)
    expect(result).toBe('spawn ~/.bun/bin/claude ENOENT')
  })

  it('replaces exact-boundary homedir outside the known roots', () => {
    // Custom NFS layout: homedir not under /Users or /home.
    const result = scrubPaths('ENOENT /mnt/nfs/alice/config.json', '/mnt/nfs/alice')
    expect(result).toBe('ENOENT ~/config.json')
  })

  it('does NOT match a root-keyword prefix inside a longer dirname', () => {
    // Regression: `/homes/alice/secret.json` must not collapse to
    // `<path>s/alice/secret.json` -- the leading-match bug that led
    // to the root-alternative lookahead.
    expect(scrubPaths('ENOENT /homes/alice/secret.json', HOME))
      .toBe('ENOENT /homes/alice/secret.json')
    expect(scrubPaths('stat /Users-backup/bob/x', HOME))
      .toBe('stat /Users-backup/bob/x')
    expect(scrubPaths('EACCES /opts-archive/sam/y', HOME))
      .toBe('EACCES /opts-archive/sam/y')
    expect(scrubPaths('ENOENT /rooted/ada/z', HOME))
      .toBe('ENOENT /rooted/ada/z')
    expect(scrubPaths('cache /tmpfs/x/y', HOME))
      .toBe('cache /tmpfs/x/y')
  })

  it('still scrubs the exact root keyword followed by a slash or boundary', () => {
    // The lookahead must NOT block legitimate root matches.
    expect(scrubPaths('ENOENT /Users/foo/x', HOME)).toContain('<path>/x')
    expect(scrubPaths('ENOENT /home/bob/cfg', HOME)).toContain('<path>/cfg')
    expect(scrubPaths('ENOENT /opt/app/bin', HOME)).toContain('<path>/bin')
    expect(scrubPaths('ENOENT /tmp/mcp/x', HOME)).toContain('<path>/x')
    // Bare root keyword at end of string:
    expect(scrubPaths('ENOENT /Users', HOME)).toBe('ENOENT <path>')
    expect(scrubPaths('ENOENT /tmp.log', HOME)).toBe('ENOENT /tmp.log')
  })

  it('does not extend the homedir replace past a shared-prefix username', () => {
    // Step 1 catches any /Users/... already. Step 2 (homedir replace)
    // only fires for custom homedirs outside known roots. Regression
    // guard: /mnt/nfs/alicesmith with HOME=/mnt/nfs/alice must not
    // become "~smith/...".
    const result = scrubPaths('ENOENT /mnt/nfs/alicesmith/x', '/mnt/nfs/alice')
    // The path is under neither Users/home nor the exact homedir, so
    // it stays (there is no known-roots match and no boundary-aware
    // homedir hit). That is intentional: at least the username is
    // NOT conflated with the caller's.
    expect(result).not.toContain('~smith')
    expect(result).not.toContain('~/')
  })
})
