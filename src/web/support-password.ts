// The support password bucket of this dashboard: one per machine, kept in the
// database (support-password-gate.ts says why). Its own module so that the
// login route (routes/auth.ts) can end its locks without importing the support
// routes.
import { loadSupportPasswordStateRaw, saveSupportPasswordState } from '../db.js'
import { logger } from '../logger.js'
import { notifyOwner } from '../notify.js'
import {
  createSupportPasswordGate,
  normaliseSupportPasswordState,
  SUPPORT_PASSWORD_STATE_EMPTY,
  type SupportPasswordGate,
} from '../support-password-gate.js'

export const SUPPORT_HARD_LOCK_NOTICE =
  '⚠️ Support-hozzáférés: a bekapcsolásához ma háromszor zárolt a jelszó-ellenőrzés a sok rossz jelszó miatt. ' +
  'A bekapcsolás a következő dashboard-belépésedig zárva marad. Ha nem te próbálkoztál, változtasd meg a jelszavad.'

let gate: SupportPasswordGate | null = null

export function supportPasswordGate(): SupportPasswordGate {
  if (gate === null) {
    gate = createSupportPasswordGate({
      store: {
        load: () => {
          const raw = loadSupportPasswordStateRaw()
          return raw === undefined ? SUPPORT_PASSWORD_STATE_EMPTY : normaliseSupportPasswordState(raw)
        },
        save: (state) => saveSupportPasswordState(state),
      },
      now: () => Date.now(),
      alertHardLock: () => {
        logger.warn('support access: the password check is locked until the next owner login (third lock within 24 hours)')
        void notifyOwner(SUPPORT_HARD_LOCK_NOTICE).catch((err) => logger.warn({ err }, 'support access: the hard-lock notice was not sent'))
      },
    })
  }
  return gate
}
