/** Preserve the pre-delivery-ledger queue format while normalizing old files. */
export function normalizeCodexChannelState(raw) {
  const state = raw && typeof raw === 'object' && !Array.isArray(raw) ? {...raw} : {}
  if (!state.threads || typeof state.threads !== 'object' || Array.isArray(state.threads)) state.threads = {}
  if (!Array.isArray(state.pending)) state.pending = []
  return state
}

/** Persist each destination BEFORE removing the original. A repeated migration
 * reuses the same id, including if saving channels.json previously failed. */
export function migrateLegacyPending(state, recovery, save) {
  const original = state.pending
  for (const item of original) {
    const provenUnstarted = item?.queueVersion === 2 && item?.status === 'queued' &&
      item?.attemptCount === 0 && item?.startedAt == null
    recovery.prepareChannel(item, provenUnstarted)
  }
  const next = {...state, pending: []}
  save(next)
  state.pending = []
}
