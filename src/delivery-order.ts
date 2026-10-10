// Card ad771121: the delivery order of pending inter-agent rows -- high priority first, then FIFO
// (created_at, with the id breaking a same-second tie). One definition for the re-sorts in db.ts and
// for the router; a pure module, so a test that mocks db.js still gets the real comparison.
export interface DeliveryOrderKey {
  id: number
  created_at: number
  priority?: number | null
}

export function compareDeliveryOrder(a: DeliveryOrderKey, b: DeliveryOrderKey): number {
  return ((b.priority ?? 0) - (a.priority ?? 0)) || (a.created_at - b.created_at) || (a.id - b.id)
}
