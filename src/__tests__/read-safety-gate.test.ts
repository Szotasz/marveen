import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdirSync, writeFileSync, symlinkSync, rmSync, rmdirSync } from 'node:fs'
// @ts-expect-error -- plain .mjs hook, no type declarations (same pattern as email-send-gate.test.ts)
import { gateDecision } from '../../scripts/hooks/read-safety-gate.mjs'

const read = (file_path: string) => gateDecision('Read', { file_path })

const STORE = '/Users/macmini/marveen/store'
const MIRROR = `${STORE}/kanban-attachments`
// The adapter writes `task-<pmTaskId>/` folders here; Nova also saves assets by
// card id in the same root. The carve-out must cover the whole root, either shape.
const TASK_DIR = `${MIRROR}/task-1`
const CARD_DIR = `${MIRROR}/c3b14cb1`
const ASSET = `${TASK_DIR}/101-brief.pdf`
const ESCAPE_LINK = `${TASK_DIR}/escape.pdf`

// The mirror is a LIVE directory: the adapter downloads real client attachments
// here and Nova hand-saves assets into it. So this test creates its own clearly
// named fixtures and removes EXACTLY those -- never the mirror root, never a
// recursive sweep of a directory it does not own.
//
// It used to `rmSync(TASK_DIR, { recursive: true })` on a folder that could hold
// other people's files, and on 2026-07-22 that silently ate a file and a symlink
// placed there by hand. A test must not be able to delete data it did not create.
const CARD_ASSET = `${CARD_DIR}/read-gate-test-asset.txt`
beforeAll(() => {
  mkdirSync(TASK_DIR, { recursive: true })
  mkdirSync(CARD_DIR, { recursive: true })
  writeFileSync(ASSET, 'PDF-BYTES')
  writeFileSync(CARD_ASSET, 'MANUAL-BYTES')
  rmSync(ESCAPE_LINK, { force: true }) // a leftover link from an aborted run
  symlinkSync(`${STORE}/.dashboard-token`, ESCAPE_LINK)
})
afterAll(() => {
  // Named files only -- no recursive removal anywhere under the live mirror.
  rmSync(ESCAPE_LINK, { force: true })
  rmSync(ASSET, { force: true })
  rmSync(CARD_ASSET, { force: true })
  // Drop the task folder only while it is empty, i.e. only if it held nothing but
  // our own fixtures. A non-empty rmdir throws, so anything else stays put.
  try { rmdirSync(TASK_DIR) } catch { /* someone else's files live here -- leave it */ }
})

// --- The carve-out itself ----------------------------------------------------
describe('read gate: kanban-attachments carve-out', () => {
  it('allows an adapter-mirrored attachment in a task-<pmId> folder', () => {
    expect(read(ASSET).decision).toBe('allow')
  })
  it('allows a hand-saved asset in a card-id folder (Nova saves assets this way)', () => {
    expect(read(CARD_ASSET).decision).toBe('allow')
  })
  it('allows a mirrored attachment reached via a redundant path segment', () => {
    expect(read(`${TASK_DIR}/./101-brief.pdf`).decision).toBe('allow')
  })
  it('does NOT allow a file that merely starts with the mirror name (sibling dir)', () => {
    // `/store/kanban-attachments-evil/x` must not ride the prefix: the constant ends
    // with a separator, so this falls through to the store/ deny.
    expect(read(`${STORE}/kanban-attachments-evil/x.pdf`).decision).toBe('deny')
  })
  it('denies a non-existent path inside the mirror (no exception without resolution)', () => {
    expect(read(`${TASK_DIR}/does-not-exist.pdf`).decision).toBe('deny')
  })
})

// --- Nova's explicit requirement: the rest of store/ stays shut ---------------
describe('read gate: store/ secrets stay denied after the carve-out', () => {
  it('DENIES the dashboard token', () => {
    expect(read(`${STORE}/.dashboard-token`).decision).toBe('deny')
  })
  it('DENIES the vault', () => {
    expect(read(`${STORE}/vault.json`).decision).toBe('deny')
  })
  it('DENIES the sqlite db', () => {
    expect(read(`${STORE}/claudeclaw.db`).decision).toBe('deny')
  })
  it('DENIES another agent .secrets file', () => {
    expect(read('/Users/macmini/marveen/agents/lumen/.secrets/creds.txt').decision).toBe('deny')
  })
  it('DENIES an ssh key', () => {
    expect(read('/Users/macmini/.ssh/id_ed25519').decision).toBe('deny')
  })
})

// --- The carve-out must not become a traversal / symlink hole ----------------
describe('read gate: the carve-out cannot be used to reach the secrets next to it', () => {
  it('DENIES a traversal out of the mirror to the dashboard token', () => {
    // normalize() collapses the '..' BEFORE any check, so this is just a store/ read.
    expect(read(`${MIRROR}/../.dashboard-token`).decision).toBe('deny')
  })
  it('DENIES a traversal out of the mirror to the vault', () => {
    expect(read(`${TASK_DIR}/../../vault.json`).decision).toBe('deny')
  })
  it('DENIES a symlink inside the mirror that points at the dashboard token', () => {
    // The string prefix matches, so only the realpath check can stop this one.
    expect(read(ESCAPE_LINK).decision).toBe('deny')
  })
})

// --- Pre-existing behaviour must be unchanged by the carve-out ---------------
describe('read gate: unrelated decisions unchanged', () => {
  it('still allows ordinary project reads', () => {
    expect(read('/Users/macmini/marveen/src/web.ts').decision).toBe('allow')
  })
  it("still allows bit's own secrets (documented exemption: the adapter dev login)", () => {
    expect(read('/Users/macmini/marveen/agents/bit/.secrets/nova-innoplan-dev.txt').decision).toBe('allow')
  })
  it('still defers an absolute path outside the allowed roots', () => {
    expect(read('/etc/hosts').decision).toBe('defer')
  })
  it('still defers a non-Read tool', () => {
    expect(gateDecision('Bash', { file_path: ASSET }).decision).toBe('defer')
  })
})
