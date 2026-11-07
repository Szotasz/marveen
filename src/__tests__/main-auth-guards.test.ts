// MAINAUTH1107 (APIKULCSINDITAS1004 A): the guards that assume an OAuth login do not misfire on a main agent that runs
// on an API key: the reauth escalation names the key (no /login advice, no fleet-token probe, no restart loop), the
// rotation never decides for it, and the shared-login [GUARD] notices stay quiet.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildEscalationMessage, buildQuietSummaryMessage, type QuietSuppressedEntry } from '../web/reauth-healer.js'
import { mainLaunchedOnKey, readMainAuthLaunched } from '../web/main-auth.js'

const REPO = process.cwd()
const readSrc = (...p: string[]) => readFileSync(join(REPO, ...p), 'utf-8')
const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

describe('reauth escalation on an API key', () => {
  it('names the key and the Console, and neither OAuth nor /login', () => {
    const m = buildEscalationMessage('marveen', 'Invalid API key', 10, false, false, false, true)
    expect(m).toContain('API-kulccsal fut')
    expect(m).toContain('Anthropic Console')
    expect(m).not.toContain('/login')
    expect(m).not.toContain('OAuth')
  })
  it('without the flag the message is the OAuth one, as before', () => {
    expect(buildEscalationMessage('marveen', 'Not logged in', 10)).toContain('halott OAuth tokent')
  })
  it('the morning summary gives the key line, and no /login line when only key entries are left', () => {
    const e: QuietSuppressedEntry = { session: 's', label: 'marveen', reason: 'Invalid API key', consecutiveDead: 10, apiKey: true }
    const m = buildQuietSummaryMessage([e])
    expect(m).toContain('API-kulcs')
    expect(m).not.toContain('/login')
  })
  it('checkSession: a main on a key skips the fleet-token probe and the main restart, and marks the escalation', () => {
    const src = readSrc('src', 'web', 'reauth-healer.ts')
    expect(src).toContain('const mainOnKey = isMain && !isFirstRunGate && mainLaunchedOnKey()')
    expect(src).toContain('if (!isFirstRunGate && !mainOnKey) {')
    expect(src).toContain('...(mainOnKey ? { apiKey: true } : {})')
  })
})

describe('mainLaunchedOnKey: from the record of the last main launch', () => {
  it.each([['api', true], ['keyonly', true], ['subscription', false], ['none', false]])('%s -> %s', (effective, onKey) => {
    const store = mkdtempSync(join(tmpdir(), 'mauth-g-')); dirs.push(store)
    writeFileSync(join(store, '.main-auth-launched'), JSON.stringify({ configured: 'api', effective, conflict: null }))
    expect(mainLaunchedOnKey(store)).toBe(onKey)
  })
  it('no record (no launch yet, or an older version): not on a key', () => {
    const store = mkdtempSync(join(tmpdir(), 'mauth-g-')); dirs.push(store)
    expect(readMainAuthLaunched(store)).toBeNull()
    expect(mainLaunchedOnKey(store)).toBe(false)
    writeFileSync(join(store, '.main-auth-launched'), '{broken')
    expect(mainLaunchedOnKey(store)).toBe(false)
  })
})

describe('rotation and the shared-login notices', () => {
  it('the rotate-check refuses to decide for a main on an API key, right before the decision', () => {
    const src = readSrc('src', 'claude-plan-rotate-check-run.ts')
    const gate = src.indexOf("if (readAgentAuthMode(MAIN_AGENT_ID) === 'api' && !readClaudePlansState().activePlanByAgent[MAIN_AGENT_ID]) {")
    expect(gate).toBeGreaterThan(src.indexOf("if (!settingIsOn('CLAUDE_ROTATION_ENABLED') || !settingIsOn('MAIN_AGENT_ISOLATED_CONFIG')) return"))
    expect(gate).toBeLessThan(src.indexOf('const result = decideAndRecord({'))
  })
  it('the respawn guard sends no isolate-advice for a main that runs on a key (the effective mode, as channels.sh)', () => {
    const src = readSrc('src', 'web', 'main-config-decision.ts')
    const quiet = src.indexOf("onKey = decideMainAuth(gatherMainAuthInputs('shared', null)).effective === 'api'")
    expect(quiet).toBeGreaterThan(-1)
    expect(quiet).toBeLessThan(src.indexOf("createAgentMessage('respawn-guard'"))
  })
})

describe('the owner hears it when the api mode does not take effect (channels.sh)', () => {
  it('a conflict or a failed stamp: one notice per distinct cause, marked only after a successful send', () => {
    const sh = readSrc('scripts', 'channels.sh')
    expect(sh).toContain('if [ "${MAIN_AUTH_CONFIGURED:-}" = api ] && declare -F main_auth_problem_notice >/dev/null; then')
    expect(sh).toContain(`( bash "$INSTALL_DIR/scripts/notify.sh" "$_ma_text" >/dev/null 2>&1 && printf '%s' "$_ma_cause" > "$_ma_alert" ) &`)
  })
  it.each([['no-key', '-'], ['own-login', '-'], ['custom-provider', '-'], ['plan-token', '-'], ['-', 'stamp']])('the notice text exists for %s/%s, in both languages, and is empty when nothing is wrong', (conflict, failed) => {
    const lib = join(REPO, 'scripts', 'lib', 'auth-key-mode.sh')
    const run = (c: string, f: string, lang: string) =>
      execFileSync('/bin/bash', ['-c', `. "$1" && main_auth_problem_notice "$2" "$3" "$4"`, 'bash', lib, c, f, lang], { encoding: 'utf-8' }).trim()
    expect(run(conflict, failed, 'hu')).toContain('API-kulcsos futásra van állítva')
    expect(run(conflict, failed, 'en')).toContain('set to run on an API key')
    expect(run('-', '-', 'hu')).toBe('')
  })
})
