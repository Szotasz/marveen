// Tenant-scoped query wrapper for the four core tables.
//
// Every method on the returned object hard-wires the caller's tenant_id into
// the SQL so route handlers can never accidentally read or write another
// tenant's data -- even if the caller passes a wrong value, the WHERE clause
// wins. Cross-tenant reads return an empty list (not a 403); cross-tenant
// writes are structurally impossible because the tenant_id column is always
// supplied by the scope, not by the caller.
//
// Admin-level aggregation that needs to span tenants should use the raw db
// handle directly, protected by the admin:all permission check.
//
// The wrapper accepts a db parameter rather than calling getDb() so that
// tests can pass an in-memory database without touching the production store.

import type Database from 'better-sqlite3'
import { syncVecMemoryDelete } from '../db.js'

// ── Types ────────────────────────────────────────────────────────────────────

export interface ScopedMemory {
  id: number
  agent_id: string
  category: string
  key: string
  value: string
  tenant_id: string
  [key: string]: unknown
}

export interface ScopedKanbanCard {
  id: string
  title: string
  status: string
  tenant_id: string
  [key: string]: unknown
}

export interface ScopedAgentMessage {
  id: number
  from_agent: string
  to_agent: string
  content: string
  status: string
  tenant_id: string
  [key: string]: unknown
}

export interface ScopedImportMemory {
  id: string
  source_id: string
  file_path: string
  content: string
  tenant_id: string
  [key: string]: unknown
}

// ── Main export ───────────────────────────────────────────────────────────────

export function scopeToTenant(db: Database.Database, tenantId: string) {
  return {

    // ── memories ─────────────────────────────────────────────────────────────

    memories: {
      /** List memories for an agent within this tenant, including shared-tier. */
      list(agentId: string, category?: string, limit = 50): ScopedMemory[] {
        if (category) {
          return db
            .prepare(
              `SELECT * FROM memories
               WHERE tenant_id = ? AND (agent_id = ? OR category = 'shared') AND category = ?
               ORDER BY accessed_at DESC LIMIT ?`,
            )
            .all(tenantId, agentId, category, limit) as ScopedMemory[]
        }
        return db
          .prepare(
            `SELECT * FROM memories
             WHERE tenant_id = ? AND (agent_id = ? OR category = 'shared')
             ORDER BY accessed_at DESC LIMIT ?`,
          )
          .all(tenantId, agentId, limit) as ScopedMemory[]
      },

      /** Get a single memory by id, only if it belongs to this tenant. */
      get(id: number): ScopedMemory | null {
        return (
          (db
            .prepare('SELECT * FROM memories WHERE tenant_id = ? AND id = ?')
            .get(tenantId, id) as ScopedMemory | undefined) ?? null
        )
      },

      /** Insert a new memory stamped with this tenant. */
      insert(
        agentId: string,
        category: string,
        content: string,
        keywords?: string,
      ): number {
        const now = Math.floor(Date.now() / 1000)
        const result = db
          .prepare(
            `INSERT INTO memories (agent_id, category, content, keywords, tenant_id, created_at, accessed_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(agentId, category, content, keywords ?? null, tenantId, now, now)
        return Number(result.lastInsertRowid)
      },

      /** Update a memory only if it belongs to this tenant. */
      update(id: number, patch: { content?: string; category?: string }): boolean {
        const fields: string[] = []
        const params: unknown[] = []
        if (patch.content !== undefined) { fields.push('content = ?'); params.push(patch.content) }
        if (patch.category !== undefined) { fields.push('category = ?'); params.push(patch.category) }
        if (fields.length === 0) return false
        params.push(tenantId, id)
        const result = db
          .prepare(
            `UPDATE memories SET ${fields.join(', ')} WHERE tenant_id = ? AND id = ?`,
          )
          .run(...params)
        return result.changes > 0
      },

      /** Delete a memory only if it belongs to this tenant. */
      delete(id: number): boolean {
        const result = db
          .prepare('DELETE FROM memories WHERE tenant_id = ? AND id = ?')
          .run(tenantId, id)
        if (result.changes > 0) syncVecMemoryDelete(id)
        return result.changes > 0
      },
    },

    // ── kanban_cards ─────────────────────────────────────────────────────────

    kanban: {
      /** List kanban cards for this tenant. */
      list(status?: string, limit = 200): ScopedKanbanCard[] {
        if (status) {
          return db
            .prepare(
              `SELECT * FROM kanban_cards
               WHERE tenant_id = ? AND status = ?
               ORDER BY created_at DESC LIMIT ?`,
            )
            .all(tenantId, status, limit) as ScopedKanbanCard[]
        }
        return db
          .prepare(
            `SELECT * FROM kanban_cards
             WHERE tenant_id = ?
             ORDER BY created_at DESC LIMIT ?`,
          )
          .all(tenantId, limit) as ScopedKanbanCard[]
      },

      /** Get a single card by id, only if it belongs to this tenant. */
      get(id: string): ScopedKanbanCard | null {
        return (
          (db
            .prepare('SELECT * FROM kanban_cards WHERE tenant_id = ? AND id = ?')
            .get(tenantId, id) as ScopedKanbanCard | undefined) ?? null
        )
      },

      /** Insert a new kanban card stamped with this tenant. */
      insert(id: string, title: string, status = 'planned'): void {
        db.prepare(
          `INSERT INTO kanban_cards (id, title, status, tenant_id) VALUES (?, ?, ?, ?)`,
        ).run(id, title, status, tenantId)
      },

      /** Update a card only if it belongs to this tenant. */
      update(id: string, patch: { title?: string; status?: string }): boolean {
        const fields: string[] = []
        const params: unknown[] = []
        if (patch.title !== undefined) { fields.push('title = ?'); params.push(patch.title) }
        if (patch.status !== undefined) { fields.push('status = ?'); params.push(patch.status) }
        if (fields.length === 0) return false
        params.push(tenantId, id)
        const result = db
          .prepare(
            `UPDATE kanban_cards SET ${fields.join(', ')} WHERE tenant_id = ? AND id = ?`,
          )
          .run(...params)
        return result.changes > 0
      },

      /** Delete a card only if it belongs to this tenant. */
      delete(id: string): boolean {
        const result = db
          .prepare('DELETE FROM kanban_cards WHERE tenant_id = ? AND id = ?')
          .run(tenantId, id)
        return result.changes > 0
      },
    },

    // ── agent_messages ───────────────────────────────────────────────────────

    agentMessages: {
      /** List messages for a target agent within this tenant. */
      listFor(toAgent: string, status?: string, limit = 100): ScopedAgentMessage[] {
        if (status) {
          return db
            .prepare(
              `SELECT * FROM agent_messages
               WHERE tenant_id = ? AND to_agent = ? AND status = ?
               ORDER BY created_at DESC LIMIT ?`,
            )
            .all(tenantId, toAgent, status, limit) as ScopedAgentMessage[]
        }
        return db
          .prepare(
            `SELECT * FROM agent_messages
             WHERE tenant_id = ? AND to_agent = ?
             ORDER BY created_at DESC LIMIT ?`,
          )
          .all(tenantId, toAgent, limit) as ScopedAgentMessage[]
      },

      /** Insert a message stamped with this tenant. */
      insert(fromAgent: string, toAgent: string, content: string): number {
        const now = Math.floor(Date.now() / 1000)
        const result = db
          .prepare(
            `INSERT INTO agent_messages (from_agent, to_agent, content, status, tenant_id, created_at)
             VALUES (?, ?, ?, 'pending', ?, ?)`,
          )
          .run(fromAgent, toAgent, content, tenantId, now)
        return Number(result.lastInsertRowid)
      },
    },

    // ── import_memories ──────────────────────────────────────────────────────

    importMemories: {
      /** List import memories for a source within this tenant. */
      listForSource(sourceId: string, limit = 500): ScopedImportMemory[] {
        return db
          .prepare(
            `SELECT * FROM import_memories
             WHERE tenant_id = ? AND source_id = ?
             ORDER BY updated_at DESC LIMIT ?`,
          )
          .all(tenantId, sourceId, limit) as ScopedImportMemory[]
      },

      /** Get a single import memory by id, only if it belongs to this tenant. */
      get(id: string): ScopedImportMemory | null {
        return (
          (db
            .prepare('SELECT * FROM import_memories WHERE tenant_id = ? AND id = ?')
            .get(tenantId, id) as ScopedImportMemory | undefined) ?? null
        )
      },

      /** Insert an import memory stamped with this tenant. */
      insert(
        id: string,
        sourceId: string,
        filePath: string,
        content: string,
      ): void {
        const now = Math.floor(Date.now() / 1000)
        db.prepare(
          `INSERT INTO import_memories (id, source_id, file_path, content, tenant_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(id, sourceId, filePath, content, tenantId, now, now)
      },

      /** Delete an import memory only if it belongs to this tenant. */
      delete(id: string): boolean {
        const result = db
          .prepare('DELETE FROM import_memories WHERE tenant_id = ? AND id = ?')
          .run(tenantId, id)
        return result.changes > 0
      },
    },
  }
}

export type TenantScope = ReturnType<typeof scopeToTenant>
