// GUARDSENDER1584 -- follow-up to #1584: the installers put the fleet's own
// guards into SYSTEM_SENDER_IDS by default, so a guard alert is sent under the
// guard's name instead of falling back to MAIN_AGENT_ID (the supervisory system
// writing as the main agent). What each part pins, on the REAL shell functions
// cut out of install-linux.sh and install-macos.sh:
//  - a fresh .env gets both ids; an operator's list keeps every entry and gets
//    the missing ones appended; an id already there is not written twice, with
//    the server's normalisation (spaces, quotes); a re-run changes nothing;
//  - the LAST SYSTEM_SENDER_IDS line is the one read (the server's rule,
//    src/env-parse.ts) and the result is ONE line;
//  - nothing else in the .env moves, and it stays 0600;
//  - the server's own parse of the written line contains both ids;
//  - the channels.sh guard, given that .env, sends under its own name, and
//    without it under MAIN_AGENT_ID (the behaviour this exists to change);
//  - both installers carry the same function and the same two calls.
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseEnvContent } from '../env-parse.js'
import { parseSystemSenderIds } from '../config.js'
import { sanitizeAgentIdent } from '../prompt-safety.js'

const ROOT = join(__dirname, '..', '..')
const src = (f: string) => readFileSync(join(ROOT, f), 'utf-8')
const fn = (text: string, name: string) => {
  const m = text.match(new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?\\n\\}\\n`, 'm'))
  expect(m, `${name}() not found`).not.toBeNull()
  return m![0]
}
const CALLS = ['env_add_list_entry SYSTEM_SENDER_IDS prod-tree-guard', 'env_add_list_entry SYSTEM_SENDER_IDS channels-sh-guard']

describe.each(['install-linux.sh', 'install-macos.sh'])('%s: SYSTEM_SENDER_IDS', (script) => {
  const text = src(script)
  const run = (env: string | null) => {
    const dir = mkdtempSync(join(tmpdir(), 'guard-sender-ids-'))
    if (env !== null) writeFileSync(join(dir, '.env'), env, { mode: 0o600 })
    execFileSync('bash', ['-c', ['set -e', `INSTALL_DIR='${dir}'`, '(umask 077 && touch "$INSTALL_DIR/.env")',
      fn(text, 'env_merge_key'), fn(text, 'env_add_list_entry'), ...CALLS].join('\n')])
    const p = join(dir, '.env')
    return { body: readFileSync(p, 'utf-8'), mode: statSync(p).mode & 0o777, dir }
  }
  const lines = (body: string) => body.split('\n').filter((l) => l.startsWith('SYSTEM_SENDER_IDS='))

  it('the installer calls it for both guards, after MAIN_AGENT_ID is written', () => {
    for (const c of CALLS) expect(text).toContain(`\n${c}\n`)
    expect(text.indexOf(CALLS[0])).toBeGreaterThan(text.indexOf('env_merge_key MAIN_AGENT_ID'))
    expect(text.indexOf('env_add_list_entry() {')).toBeLessThan(text.indexOf(CALLS[0]))
  })
  it('a fresh .env: both ids, one line, 0600', () => {
    const r = run('')
    expect(lines(r.body)).toEqual(['SYSTEM_SENDER_IDS=prod-tree-guard,channels-sh-guard'])
    expect(r.mode).toBe(0o600)
  })
  it('an operator\'s list keeps its entries; the others in the file do not move', () => {
    const r = run('BOT_NAME=Teszt\nSYSTEM_SENDER_IDS=cortex,billing\nWEB_PORT=3420\n')
    expect(r.body).toBe('BOT_NAME=Teszt\nWEB_PORT=3420\nSYSTEM_SENDER_IDS=cortex,billing,prod-tree-guard,channels-sh-guard\n')
  })
  it('an id already there (spaces, quotes) is not written twice', () => {
    expect(lines(run('SYSTEM_SENDER_IDS=" cortex , prod-tree-guard "\n').body)).toEqual(['SYSTEM_SENDER_IDS=cortex , prod-tree-guard,channels-sh-guard'])
    const mind = 'X=1\nSYSTEM_SENDER_IDS=channels-sh-guard,prod-tree-guard\n'
    expect(run(mind).body).toBe(mind)
  })
  it('a re-run changes nothing', () => {
    const egyszer = run('SYSTEM_SENDER_IDS=cortex\n').body
    expect(run(egyszer).body).toBe(egyszer)
  })
  it('two lines: the LAST one is what the server reads, and the result is one line', () => {
    const r = run('SYSTEM_SENDER_IDS=prod-tree-guard\nSYSTEM_SENDER_IDS=cortex\n')
    expect(lines(r.body)).toEqual(['SYSTEM_SENDER_IDS=cortex,prod-tree-guard,channels-sh-guard'])
  })
  it('the server\'s own parse of the written line has both guards and the operator\'s entry', () => {
    for (const env of ['', 'SYSTEM_SENDER_IDS=cortex\n', 'SYSTEM_SENDER_IDS=" cortex , prod-tree-guard "\n']) {
      const ids = parseSystemSenderIds(parseEnvContent(run(env).body).SYSTEM_SENDER_IDS, sanitizeAgentIdent)
      expect(ids.has('prod-tree-guard') && ids.has('channels-sh-guard')).toBe(true)
      if (env) expect(ids.has('cortex')).toBe(true)
    }
  })
})

describe('the guard that reads it (scripts/channels.sh _guard_sender)', () => {
  const guard = fn(src('scripts/channels.sh'), '_guard_sender')
  const kuldo = (envBody: string) => execFileSync('bash', ['-c', [
    `ENV_FILE=$(mktemp); printf '%s' '${envBody}' > "$ENV_FILE"`,
    // the same reads channels.sh does from the install's .env
    `MAIN_AGENT_ID="$(grep -E '^MAIN_AGENT_ID=' "$ENV_FILE" | head -1 | cut -d= -f2-)"`,
    `SYSTEM_SENDER_IDS="$(grep -E '^SYSTEM_SENDER_IDS=' "$ENV_FILE" | head -1 | cut -d= -f2-)"`,
    guard, '_guard_sender'].join('\n')], { encoding: 'utf-8' })
  it('with the installer\'s line: its own name; without it: the main agent\'s', () => {
    expect(kuldo('MAIN_AGENT_ID=hex\nSYSTEM_SENDER_IDS=prod-tree-guard,channels-sh-guard\n')).toBe('channels-sh-guard')
    expect(kuldo('MAIN_AGENT_ID=hex\n')).toBe('hex')
  })
})

describe('the two installers do not drift', () => {
  it('the same env_add_list_entry in both', () => {
    expect(fn(src('install-linux.sh'), 'env_add_list_entry')).toBe(fn(src('install-macos.sh'), 'env_add_list_entry'))
  })
})
