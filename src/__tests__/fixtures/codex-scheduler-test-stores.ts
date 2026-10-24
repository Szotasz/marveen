import { CodexDeliveryStore } from '../../codex-delivery.js'
import { DeliveryRecoveryStore } from '../../codex-recovery.js'

/** Explicit throwaway stores for scheduler tests, even when Codex mode is inherited. */
export function createCodexSchedulerTestStores() {
  const dbPath = ':memory:'
  const codexDeliveryStore = new CodexDeliveryStore(dbPath)
  const deliveryRecoveryStore = new DeliveryRecoveryStore(dbPath)
  return {
    codexDeliveryStore,
    deliveryRecoveryStore,
    close() {
      deliveryRecoveryStore.close()
      codexDeliveryStore.close()
    },
  }
}
