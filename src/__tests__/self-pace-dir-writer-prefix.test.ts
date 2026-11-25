// #3001: the DIR_WRITERS rule of the egress-allowlist check (a cp, mv, tar, unzip .. pointed at the store dir or
// the install root creates a name the command does not spell) read only the FIRST word of the segment. A reserved word,
// a wrapper or a runner in front hid the writer: `for ..; do tar xf a.tar -C <store>; done`, `env cp x <store>`,
// `xargs cp -t <store>`, `find .. -exec cp {} <store> \;` all passed. Now a writer named anywhere in the segment, with the
// store dir or the root as an argument, makes it a mention; a plain read of a mention still passes. The allowed rows next
// to it, and the one refused read, are the cost side.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
// @ts-expect-error -- plain .mjs hook script, no types
import { gateDecision } from '../../scripts/self-pace-gate.mjs'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let root: string
let store: string
let allowlist: string
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'sp-dirwriter-')))
  store = join(root, 'store')
  mkdirSync(store)
  allowlist = join(store, 'egress-allowlist.json')
  writeFileSync(allowlist, JSON.stringify({ domains: ['a.example'] }))
})
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

const bash = (command: string, cwd = '/tmp') => gateDecision('Bash', { command }, { allowlistPath: allowlist, cwd })
const allowed = (command: string) => expect(bash(command), command).toEqual({ deny: false })
const deniedAs = (reason: string, command: string) => expect(bash(command), command).toEqual({ deny: true, reason })

describe('a directory writer behind a reserved word is still a writer', () => {
  it('the card rows: do, then, else, elif, if, while, until', () => {
    const t = `tar xf /tmp/a.tar -C ${store}`
    deniedAs('egress-allowlist', `for i in a; do ${t}; done`)
    deniedAs('egress-allowlist', `if true; then ${t}; fi`)
    deniedAs('egress-allowlist', `if false; then :; else ${t}; fi`)
    deniedAs('egress-allowlist', `if false; then :; elif ${t}; then :; fi`)
    deniedAs('egress-allowlist', `if ${t}; then :; fi`)
    deniedAs('egress-allowlist', `while ${t}; do :; done`)
    deniedAs('egress-allowlist', `until ${t}; do :; done`)
  })
  it('a brace group, !, a case arm, and the install root as the target', () => {
    deniedAs('egress-allowlist', `{ cp /tmp/x ${store}; }`)
    deniedAs('egress-allowlist', `! mv /tmp/x ${store}`)
    deniedAs('egress-allowlist', `case a in a) unzip /tmp/a.zip -d ${store};; esac`)
    deniedAs('egress-allowlist', `cd ${root} && for f in /tmp/x; do cp /tmp/x .; done`)
    deniedAs('egress-allowlist', `for f in a; do /usr/bin/ln -s /tmp/x ${root}; done`)
  })
})

describe('a directory writer behind a wrapper or a runner is still a writer', () => {
  it('env, nice, nohup, time, timeout, command, exec, sudo', () => {
    const c = `cp /tmp/x ${store}`
    for (const w of ['env', 'env A=1', 'nice', 'nice -n 5', 'nohup', 'time', 'timeout 5', 'command', 'exec', 'sudo']) {
      deniedAs('egress-allowlist', `${w} ${c}`)
    }
  })
  it('xargs and find -exec run the writer', () => {
    deniedAs('egress-allowlist', `echo /tmp/x | xargs cp -t ${store}`)
    deniedAs('egress-allowlist', `ls /tmp/d | xargs -I{} cp /tmp/d/{} ${store}`)
    deniedAs('egress-allowlist', `find /tmp/d -name x -exec cp {} ${store} \\;`)
  })
  it('the first-word rows keep their old answer', () => {
    deniedAs('egress-allowlist', `tar xf /tmp/a.tar -C ${store}`)
    deniedAs('egress-allowlist', `A=1 cp /tmp/x ${store}`)
    deniedAs('egress-allowlist', `( cp /tmp/x ${store} )`)
  })
})

describe('a writer in quoted shell code is read too (why a quoted writer name counts)', () => {
  it('bash -c, sh -c, eval, su -c, xargs sh -c, find -exec sh -c: the quoted code runs', () => {
    deniedAs('egress-allowlist', `bash -c 'tar xf /tmp/a.tar -C ${store}'`)
    deniedAs('egress-allowlist', `sh -c "cp /tmp/x ${store}"`)
    deniedAs('egress-allowlist', `eval 'cp /tmp/x ${store}'`)
    deniedAs('egress-allowlist', `su -c 'cp /tmp/x ${store}'`)
    deniedAs('egress-allowlist', `echo /tmp/x | xargs -I{} sh -c 'cp {} ${store}'`)
    deniedAs('egress-allowlist', `find /tmp/d -exec sh -c 'cp "$1" ${store}' _ {} \\;`)
  })
})

describe('the cost side: what stays allowed', () => {
  it('a writer name as the argument of a reader is a mention, and a plain read of it passes', () => {
    allowed(`grep -rn install ${root}`)
    allowed(`grep -rn "cp " ${store}`)
    allowed(`echo tar ${store}`)
  })
  it('the price of the reading: such a read with a redirect onto a target built at runtime is refused', () => {
    deniedAs('egress-allowlist', `grep -rn install ${root} > $out`)
  })
  it('a writer behind a prefix that writes into a subdirectory, a new name, or another dir', () => {
    allowed(`for f in /tmp/x; do cp "$f" ${store}/new-name.txt; done`)
    allowed(`for f in /tmp/x; do cp "$f" ${store}/sub/; done`)
    allowed(`for f in /tmp/x; do cp "$f" /tmp/y; done`)
    allowed(`env cp /tmp/x /tmp/y`)
  })
})
