// Support access on the dashboard's side, outside a request (SUPPORTKULCS1109, PR1b 2b-3):
//   - the reconcile at the start and once a day (only with the background services on);
//   - takeSupportAccessDown(via): the one teardown the security events call (terv-v7 3.9): a security reset, a
//     password change, a dashboard user's removal. It removes the lines, the token and the record, and closes the
//     open consent rows with the reason; when something stays, the owner is told.
import { getDb, insertSupportConsent, revokeOpenSupportConsents, type SupportRevokedVia } from '../db.js'
import { logger } from '../logger.js'
import { notifyOwner } from '../notify.js'
import { createHttpsRedeemTransport, type RedeemTransport } from '../support-access-redeem.js'
import { reconcileSupportStandby, type ReconcileOutcome } from '../support-reconcile.js'
import { createStandbyDeps } from '../support-standby-cli.js'
import { disableSupportStandby, type DisableResult, type StandbyDeps } from '../support-standby-enable.js'
import { withSupportStandbyLock } from './support-standby-lock.js'
import { countSupportLines } from '../support-access-line.js'
import { SUPPORT_CONSENT_LAUNCHER_LANG, supportConsentSha256 } from '../support-consent-text.js'
import type { SupportGroupRecord } from '../support-group-record.js'
import { lstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export const SUPPORT_RECONCILE_EVERY_MS = 24 * 60 * 60 * 1000

/**
 * The consent row the reconcile writes for an enabling that has none (Samu 78359, Q1), copied from the group record:
 * with the sha256 of the RECORDED version's approved text in the launcher's language (that enabling came from the
 * launcher), NULL when that version has none.
 */
export function insertConsentFromRecord(r: Pick<SupportGroupRecord, 'grantId' | 'consentVersion' | 'consentAt' | 'keys'>): void {
  insertSupportConsent({
    grantId: r.grantId,
    consentVersion: r.consentVersion,
    // the launcher's enabling: the owner saw the launcher's (Hungarian) text
    consentLang: SUPPORT_CONSENT_LAUNCHER_LANG,
    consentSha256: supportConsentSha256(r.consentVersion, SUPPORT_CONSENT_LAUNCHER_LANG),
    consentAt: r.consentAt,
    locale: null,
    keyNames: r.keys.map((k) => k.name),
    createdVia: 'command',
    actor: 'reconcile',
  })
}
/** The first run waits a little after the start, so it does not compete with the start itself. */
export const SUPPORT_RECONCILE_FIRST_DELAY_MS = 60 * 1000

const tell = (text: string): void => {
  void notifyOwner(text).catch((err) => logger.warn({ err }, 'support access: a notice to the owner was not sent'))
}

/** `over` is for tests: another machine's folders and a fake service; the real run passes nothing. */
export async function runSupportReconcile(over: { standby?: StandbyDeps; transport?: RedeemTransport } = {}): Promise<ReconcileOutcome> {
  let standby
  try {
    standby = over.standby ?? createStandbyDeps()
  } catch {
    logger.warn('support access: reconcile skipped, the login user is not known')
    return 'failed'
  }
  const outcome = await withSupportStandbyLock(() => reconcileSupportStandby({
    standby,
    transport: over.transport ?? createHttpsRedeemTransport(),
    consents: {
      has: (grantId) => getDb().prepare('SELECT 1 FROM support_consents WHERE grant_id = ?').get(grantId) !== undefined,
      insertFromRecord: insertConsentFromRecord,
      revokeOpen: (via) => {
        revokeOpenSupportConsents(via)
      },
    },
    notifyOwner: tell,
    log: (event, fields) => logger.info({ ...(fields ?? {}), event }, 'support access: reconcile'),
  }))
  logger.info({ outcome }, 'support access: reconcile done')
  return outcome
}

/** Start the reconcile: once shortly after the start, then every day. The timers do not keep the process alive. */
export function startSupportReconcile(): { stop: () => void } {
  let running = false
  const run = (): void => {
    if (running) return
    running = true
    void runSupportReconcile()
      .catch(() => 'failed')
      .finally(() => {
        running = false
      })
  }
  const first = setTimeout(run, SUPPORT_RECONCILE_FIRST_DELAY_MS)
  const every = setInterval(run, SUPPORT_RECONCILE_EVERY_MS)
  first.unref()
  every.unref()
  return {
    stop: () => {
      clearTimeout(first)
      clearInterval(every)
    },
  }
}

export type TeardownVia = Extract<SupportRevokedVia, 'security_reset' | 'password_change' | 'user_delete'>

/**
 * Is there anything of support access on this machine? The support folder, or a support line in a keys file (read
 * only). Without either there is nothing to take down, and the keys files are not even locked: a password change on
 * a machine that never had support must not rewrite or lock anything under ~/.ssh (nor in a test run).
 */
export function hasSupportState(deps: Pick<StandbyDeps, 'supportDir' | 'sshDir' | 'pins'>): boolean {
  try {
    lstatSync(deps.supportDir)
    return true
  } catch {
    /* no folder: look at the keys files */
  }
  const pinned = new Set(deps.pins.keys.map((k) => k.pub))
  for (const name of ['authorized_keys', 'authorized_keys2']) {
    try {
      if (countSupportLines(readFileSync(join(deps.sshDir, name), 'latin1'), pinned) > 0) return true
    } catch {
      /* missing or unreadable: the disable would report it; nothing to find here */
    }
  }
  return false
}

/** The one teardown of the security events. Never throws; the answer says what stayed. */
export async function takeSupportAccessDown(via: TeardownVia): Promise<DisableResult | null> {
  let deps: StandbyDeps
  try {
    deps = createStandbyDeps()
  } catch {
    logger.warn({ via }, 'support access: teardown skipped, the login user is not known')
    return null
  }
  return withSupportStandbyLock(() => takeSupportAccessDownWith(deps, via))
}

/** takeSupportAccessDown with the machine's dependencies handed in (tests). */
export async function takeSupportAccessDownWith(deps: Pick<StandbyDeps, 'supportDir' | 'sshDir' | 'pins'>, via: TeardownVia): Promise<DisableResult | null> {
  if (!hasSupportState(deps)) return { ok: true, removedLines: 0 }
  let done: DisableResult
  try {
    done = await disableSupportStandby(deps)
  } catch {
    logger.warn({ via }, 'support access: teardown failed')
    return null
  }
  if (done.ok) {
    // Never throws (Samu's review of #2786, N1): a failed row update is logged, the machine is already clean.
    let closed = 0
    try {
      closed = revokeOpenSupportConsents(via)
    } catch {
      logger.warn({ via }, 'support access: taken down, but the consent rows could not be closed')
    }
    if (done.removedLines > 0 || closed > 0) logger.info({ via, removedLines: done.removedLines, closed }, 'support access: taken down')
  } else {
    logger.warn({ via, problem: done.problem }, 'support access: teardown incomplete')
    tell('⚠️ Support-hozzáférés: egy biztonsági művelet után (' + via + ') a support-készenlétet nem sikerült teljesen levenni (' + done.problem + '). Kapcsold ki a dashboardon, vagy szólj.')
  }
  return done
}
