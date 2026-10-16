import { describe, it, expect } from 'vitest'
import { readFileSync, writeFileSync, mkdtempSync, rmSync, chmodSync, statSync, readdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// SLACKMGDATOM913: the slack branch of the macOS installer wrote the system
// org-policy file (/Library/Application Support/ClaudeCode/managed-settings.json)
// through `... | sudo python3 | sudo tee` with an `except: existing = {}`
// fallback. Two measured failure shapes:
//   - tee TRUNCATES the target before its stdin arrives, so a failing merge
//     process left an EMPTY org-policy file behind (host-wide channel mute);
//   - the {} fallback silently rebuilt the policy from scratch on any parse
//     hiccup, dropping every OTHER managed key (channelsEnabled, other
//     allowlists).
// The fix adopts the #1306 Discord-branch shape (tmp + copymode + os.replace,
// refuse-to-write on parse failure). The installer runs on customer Macs where
// no harness executes it end to end, so this suite anchors the shipped text
// AND actually runs the extracted merge script against temp files.

const ROOT = join(__dirname, '..', '..')
const MAC = readFileSync(join(ROOT, 'install-macos.sh'), 'utf-8')

function heredocSource(marker: string): string {
  const open = MAC.indexOf(`<<'${marker}'`)
  const start = MAC.indexOf('\n', open) + 1
  const end = MAC.indexOf(`\n${marker}`, start)
  expect(open, `${marker} heredoc present`).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  return MAC.slice(start, end)
}
const slackMergeSource = (): string => heredocSource('SLACKMERGEPY')
const slackCreateSource = (): string => heredocSource('SLACKCREATEPY')

describe('slack-branch managed-settings write is atomic and refuses to rebuild (SLACKMGDATOM913)', () => {
  it('the old unsafe shapes are gone from the shipped installer', () => {
    expect(MAC).not.toContain('except: existing = {}')
    // tee must never target the org-policy file again -- it truncates first.
    expect(MAC).not.toContain('tee "$MANAGED_FILE"')
  })

  it('the merge block carries the safe-merge markers', () => {
    const block = slackMergeSource()
    expect(block).toContain('os.replace(tmp, p)')
    expect(block).toContain('shutil.copymode(p, tmp)')
    expect(block).toContain('NOT writing')
  })

  it('the create branch also writes via tmp + os.replace, with the mode pinned', () => {
    const createBlock = slackCreateSource()
    expect(createBlock).toContain('os.replace(tmp, p)')
    // Review condition (#1308): a fresh tmp inherits the caller's umask, and
    // under umask 077 a root-owned 0600 policy is unreadable to the session --
    // the channel policy silently never takes effect. Same pin as
    // scripts/ensure-managed-channels-enabled.sh.
    expect(createBlock).toContain('os.chmod(tmp, 0o644)')
  })

  it('the extracted create script writes a 0644 policy even under umask 077', () => {
    const dir = mkdtempSync(join(tmpdir(), 'slackmgd-'))
    try {
      const target = join(dir, 'managed-settings.json')
      execFileSync('bash', ['-c', 'umask 077; exec python3 - "$0"', target], {
        input: slackCreateSource(), stdio: ['pipe', 'pipe', 'pipe'],
      })
      const parsed = JSON.parse(readFileSync(target, 'utf-8')) as { allowedChannelPlugins: Array<{ plugin: string }> }
      expect(parsed.allowedChannelPlugins.map((p) => p.plugin).sort())
        .toEqual(['discord', 'slack-channel', 'teams', 'telegram'])
      expect(statSync(target).mode & 0o777).toBe(0o644)
      expect(readdirSync(dir)).toEqual(['managed-settings.json'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  describe('the extracted merge script, executed for real', () => {
    function run(dir: string, content: string, mode?: number): { status: number; after: string } {
      const target = join(dir, 'managed-settings.json')
      writeFileSync(target, content)
      if (mode !== undefined) chmodSync(target, mode)
      let status = 0
      try {
        execFileSync('python3', ['-', target], { input: slackMergeSource(), stdio: ['pipe', 'pipe', 'pipe'] })
      } catch (err) {
        status = (err as { status?: number }).status ?? -1
      }
      return { status, after: readFileSync(target, 'utf-8') }
    }

    it('merges the four entries into a live policy and KEEPS unrelated keys and the file mode', () => {
      const dir = mkdtempSync(join(tmpdir(), 'slackmgd-'))
      try {
        const before = JSON.stringify({
          channelsEnabled: true,
          allowedChannelPlugins: [{ plugin: 'slack-channel', marketplace: 'marveen-marketplace' }],
        })
        const { status, after } = run(dir, before, 0o600)
        expect(status).toBe(0)
        const parsed = JSON.parse(after) as { channelsEnabled?: boolean; allowedChannelPlugins: Array<{ plugin: string }> }
        expect(parsed.channelsEnabled).toBe(true) // the {} fallback would have dropped this
        expect(parsed.allowedChannelPlugins.map((p) => p.plugin).sort())
          .toEqual(['discord', 'slack-channel', 'teams', 'telegram'])
        // copymode: the 0600 org-policy stays 0600
        expect(statSync(join(dir, 'managed-settings.json')).mode & 0o777).toBe(0o600)
        // atomic: no leftover tmp file
        expect(readdirSync(dir)).toEqual(['managed-settings.json'])
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it('a corrupt policy file is left BYTE-IDENTICAL, exit non-zero', () => {
      const dir = mkdtempSync(join(tmpdir(), 'slackmgd-'))
      try {
        const corrupt = '{ this is not json'
        const { status, after } = run(dir, corrupt)
        expect(status).not.toBe(0)
        expect(after).toBe(corrupt)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it('a non-object root is refused, file untouched', () => {
      const dir = mkdtempSync(join(tmpdir(), 'slackmgd-'))
      try {
        const { status, after } = run(dir, '[1,2,3]')
        expect(status).not.toBe(0)
        expect(after).toBe('[1,2,3]')
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it('is idempotent: a second run changes nothing', () => {
      const dir = mkdtempSync(join(tmpdir(), 'slackmgd-'))
      try {
        const first = run(dir, JSON.stringify({ allowedChannelPlugins: [] }))
        expect(first.status).toBe(0)
        const target = join(dir, 'managed-settings.json')
        const between = readFileSync(target, 'utf-8')
        let status = 0
        try {
          execFileSync('python3', ['-', target], { input: slackMergeSource(), stdio: ['pipe', 'pipe', 'pipe'] })
        } catch (err) {
          status = (err as { status?: number }).status ?? -1
        }
        expect(status).toBe(0)
        expect(readFileSync(target, 'utf-8')).toBe(between)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })
  })
})
