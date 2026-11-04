import { describe, it, expect, afterEach } from 'vitest'
import { readFileSync, writeFileSync, mkdtempSync, rmSync, chmodSync, statSync, readdirSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// SLACKMGDATOM913, then MANAGEDSETTINGSWRITE1103.
//
// The macOS installer writes the system org-policy file
// (/Library/Application Support/ClaudeCode/managed-settings.json) in three places:
// the Discord merge, the Slack merge and the Slack create. SLACKMGDATOM913 fixed the
// `sudo tee` truncation and the `except: existing = {}` rebuild. Each place then still
// carried its own inline python, writing a FIXED `<file>.tmp` through open(), which
// follows a symlink, as root. MANAGEDSETTINGSWRITE1103 moves all three (and
// scripts/ensure-managed-channels-enabled.sh) onto ONE writer,
// scripts/lib/managed-settings-write.py, whose own rules are pinned in
// scripts/__tests__/managed-settings-write.test.py.
//
// The installer runs on customer Macs where no harness executes it end to end, so this
// suite reads the writer calls OUT OF THE SHIPPED install-macos.sh and runs the real
// writer with exactly those arguments against temp files.

const ROOT = join(__dirname, '..', '..')
const MAC = readFileSync(join(ROOT, 'install-macos.sh'), 'utf-8')
const WRITER = join(ROOT, 'scripts', 'lib', 'managed-settings-write.py')
const CALL_MARK = 'scripts/lib/managed-settings-write.py" "$MANAGED_FILE"'

const ALL_FOUR = [
  'slack-channel@marveen-marketplace',
  'telegram@claude-plugins-official',
  'teams@marveen-marketplace',
  'discord@claude-plugins-official',
]

/** Every writer call in install-macos.sh: the arguments after "$MANAGED_FILE", backslash continuations joined. */
function writerCalls(src: string): string[][] {
  const lines = src.split('\n')
  const calls: string[][] = []
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i]!.includes(CALL_MARK)) continue
    let text = lines[i]!.slice(lines[i]!.indexOf(CALL_MARK) + CALL_MARK.length)
    while (text.trimEnd().endsWith('\\')) {
      text = text.trimEnd().slice(0, -1) + ' ' + lines[++i]!
    }
    calls.push(text.trim().split(/\s+/).filter(Boolean))
  }
  return calls
}

const plugins = (args: string[]): string[] =>
  args.flatMap((a, i) => (args[i - 1] === '--add-plugin' ? [a] : []))

const calls = writerCalls(MAC)
const discordMerge = calls[0]!
const slackMerge = calls[1]!
const slackCreate = calls[2]!

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function fixture(content: string | null, mode?: number): { dir: string; target: string } {
  const dir = mkdtempSync(join(tmpdir(), 'slackmgd-'))
  dirs.push(dir)
  const target = join(dir, 'managed-settings.json')
  if (content !== null) writeFileSync(target, content)
  if (mode !== undefined) chmodSync(target, mode)
  return { dir, target }
}

/** The installer's own call, minus sudo (the writer checks ownership against the effective uid). */
function runCall(target: string, args: string[], umask = '022'): number {
  const r = spawnSync('bash', ['-c', `umask ${umask}; exec python3 -I "$@"`, 'bash', WRITER, target, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return r.status ?? -1
}

describe('install-macos.sh managed-settings writes go through the one shared writer (MANAGEDSETTINGSWRITE1103)', () => {
  it('no inline managed-settings writer is left in the shipped installer', () => {
    for (const marker of ['DISCORDMERGEPY', 'SLACKMERGEPY', 'SLACKCREATEPY']) expect(MAC).not.toContain(marker)
    expect(MAC).not.toContain("p + '.tmp'")
    expect(MAC).not.toContain('except: existing = {}')
    // tee must never target the org-policy file again -- it truncates first.
    expect(MAC).not.toContain('tee "$MANAGED_FILE"')
  })

  it('exactly three calls, in order: Discord merge, Slack merge, Slack create', () => {
    expect(calls).toHaveLength(3)
    expect(discordMerge).toEqual(['--add-plugin', 'discord@claude-plugins-official'])
    expect(slackMerge).not.toContain('--create')
    expect(plugins(slackMerge)).toEqual(ALL_FOUR)
    expect(slackCreate[0]).toBe('--create')
    expect(plugins(slackCreate)).toEqual(ALL_FOUR)
  })

  it('every call runs the writer as root with -I, from the install dir', () => {
    const lines = MAC.split('\n').filter((l) => l.includes(CALL_MARK))
    for (const l of lines) expect(l).toContain('sudo python3 -I "$INSTALL_DIR/scripts/lib/managed-settings-write.py" "$MANAGED_FILE"')
  })

  it('the manual hint lists the same four plugins the calls add', () => {
    for (const p of ALL_FOUR) {
      const [name, market] = p.split('@')
      expect(MAC).toContain(`{"plugin":"${name}","marketplace":"${market}"}`)
    }
  })

  it('the Slack create call writes a 0644 policy even under umask 077, no tmp left behind', () => {
    const { dir, target } = fixture(null)
    expect(runCall(target, slackCreate, '077')).toBe(0)
    const parsed = JSON.parse(readFileSync(target, 'utf-8')) as { allowedChannelPlugins: Array<{ plugin: string; marketplace: string }> }
    expect(parsed.allowedChannelPlugins.map((p) => `${p.plugin}@${p.marketplace}`)).toEqual(ALL_FOUR)
    expect(statSync(target).mode & 0o777).toBe(0o644)
    expect(readdirSync(dir)).toEqual(['managed-settings.json'])
  })

  it('the merge calls do not create a missing file', () => {
    for (const args of [discordMerge, slackMerge]) {
      const { target } = fixture(null)
      expect(runCall(target, args)).toBe(0)
      expect(existsSync(target)).toBe(false)
    }
  })

  describe('the Slack and Discord merge calls, executed for real', () => {
    it('merge into a live policy and KEEP unrelated keys and the file mode', () => {
      const before = JSON.stringify({
        channelsEnabled: true,
        allowedChannelPlugins: [{ plugin: 'slack-channel', marketplace: 'marveen-marketplace' }],
      })
      const { dir, target } = fixture(before, 0o600)
      expect(runCall(target, slackMerge)).toBe(0)
      const parsed = JSON.parse(readFileSync(target, 'utf-8')) as { channelsEnabled?: boolean; allowedChannelPlugins: Array<{ plugin: string }> }
      expect(parsed.channelsEnabled).toBe(true) // the {} fallback would have dropped this
      expect(parsed.allowedChannelPlugins.map((p) => p.plugin).sort()).toEqual(['discord', 'slack-channel', 'teams', 'telegram'])
      expect(statSync(target).mode & 0o777).toBe(0o600)
      expect(readdirSync(dir)).toEqual(['managed-settings.json'])

      expect(runCall(target, discordMerge)).toBe(0) // discord already there: nothing added twice
      const again = JSON.parse(readFileSync(target, 'utf-8')) as { allowedChannelPlugins: Array<{ plugin: string }> }
      expect(again.allowedChannelPlugins.filter((p) => p.plugin === 'discord')).toHaveLength(1)
    })

    it('a corrupt policy file is left BYTE-IDENTICAL, exit non-zero', () => {
      for (const args of [discordMerge, slackMerge, slackCreate]) {
        const corrupt = '{ this is not json'
        const { target } = fixture(corrupt)
        expect(runCall(target, args)).not.toBe(0)
        expect(readFileSync(target, 'utf-8')).toBe(corrupt)
      }
    })

    it('a non-object root is refused, file untouched', () => {
      for (const args of [discordMerge, slackMerge, slackCreate]) {
        const { target } = fixture('[1,2,3]')
        expect(runCall(target, args)).not.toBe(0)
        expect(readFileSync(target, 'utf-8')).toBe('[1,2,3]')
      }
    })

    it('is idempotent: a second run changes nothing', () => {
      const { target } = fixture(JSON.stringify({ allowedChannelPlugins: [] }))
      expect(runCall(target, slackMerge)).toBe(0)
      const between = readFileSync(target, 'utf-8')
      expect(runCall(target, slackMerge)).toBe(0)
      expect(readFileSync(target, 'utf-8')).toBe(between)
    })
  })
})
