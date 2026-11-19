// Support access: the detective reconcile (SUPPORTKULCS1109, PR1b 2b-3; terv-v7 3.8, Dani 32056 G1-G6,
// Samu 78359 Q1).
//
// Runs at the dashboard's start and once a day, only with the background
// services on. It never ADDS a line; it only takes away what no longer holds:
//
//   - neither token nor record: standby is off; any support line left in the
//     keys files goes (a crash between the steps of a disable, a hand edit);
//   - only one of them, or something at their paths that is not ours: a half
//     state nobody can trust: everything goes, as a disable (`tampered`);
//   - both: the consent row is copied from the record if the table lacks it
//     (Q1: an enabling made outside the dashboard); then sshd is asked again
//     (a setting changed since the enabling, e.g. PermitTunnel: the lines go,
//     `tampered`, and the owner is told); the kit must still verify and its
//     dispatcher be the path the record binds; the lines are reconciled to what
//     the record and THIS release's pins give (a deviant line goes, a missing
//     one is not written back); and marveen.io is asked with the self-probe;
//     when that changes nothing, the host key sshd offers is asked again and
//     sent (support-access-hostkey.ts, confirmed by a root-owned .pub): the
//     resend of an enable whose send did not get a 200, and the news of a
//     changed key. A missing or unconfirmed key is not sent; neither it nor a
//     failed send changes anything here; the log has the fingerprint only.
//
// token_revoked (G1-G6): only HTTP 401 with exactly {"error":"token_revoked"}
// takes the lines away (support-access-check.ts). Under the lock of the keys
// file the token is read again, and the lines go only if the token that got
// that answer is still the one in place (G3); then the token and the record go
// (G4: lines first). Every other answer changes nothing (G5). Each step is
// logged without the token.
//
// The window, stated: between two runs a changed setting is not seen; with
// the dashboard stopped, it is not seen until it starts again.
import { reconcileSupportLinesOnDisk, revokeSupportLinesIf } from './support-access-fs.js'
import { supportSelfProbe } from './support-access-check.js'
import { hostKeyFingerprint, sendSupportHostKey } from './support-access-hostkey.js'
import type { RedeemTransport } from './support-access-redeem.js'
import { readSupportToken, removeSupportToken } from './support-access-token.js'
import { readGroupRecord, removeGroupRecord, type SupportGroupRecord } from './support-group-record.js'
import { verifyKit } from './support-kit.js'
import { KIT_DISPATCHER_NAME } from './support-kit-sources.js'
import { disableSupportStandby, type StandbyDeps } from './support-standby-enable.js'
import { join } from 'node:path'

/** How the consent table's open rows are closed (the eight values of the plan; the reconcile uses three). */
export type ReconcileRevokedVia = 'tampered' | 'external' | 'replaced'

export interface ReconcileDeps {
  readonly standby: Pick<StandbyDeps, 'supportDir' | 'sshDir' | 'pins' | 'probeSshd' | 'readHostKey'>
  readonly transport: RedeemTransport
  readonly consents: {
    readonly has: (grantId: string) => boolean
    readonly insertFromRecord: (record: SupportGroupRecord) => void
    readonly revokeOpen: (via: ReconcileRevokedVia) => void
  }
  readonly notifyOwner: (text: string) => void
  /** One line per step; never the token. */
  readonly log: (event: string, fields?: Record<string, string | number>) => void
}

export type ReconcileOutcome =
  | 'off'
  | 'kept'
  | 'removed_half_state'
  | 'removed_sshd'
  | 'removed_kit'
  | 'removed_unpinned'
  | 'removed_token_revoked'
  | 'token_changed'
  | 'failed'

export const RECONCILE_NOTICE_REMOVED =
  '⚠️ Support-hozzáférés: a gépen a support-készenlétet kikapcsoltam, mert '
const REASON_TEXT: Record<'removed_half_state' | 'removed_sshd' | 'removed_kit' | 'removed_unpinned', string> = {
  removed_half_state: 'a támogatás fájljai félbemaradt vagy idegen állapotban voltak.',
  removed_sshd: 'az SSH-beállítás megváltozott, és már nem biztonságos a supporthoz.',
  removed_kit: 'a support-készlet megváltozott vagy hiányzik.',
  removed_unpinned: 'ez a kiadás már egyik kulcsát sem ismeri.',
}

export async function reconcileSupportStandby(deps: ReconcileDeps): Promise<ReconcileOutcome> {
  try {
    return await reconcileOnce(deps)
  } catch {
    deps.log('reconcile_failed')
    return 'failed'
  }
}

async function teardown(deps: ReconcileDeps, outcome: keyof typeof REASON_TEXT, via: ReconcileRevokedVia): Promise<ReconcileOutcome> {
  const done = await disableSupportStandby(deps.standby)
  deps.log('teardown', { outcome, ok: done.ok ? 1 : 0, removed_lines: done.removedLines })
  if (!done.ok) return 'failed'
  deps.consents.revokeOpen(via)
  deps.notifyOwner(RECONCILE_NOTICE_REMOVED + REASON_TEXT[outcome])
  return outcome
}

async function reconcileOnce(deps: ReconcileDeps): Promise<ReconcileOutcome> {
  const { supportDir, sshDir, pins } = deps.standby
  const pinnedBlobs = new Set(pins.keys.map((k) => k.pub))
  const token = readSupportToken(supportDir)
  const record = readGroupRecord(supportDir)

  if (token.kind === 'missing' && record.kind === 'missing') {
    const r = await reconcileSupportLinesOnDisk({ sshDir, pinnedBlobs, grant: null })
    deps.log('off', { removed_lines: r.removed })
    return 'off'
  }
  if (token.kind !== 'ok' || record.kind !== 'ok') return teardown(deps, 'removed_half_state', 'tampered')
  const rec = record.record

  // Q1: the table row follows the record (an enabling that did not go through the dashboard route).
  if (!deps.consents.has(rec.grantId)) {
    deps.consents.insertFromRecord(rec)
    deps.log('consent_row_copied')
  }

  const sshd = await deps.standby.probeSshd(pins.fromCidrs)
  if (!sshd.ok) return teardown(deps, 'removed_sshd', 'tampered')

  const kit = verifyKit({ supportDir })
  if (!kit.ok || kit.manifest.files[KIT_DISPATCHER_NAME] === undefined || join(kit.kitDir, KIT_DISPATCHER_NAME) !== rec.dispatchPath) {
    return teardown(deps, 'removed_kit', 'tampered')
  }

  // The keys of the group that THIS release still pins, by name and fingerprint.
  const keys = pins.keys.filter((p) => rec.keys.some((k) => k.name === p.name && k.fingerprint === p.fingerprint))
  if (keys.length === 0) return teardown(deps, 'removed_unpinned', 'replaced')
  const lines = await reconcileSupportLinesOnDisk({
    sshDir,
    pinnedBlobs,
    grant: { keys, fromCidrs: pins.fromCidrs, grantId: rec.grantId, consentVersion: rec.consentVersion, dispatchPath: rec.dispatchPath, sshd: sshd.version },
  })
  deps.log('lines', { kept: lines.kept, removed: lines.removed, missing: lines.missing })

  // G1-G6: the self-probe; only token_revoked changes anything.
  const verdict = await supportSelfProbe({ token: token.token, fingerprint: keys[0].fingerprint }, deps.transport)
  deps.log('self_probe', { verdict })
  if (verdict !== 'token_revoked') {
    const own = await deps.standby.readHostKey(sshd)
    if (own.kind !== 'ok') {
      deps.log(own.kind === 'missing' ? 'host_key_missing' : 'host_key_unverified')
    } else {
      const sent = await sendSupportHostKey({ token: token.token, hostKey: own.key }, deps.transport)
      deps.log('host_key', { fingerprint: hostKeyFingerprint(own.key), sent })
    }
    return 'kept'
  }
  const sameToken = (): boolean => {
    const now = readSupportToken(supportDir)
    return now.kind === 'ok' && now.token === token.token
  }
  const revoked = await revokeSupportLinesIf({ sshDir, pinnedBlobs }, sameToken)
  if (revoked.skipped) {
    deps.log('token_revoked_skipped')
    return 'token_changed'
  }
  deps.log('token_revoked_lines', { removed: revoked.removed })
  if (!sameToken()) {
    deps.log('token_revoked_token_changed')
    return 'token_changed'
  }
  removeSupportToken(supportDir)
  removeGroupRecord(supportDir)
  deps.consents.revokeOpen('external')
  deps.log('token_revoked_done')
  deps.notifyOwner('ℹ️ Support-hozzáférés: a gépet a marveen.io fiókban eltávolítottad, ezért a gépről is levettem a support-sorokat és a tokent.')
  return 'removed_token_revoked'
}
