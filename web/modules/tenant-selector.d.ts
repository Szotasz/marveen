/**
 * Insert a tenant-filter <select> into the element identified by containerId.
 * Only renders for global admin sessions (role=admin, tenant_id=null).
 *
 * @returns a getter `() => string | null` for the selected tenantId,
 *          or null if the caller is not a global admin.
 */
export function initTenantSelector(
  containerId: string,
  onChange: (tenantId: string | null) => void,
): Promise<(() => string | null) | null>
