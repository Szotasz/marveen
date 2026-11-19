// Agent package credential and catalog (MIOAGENTINSTALL1114, PR-I2; plan 6, 6.4, 6.5).
//
//   GET    /api/agent-packages/credential  -> {connected:false} | {connected:true, label, deviceTokenId, connectedAt}
//   POST   /api/agent-packages/credential  {code:"PPPP-SSSSSSSS"} -> the GET shape + replaced, replacedDeviceTokenId
//   DELETE /api/agent-packages/credential  -> {ok:true, connected:false, remoteRevoked:false}
//   GET    /api/agent-packages/catalog     -> {catalog: <the publishing side's body>}
//   POST   /api/agents/install-package     {slug} -> {ok, name, version, modelHintApplied, skillReport} (PR-I3, plan 6.1)
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
import { meetsMinMarveenVersion, parseVersion, verifyDelivery, type Jwk } from '../agent-package/verify.js'
import { STRICT_SLUG_RE, agentsBaseDir, isReservedName, markerPathOf } from '../agent-package/marker.js'
import {
  flushPendingPackageNotices, packageSkillReport, readPackageManifest, reapInterruptedPackageInstalls, runInstallBlock, sameDeviceLayout,
} from '../agent-package/install.js'
import { sanitizeAgentName } from '../sanitize.js'
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
function slugFromBody(raw: Buffer): string | null {
  let v: unknown
  try {
    v = JSON.parse(raw.toString('utf8'))
  } catch {
    return null
  }
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null
  const keys = Object.keys(v)
  if (keys.length !== 1 || keys[0] !== 'slug') return null
  const slug = (v as { slug: unknown }).slug
  return typeof slug === 'string' ? slug : null
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
  const slug = slugFromBody(raw)
  if (slug === null) { json(res, BAD_REQUEST, 400); return }
  if (!STRICT_SLUG_RE.test(slug) || sanitizeAgentName(slug) !== slug) { json(res, { error: 'invalid_slug' }, 400); return }
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
    const r = runInstallBlock({ name: slug, pkg, model, driveFolder, lang, now })
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

export async function tryHandleAgentPackages(ctx: RouteContext, deps: PackageDeps = RELEASED_DEPS): Promise<boolean> {
  const { req, res, path, method } = ctx

  if (path === CREDENTIAL_PATH && method === 'GET') {
    if (!mayActAsOwner(ctx.auth, req)) { refuseOwner(res); return true }
    json(res, readCredentialView())
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
    json(res, { catalog: r.catalog })
    return true
  }

  if (path === INSTALL_PATH && method === 'POST') {
    await installPackage(ctx, deps)
    return true
  }

  if (path === CREDENTIAL_PATH) { methodNotAllowed(res, method, ['GET', 'POST', 'DELETE']); return true }
  if (path === INSTALL_PATH) { methodNotAllowed(res, method, ['POST']); return true }
  if (path === CATALOG_PATH) { methodNotAllowed(res, method, ['GET']); return true }
  return false
}
