// Agent package credential and catalog (MIOAGENTINSTALL1114, PR-I2; plan 6, 6.4, 6.5).
//
//   GET    /api/agent-packages/credential  -> {connected:false} | {connected:true, label, deviceTokenId, connectedAt}
//   POST   /api/agent-packages/credential  {code:"PPPP-SSSSSSSS"} -> the GET shape + replaced, replacedDeviceTokenId
//   DELETE /api/agent-packages/credential  -> {ok:true, connected:false, remoteRevoked:false}
//   GET    /api/agent-packages/catalog     -> {catalog: <the publishing side's body>, knownKids: [<kid>], origin, marveenVersion}
//   POST   /api/agents/install-package     {slug} -> {ok, name, version, modelHintApplied, skillReport} (PR-I3, plan 6.1)
//   POST   /api/agents/:name/package/check {} -> the change list (PR-I4, plan 6.2, 8.2)
//   POST   /api/agents/:name/package/apply {planId, decisions} -> {ok, kind, version, applied, keptMine} (PR-I4, plan 6.3, 8.4)
//
// Every route takes the owner (mayActAsOwner) BEFORE it reads a body: the
// credential lets this machine download packages on the owner's account. The
// network and the credential file are remote.ts's; this file never sees the
// token. The Remote comes from `deps` (5.2): the released build is what web.ts
// wires, the handler called with ONE argument, so RELEASED_DEPS and its fixed
// origin apply; a test passes its own deps with a test origin.

import { lstatSync } from 'node:fs'
import { join } from 'node:path'
import { STORE_DIR, MAIN_AGENT_ID } from '../../config.js'
import { AGENT_MODEL_CHOICES } from '../../config-registry.js'
import { getEffectiveSettingValue } from '../../settings-store.js'
import { createAgentMessage } from '../../db.js'
import { logger } from '../../logger.js'
import { notifyOwner } from '../../notify.js'
import { json, methodNotAllowed, readBodyOrRefuse } from '../http-helpers.js'
import { RELEASED_KEYS } from '../agent-package/keys.js'
import { PACKAGE_ORIGIN, deleteCredential, hasCredential, makeRemote, readCredentialView, type Remote } from '../agent-package/remote.js'
import { SLUG_RE, meetsMinMarveenVersion, parseVersion, verifyDelivery, type Jwk } from '../agent-package/verify.js'
import { agentsBaseDir, isHiddenByInstallMarker, isReservedName, markerPathOf } from '../agent-package/marker.js'
import {
  OWNER_DISPLAY_NAME_MAX_INPUT, flushPendingPackageNotices, ownerDisplayName, packageSkillReport, readPackageManifest, reapInterruptedPackageInstalls,
  runInstallBlock, sameDeviceLayout,
} from '../agent-package/install.js'
import { sanitizeAgentName } from '../sanitize.js'
import {
  checkDecisions, classifyVersion, computeChangeList, installedFileHashes, readUpdatingTrace, runApplyBlock, shellRepairState,
  updateSkillReport, type ChangeList,
} from '../agent-package/update.js'
import { quarantineOn } from '../skill-quarantine.js'
import type { PackageManifest } from '../agent-package/install.js'
import type { VerifiedPackage } from '../agent-package/verify.js'
import { refuseIfCliCannotLaunch } from '../agent-create.js'
import { launchableInstallDefault } from '../default-model-guard.js'
import { currentVersion } from '../update-checker.js'
import { serializeSkillsDir } from '../skills-dir-queue.js'
import { agentTextLang } from '../agent-text-lang.js'
import { isAgentRunning } from '../agent-process.js'
import { listAgentNames } from '../agent-config.js'
import { mayActAsOwner, refuseOwner } from './auth.js'
import type { RouteContext } from './types.js'

export type PackageDeps = {
  keys: readonly Jwk[]; fetchImpl: typeof fetch; now: () => Date; remote: Remote
  /** The owner alert path for the installer's stored notices (plan 7.3, N16); none: the notices wait for the next start. */
  notify?: (text: string) => Promise<boolean>
}

export const RELEASED_DEPS: PackageDeps = {
  keys: RELEASED_KEYS,
  fetchImpl: fetch,
  now: () => new Date(),
  remote: makeRemote(PACKAGE_ORIGIN),
  notify: notifyOwner,
}

const CREDENTIAL_PATH = '/api/agent-packages/credential'
const CATALOG_PATH = '/api/agent-packages/catalog'
const INSTALL_PATH = '/api/agents/install-package'
/** Plan 6: a request body is at most 4 KiB. */
const BODY_MAX_BYTES = 4 * 1024
const BAD_REQUEST = { error: 'bad_request' }

/**
 * The device-link code (A-side contract 4.1: `PPPP-SSSSSSSS`, Crockford base32)
 * in its canonical form, or null. As Crockford decoding reads it: case does not
 * matter, blanks and hyphens are ignored, O reads as 0 and I, L as 1.
 */
export function normalizeLinkCode(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 64) return null
  const s = raw.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1')
  if (!/^[0-9A-HJKMNP-TV-Z]{12}$/.test(s)) return null
  return `${s.slice(0, 4)}-${s.slice(4)}`
}

/** The redeem body: exactly {code}; null for anything else (the parse error is dropped, T1). */
function codeFromBody(raw: Buffer): string | null {
  let v: unknown
  try {
    v = JSON.parse(raw.toString('utf8'))
  } catch {
    return null
  }
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null
  const keys = Object.keys(v)
  if (keys.length !== 1 || keys[0] !== 'code') return null
  return normalizeLinkCode((v as { code: unknown }).code)
}

/** The install body: exactly {slug} with a string value; null for anything else. */
/**
 * The install body: `{slug}`, or `{slug, display_name}` (MIOAGENTB4-1122, Samu 83718: the name the owner chose for
 * the dashboard). Any other key is a 400 bad_request, as before; a display_name that is not a string, longer than
 * OWNER_DISPLAY_NAME_MAX_INPUT, or against a manifest text rule after the cleaning is its own 400, so the dialog can
 * say which field is wrong (Samu 83741).
 */
function installBodyOf(raw: Buffer): { slug: string; displayName?: string } | 'bad_request' | 'invalid_display_name' {
  let v: unknown
  try {
    v = JSON.parse(raw.toString('utf8'))
  } catch {
    return 'bad_request'
  }
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return 'bad_request'
  const keys = Object.keys(v)
  if (!keys.includes('slug') || keys.some((k) => k !== 'slug' && k !== 'display_name')) return 'bad_request'
  const { slug, display_name: rawName } = v as { slug: unknown; display_name?: unknown }
  if (typeof slug !== 'string') return 'bad_request'
  if (rawName === undefined) return { slug }
  if (typeof rawName !== 'string' || Array.from(rawName).length > OWNER_DISPLAY_NAME_MAX_INPUT) return 'invalid_display_name'
  const name = ownerDisplayName(rawName)
  if (name === null) return 'invalid_display_name'
  return name === undefined ? { slug } : { slug, displayName: name }
}

type Answer = { status: number; body: Record<string, unknown> }

/** An entry at `p`, a dangling link included (existsSync follows links). */
function entryExists(p: string): boolean {
  try {
    lstatSync(p)
    return true
  } catch {
    return false
  }
}

/** Plan 7.3: after a cleanup or a set-aside beside a live server, the stored owner notices go out (best effort). */
function flushNotices(deps: PackageDeps): void {
  if (!deps.notify) return
  void flushPendingPackageNotices(deps.notify).catch((err) => logger.warn({ err }, 'agent package owner notices were not sent'))
}

/**
 * Plan 6.1 step 4: what stands under the name now. null when the name is free. A marker that stands is first given
 * to the reaper (it cannot belong to a running install: the block is synchronous); one that stays is stale_install.
 */
function nameStateRefusal(slug: string): Answer | null {
  if (entryExists(markerPathOf(slug))) {
    reapInterruptedPackageInstalls({ only: slug })
    if (entryExists(markerPathOf(slug))) return { status: 409, body: { error: 'stale_install' } }
  }
  const dir = join(agentsBaseDir(), slug)
  if (!entryExists(dir)) return null
  const m = readPackageManifest(dir)
  if (m.state === 'ok' && m.manifest.payload.slug === slug) {
    return { status: 409, body: { error: 'already_installed', version: m.manifest.payload.version } }
  }
  return { status: 409, body: { error: 'name_taken' } }
}

const UNSUPPORTED_LAYOUT_MESSAGE = 'Package install is not available on this layout: the agents folder and the store folder are on different volumes. Put both on one volume, then install again.'

/** The catalog row of `slug`, or null (the catalog body is the publishing side's, so every field is checked). */
function catalogEntry(catalog: Record<string, unknown>, slug: string): Record<string, unknown> | null {
  const list = catalog.packages
  if (!Array.isArray(list)) return null
  for (const p of list) {
    if (p !== null && typeof p === 'object' && !Array.isArray(p) && (p as Record<string, unknown>).slug === slug) return p as Record<string, unknown>
  }
  return null
}

/**
 * POST /api/agents/install-package (plan 6.1). Steps 1-5 are local and download nothing: on a trial account the
 * first successful download fixes the one pick, so every local refusal comes first.
 */
async function installPackage(ctx: RouteContext, deps: PackageDeps): Promise<void> {
  const { req, res } = ctx
  // 1. the owner, before the body.
  if (!mayActAsOwner(ctx.auth, req)) { refuseOwner(res); return }
  // 2. the body and the slug.
  const raw = await readBodyOrRefuse(req, res, { maxBytes: BODY_MAX_BYTES })
  if (raw === null) return
  const body = installBodyOf(raw)
  if (body === 'bad_request') { json(res, BAD_REQUEST, 400); return }
  if (body === 'invalid_display_name') { json(res, { error: 'invalid_display_name' }, 400); return }
  const slug = body.slug
  if (!SLUG_RE.test(slug) || sanitizeAgentName(slug) !== slug) { json(res, { error: 'invalid_slug' }, 400); return }
  // 3. a reserved name.
  if (isReservedName(slug)) { json(res, { error: 'name_reserved' }, 409); return }
  // 4. the layout (a set-aside must be one rename), then the name's state, in the skills-dir queue.
  if (!sameDeviceLayout(STORE_DIR)) { json(res, { error: 'unsupported_layout', message: UNSUPPORTED_LAYOUT_MESSAGE }, 409); return }
  const taken = await serializeSkillsDir(() => nameStateRefusal(slug))
  flushNotices(deps)
  if (taken !== null) { json(res, taken.body, taken.status); return }
  // 5. the own version, the CLI gate on the default model, the credential, the keys and the origin.
  const ownVersion = currentVersion()
  if (parseVersion(ownVersion) === null) { json(res, { error: 'own_version_unknown' }, 500); return }
  let model = await launchableInstallDefault('agent-package-install', { fresh: true })
  const cliGate = await refuseIfCliCannotLaunch(model)
  if (cliGate) { json(res, cliGate, 422); return }
  if (!hasCredential()) { json(res, { error: 'not_connected' }, 409); return }
  if (deps.keys.length === 0 || !deps.remote.configured()) {
    json(res, { error: 'download_failed', reason: 'not_configured' }, 502)
    return
  }
  // 5b. the signing key, BEFORE the download (MIOAGENTB4-1122, Samu D2): on a trial account the download fixes the
  // one pick, so a package this build's keys would refuse must be refused here. The publishing side cannot know our
  // keys; the catalog names each package's kid. Fail-closed: no catalog row or no kid means no download.
  const cat = await deps.remote.catalog({ fetchImpl: deps.fetchImpl, now: deps.now })
  if (!cat.ok) { json(res, cat.refusal.body, cat.refusal.status); return }
  const entry = catalogEntry(cat.catalog, slug)
  if (entry === null) { json(res, { error: 'package_not_found' }, 404); return }
  if (typeof entry.kid !== 'string' || !deps.keys.some((k) => k.kid === entry.kid)) { json(res, { error: 'unknown_kid' }, 409); return }
  // 6. the download.
  const dl = await deps.remote.download(slug, ownVersion, { fetchImpl: deps.fetchImpl, now: deps.now })
  if (!dl.ok) { json(res, dl.refusal.body, dl.refusal.status); return }
  // 7. the verification: nothing is written for a package that fails it.
  const v = verifyDelivery(dl.bytes, slug, deps.keys)
  if (!v.ok) {
    json(res, { error: 'package_rejected', step: v.step, reason: v.reason, ...(v.detail ? { detail: v.detail } : {}) }, 422)
    return
  }
  const pkg = v.pkg
  // 8. the minimum version (the publishing side decided it already; this is the safety net).
  if (!meetsMinMarveenVersion(ownVersion, pkg.minMarveenVersion)) {
    json(res, { error: 'incompatible', minMarveenVersion: pkg.minMarveenVersion }, 409)
    return
  }
  // 9. the model hint: only a Claude model of the picker's closed list that the installed CLI launches (M26: the
  // payload must not send the owner's conversations to another provider).
  let modelHintApplied: boolean | null = null
  if (pkg.modelHint !== null) {
    modelHintApplied = false
    if (pkg.modelHint.startsWith('claude-') && AGENT_MODEL_CHOICES.includes(pkg.modelHint)
      && (await refuseIfCliCannotLaunch(pkg.modelHint)) === null) {
      model = pkg.modelHint
      modelHintApplied = true
    }
  }
  // 10. the disk phase: one synchronous block in the skills-dir queue.
  const driveFolder = String(getEffectiveSettingValue('OWNER_DRIVE_FOLDER') || '')
  const lang = agentTextLang()
  const now = deps.now()
  const out = await serializeSkillsDir(() => {
    const r = runInstallBlock({ name: slug, pkg, model, driveFolder, lang, now, ...(body.displayName ? { displayName: body.displayName } : {}) })
    if (r.ok) return { ok: true as const, skillReport: packageSkillReport(slug, pkg, now) }
    if (r.kind === 'marker_exists') return { ok: false as const, answer: { status: 409, body: { error: 'stale_install' } } }
    if (r.kind === 'dir_exists') {
      return { ok: false as const, answer: nameStateRefusal(slug) ?? { status: 409, body: { error: 'name_taken' } } }
    }
    return { ok: false as const, answer: { status: 500, body: { error: 'install_failed' } } }
  })
  if (!out.ok) {
    flushNotices(deps)
    json(res, out.answer.body, out.answer.status)
    return
  }
  // 11. the answer, then the fleet notice: the NAME only (plan 4.2), never the package's description.
  json(res, { ok: true, name: slug, version: pkg.version, modelHintApplied, skillReport: out.skillReport })
  try {
    const running = listAgentNames().filter((a) => a !== slug && isAgentRunning(a))
    for (const target of [MAIN_AGENT_ID, ...running]) {
      createAgentMessage('system', target, `Uj csapattag erkezett: ${slug}. Udv neki ha legkozelebb beszeltek!`)
    }
  } catch (err) {
    logger.warn({ err, name: slug }, 'Agent package installed, but the team notification failed')
  }
}

// ---------------------------------------------------------------------------
// PR-I4: the update (plan 6.2, 6.3, 8)
// ---------------------------------------------------------------------------

const UPDATE_PATH_RE = /^\/api\/agents\/([^/]+)\/package\/(check|apply)$/
/** 6.3: one apply per agent at a time in this process, from the download to the end of the block. */
const applying = new Set<string>()

type Installed = { name: string; dir: string; manifest: PackageManifest; installedFiles: Map<string, string> }

/** The agent and its record (6.2 rows 2-5); null with the refusal already sent. */
function installedPackageOf(raw: string): Installed | Answer {
  let name: string
  try {
    name = decodeURIComponent(raw)
  } catch {
    return { status: 404, body: { error: 'agent_not_found' } }
  }
  if (sanitizeAgentName(name) !== name || isReservedName(name)) return { status: 404, body: { error: 'agent_not_found' } }
  const dir = join(agentsBaseDir(), name)
  let isDir = false
  try { isDir = lstatSync(dir).isDirectory() } catch { /* absent */ }
  // 7.2 / 4.2: a folder under a counting install marker is not an agent.
  if (!isDir || isHiddenByInstallMarker(name)) return { status: 404, body: { error: 'agent_not_found' } }
  const m = readPackageManifest(dir)
  if (m.state === 'none') return { status: 404, body: { error: 'not_a_package' } }
  if (m.state === 'unreadable') return { status: 409, body: { error: 'manifest_unreadable' } }
  const installedFiles = installedFileHashes(m.manifest)
  if (installedFiles === null) return { status: 409, body: { error: 'manifest_unreadable' } }
  return { name, dir, manifest: m.manifest, installedFiles }
}

/** 6.2: the same gates as the install's steps 5-8 (credential, keys, the catalog kid, download, verify, minimum). */
async function downloadVerified(slug: string, deps: PackageDeps): Promise<{ ok: true; pkg: VerifiedPackage } | { ok: false; answer: Answer }> {
  const ownVersion = currentVersion()
  if (parseVersion(ownVersion) === null) return { ok: false, answer: { status: 500, body: { error: 'own_version_unknown' } } }
  if (!hasCredential()) return { ok: false, answer: { status: 409, body: { error: 'not_connected' } } }
  if (deps.keys.length === 0 || !deps.remote.configured()) return { ok: false, answer: { status: 502, body: { error: 'download_failed', reason: 'not_configured' } } }
  const cat = await deps.remote.catalog({ fetchImpl: deps.fetchImpl, now: deps.now })
  if (!cat.ok) return { ok: false, answer: cat.refusal }
  const entry = catalogEntry(cat.catalog, slug)
  if (entry === null) return { ok: false, answer: { status: 404, body: { error: 'package_not_found' } } }
  if (typeof entry.kid !== 'string' || !deps.keys.some((k) => k.kid === entry.kid)) return { ok: false, answer: { status: 409, body: { error: 'unknown_kid' } } }
  const dl = await deps.remote.download(slug, ownVersion, { fetchImpl: deps.fetchImpl, now: deps.now })
  if (!dl.ok) return { ok: false, answer: dl.refusal }
  const v = verifyDelivery(dl.bytes, slug, deps.keys)
  if (!v.ok) return { ok: false, answer: { status: 422, body: { error: 'package_rejected', step: v.step, reason: v.reason, ...(v.detail ? { detail: v.detail } : {}) } } }
  if (!meetsMinMarveenVersion(ownVersion, v.pkg.minMarveenVersion)) {
    return { ok: false, answer: { status: 409, body: { error: 'incompatible', minMarveenVersion: v.pkg.minMarveenVersion } } }
  }
  return { ok: true, pkg: v.pkg }
}

/** Inside the queue: the record read again, the kind, the change list (8.1, 8.2). */
function listNow(name: string, pkg: VerifiedPackage, quarantine: boolean): { ok: true; list: ChangeList; at: Installed } | { ok: false; answer: Answer } {
  const at = installedPackageOf(name)
  if (!('manifest' in at)) return { ok: false, answer: at }
  if (at.manifest.payload.slug !== pkg.slug) return { ok: false, answer: { status: 409, body: { error: 'manifest_unreadable' } } }
  const installed = { version: at.manifest.payload.version, payloadSha256: at.manifest.payloadSha256 }
  let k
  try {
    k = classifyVersion(installed, { version: pkg.version, payloadSha256: pkg.payloadSha256 })
  } catch {
    return { ok: false, answer: { status: 409, body: { error: 'manifest_unreadable' } } }
  }
  if (!k.ok) {
    return { ok: false, answer: k.error === 'downgrade_refused'
      ? { status: 409, body: { error: 'downgrade_refused', installed: installed.version, available: pkg.version } }
      : { status: 409, body: { error: 'version_conflict' } } }
  }
  const list = computeChangeList({ name, agentDir: at.dir, manifest: at.manifest, installedFiles: at.installedFiles, pkg, kind: k.kind, quarantine })
  return { ok: true, list, at }
}

/** The body of check: empty or {} (6.2). */
function isEmptyBody(raw: Buffer): boolean {
  const t = raw.toString('utf8').trim()
  if (t === '') return true
  try {
    const v = JSON.parse(t)
    return v !== null && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0
  } catch {
    return false
  }
}

/** The body of apply: exactly {planId, decisions} with a 64-hex planId (6.3); the decisions are checked later. */
function applyBody(raw: Buffer): { planId: string; decisions: unknown } | null {
  let v: unknown
  try {
    v = JSON.parse(raw.toString('utf8'))
  } catch {
    return null
  }
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null
  const o = v as Record<string, unknown>
  const keys = Object.keys(o).sort()
  if (keys.length !== 2 || keys[0] !== 'decisions' || keys[1] !== 'planId') return null
  if (typeof o.planId !== 'string' || !/^[0-9a-f]{64}$/.test(o.planId)) return null
  return { planId: o.planId, decisions: o.decisions }
}

/** POST /api/agents/:name/package/check (6.2): downloads and verifies, writes nothing. */
async function checkUpdate(ctx: RouteContext, deps: PackageDeps, rawName: string): Promise<void> {
  const { req, res } = ctx
  if (!mayActAsOwner(ctx.auth, req)) { refuseOwner(res); return }
  const raw = await readBodyOrRefuse(req, res, { maxBytes: BODY_MAX_BYTES })
  if (raw === null) return
  if (!isEmptyBody(raw)) { json(res, BAD_REQUEST, 400); return }
  const first = installedPackageOf(rawName)
  if (!('manifest' in first)) { json(res, first.body, first.status); return }
  const got = await downloadVerified(first.manifest.payload.slug, deps)
  if (!got.ok) { json(res, got.answer.body, got.answer.status); return }
  // M30: the switch read ONCE per call; 8.4: the disk hashes read in the queue, never a half-written state.
  const quarantine = quarantineOn()
  const out = await serializeSkillsDir(() => {
    const l = listNow(first.name, got.pkg, quarantine)
    if (!l.ok) return l
    return { ...l, shellRepair: l.list.kind === 'repair' ? shellRepairState(l.at.dir) : undefined }
  })
  if (!out.ok) { json(res, out.answer.body, out.answer.status); return }
  const skillReport = updateSkillReport(got.pkg, quarantine, out.list.skillFolders)
  const trace = readUpdatingTrace(first.name)
  json(res, {
    ...out.list,
    globalNameCollisions: skillReport.globalNameCollisions,
    skillReport,
    ...(out.shellRepair ? { shellRepair: out.shellRepair } : {}),
    ...(trace ? { interruptedUpdate: trace } : {}),
  })
}

/** POST /api/agents/:name/package/apply (6.3): downloads again, then ONE synchronous block in the queue. */
async function applyUpdate(ctx: RouteContext, deps: PackageDeps, rawName: string): Promise<void> {
  const { req, res } = ctx
  if (!mayActAsOwner(ctx.auth, req)) { refuseOwner(res); return }
  const raw = await readBodyOrRefuse(req, res, { maxBytes: BODY_MAX_BYTES })
  if (raw === null) return
  const body = applyBody(raw)
  if (body === null) { json(res, BAD_REQUEST, 400); return }
  const first = installedPackageOf(rawName)
  if (!('manifest' in first)) { json(res, first.body, first.status); return }
  if (applying.has(first.name)) { json(res, { error: 'update_in_progress' }, 409); return }
  applying.add(first.name)
  try {
    const got = await downloadVerified(first.manifest.payload.slug, deps)
    if (!got.ok) { json(res, got.answer.body, got.answer.status); return }
    const quarantine = quarantineOn()
    const driveFolder = String(getEffectiveSettingValue('OWNER_DRIVE_FOLDER') || '')
    const lang = agentTextLang()
    const now = deps.now()
    const out = await serializeSkillsDir((): { ok: true; kind: string; keptMine: string[]; applied: Record<string, number> } | { ok: false; answer: Answer } => {
      const l = listNow(first.name, got.pkg, quarantine)
      if (!l.ok) return l
      if (l.list.planId !== body.planId) return { ok: false, answer: { status: 409, body: { error: 'plan_changed', plan: l.list } } }
      const d = checkDecisions(l.list, body.decisions)
      if (!d.ok) return { ok: false, answer: { status: d.status, body: d.body } }
      const r = runApplyBlock({ name: l.at.name, agentDir: l.at.dir, list: l.list, ops: d.ops, pkg: got.pkg, manifest: l.at.manifest, installedFiles: l.at.installedFiles, driveFolder, lang, now })
      if (!r.ok) {
        if (r.body.error === 'plan_changed') {
          // D2: the disk moved inside the block; the new list goes with the refusal, as for a planId mismatch.
          const again = listNow(first.name, got.pkg, quarantine)
          return { ok: false, answer: { status: 409, body: again.ok ? { error: 'plan_changed', plan: again.list } : again.answer.body } }
        }
        return { ok: false, answer: { status: r.status, body: r.body } }
      }
      return { ok: true, kind: l.list.kind, keptMine: d.keptMine, applied: r.applied }
    })
    if (!out.ok) { json(res, out.answer.body, out.answer.status); return }
    // N18/e: the audit lines are written on a successful apply (the check writes none).
    try { packageSkillReport(first.name, got.pkg, now) } catch (err) { logger.warn({ err, name: first.name }, 'agent package update: the skill audit did not run') }
    json(res, { ok: true, kind: out.kind, version: got.pkg.version, applied: out.applied, keptMine: out.keptMine })
  } finally {
    applying.delete(first.name)
  }
}

export async function tryHandleAgentPackages(ctx: RouteContext, deps: PackageDeps = RELEASED_DEPS): Promise<boolean> {
  const { req, res, path, method } = ctx

  if (path === CREDENTIAL_PATH && method === 'GET') {
    if (!mayActAsOwner(ctx.auth, req)) { refuseOwner(res); return true }
    // MIOAGENTB4-1122 (Marveen 84855): `configured` is the condition every outgoing call answers not_configured on.
    // While it is false the dashboard shows neither the menu item nor the connect box.
    json(res, { ...readCredentialView(), configured: deps.remote.configured() })
    return true
  }

  if (path === CREDENTIAL_PATH && method === 'POST') {
    if (!mayActAsOwner(ctx.auth, req)) { refuseOwner(res); return true }
    const raw = await readBodyOrRefuse(req, res, { maxBytes: BODY_MAX_BYTES })
    if (raw === null) return true
    const code = codeFromBody(raw)
    if (code === null) { json(res, BAD_REQUEST, 400); return true }
    const r = await deps.remote.redeem(code, { fetchImpl: deps.fetchImpl, now: deps.now })
    if (!r.ok) { json(res, r.refusal.body, r.refusal.status); return true }
    json(res, { ...r.view, replaced: r.replaced, replacedDeviceTokenId: r.replacedDeviceTokenId })
    return true
  }

  if (path === CREDENTIAL_PATH && method === 'DELETE') {
    if (!mayActAsOwner(ctx.auth, req)) { refuseOwner(res); return true }
    try {
      deleteCredential()
    } catch {
      json(res, { error: 'credential_delete_failed' }, 500)
      return true
    }
    json(res, { ok: true, connected: false, remoteRevoked: false })
    return true
  }

  if (path === CATALOG_PATH && method === 'GET') {
    if (!mayActAsOwner(ctx.auth, req)) { refuseOwner(res); return true }
    const r = await deps.remote.catalog({ fetchImpl: deps.fetchImpl, now: deps.now })
    if (!r.ok) { json(res, r.refusal.body, r.refusal.status); return true }
    // MIOAGENTB4-1122 (Samu D2): the kids this build accepts, BESIDE the unchanged body, so the dashboard can lock a
    // card before a download. Public key ids, not secrets; the server still refuses on its own (5b). The origin is the
    // only place the dashboard loads a package picture from (Samu, extra 1); the own version locks a card whose minimum
    // is higher (the publishing side refuses that download before a trial pick too, so this is a convenience).
    json(res, { catalog: r.catalog, knownKids: deps.keys.map((k) => k.kid), origin: deps.remote.origin(), marveenVersion: currentVersion() })
    return true
  }

  if (path === INSTALL_PATH && method === 'POST') {
    await installPackage(ctx, deps)
    return true
  }

  const upd = UPDATE_PATH_RE.exec(path)
  if (upd !== null) {
    if (method !== 'POST') { methodNotAllowed(res, method, ['POST']); return true }
    if (upd[2] === 'check') await checkUpdate(ctx, deps, upd[1])
    else await applyUpdate(ctx, deps, upd[1])
    return true
  }

  if (path === CREDENTIAL_PATH) { methodNotAllowed(res, method, ['GET', 'POST', 'DELETE']); return true }
  if (path === INSTALL_PATH) { methodNotAllowed(res, method, ['POST']); return true }
  if (path === CATALOG_PATH) { methodNotAllowed(res, method, ['GET']); return true }
  return false
}
