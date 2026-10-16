/**
 * BOOTPRUNEASCII1007, two older boot-hook-prune.py defects measured in the #1758
 * review (both pruned or rewrote a LIVE ~/.claude/settings.json on every boot):
 *  (a) the volatile-dir test was a bare substring, so a live hook such as
 *      "$HOME/tmp/live.py" or /<somewhere>/tmp/live.py was pruned;
 *  (b) a prune rewrote the whole file with json.dump's default ensure_ascii, so
 *      every accented value became \uXXXX.
 *
 * What each part proves, by running the real script against a disposable
 * HOME / INSTALL_DIR (never the live ~/.claude):
 *  - a hook whose script is under a tmp directory that only CONTAINS "/tmp/" in a
 *    longer path ($HOME/tmp/, <dir>/tmp/) and exists is kept;
 *  - a hook that names a real volatile path where a path starts (plain, quoted,
 *    after `=`, inside `bash -c '...'`, /var/tmp, /private/tmp, /dev/shm) is still
 *    pruned, so the fix does not open the guard the original /tmp incident needed;
 *  - after a prune, non-ASCII text is written as is and parses to the same value.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const PRUNE_SCRIPT = join(process.cwd(), 'scripts', 'boot-hook-prune.py')

let home: string
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'boot-prune-tmpascii-')) })
afterEach(() => { rmSync(home, { recursive: true, force: true }) })

function settingsWith(commands: string[], extra: Record<string, unknown> = {}) {
  mkdirSync(join(home, '.claude'), { recursive: true })
  const p = join(home, '.claude', 'settings.json')
  writeFileSync(p, JSON.stringify({
    ...extra,
    hooks: { Stop: [{ hooks: commands.map((command) => ({ type: 'command', command })) }] },
  }, null, 2))
  return p
}
function run() {
  execFileSync('python3', [PRUNE_SCRIPT], { env: { ...process.env, HOME: home, INSTALL_DIR: home } })
}
function kept(p: string): string[] {
  return (JSON.parse(readFileSync(p, 'utf8')).hooks?.Stop?.[0]?.hooks ?? []).map((h: { command: string }) => h.command)
}

describe('(a) the volatile-dir test matches where a path starts, not a substring', () => {
  it('a live hook under a "tmp" directory inside a longer path is kept', () => {
    mkdirSync(join(home, 'tmp'), { recursive: true })
    writeFileSync(join(home, 'tmp', 'live.py'), '#\n')
    // The absolute fixture lives under the checkout, not under tmpdir(): on the
    // Linux CI tmpdir() IS /tmp, and a path that really starts with /tmp/ must be
    // pruned. Only the "tmp inside a longer path" shape is under test here.
    const absRoot = mkdtempSync(join(process.cwd(), '.boot-prune-abs-'))
    try {
      mkdirSync(join(absRoot, 'work', 'tmp'), { recursive: true })
      writeFileSync(join(absRoot, 'work', 'tmp', 'abs.sh'), '#\n')
      const live = [
        'python3 "$HOME/tmp/live.py"',
        'python3 ~/tmp/live.py',
        `bash ${join(absRoot, 'work', 'tmp', 'abs.sh')}`,
      ]
      // one stale entry so the file is actually rewritten
      const p = settingsWith([...live, `python3 ${join(absRoot, 'nincs', 'gone.py')}`])
      run()
      expect(kept(p)).toEqual(live)
    } finally {
      rmSync(absRoot, { recursive: true, force: true })
    }
  })

  it.each([
    ['plain', 'python3 /tmp/x/hook.py'],
    ['quoted', 'python3 "/tmp/x/hook.py"'],
    ['after =', 'HOOK=/tmp/x/hook.py python3 -c pass'],
    ['inside bash -c', "bash -c '[ -f /tmp/foo/g.py ] && exec python3 /tmp/foo/g.py; exit 0'"],
    ['/var/tmp', 'python3 /var/tmp/x/hook.py'],
    ['/private/tmp', 'python3 /private/tmp/x/hook.py'],
    ['/dev/shm', 'python3 /dev/shm/x/hook.py'],
    ['at the very start', '/tmp/x/hook.sh'],
  ])('a real volatile path is still pruned (%s)', (_n, cmd) => {
    const p = settingsWith([cmd])
    run()
    expect(kept(p)).toEqual([])
  })
  it('an EXISTING script under /tmp is pruned for being volatile, plain and quoted', () => {
    // The non-existence check cannot be what prunes it: the file is there. Only
    // the volatile-dir test (with the quote as a path start) can.
    const vol = mkdtempSync('/tmp/boot-prune-volatile-')
    try {
      writeFileSync(join(vol, 'hook.py'), '#\n')
      for (const cmd of [`python3 ${vol}/hook.py`, `python3 "${vol}/hook.py"`, `python3 '${vol}/hook.py'`]) {
        const p = settingsWith([cmd])
        run()
        expect(kept(p), cmd).toEqual([])
      }
    } finally {
      rmSync(vol, { recursive: true, force: true })
    }
  })
})

describe('(b) a prune keeps non-ASCII text as written', () => {
  it('accented values are not rewritten as \\uXXXX and parse to the same value', () => {
    const extra = { env: { NEV: 'Árvíztűrő tükörfúrógép' }, statusLine: { label: 'ő ű' } }
    const p = settingsWith(['python3 /tmp/x/hook.py'], extra)
    run()
    const raw = readFileSync(p, 'utf8')
    expect(raw).toContain('Árvíztűrő tükörfúrógép')
    expect(raw).not.toMatch(/\\u00c1/)
    const after = JSON.parse(raw)
    expect(after.env).toEqual(extra.env)
    expect(after.statusLine).toEqual(extra.statusLine)
  })
})
