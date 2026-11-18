// The agent package installer's disk phase (MIOAGENTINSTALL1114, PR-I3; plan 4, 4.1, 7.2-7.5, 10.2 (2), 10.3).
//
// On a temp tree (PROJECT_ROOT and STORE_DIR are a temp dir): the payload-to-disk mapping, the LOCAL.md placeholder,
// the directory identity, the install block run to its end, stopped after every step (a process death: the test
// calls the first k exported steps and then the reaper) and failing at a step (the block's own error branch), the
// marker rule against hand-made agents, the reaper's handling of bad markers and of what is not a file, and the owner
// notices. writeAgentBase is replaced by a recorder (its own writes are pinned by agent-create-characterization).
// Mutant rows 20, 21, 23, 24, 35, 36, 37, 39, 47 (set-aside half), 50 and 55 of plan 10.4 are pinned here.
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import {
  chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync,
  symlinkSync, writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const tmpRoot = mkdtempSync(join(tmpdir(), 'marveen-agent-package-install-'))
process.env.CLAUDECLAW_ENV_DIR = tmpRoot
const STORE = join(tmpRoot, 'store')
const AGENTS = join(tmpRoot, 'agents')

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<object>()), PROJECT_ROOT: tmpRoot, STORE_DIR: join(tmpRoot, 'store'), MAIN_AGENT_ID: 'agent-a',
  OWNER_NAME: 'TestOwner', BOT_NAME: 'Botty',
}))
const h = vi.hoisted(() => ({ baseCalls: [] as Array<[string, unknown]>, baseThrows: false, rosterNoop: false, shellAtBase: [] as boolean[], blockRecord: false }))
vi.mock('../web/agent-create.js', async (orig) => ({
  ...(await orig<typeof import('../web/agent-create.js')>()),
  writeAgentBase: (name: string, base: Record<string, unknown>) => {
    h.baseCalls.push([name, base])
    // (39) whether the shell was already the folder's first file when the base was written.
    h.shellAtBase.push(existsSync(join(tmpRoot, 'agents', name, 'CLAUDE.md')))
    if (h.baseThrows) throw new Error('base write failed')
    // (50) a FILE where the record's folder goes: step 7 then throws.
    if (h.blockRecord) writeFileSync(join(tmpRoot, 'agents', name, '.package'), 'x')
    writeFileSync(join(tmpRoot, 'agents', name, 'agent-config.json'), JSON.stringify({ model: base.model, displayName: base.displayName }))
  },
}))
vi.mock('../web/agent-scaffold.js', async (orig) => {
  const real = await orig<typeof import('../web/agent-scaffold.js')>()
  return { ...real, ensureFleetRosterSection: (n: string) => (h.rosterNoop ? undefined : real.ensureFleetRosterSection(n)) }
})

mkdirSync(join(tmpRoot, 'templates', 'profiles'), { recursive: true })
for (const f of readdirSync(join(__dirname, '..', '..', 'templates', 'profiles'))) {
  copyFileSync(join(__dirname, '..', '..', 'templates', 'profiles', f), join(tmpRoot, 'templates', 'profiles', f))
}

const I = await import('../web/agent-package/install.js')
const M = await import('../web/agent-package/marker.js')
const { listAllAgentNames, isKnownAgent } = await import('../web/agent-config.js')
const { verifyDelivery } = await import('../web/agent-package/verify.js')
const { makeKeyPair, makeSignedDelivery, makePng } = await import('./helpers/make-delivery.js')
type Ctx = import('../web/agent-package/install.js').InstallContext

const KEY = makeKeyPair()
const NOW = new Date('2026-11-18T10:00:00.000Z')
const FILES = {
  'CLAUDE.md': '# Invoice helper\n\nYou help with invoices. PACKAGE-CANARY\n',
  'SOUL.md': 'Calm, precise, brief.\n',
  'skills/invoice-check/SKILL.md': '---\nname: invoice-check\ndescription: Checks an invoice\n---\nCheck it.\n',
  'skills/invoice-check/references/rules.md': 'The rules.\n',
}
function pkgOf(over: Record<string, unknown> = {}) {
  const bytes = makeSignedDelivery({ kid: KEY.kid, privateKey: KEY.privateKey, slug: 'invoice-helper', version: '1.2.0', files: FILES, avatar: { path: 'avatar.png', contentType: 'image/png', bytes: makePng() }, displayName: 'Invoice Helper', ...over })
  const v = verifyDelivery(bytes, (over.slug as string) ?? 'invoice-helper', [KEY.jwk])
  if (!v.ok) throw new Error(`test delivery refused: ${v.reason}`)
  return v.pkg
}
const ctxOf = (name = 'invoice-helper', over: Record<string, unknown> = {}): Ctx => ({ name, pkg: pkgOf({ slug: name, ...over }), model: 'claude-sonnet-5', driveFolder: '', lang: 'hu', now: NOW })
const dir = (n: string) => join(AGENTS, n)
const marker = (n: string) => join(STORE, 'agent-package-installing', `${n}.json`)
const leftovers = () => (existsSync(join(STORE, 'agent-package-leftovers')) ? readdirSync(join(STORE, 'agent-package-leftovers')).filter((e) => e !== 'pending-notices' && e !== 'bad-markers') : [])
const notices = () => (existsSync(I.pendingNoticesDir()) ? readdirSync(I.pendingNoticesDir()).map((f) => JSON.parse(readFileSync(join(I.pendingNoticesDir(), f), 'utf8'))) : [])
const hidden = () => JSON.parse(readFileSync(join(STORE, 'agent-package-hidden.json'), 'utf8'))
/** Every file under a folder with its bytes, for "byte for byte unchanged". */
function treeOf(root: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (d: string, rel: string) => {
    for (const e of readdirSync(d)) {
      const p = join(d, e)
      const st = lstatSync(p)
      if (st.isDirectory()) walk(p, rel + e + '/')
      else out[rel + e] = st.isSymbolicLink() ? 'link' : readFileSync(p).toString('base64')
    }
  }
  if (existsSync(root)) walk(root, '')
  return out
}
/** A fake marker with the folder's real identity: the strongest forgery a same-user writer can make. */
function forgeMarker(n: string): void {
  mkdirSync(join(STORE, 'agent-package-installing'), { recursive: true })
  writeFileSync(marker(n), JSON.stringify({ slug: n, version: '1.0.0', startedAt: NOW.toISOString(), pid: 1, ...M.dirIdentityOf(dir(n)) }))
}

beforeEach(() => {
  rmSync(STORE, { recursive: true, force: true })
  rmSync(AGENTS, { recursive: true, force: true })
  mkdirSync(STORE, { recursive: true })
  mkdirSync(AGENTS, { recursive: true })
  h.baseCalls.length = 0
  h.baseThrows = false
  h.rosterNoop = false
  h.blockRecord = false
  h.shellAtBase.length = 0
})
afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }))

describe('payloadPathToDisk (plan 4)', () => {
  it('maps every allowed path, and only those', () => {
    expect(I.payloadPathToDisk('CLAUDE.md')).toBe('PACKAGE.md')
    expect(I.payloadPathToDisk('SOUL.md')).toBe('SOUL.md')
    expect(I.payloadPathToDisk('skills/a1/SKILL.md')).toBe(join('.claude', 'skills', 'a1', 'SKILL.md'))
    expect(I.payloadPathToDisk('skills/a1/references/r_1.md')).toBe(join('.claude', 'skills', 'a1', 'references', 'r_1.md'))
    expect(I.payloadPathToDisk('avatar.png')).toBe('avatar.png')
    expect(I.payloadPathToDisk('avatar.webp')).toBe('avatar.webp')
    for (const bad of ['LOCAL.md', 'PACKAGE.md', '../x.md', 'skills/a/../../x.md', '.package/manifest.json', 'avatar.jpg', 'skills/A/SKILL.md']) {
      expect(() => I.payloadPathToDisk(bad)).toThrow()
    }
  })
})

describe('LOCAL.md (plan 4, S16; mutant 21)', () => {
  it('the placeholder is the contract text byte for byte in both languages, with no heading line', () => {
    expect(I.LOCAL_MD_TEXT.hu).toBe('Ez a fájl az ügynök helyi, csak rád szabott részét tartalmazza. Az ügynök az első beszélgetésben tölti ki, és a csomag frissítései soha nem írják felül. Kézzel is szerkesztheted.\n')
    expect(I.LOCAL_MD_TEXT.en).toBe('This file holds the local part of this agent that is tailored to you. The agent fills it in during your first conversation, and package updates never overwrite it. You can also edit it by hand.\n')
    for (const lang of ['hu', 'en'] as const) {
      mkdirSync(dir('l-' + lang))
      expect(I.writeLocalIfAbsent(dir('l-' + lang), lang)).toBe(true)
      const text = readFileSync(join(dir('l-' + lang), 'LOCAL.md'), 'utf8')
      expect(text).toBe(I.LOCAL_MD_TEXT[lang])
      expect(text.split('\n').some((l) => l.startsWith('#'))).toBe(false)
    }
  })
  it('an existing LOCAL.md is never overwritten', () => {
    mkdirSync(dir('l'))
    writeFileSync(join(dir('l'), 'LOCAL.md'), 'mine\n')
    expect(I.writeLocalIfAbsent(dir('l'), 'en')).toBe(false)
    expect(readFileSync(join(dir('l'), 'LOCAL.md'), 'utf8')).toBe('mine\n')
  })
})

describe('sameDirIdentity (plan 7.2, N18/b; mutant 35)', () => {
  const st = (b: bigint, c: bigint, m: bigint) => ({ dev: 7n, ino: 42n, birthtimeNs: b, ctimeNs: c, mtimeNs: m })
  const mk = (birth: string) => ({ dev: '7', ino: '42', birthtimeNs: birth })
  it('a real birth time on a modified folder counts', () => {
    expect(M.sameDirIdentity(mk('100'), st(100n, 200n, 300n))).toBe(true)
    expect(M.sameDirIdentity(mk('99'), st(100n, 200n, 300n))).toBe(false)
  })
  it('a never-modified folder (birth = change = modification): the birth time is left out', () => {
    expect(M.sameDirIdentity(mk('99'), st(100n, 100n, 100n))).toBe(true)
  })
  it('a file system that reports the change time as the birth time: left out', () => {
    expect(M.sameDirIdentity(mk('99'), st(200n, 200n, 300n))).toBe(true)
    expect(M.sameDirIdentity(mk('99'), st(300n, 200n, 300n))).toBe(true)
  })
  it('zero: left out; dev and ino still decide', () => {
    expect(M.sameDirIdentity(mk('99'), st(0n, 200n, 300n))).toBe(true)
    expect(M.sameDirIdentity({ dev: '8', ino: '42', birthtimeNs: '0' }, st(0n, 200n, 300n))).toBe(false)
    expect(M.sameDirIdentity({ dev: '7', ino: '43', birthtimeNs: '0' }, st(0n, 200n, 300n))).toBe(false)
  })
})

describe('the install block, run to its end (plan 7.2)', () => {
  it('writes the layout, the shell first, the record, and commits by removing the marker', () => {
    const c = ctxOf()
    expect(I.runInstallBlock(c)).toEqual({ ok: true })
    const d = dir('invoice-helper')
    const claude = readFileSync(join(d, 'CLAUDE.md'))
    expect(M.startsWithPackageShell(claude)).toBe(true)
    const text = claude.toString('utf8')
    expect(text.startsWith(M.PACKAGE_SHELL_PREFIX_TEXT + '\n<!-- BEGIN GENERATED: fleet-base-rules')).toBe(true)
    // (25) the fleet base rules block with the install's own names.
    expect(text).toContain('invoice-helper')
    expect(text).toContain('agent-a')
    expect(text).not.toContain('AGENT_NAME')
    expect(M.hasLaunchTrace(claude)).toBe(true)
    expect(readFileSync(join(d, 'PACKAGE.md'), 'utf8')).toBe(FILES['CLAUDE.md'])
    expect(readFileSync(join(d, 'SOUL.md'), 'utf8')).toBe(FILES['SOUL.md'])
    expect(readFileSync(join(d, '.claude', 'skills', 'invoice-check', 'references', 'rules.md'), 'utf8')).toBe('The rules.\n')
    expect(existsSync(join(d, 'avatar.png'))).toBe(true)
    expect(readFileSync(join(d, 'LOCAL.md'), 'utf8')).toBe(I.LOCAL_MD_TEXT.hu)
    const rec = JSON.parse(readFileSync(join(d, '.package', 'manifest.json'), 'utf8'))
    expect(rec).toMatchObject({ schema: 1, payloadSha256: c.pkg.payloadSha256, kid: KEY.kid, installedAt: NOW.toISOString() })
    expect(rec.payload).toEqual(JSON.parse(Buffer.from(c.pkg.unverifiedPayloadBytes()).toString('utf8')))
    expect(existsSync(marker('invoice-helper'))).toBe(false)
    expect(hidden()).toEqual([])
    expect(listAllAgentNames()).toContain('invoice-helper')
    expect(I.packageStartRefusal('invoice-helper', d)).toBeNull()
    // (55) the base gets the VERIFIED display name and the chosen model.
    expect(h.baseCalls).toEqual([['invoice-helper', { model: 'claude-sonnet-5', profileId: 'default', customProvider: null, displayName: 'Invoice Helper' }]])
    expect(h.shellAtBase).toEqual([true])
    expect(I.readPackageManifest(d).state).toBe('ok')
    expect(I.packageDescription(d)).toBe(c.pkg.description)
  })

  it('English install: the English placeholder', () => {
    const c = { ...ctxOf(), lang: 'en' as const }
    expect(I.runInstallBlock(c).ok).toBe(true)
    expect(readFileSync(join(dir('invoice-helper'), 'LOCAL.md'), 'utf8')).toBe(I.LOCAL_MD_TEXT.en)
  })

  it('(20) a folder that already exists: dir_exists, the folder byte for byte unchanged, no marker left', () => {
    mkdirSync(dir('invoice-helper'))
    writeFileSync(join(dir('invoice-helper'), 'CLAUDE.md'), '# Mine\n')
    const before = treeOf(dir('invoice-helper'))
    expect(I.runInstallBlock(ctxOf())).toEqual({ ok: false, kind: 'dir_exists' })
    expect(treeOf(dir('invoice-helper'))).toEqual(before)
    expect(existsSync(marker('invoice-helper'))).toBe(false)
  })

  it('a marker that stands: marker_exists, nothing touched', () => {
    mkdirSync(join(STORE, 'agent-package-installing'), { recursive: true })
    writeFileSync(marker('invoice-helper'), '{}')
    expect(I.runInstallBlock(ctxOf())).toEqual({ ok: false, kind: 'marker_exists' })
    expect(existsSync(dir('invoice-helper'))).toBe(false)
    expect(readFileSync(marker('invoice-helper'), 'utf8')).toBe('{}')
  })
})

// The steps in order, as the block runs them (step 8 is the commit).
const STEPS: Array<[string, (c: Ctx) => void]> = [
  ['1', I.step1WriteMarker], ['2', I.step2Mkdir], ['3', I.step3Identity], ['3b', I.step3bShell], ['4', I.step4Base],
  ['5', I.step5Files], ['6', I.step6Local], ['7', I.step7Manifest], ['7b', I.step7bRoster],
]

describe('process death after each step, then the reaper (plan 7.2 table; mutants 23, 39, 50)', () => {
  for (let k = 1; k <= STEPS.length; k++) {
    const last = STEPS[k - 1][0]
    it(`stopped after step ${last}`, () => {
      const c = ctxOf()
      for (const [, step] of STEPS.slice(0, k)) step(c)
      M.writeHiddenList()
      const d = dir('invoice-helper')
      if (last === '1') {
        expect(M.installMarkerState('invoice-helper')).toEqual({ kind: 'valid', phase: 'pre-dir' })
        I.reapInterruptedPackageInstalls({ now: () => NOW })
        expect(existsSync(marker('invoice-helper'))).toBe(false)
        return
      }
      if (last === '7b') {
        // (50) the roster block is the launch trace: a finished folder is not a target; it is visible and startable.
        expect(M.installMarkerState('invoice-helper')).toEqual({ kind: 'invalid', why: 'launch_trace' })
        expect(listAllAgentNames()).toContain('invoice-helper')
        expect(I.packageStartRefusal('invoice-helper', d)).toBeNull()
        const before = treeOf(d)
        I.reapInterruptedPackageInstalls({ now: () => NOW })
        expect(existsSync(marker('invoice-helper'))).toBe(false)
        expect(treeOf(d)).toEqual(before)
        expect(notices().map((n) => n.kind)).toEqual(['orphan_marker'])
        return
      }
      // Steps 2 to 7: hidden, unstartable, not a known agent.
      expect(M.installMarkerState('invoice-helper').kind).toBe('valid')
      expect(hidden()).toEqual(['invoice-helper'])
      expect(listAllAgentNames()).not.toContain('invoice-helper')
      expect(isKnownAgent('invoice-helper')).toBe(false)
      expect(I.packageStartRefusal('invoice-helper', d)).toBe(I.REFUSAL_INSTALL_INCOMPLETE)
      if (last === '7') expect(M.hasLaunchTrace(readFileSync(join(d, 'CLAUDE.md')))).toBe(false)
      const s = I.reapInterruptedPackageInstalls({ now: () => NOW })
      expect(existsSync(marker('invoice-helper'))).toBe(false)
      expect(existsSync(d)).toBe(false)
      expect(hidden()).toEqual([])
      if (last === '2') {
        // an empty folder from step 2: removed, nothing set aside.
        expect(leftovers()).toEqual([])
        expect(s.setAside).toBe(0)
      } else {
        expect(leftovers()).toEqual([`invoice-helper.${I.stampOf(NOW)}`])
        expect(notices().map((n) => n.kind)).toEqual(['set_aside'])
      }
    })
  }
})

describe('a step that throws: the block\'s own error branch (mutant 24, 50)', () => {
  it('step 4 throws: 500 failed, the folder set aside (renamed, then the marker removed), the name free', () => {
    h.baseThrows = true
    expect(I.runInstallBlock(ctxOf())).toEqual({ ok: false, kind: 'failed' })
    expect(existsSync(dir('invoice-helper'))).toBe(false)
    expect(existsSync(marker('invoice-helper'))).toBe(false)
    expect(leftovers()).toEqual([`invoice-helper.${I.stampOf(NOW)}`])
    expect(readFileSync(join(STORE, 'agent-package-leftovers', `invoice-helper.${I.stampOf(NOW)}`, 'CLAUDE.md'), 'utf8').startsWith(M.PACKAGE_SHELL_PREFIX_TEXT)).toBe(true)
    expect(hidden()).toEqual([])
    h.baseThrows = false
    expect(I.runInstallBlock(ctxOf()).ok).toBe(true)
  })

  it('(50) the record cannot be written: set aside, and the roster block was not written before it', () => {
    h.blockRecord = true
    expect(I.runInstallBlock(ctxOf())).toEqual({ ok: false, kind: 'failed' })
    const aside = join(STORE, 'agent-package-leftovers', `invoice-helper.${I.stampOf(NOW)}`)
    expect(M.hasLaunchTrace(readFileSync(join(aside, 'CLAUDE.md')))).toBe(false)
  })

  it('(50) the roster writer fails silently: the postcondition catches it, the folder is set aside', () => {
    h.rosterNoop = true
    expect(I.runInstallBlock(ctxOf())).toEqual({ ok: false, kind: 'failed' })
    expect(existsSync(dir('invoice-helper'))).toBe(false)
    expect(leftovers()).toHaveLength(1)
  })

  it('(47) the set-aside rename fails: a set_aside_failed notice, the marker stays, the folder stays hidden', () => {
    h.baseThrows = true
    // The leftovers folder takes no new entry (the rename fails); its notices folder exists and is writable.
    mkdirSync(join(STORE, 'agent-package-leftovers', 'pending-notices'), { recursive: true })
    chmodSync(join(STORE, 'agent-package-leftovers'), 0o500)
    try {
      expect(I.runInstallBlock(ctxOf())).toEqual({ ok: false, kind: 'failed' })
    } finally {
      chmodSync(join(STORE, 'agent-package-leftovers'), 0o700)
    }
    expect(existsSync(dir('invoice-helper'))).toBe(true)
    expect(existsSync(marker('invoice-helper'))).toBe(true)
    expect(listAllAgentNames()).not.toContain('invoice-helper')
    expect(hidden()).toEqual(['invoice-helper'])
    expect(notices().map((n) => n.kind)).toEqual(['set_aside_failed'])
  })
})

describe('the marker rule against agents the installer did not make (mutants 23, 37, 39)', () => {
  const handMade: Array<[string, (d: string) => void]> = [
    ['(a) generation running: no CLAUDE.md yet', (d) => { writeFileSync(join(d, 'agent-config.json'), '{}') }],
    ['(b) the fallback template CLAUDE.md', (d) => { writeFileSync(join(d, 'CLAUDE.md'), '# hand\n\nTemplate body.\n') }],
    ['(c) a complete CLAUDE.md with the roster block', (d) => { writeFileSync(join(d, 'CLAUDE.md'), `# hand\n\n${M.FLEET_ROSTER_BEGIN}\nx\n`) }],
    ['(d) the shell, hand-made, with the roster block', (d) => { writeFileSync(join(d, 'CLAUDE.md'), `${M.PACKAGE_SHELL_PREFIX_TEXT}\n${M.FLEET_ROSTER_BEGIN}\n`); writeFileSync(join(d, 'PACKAGE.md'), 'p\n') }],
  ]
  for (const [label, make] of handMade) {
    it(`${label}: a forged marker with the right identity neither hides it nor gets it moved`, () => {
      mkdirSync(dir('hand'))
      make(dir('hand'))
      forgeMarker('hand')
      const before = treeOf(dir('hand'))
      expect(M.installMarkerState('hand').kind).toBe('invalid')
      expect(listAllAgentNames()).toContain('hand')
      expect(isKnownAgent('hand')).toBe(true)
      expect(I.packageStartRefusal('hand', dir('hand'))).toBeNull()
      I.reapInterruptedPackageInstalls({ now: () => NOW })
      expect(treeOf(dir('hand'))).toEqual(before)
      expect(existsSync(marker('hand'))).toBe(false)
      expect(leftovers()).toEqual([])
    })
  }

  it('a marker whose identity does not match (another folder under the name): visible, untouched', () => {
    mkdirSync(dir('hand'))
    forgeMarker('hand')
    rmSync(dir('hand'), { recursive: true })
    mkdirSync(join(tmpRoot, 'filler'), { recursive: true })
    mkdirSync(dir('hand'))
    writeFileSync(join(dir('hand'), 'CLAUDE.md'), M.PACKAGE_SHELL_PREFIX_TEXT)
    const m = JSON.parse(readFileSync(marker('hand'), 'utf8'))
    writeFileSync(marker('hand'), JSON.stringify({ ...m, ino: String(BigInt(m.ino) + 1000n) }))
    expect(M.installMarkerState('hand')).toEqual({ kind: 'invalid', why: 'identity_mismatch' })
    expect(listAllAgentNames()).toContain('hand')
    const before = treeOf(dir('hand'))
    I.reapInterruptedPackageInstalls({ now: () => NOW })
    expect(treeOf(dir('hand'))).toEqual(before)
  })

  it('(23, J2) the agents entry is a link: neither the link nor its target moves', () => {
    mkdirSync(join(tmpRoot, 'elsewhere', 'real'), { recursive: true })
    writeFileSync(join(tmpRoot, 'elsewhere', 'real', 'CLAUDE.md'), M.PACKAGE_SHELL_PREFIX_TEXT)
    symlinkSync(join(tmpRoot, 'elsewhere', 'real'), dir('linked'))
    mkdirSync(join(STORE, 'agent-package-installing'), { recursive: true })
    writeFileSync(marker('linked'), JSON.stringify({ slug: 'linked', version: '1.0.0', startedAt: NOW.toISOString(), pid: 1, ...M.dirIdentityOf(join(tmpRoot, 'elsewhere', 'real')) }))
    expect(M.installMarkerState('linked').kind).toBe('invalid')
    I.reapInterruptedPackageInstalls({ now: () => NOW })
    expect(lstatSync(dir('linked')).isSymbolicLink()).toBe(true)
    expect(existsSync(join(tmpRoot, 'elsewhere', 'real', 'CLAUDE.md'))).toBe(true)
  })

  it('(23, K1) an empty folder without a marker is never touched', () => {
    mkdirSync(dir('empty'))
    I.reapInterruptedPackageInstalls({ now: () => NOW })
    expect(existsSync(dir('empty'))).toBe(true)
  })

  it('(37, J2) a marker whose content names another slug: moved to bad-markers, agents/ byte for byte unchanged', () => {
    mkdirSync(dir('victim'))
    writeFileSync(join(dir('victim'), 'CLAUDE.md'), '# victim\n')
    mkdirSync(join(STORE, 'agent-package-installing'), { recursive: true })
    writeFileSync(marker('victim'), JSON.stringify({ slug: '../store', version: '1.0.0', startedAt: 'x', pid: 1, ...M.dirIdentityOf(dir('victim')) }))
    writeFileSync(join(STORE, 'agent-package-installing', 'Bad_Name.json'), '{}')
    const before = treeOf(AGENTS)
    expect(M.installMarkerState('victim')).toEqual({ kind: 'invalid', why: 'bad_content' })
    I.reapInterruptedPackageInstalls({ now: () => NOW })
    expect(treeOf(AGENTS)).toEqual(before)
    expect(readdirSync(join(STORE, 'agent-package-leftovers', 'bad-markers')).sort()).toEqual([`${I.stampOf(NOW)}-Bad_Name.json`, `${I.stampOf(NOW)}-victim.json`])
    expect(readdirSync(join(STORE, 'agent-package-installing'))).toEqual([])
    expect(notices().map((n) => n.kind).sort()).toEqual(['bad_marker', 'bad_marker'])
  })

  it('(37, D17) a link or a folder in a marker\'s place is left alone with a marker_blocked notice; a tmp leftover is removed', () => {
    const md = join(STORE, 'agent-package-installing')
    mkdirSync(join(md, 'dir-name.json'), { recursive: true })
    symlinkSync(join(tmpRoot, 'nowhere'), join(md, 'link-name.json'))
    writeFileSync(join(md, 'some-name.json.123.456.abcd1234.tmp'), '{}')
    I.reapInterruptedPackageInstalls({ now: () => NOW })
    expect(readdirSync(md).sort()).toEqual(['dir-name.json', 'link-name.json'])
    expect(notices().map((n) => n.kind)).toEqual(['marker_blocked', 'marker_blocked'])
  })

  it('the hidden list is written by the reaper even when there is no marker', () => {
    I.reapInterruptedPackageInstalls({ now: () => NOW })
    expect(hidden()).toEqual([])
    expect(statSync(join(STORE, 'agent-package-hidden.json')).mode & 0o777).toBe(0o600)
  })
})

describe('the owner notices (plan 7.3; mutant 36)', () => {
  it('a failed send keeps the notice for the next run; a successful one removes it', async () => {
    I.writePendingNotice('set_aside', 'invoice-helper', '/x/leftovers/invoice-helper.1', NOW)
    const texts: string[] = []
    expect(await I.flushPendingPackageNotices(async (t) => { texts.push(t); return false })).toBe(0)
    expect(notices()).toHaveLength(1)
    expect(await I.flushPendingPackageNotices(async (t) => { texts.push(t); return true })).toBe(1)
    expect(notices()).toHaveLength(0)
    expect(texts).toHaveLength(2)
    expect(texts[0]).toContain('/x/leftovers/invoice-helper.1')
  })
  it('a send that throws keeps the notice', async () => {
    I.writePendingNotice('orphan_marker', 'a1', '/p', NOW)
    expect(await I.flushPendingPackageNotices(async () => { throw new Error('down') })).toBe(0)
    expect(notices()).toHaveLength(1)
  })
  it('no at-sign after white space in any notice text or refusal text (v1.2.1/1)', () => {
    const kinds = ['set_aside', 'set_aside_failed', 'orphan_marker', 'bad_marker', 'marker_blocked', 'fallback_refused']
    const texts = [...kinds.map((kind) => I.noticeText({ kind, name: 'a1', path: '/s/p' })), I.REFUSAL_INSTALL_INCOMPLETE, I.REFUSAL_FILES_MISSING, I.REFUSAL_SHELL_BROKEN]
    for (const t of texts) expect(t).not.toContain('@')
  })
})

describe('the package record and the description (plan 4.1, 4.2)', () => {
  it('readPackageManifest: none, unreadable for corrupt or wrong-shaped records', () => {
    mkdirSync(join(dir('p'), '.package'), { recursive: true })
    expect(I.readPackageManifest(dir('none'))).toEqual({ state: 'none' })
    for (const bad of ['{', '{"schema":2}', '[]', '{"schema":1,"payloadSha256":"x","kid":"k","installedAt":"a","updatedAt":"a","payload":{}}']) {
      writeFileSync(join(dir('p'), '.package', 'manifest.json'), bad)
      expect(I.readPackageManifest(dir('p'))).toEqual({ state: 'unreadable' })
      expect(I.packageDescription(dir('p'))).toBeNull()
    }
  })
  it('a description in an edited record that fails the manifest text rules is not shown', () => {
    expect(I.runInstallBlock(ctxOf()).ok).toBe(true)
    const p = join(dir('invoice-helper'), '.package', 'manifest.json')
    const rec = JSON.parse(readFileSync(p, 'utf8'))
    rec.payload.description = '<img src=x onerror=alert(1)> ‮'
    writeFileSync(p, JSON.stringify(rec))
    expect(I.packageDescription(dir('invoice-helper'))).toBe('')
    rec.payload.description = 'x'.repeat(300)
    writeFileSync(p, JSON.stringify(rec))
    expect(I.packageDescription(dir('invoice-helper'))).toBe('x'.repeat(200))
  })
})
