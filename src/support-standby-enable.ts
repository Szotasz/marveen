// Support standby: switching it on (enable) and off (disable) on this machine.
//
// ENABLE runs ONLY as the kit's copy of the routine, started by the loader
// (support-kit-loader.ts), never as the copy in the install tree: what opens
// access must not depend on a tree that may be half updated. The one-time code
// comes on standard input, never in an argument. The steps, in this order, and
// nothing is written before every check has passed:
//
//   1. the code has the shape of a support code (no network yet);
//   2. the pins of this release are set and valid;
//   3. standby is not on already: no token and no record (Dani's review of
//      #2779, F1: a second enable would redeem a second code and overwrite
//      the token; switch off first);
//   4. sshd is asked (root, or the non-root proof), and must answer `ok`;
//      then its ed25519 host key is asked with ssh-keyscan (support-access-hostkey.ts):
//      none, or not exactly one, is host_key_missing; one that no root-owned
//      .pub file confirms is host_key_unverified (Dani 79778);
//   5. the kit is verified, and its manifest names the dispatcher: the lines
//      bind that path (Dani 78357, Q3: the kit is checked before any line);
//   6. the keys files are laid out so that a grant can keep them right (the
//      grant checks again under its lock; F2: a layout it would refuse must
//      not cost the code);
//   7. the code is redeemed for the narrow token;
//   8. the token, 9. the group record, 10. the lines are written;
//  11. the host key is sent to marveen.io with the token. Only 200 is "stored";
//      any other answer does not stop the enable: the daily reconcile sends it again.
//
// If 8-10 fail, everything that was written goes again (the lines, the record,
// the token), and the answer is the failure.
//
// DISABLE works from the tree too, without a kit: lines first (a removal
// never stops on how the keys files are laid out), then the token and the
// record, then the pid files of running dispatchers (each stops its subcommand
// when its file goes). It reports success only when lines, token and record are gone.
//
// Until the real dispatcher exists (PR1c) the kit carries a placeholder that
// refuses every start, so an enabled standby opens no login (Dani 78357, Q3).
import { join } from 'node:path'
import { grantSupportLines, keysFileLayout, revokeSupportLines, SupportKeysLayoutError } from './support-access-fs.js'
import { SupportLineError } from './support-access-line.js'
import { validateSupportPins, type SupportKeyPin } from './support-access-pins.js'
import { classifySupportCode, redeemSupportCode, type RedeemProblem, type RedeemTransport, type SupportCodeProblem } from './support-access-redeem.js'
import type { SshdAssessment, SshdProblem } from './support-access-sshd.js'
import { readSupportToken, removeSupportToken, writeSupportToken } from './support-access-token.js'
import { readGroupRecord, removeGroupRecord, stopRunningDispatchers, writeGroupRecord } from './support-group-record.js'
import { verifyKit, type KitProblem } from './support-kit.js'
import { sendSupportHostKey, type HostKeySendResult, type OwnHostKey } from './support-access-hostkey.js'
import { KIT_DISPATCHER_NAME } from './support-kit-sources.js'

export interface StandbyDeps {
  /** The support folder: the kit, the token and the record live here. */
  readonly supportDir: string
  /** The login user's .ssh folder (from the user database). */
  readonly sshDir: string
  readonly pins: { readonly keys: readonly SupportKeyPin[]; readonly fromCidrs: readonly string[] }
  readonly probeSshd: (fromCidrs: readonly string[]) => Promise<SshdAssessment>
  /** The ed25519 host key sshd offers on its first port, confirmed by a root-owned .pub (readOwnHostKey). Never rejects. */
  readonly readHostKey: (sshd: { readonly listenPorts: readonly number[]; readonly hostKeyFiles: readonly string[] }) => Promise<OwnHostKey>
  readonly redeemTransport: RedeemTransport
  readonly now: () => Date
  readonly newGrantId: () => string
  /** True only for the kit's copy of the routine, started by the loader. */
  readonly startedFromKit: boolean
}

export type EnableProblem =
  | 'enable_not_from_kit'
  | SupportCodeProblem
  | 'consent_invalid'
  | 'support_keys_unset'
  | 'support_from_unset'
  | 'support_pins_invalid'
  | 'already_on'
  | SshdProblem
  | 'host_key_missing'
  | 'host_key_unverified'
  | KitProblem
  | RedeemProblem
  | 'keys_file_layout'
  | 'enable_write_failed'

export type EnableResult =
  | { readonly ok: true; readonly keys: readonly string[]; readonly lines: number; readonly hostKey: HostKeySendResult }
  | { readonly ok: false; readonly problem: EnableProblem }

/** The highest consent version this release knows; a newer one is refused (the owner saw text this build cannot show). */
export const SUPPORT_CONSENT_VERSION = 2

function utcSecond(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z')
}

export async function enableSupportStandby(input: { readonly code: unknown; readonly consentVersion: unknown }, deps: StandbyDeps): Promise<EnableResult> {
  const no = (problem: EnableProblem): EnableResult => ({ ok: false, problem })
  if (!deps.startedFromKit) return no('enable_not_from_kit')
  const code = classifySupportCode(input.code)
  if (!code.ok) return no(code.problem)
  if (input.consentVersion !== SUPPORT_CONSENT_VERSION) return no('consent_invalid')
  const { keys, fromCidrs } = deps.pins
  // the pins' own answer: no key, no source address, or malformed (Geri 78991: the source address was reported as no key)
  const pins = validateSupportPins(keys, fromCidrs)
  if (!pins.ok) return no(pins.code)
  if (readSupportToken(deps.supportDir).kind !== 'missing' || readGroupRecord(deps.supportDir).kind !== 'missing') return no('already_on')

  const sshd = await deps.probeSshd(fromCidrs)
  if (!sshd.ok) return no(sshd.problem)
  const own = await deps.readHostKey(sshd)
  if (own.kind !== 'ok') return no(own.kind === 'missing' ? 'host_key_missing' : 'host_key_unverified')
  const hostKey = own.key
  const kit = verifyKit({ supportDir: deps.supportDir })
  if (!kit.ok) return no(kit.problem)
  if (kit.manifest.files[KIT_DISPATCHER_NAME] === undefined) return no('kit_mismatch')
  const dispatchPath = join(kit.kitDir, KIT_DISPATCHER_NAME)
  const layout = keysFileLayout(deps.sshDir)
  if (layout === 'link-elsewhere' || layout === 'hard-link') return no('keys_file_layout')

  const redeemed = await redeemSupportCode(code.code, { transport: deps.redeemTransport })
  if (!redeemed.ok) return no(redeemed.problem)

  const pinnedBlobs = new Set(keys.map((k) => k.pub))
  const grantId = deps.newGrantId()
  const sortedKeys = [...keys].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  try {
    writeSupportToken(deps.supportDir, redeemed.token)
    writeGroupRecord(deps.supportDir, {
      grantId,
      consentVersion: SUPPORT_CONSENT_VERSION,
      consentAt: utcSecond(deps.now()),
      keys: sortedKeys.map((k) => ({ name: k.name, fingerprint: k.fingerprint })),
      fromCidrs: [...fromCidrs],
      dispatchPath,
      sshd: sshd.version,
    })
    await grantSupportLines({
      sshDir: deps.sshDir,
      pinnedBlobs,
      grant: { keys: sortedKeys, fromCidrs, grantId, consentVersion: SUPPORT_CONSENT_VERSION, dispatchPath, sshd: sshd.version },
    })
  } catch (err) {
    // Take back whatever was written, each step on its own: one failure must not keep the others in place.
    try {
      await revokeSupportLines({ sshDir: deps.sshDir, pinnedBlobs })
    } catch {
      /* the answer below is a failure anyway; the reconcile takes out what is left */
    }
    try {
      removeGroupRecord(deps.supportDir)
    } catch {
      /* as above */
    }
    try {
      removeSupportToken(deps.supportDir)
    } catch {
      /* as above */
    }
    if (err instanceof SupportKeysLayoutError) return no('keys_file_layout')
    if (err instanceof SupportLineError) return no('support_pins_invalid')
    return no('enable_write_failed')
  }
  // Outside the try: a failed send must not take back what was written.
  const sent = await sendSupportHostKey({ token: redeemed.token, hostKey }, deps.redeemTransport)
  return { ok: true, keys: sortedKeys.map((k) => k.name), lines: sortedKeys.length, hostKey: sent }
}

export type DisableResult =
  | { readonly ok: true; readonly removedLines: number }
  | { readonly ok: false; readonly problem: 'lines_remain' | 'token_remains' | 'record_remains'; readonly removedLines: number }

/** Take support access off this machine: the lines, then the token, then the record. Never stops at the first failure. */
export async function disableSupportStandby(deps: Pick<StandbyDeps, 'supportDir' | 'sshDir' | 'pins'>): Promise<DisableResult> {
  const pinnedBlobs = new Set(deps.pins.keys.map((k) => k.pub))
  let removedLines = 0
  let linesFailed = false
  try {
    removedLines = (await revokeSupportLines({ sshDir: deps.sshDir, pinnedBlobs })).removed
  } catch {
    linesFailed = true
  }
  let tokenFailed = false
  try {
    removeSupportToken(deps.supportDir)
  } catch {
    tokenFailed = true
  }
  let recordFailed = false
  try {
    removeGroupRecord(deps.supportDir)
  } catch {
    recordFailed = true
  }
  // A running subcommand (a `run` above all) stops at once: its pid file goes. The token is
  // gone already, which stops it too; this is the second, independent signal (D4).
  try {
    stopRunningDispatchers(deps.supportDir)
  } catch {
    // an unreadable run folder: the missing token still stops every dispatcher
  }
  if (linesFailed) return { ok: false, problem: 'lines_remain', removedLines }
  if (tokenFailed) return { ok: false, problem: 'token_remains', removedLines }
  if (recordFailed) return { ok: false, problem: 'record_remains', removedLines }
  return { ok: true, removedLines }
}
