import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SETTINGS_REGISTRY } from '../config-registry.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SH = readFileSync(join(__dirname, '../../scripts/channels.sh'), 'utf-8')
const HELPER = readFileSync(join(__dirname, '../../scripts/main-agent-chrome-flag.mjs'), 'utf-8')

describe('MAIN_AGENT_CHROME: opt-in, default off', () => {
  const def = SETTINGS_REGISTRY.find((s) => s.key === 'MAIN_AGENT_CHROME')

  it('is registered as a boolean that defaults to OFF', () => {
    expect(def).toBeTruthy()
    expect(def!.type).toBe('boolean')
    expect(def!.default).toBe('0')
  })

  it('is a channels setting and says a restart is needed', () => {
    // It only takes effect when the session is relaunched -- if the UI implied
    // otherwise, someone would flip it and wonder why nothing happened.
    expect(def!.module).toBe('channels')
    expect(def!.requiresRestart).toBe(true)
  })

  it('is not marked secret (it is a preference, not a credential)', () => {
    expect(def!.secret).toBe(false)
  })

  it('the description warns that the extension is a separate install', () => {
    expect(def!.description).toMatch(/BŐVÍTMÉNY|bővítmény/)
  })
})

// This is the failure Nova specifically asked to guard against: the second build
// site is the resume/relaunch path. Patching only the first would make the flag
// work once and then vanish silently on the next restart -- a fault that looks
// like "the browser integration randomly stopped".
describe('channels.sh: the flag is applied at BOTH build sites', () => {
  const launches = SH.match(/\$CLAUDE --dangerously-skip-permissions [^\n"]*--channels plugin:/g) ?? []

  it('there are exactly two launch command constructions', () => {
    expect(launches.length).toBe(2)
  })

  it('EVERY launch carries CHROME_FLAG -- not just the first', () => {
    for (const l of launches) expect(l).toContain('${CHROME_FLAG}')
  })

  it('CHROME_FLAG sits next to MODEL_FLAG, before --channels', () => {
    for (const l of launches) {
      expect(l.indexOf('${MODEL_FLAG}')).toBeLessThan(l.indexOf('${CHROME_FLAG}'))
      expect(l.indexOf('${CHROME_FLAG}')).toBeLessThan(l.indexOf('--channels'))
    }
  })

  it('CHROME_FLAG is initialised to empty before use (no unbound-variable launch)', () => {
    const init = SH.indexOf('CHROME_FLAG=""')
    expect(init).toBeGreaterThan(-1)
    expect(init).toBeLessThan(SH.indexOf('${CHROME_FLAG}'))
  })
})

describe('the helper fails silent, never loud', () => {
  it('writes the flag only for an explicit "1"', () => {
    expect(HELPER).toContain("=== '1'")
    expect(HELPER).toContain("process.stdout.write('--chrome ')")
  })

  it('a missing dist, unknown key or unreadable overrides print NOTHING', () => {
    // A failure to read a preference must not change how the main agent starts:
    // the catch is empty on purpose, and there is no fallback write.
    const tail = HELPER.slice(HELPER.indexOf('} catch {'))
    expect(tail).not.toContain('process.stdout.write')
  })

  it('channels.sh only calls the helper when dist exists (strict no-op otherwise)', () => {
    expect(SH).toContain('[ -f "$INSTALL_DIR/dist/settings-store.js" ]')
  })

  it('records WHY a missing extension is safe, with the measurement', () => {
    // The claim "a missing extension does not wedge the agent" is measured, not
    // assumed -- keep the note next to the code so it is not lost.
    expect(SH).toMatch(/2\.1\.217|extension ABSENT/)
  })
})
