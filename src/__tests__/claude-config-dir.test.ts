import { describe, it, expect } from 'vitest'
import { resolveClaudeConfigDir } from '../web/agent-config.js'

// Stable fake homedir so the expansion path is identical across hosts.
const HOME = '/tmp/fake-home'

describe('resolveClaudeConfigDir -- guard rails', () => {
  it('returns null for empty JSON', () => {
    expect(resolveClaudeConfigDir('{}', HOME)).toBeNull()
  })

  it('returns null for unparseable JSON', () => {
    expect(resolveClaudeConfigDir('not json', HOME)).toBeNull()
    expect(resolveClaudeConfigDir('', HOME)).toBeNull()
  })

  it('returns null when JSON parses to non-object (array, primitive, null)', () => {
    expect(resolveClaudeConfigDir('null', HOME)).toBeNull()
    expect(resolveClaudeConfigDir('[]', HOME)).toBeNull()
    expect(resolveClaudeConfigDir('"string"', HOME)).toBeNull()
    expect(resolveClaudeConfigDir('42', HOME)).toBeNull()
  })

  it('returns null when claudeConfigDir field is missing', () => {
    expect(resolveClaudeConfigDir('{"model":"sonnet"}', HOME)).toBeNull()
  })

  it('returns null when claudeConfigDir is not a string', () => {
    expect(resolveClaudeConfigDir('{"claudeConfigDir":null}', HOME)).toBeNull()
    expect(resolveClaudeConfigDir('{"claudeConfigDir":42}', HOME)).toBeNull()
    expect(resolveClaudeConfigDir('{"claudeConfigDir":true}', HOME)).toBeNull()
    expect(resolveClaudeConfigDir('{"claudeConfigDir":[]}', HOME)).toBeNull()
    expect(resolveClaudeConfigDir('{"claudeConfigDir":{}}', HOME)).toBeNull()
  })

  it('returns null for empty or whitespace-only string', () => {
    expect(resolveClaudeConfigDir('{"claudeConfigDir":""}', HOME)).toBeNull()
    expect(resolveClaudeConfigDir('{"claudeConfigDir":"   "}', HOME)).toBeNull()
    expect(resolveClaudeConfigDir('{"claudeConfigDir":"\\t\\n"}', HOME)).toBeNull()
  })
})

describe('resolveClaudeConfigDir -- tilde expansion', () => {
  it('expands a bare ~ to the home directory', () => {
    expect(resolveClaudeConfigDir('{"claudeConfigDir":"~"}', HOME)).toBe(HOME)
  })

  it('expands ~/ prefix against the home directory', () => {
    expect(resolveClaudeConfigDir('{"claudeConfigDir":"~/.claude-coding"}', HOME))
      .toBe('/tmp/fake-home/.claude-coding')
  })

  it('expands ~/ even with nested subpaths', () => {
    expect(resolveClaudeConfigDir('{"claudeConfigDir":"~/configs/claude/alt"}', HOME))
      .toBe('/tmp/fake-home/configs/claude/alt')
  })

  it('rejects a tilde in the middle of the string', () => {
    // The runtime shell would re-expand mid-string tildes at assignment
    // time (`X=/opt/foo~bar` becomes `X=/opt/foo/var/<...>` if `~bar` is a
    // real account), so the resolver rejects them rather than silently
    // routing the launcher elsewhere.
    expect(resolveClaudeConfigDir('{"claudeConfigDir":"/opt/foo~bar"}', HOME))
      .toBeNull()
  })
})

describe('resolveClaudeConfigDir -- character whitelist', () => {
  // The launcher inlines the path into a nested-quoted tmux command, so the
  // path actually lands partly inside and partly outside double-quote
  // context. We allow only a conservative whitelist of characters that
  // survive both layers safely: alphanumerics, dot, slash, hyphen,
  // underscore, tilde.
  const baseJson = (v: string) =>
    `{"claudeConfigDir":${JSON.stringify(v)}}`

  it('rejects values containing a double quote', () => {
    expect(resolveClaudeConfigDir(baseJson('~/x";rm -rf /tmp/y;"'), HOME)).toBeNull()
    expect(resolveClaudeConfigDir(baseJson('/abs/with"quote'), HOME)).toBeNull()
  })

  it('rejects values containing a single quote', () => {
    expect(resolveClaudeConfigDir(baseJson("/abs/with'quote"), HOME)).toBeNull()
  })

  it('rejects values containing parentheses (subshell when unquoted)', () => {
    expect(resolveClaudeConfigDir(baseJson('/abs/with(parens)'), HOME)).toBeNull()
    expect(resolveClaudeConfigDir(baseJson('~/foo(bar'), HOME)).toBeNull()
    expect(resolveClaudeConfigDir(baseJson('~/foo)bar'), HOME)).toBeNull()
  })

  it('rejects values containing whitespace (would split the unquoted segment)', () => {
    expect(resolveClaudeConfigDir(baseJson('/abs path/with spaces'), HOME)).toBeNull()
    expect(resolveClaudeConfigDir(baseJson('/abs\twith\ttabs'), HOME)).toBeNull()
  })

  it('rejects values containing a dollar sign (variable expansion)', () => {
    expect(resolveClaudeConfigDir(baseJson('/abs/$HOME/x'), HOME)).toBeNull()
  })

  it('rejects values containing a backtick (command substitution)', () => {
    expect(resolveClaudeConfigDir(baseJson('/abs/`whoami`/x'), HOME)).toBeNull()
  })

  it('rejects values containing a semicolon (command separator)', () => {
    expect(resolveClaudeConfigDir(baseJson('/abs;rm -rf /tmp/x'), HOME)).toBeNull()
  })

  it('rejects values containing a backslash', () => {
    expect(resolveClaudeConfigDir(baseJson('/abs\\path'), HOME)).toBeNull()
  })

  it('rejects values containing a newline or carriage return', () => {
    expect(resolveClaudeConfigDir(baseJson('/abs\nbad'), HOME)).toBeNull()
    expect(resolveClaudeConfigDir(baseJson('/abs\rbad'), HOME)).toBeNull()
  })

  it('rejects other shell-significant characters (&, |, *, ?, <, >, !)', () => {
    expect(resolveClaudeConfigDir(baseJson('/abs&bg'), HOME)).toBeNull()
    expect(resolveClaudeConfigDir(baseJson('/abs|pipe'), HOME)).toBeNull()
    expect(resolveClaudeConfigDir(baseJson('/abs*glob'), HOME)).toBeNull()
    expect(resolveClaudeConfigDir(baseJson('/abs?glob'), HOME)).toBeNull()
    expect(resolveClaudeConfigDir(baseJson('/abs<redir'), HOME)).toBeNull()
    expect(resolveClaudeConfigDir(baseJson('/abs>redir'), HOME)).toBeNull()
    expect(resolveClaudeConfigDir(baseJson('/abs!hist'), HOME)).toBeNull()
  })

  it('accepts a path with a hyphen, dot, underscore (common in real names)', () => {
    expect(resolveClaudeConfigDir(baseJson('~/.claude-coding_v2'), HOME))
      .toBe('/tmp/fake-home/.claude-coding_v2')
  })

  it('accepts an alphanumeric absolute path', () => {
    expect(resolveClaudeConfigDir(baseJson('/var/lib/claude_alt-config2'), HOME))
      .toBe('/var/lib/claude_alt-config2')
  })
})

describe('resolveClaudeConfigDir -- parent-traversal rejection', () => {
  // path.join collapses `..` segments silently, so without this guard a
  // value like "~/../../../etc/passwd" would resolve to "/etc/passwd"
  // instead of staying under the home directory. The operator can still
  // point at any absolute path outside home -- this just rejects the
  // ".."-laundered version, which is almost always a config typo.
  const baseJson = (v: string) =>
    `{"claudeConfigDir":${JSON.stringify(v)}}`

  it('rejects a tilde path that escapes home via `..`', () => {
    expect(resolveClaudeConfigDir(baseJson('~/../../../etc/passwd'), HOME)).toBeNull()
    expect(resolveClaudeConfigDir(baseJson('~/../etc'), HOME)).toBeNull()
  })

  it('rejects an absolute path containing `..` segments', () => {
    expect(resolveClaudeConfigDir(baseJson('/var/lib/foo/../bar'), HOME)).toBeNull()
    expect(resolveClaudeConfigDir(baseJson('/abs/path/..'), HOME)).toBeNull()
  })

  it('rejects a relative path with `..` segments', () => {
    expect(resolveClaudeConfigDir(baseJson('../escape'), HOME)).toBeNull()
    expect(resolveClaudeConfigDir(baseJson('foo/../bar'), HOME)).toBeNull()
  })

  it('accepts paths where `..` appears only inside a longer segment', () => {
    // e.g. ".." is not a SEGMENT here, just a substring. We only reject
    // proper path segments equal to `..`, not arbitrary occurrences.
    expect(resolveClaudeConfigDir(baseJson('/abs/path..foo'), HOME))
      .toBe('/abs/path..foo')
    expect(resolveClaudeConfigDir(baseJson('/abs/foo..bar/baz'), HOME))
      .toBe('/abs/foo..bar/baz')
  })

  it('accepts a legitimate absolute path outside home', () => {
    // Home-escape via `..` is rejected, but operators can still point at
    // any absolute path they like (e.g. a system-wide config dir).
    expect(resolveClaudeConfigDir(baseJson('/var/lib/claude-coding'), HOME))
      .toBe('/var/lib/claude-coding')
  })

  // Only `..` is treated as a traversal segment. `.` and `//` are accepted
  // because they are no-op path components -- the OS and `path.join`
  // normalize them away without altering where the path points. Documented
  // as tests so future reviewers do not need to reverse-engineer this.

  it('accepts a tilde path with a trailing single dot (path.join normalizes)', () => {
    // `~/foo/.` -> path.join expands AND normalizes -> `<home>/foo`.
    expect(resolveClaudeConfigDir(baseJson('~/foo/.'), HOME))
      .toBe('/tmp/fake-home/foo')
  })

  it('accepts a path containing a single-dot segment in the middle', () => {
    // Absolute paths are returned verbatim, so the `.` is preserved in the
    // string and the OS resolves it at use time.
    expect(resolveClaudeConfigDir(baseJson('/var/lib/./claude'), HOME))
      .toBe('/var/lib/./claude')
  })

  it('accepts a path with consecutive slashes (`//`)', () => {
    // Empty segments from doubled slashes are also no-ops; we leave them
    // in the absolute-path string for the OS to normalize at use time.
    expect(resolveClaudeConfigDir(baseJson('/var/lib//claude'), HOME))
      .toBe('/var/lib//claude')
  })
})

describe('resolveClaudeConfigDir -- absolute and relative paths', () => {
  it('returns absolute paths verbatim', () => {
    expect(resolveClaudeConfigDir('{"claudeConfigDir":"/abs/path"}', HOME))
      .toBe('/abs/path')
  })

  it('returns relative paths verbatim (caller responsibility)', () => {
    // Relative paths are unusual but not rejected. Claude Code itself will
    // resolve them against its CWD if it gets one.
    expect(resolveClaudeConfigDir('{"claudeConfigDir":"./relative/path"}', HOME))
      .toBe('./relative/path')
  })

  it('trims surrounding whitespace before resolving', () => {
    expect(resolveClaudeConfigDir('{"claudeConfigDir":"  /abs/path  "}', HOME))
      .toBe('/abs/path')
    expect(resolveClaudeConfigDir('{"claudeConfigDir":" ~/.claude-x "}', HOME))
      .toBe('/tmp/fake-home/.claude-x')
  })
})

describe('resolveClaudeConfigDir -- tilde position and post-expansion safety', () => {
  // The runtime shell expands `~` and `~user` in assignment context even when
  // the value is wrapped in our outer template literal, because the inner
  // shell sees the value unquoted (the JS template does not escape the
  // embedded `"` characters). So tilde is only safe at position 0 in the
  // exact forms `~` and `~/...` -- anything else is rejected.
  const baseJson = (v: string) =>
    `{"claudeConfigDir":${JSON.stringify(v)}}`

  it('rejects `~user/path` (named-user home, would be re-expanded by runtime shell)', () => {
    expect(resolveClaudeConfigDir(baseJson('~root/.claude-x'), HOME)).toBeNull()
    expect(resolveClaudeConfigDir(baseJson('~admin/foo'), HOME)).toBeNull()
  })

  it('rejects a tilde appearing mid-string', () => {
    expect(resolveClaudeConfigDir(baseJson('/abs/foo~bar'), HOME)).toBeNull()
    expect(resolveClaudeConfigDir(baseJson('~/foo~bar'), HOME)).toBeNull()
  })

  it('still accepts the two safe tilde forms', () => {
    expect(resolveClaudeConfigDir(baseJson('~'), HOME)).toBe(HOME)
    expect(resolveClaudeConfigDir(baseJson('~/.claude-x'), HOME))
      .toBe('/tmp/fake-home/.claude-x')
  })

  it('rejects a tilde-expanded path when homeDir itself is unsafe', () => {
    // Operator hosts may have a space in their home dir name. The raw input
    // `~/.claude-x` passes the whitelist, but after expansion the space
    // sneaks in. Re-validating the resolved path catches this.
    const unsafeHome = '/home/with spaces'
    expect(resolveClaudeConfigDir(baseJson('~/.claude-x'), unsafeHome)).toBeNull()
    expect(resolveClaudeConfigDir(baseJson('~'), unsafeHome)).toBeNull()
  })

  it('still resolves a tilde path when homeDir is safe', () => {
    // Sanity: the post-expansion check does not over-reject normal homes.
    const safeHome = '/home/normal'
    expect(resolveClaudeConfigDir(baseJson('~/.claude-x'), safeHome))
      .toBe('/home/normal/.claude-x')
  })
})

describe('resolveClaudeConfigDir -- realistic agent-config shapes', () => {
  it('handles a full agent-config.json with the field present', () => {
    const json = JSON.stringify({
      model: 'claude-opus-4-7',
      displayName: 'Dev 2',
      securityProfile: 'developer-senior',
      claudeConfigDir: '~/.claude-coding',
    })
    expect(resolveClaudeConfigDir(json, HOME)).toBe('/tmp/fake-home/.claude-coding')
  })

  it('handles a full agent-config.json without the field', () => {
    const json = JSON.stringify({
      model: 'claude-opus-4-7',
      displayName: 'Dev 2',
      securityProfile: 'developer-senior',
    })
    expect(resolveClaudeConfigDir(json, HOME)).toBeNull()
  })

  it('uses the supplied homeDir, not process.env.HOME', () => {
    // Two different homeDirs must produce two different results -- proves
    // the function does not silently fall back to process.env.HOME.
    const json = '{"claudeConfigDir":"~/.claude-x"}'
    expect(resolveClaudeConfigDir(json, '/home/alice')).toBe('/home/alice/.claude-x')
    expect(resolveClaudeConfigDir(json, '/home/charlie')).toBe('/home/charlie/.claude-x')
  })
})
