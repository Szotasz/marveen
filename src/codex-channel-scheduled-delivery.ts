import { scheduledCodexIdentity, type CodexDeliveryStore } from './codex-delivery.js'

export interface ScheduledDeliveryRequest {
  type: 'scheduled_delivery'
  taskId: string
  agentId: string
  scheduledOccurrence: number
  deliveryId: string
  idempotencyKey: string
  prompt: string
  queuedAt?: number
  late?: boolean
}

export function acceptScheduledDelivery(store: CodexDeliveryStore, request: ScheduledDeliveryRequest) {
  try {
    if (!request || request.type !== 'scheduled_delivery' || typeof request.prompt !== 'string' || !request.prompt.trim()) {
      throw new Error('Invalid scheduled delivery request')
    }
    const identity = scheduledCodexIdentity(request.taskId, request.agentId, request.scheduledOccurrence)
    if (identity.deliveryId !== request.deliveryId || identity.idempotencyKey !== request.idempotencyKey) {
      throw new Error('Scheduled Codex delivery identity mismatch')
    }
    const result = store.prepare({
      taskId: request.taskId, agentId: request.agentId, scheduledOccurrence: request.scheduledOccurrence,
      prompt: request.prompt, queuedAt: request.queuedAt, late: request.late,
      deliveryId: request.deliveryId, idempotencyKey: request.idempotencyKey,
    })
    return { ok: true as const, created: result.created, deliveryId: result.delivery.deliveryId,
      idempotencyKey: result.delivery.idempotencyKey, scheduledOccurrence: result.delivery.scheduledOccurrence,
      status: result.delivery.status }
  } catch (error) {
    return { ok: false as const, error: error instanceof Error ? error.message : 'Invalid scheduled delivery request' }
  }
}
