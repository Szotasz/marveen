// String-contract guard for the Ideas (Ötletláda) page surface.
// Pattern: federation-ui-contract.test.ts — read frontend files as strings,
// assert short, formatting-proof fragments.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const APP       = readFileSync(join(__dirname, '../../web/app.js'), 'utf-8')
// Ideas page extracted to ideas.js in S-13c modularization.
const IDEAS_MOD = readFileSync(join(__dirname, '../../web/modules/ideas.js'), 'utf-8')

describe('ideas UI wiring (S-13c)', () => {
  it('ideas.js exports loadIdeasPage and initIdeas', () => {
    expect(IDEAS_MOD).toMatch(/export async function loadIdeasPage\(/)
    expect(IDEAS_MOD).toMatch(/export function initIdeas\(/)
  })

  it('app.js registers the ideas page router entry', () => {
    expect(APP).toMatch(/registerPage\('ideas'/)
  })

  it('app.js lazy-loads ideas.js via dynamic import (S-16 lazy-load)', () => {
    expect(APP).toMatch(/import\(['"]\.\/modules\/ideas\.js['"]\)/)
  })

  it('app.js calls initIdeas with openModal and closeModal', () => {
    expect(APP).toMatch(/initIdeas\(\s*\{\s*openModal/)
  })

  it('ideas.js sets window globals for inline onclick handlers', () => {
    expect(IDEAS_MOD).toContain('window.openIdeaDetail')
    expect(IDEAS_MOD).toContain('window.setIdeaStatus')
    expect(IDEAS_MOD).toContain('window.openIdeaEdit')
    expect(IDEAS_MOD).toContain('window.deleteIdeaItem')
  })

  it('ideas.js uses escapeHtml for idea titles in rendered HTML', () => {
    expect(IDEAS_MOD).toMatch(/escapeHtml\(.*\.title/)
  })

  it('ideas section has been removed from app.js', () => {
    // Variables that lived only in the ideas section must not appear in app.js
    expect(APP).not.toContain('let ideasPromoteId')
    expect(APP).not.toContain('let ideaEditId')
    // ideas-specific STATUS_COLORS value: ideas statuses ('new', 'reviewed', 'kanban', 'rejected')
    expect(APP).not.toContain("new: 'var(--accent)'")
  })
})
