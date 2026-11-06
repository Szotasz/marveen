// EGRESSHOME1106 (Dani 71590): the gate resolved $HOME to the real home even when the command gave HOME a value of
// its own, so `HOME=.; cp -R /tmp/stage/. $HOME` from the project root passed and copied into the root. Now a command
// that names HOME as a bare word (HOME=, export/unset/read HOME, ...) keeps $HOME, ${HOME} and a leading ~ unresolved,
// and a `cd ~` in it leaves the cwd unknown. Reads of the real home stay as they were.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
// @ts-expect-error -- plain .mjs hook script, no types
import { gateDecision, cwdAfterSegment } from '../../scripts/self-pace-gate.mjs'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'

let root: string
let allowlist: string
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'egresshome-')))
  mkdirSync(join(root, 'store'))
  allowlist = join(root, 'store', 'egress-allowlist.json')
  writeFileSync(allowlist, JSON.stringify({ domains: ['a.example'] }))
})
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

const bash = (command: string, cwd = root) => gateDecision('Bash', { command }, { allowlistPath: allowlist, cwd })
const allowed = (command: string, cwd?: string) => expect(bash(command, cwd), command).toEqual({ deny: false })
const denied = (command: string, cwd?: string) =>
  expect(bash(command, cwd), command).toEqual({ deny: true, reason: 'egress-allowlist' })

describe('EGRESSHOME1106: a HOME the command sets is not the real home', () => {
  it("Dani's two shapes, from the project root, are denied", () => {
    denied(`HOME=.; cp -R /tmp/stage/. $HOME`)
    denied(`HOME=. && cp -R /tmp/stage/. \${HOME}`)
  })
  it('the same through ~, an export, a quote-split name, and from another cwd with a cd into the root', () => {
    denied(`HOME=.; cp -R /tmp/stage/. ~`)
    denied(`HOME=.; cp -R /tmp/stage/. ~/`)
    denied(`export HOME=.; cp -R /tmp/stage/. $HOME`)
    denied(`HO""ME=.; cp -R /tmp/stage/. $HOME`)
    denied(`cd ${root} && HOME=. && cp -R /tmp/stage/. $HOME`, '/tmp')
  })
  it('control: the same shape with an ordinary name was and stays denied', () => {
    denied(`X=.; cp -R /tmp/stage/. $X`)
  })
  it('reads and writes of the REAL home, with HOME untouched, are unchanged', () => {
    allowed(`cat $HOME/.zshrc`)
    allowed(`ls ~/Desktop`)
    allowed(`cp /tmp/x \${HOME}/Downloads/`)
    allowed(`echo $HOME; cp -R /tmp/stage/. $HOME/tmp-copy`)
  })
  it('a longer name that only contains HOME does not count', () => {
    allowed(`HOMEBREW_PREFIX=/opt/homebrew; ls $HOMEBREW_PREFIX/bin`)
    allowed(`MY_HOME=/tmp/x; cp -R /tmp/stage/. $MY_HOME`)
  })
  it('cd ~ under a HOME the command set leaves the cwd unknown; with HOME untouched it is the real home', () => {
    const touched: { cwd: string | null; homeTouched?: boolean } = { cwd: root, homeTouched: true }
    cwdAfterSegment('cd ~/x', touched)
    expect(touched.cwd).toBeNull()
    const plain: { cwd: string | null; homeTouched?: boolean } = { cwd: root, homeTouched: false }
    cwdAfterSegment('cd ~/x', plain)
    expect(plain.cwd).toBe(join(homedir(), 'x'))
  })
})
