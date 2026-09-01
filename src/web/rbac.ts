// RBAC model: roles, permissions, and endpoint-to-permission mapping.
//
// This module is the single source of truth for access-control decisions.
// The authorization middleware resolves a role from the auth result
// and then calls hasPermission() to check if the request is allowed.
//
// Design constraints:
// - Fail-closed: unknown permission or role -> deny.
// - Admin role is the only cross-tenant role; all others are tenant-scoped.
// - The current store/.dashboard-token bearer maps to the 'admin' role via
//   the backward-compat fallback in auth-gate.ts (no code change needed there
//   until the api_tokens table is populated (token-management step).

// ── Roles ──────────────────────────────────────────────────────────────────

export type Role = 'admin' | 'agent' | 'read_only' | 'viewer'

export const ALL_ROLES: readonly Role[] = ['admin', 'agent', 'read_only', 'viewer']

// ── Permissions ────────────────────────────────────────────────────────────

// Each permission maps to one or more HTTP operations on a resource group.
// Naming: <resource>:<action>  -- kebab-case resource, colon separator.
export type Permission =
  | 'memories:read'
  | 'memories:write'
  | 'kanban:read'
  | 'kanban:write'
  | 'agents:read'
  | 'messages:write'
  | 'approvals:read'
  | 'approvals:write'
  | 'blackboard:read'
  | 'blackboard:write'
  | 'admin:all'
  | 'federation:read'
  | 'federation:write'

// ── Permission sets per role ────────────────────────────────────────────────

// Only the admin role carries admin:all; all others are strictly scoped.
// read_only and viewer are intentionally narrow -- no write permissions.
// viewer includes blackboard:read so B2B users can see the fleet health bar.
const ROLE_PERMISSIONS: Record<Role, ReadonlySet<Permission>> = {
  admin: new Set<Permission>([
    'memories:read',
    'memories:write',
    'kanban:read',
    'kanban:write',
    'agents:read',
    'messages:write',
    'approvals:read',
    'approvals:write',
    'blackboard:read',
    'blackboard:write',
    'admin:all',
    'federation:read',
    'federation:write',
  ]),
  agent: new Set<Permission>([
    'memories:read',
    'memories:write',
    'kanban:read',
    'kanban:write',
    'agents:read',
    'messages:write',
    'approvals:read',
    'blackboard:read',
    'blackboard:write',
    'federation:read',
    'federation:write',
  ]),
  read_only: new Set<Permission>([
    'memories:read',
    'kanban:read',
    'agents:read',
    'blackboard:read',
    'approvals:read',
    'approvals:write',
  ]),
  viewer: new Set<Permission>([
    'memories:read',
    'kanban:read',
    'agents:read',
    'blackboard:read',
    'approvals:read',
    'approvals:write',
  ]),
}

export function hasPermission(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].has(permission)
}

// ── Endpoint-to-permission lookup ──────────────────────────────────────────
//
// Each entry maps a (method pattern, path pattern) pair to the Permission
// required to execute it. The middleware iterates entries in order and uses
// the first match. Patterns use simple prefix matching or exact matching.
//
// Conventions:
// - method: HTTP verb or '*' for any verb.
// - pathPattern: string prefix (must start with '/'); trailing '*' means prefix match.
// - If no entry matches, the middleware falls back to 'admin:all' (deny non-admin).

export interface EndpointPermissionEntry {
  method: '*' | 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  pathPattern: string
  /** Whether pathPattern is a prefix (true) or exact match (false). */
  prefix: boolean
  permission: Permission
}

export const ENDPOINT_PERMISSION_TABLE: readonly EndpointPermissionEntry[] = [
  // Admin namespace -- must be checked before generic /api/* entries.
  { method: '*', pathPattern: '/api/admin/', prefix: true, permission: 'admin:all' },
  { method: '*', pathPattern: '/api/v1/admin/', prefix: true, permission: 'admin:all' },

  // Federation wire endpoints.
  { method: 'GET', pathPattern: '/api/federation/', prefix: true, permission: 'federation:read' },
  { method: 'POST', pathPattern: '/api/federation/', prefix: true, permission: 'federation:write' },
  { method: 'GET', pathPattern: '/api/v1/federation/', prefix: true, permission: 'federation:read' },
  { method: 'POST', pathPattern: '/api/v1/federation/', prefix: true, permission: 'federation:write' },

  // Approvals -- tenant users can read and resolve their own tenant's requests (IDOR-guarded in route).
  { method: 'GET', pathPattern: '/api/approvals', prefix: true, permission: 'approvals:read' },
  { method: 'POST', pathPattern: '/api/approvals', prefix: true, permission: 'approvals:write' },
  { method: 'PATCH', pathPattern: '/api/approvals', prefix: true, permission: 'approvals:write' },
  { method: 'PUT', pathPattern: '/api/approvals', prefix: true, permission: 'approvals:write' },
  { method: 'GET', pathPattern: '/api/v1/approvals', prefix: true, permission: 'approvals:read' },
  { method: 'POST', pathPattern: '/api/v1/approvals', prefix: true, permission: 'approvals:write' },
  { method: 'PATCH', pathPattern: '/api/v1/approvals', prefix: true, permission: 'approvals:write' },
  { method: 'PUT', pathPattern: '/api/v1/approvals', prefix: true, permission: 'approvals:write' },

  // Blackboard.
  { method: 'GET', pathPattern: '/api/blackboard', prefix: true, permission: 'blackboard:read' },
  { method: 'POST', pathPattern: '/api/blackboard', prefix: true, permission: 'blackboard:write' },
  { method: 'GET', pathPattern: '/api/v1/blackboard', prefix: true, permission: 'blackboard:read' },
  { method: 'POST', pathPattern: '/api/v1/blackboard', prefix: true, permission: 'blackboard:write' },

  // Messages.
  { method: 'POST', pathPattern: '/api/messages', prefix: true, permission: 'messages:write' },
  { method: 'POST', pathPattern: '/api/v1/messages', prefix: true, permission: 'messages:write' },

  // Agents -- read-only for broad roles.
  { method: 'GET', pathPattern: '/api/agents', prefix: true, permission: 'agents:read' },
  { method: 'GET', pathPattern: '/api/v1/agents', prefix: true, permission: 'agents:read' },

  // Kanban.
  { method: 'GET', pathPattern: '/api/kanban', prefix: true, permission: 'kanban:read' },
  { method: 'POST', pathPattern: '/api/kanban', prefix: true, permission: 'kanban:write' },
  { method: 'PATCH', pathPattern: '/api/kanban', prefix: true, permission: 'kanban:write' },
  { method: 'DELETE', pathPattern: '/api/kanban', prefix: true, permission: 'kanban:write' },
  { method: 'GET', pathPattern: '/api/v1/kanban', prefix: true, permission: 'kanban:read' },
  { method: 'POST', pathPattern: '/api/v1/kanban', prefix: true, permission: 'kanban:write' },
  { method: 'PATCH', pathPattern: '/api/v1/kanban', prefix: true, permission: 'kanban:write' },
  { method: 'DELETE', pathPattern: '/api/v1/kanban', prefix: true, permission: 'kanban:write' },

  // Memories.
  { method: 'GET', pathPattern: '/api/memories', prefix: true, permission: 'memories:read' },
  { method: 'POST', pathPattern: '/api/memories', prefix: true, permission: 'memories:write' },
  { method: 'DELETE', pathPattern: '/api/memories', prefix: true, permission: 'memories:write' },
  { method: 'GET', pathPattern: '/api/v1/memories', prefix: true, permission: 'memories:read' },
  { method: 'POST', pathPattern: '/api/v1/memories', prefix: true, permission: 'memories:write' },
  { method: 'DELETE', pathPattern: '/api/v1/memories', prefix: true, permission: 'memories:write' },

  // Recall, overview and me -- non-admin readable (memories:read is the narrowest fitting permission).
  // /api/overview response is further filtered in the route handler: fleet-level fields are omitted
  // for non-admin callers -- a tenant user must not learn the fleet's internal structure.
  { method: 'GET', pathPattern: '/api/recall',      prefix: true,  permission: 'memories:read' },
  { method: 'GET', pathPattern: '/api/v1/recall',   prefix: true,  permission: 'memories:read' },
  { method: 'GET', pathPattern: '/api/overview',    prefix: false, permission: 'memories:read' },
  { method: 'GET', pathPattern: '/api/v1/overview', prefix: false, permission: 'memories:read' },
  // prefix:false because /api/me has no sub-paths yet; avoids matching /api/messages.
  // Add explicit rows when 625 introduces sub-paths.
  { method: 'GET', pathPattern: '/api/me',          prefix: false, permission: 'memories:read' },
  { method: 'GET', pathPattern: '/api/v1/me',       prefix: false, permission: 'memories:read' },

  // Workspace docs -- fleet-agent produced working documents.
  { method: 'GET',    pathPattern: '/api/workspace',    prefix: true,  permission: 'memories:read' },
  { method: 'POST',   pathPattern: '/api/workspace',    prefix: false, permission: 'memories:write' },
  { method: 'PATCH',  pathPattern: '/api/workspace',    prefix: true,  permission: 'memories:write' },
  { method: 'DELETE', pathPattern: '/api/workspace',    prefix: true,  permission: 'memories:write' },
  { method: 'GET',    pathPattern: '/api/v1/workspace', prefix: true,  permission: 'memories:read' },
  { method: 'POST',   pathPattern: '/api/v1/workspace', prefix: false, permission: 'memories:write' },
  { method: 'PATCH',  pathPattern: '/api/v1/workspace', prefix: true,  permission: 'memories:write' },
  { method: 'DELETE', pathPattern: '/api/v1/workspace', prefix: true,  permission: 'memories:write' },
]

/**
 * Resolve the required Permission for a given HTTP method + path.
 * Returns null if no entry matches (caller should treat as admin:all required).
 */
export function resolveRequiredPermission(
  method: string,
  path: string,
): Permission | null {
  for (const entry of ENDPOINT_PERMISSION_TABLE) {
    if (entry.method !== '*' && entry.method !== method) continue
    const matches = entry.prefix
      ? path.startsWith(entry.pathPattern)
      : path === entry.pathPattern
    if (matches) return entry.permission
  }
  return null
}
