import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PROJECT_ROOT } from '../config.js'
import { atomicWriteFileSync } from './atomic-write.js'
import {
  normalizeGateConfig,
  DEFAULT_GATE_CONFIG,
  type GateConfig,
} from '../context-restart-gate.js'

const CONFIG_PATH = join(PROJECT_ROOT, 'store', 'context-restart-gate.json')
const STATE_PATH  = join(PROJECT_ROOT, 'store', 'context-restart-gate-state.json')

// ---- Config (per-agent, keyed by agent name) --------------------------------

function readConfigRaw(): Record<string, unknown> {
  try {
    const parsed = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'))
    return (parsed && typeof parsed === 'object') ? parsed as Record<string, unknown> : {}
  } catch { return {} }
}

export function readGateConfig(name: string): GateConfig {
  const raw = readConfigRaw()
  return name in raw ? normalizeGateConfig(raw[name]) : { ...DEFAULT_GATE_CONFIG }
}

export function writeGateConfig(name: string, cfg: unknown): GateConfig {
  const normalized = normalizeGateConfig(cfg)
  const raw = readConfigRaw()
  raw[name] = normalized
  atomicWriteFileSync(CONFIG_PATH, JSON.stringify(raw, null, 2))
  return normalized
}

// ---- State (per-agent run-state: blocking streak tracking) ------------------

export interface GateRunState {
  /** Epoch ms when continuous blocking started; null when not blocked. */
  firstBlockedAt: number | null
  /** Epoch ms of the last persistent-block alert sent to bigme. */
  lastAlertAt: number | null
  /** Epoch ms when the last /clear was successfully sent. */
  lastClearAt: number | null
}

const EMPTY_STATE: GateRunState = {
  firstBlockedAt: null,
  lastAlertAt: null,
  lastClearAt: null,
}

function readStateRaw(): Record<string, unknown> {
  try {
    const parsed = JSON.parse(readFileSync(STATE_PATH, 'utf-8'))
    return (parsed && typeof parsed === 'object') ? parsed as Record<string, unknown> : {}
  } catch { return {} }
}

function normalizeState(raw: unknown): GateRunState {
  const o = (raw && typeof raw === 'object') ? raw as Record<string, unknown> : {}
  const msOrNull = (v: unknown): number | null =>
    (typeof v === 'number' && Number.isFinite(v) && v > 0) ? Math.floor(v) : null
  return {
    firstBlockedAt: msOrNull(o.firstBlockedAt),
    lastAlertAt:    msOrNull(o.lastAlertAt),
    lastClearAt:    msOrNull(o.lastClearAt),
  }
}

export function readGateRunState(name: string): GateRunState {
  const raw = readStateRaw()
  return name in raw ? normalizeState(raw[name]) : { ...EMPTY_STATE }
}

export function writeGateRunState(name: string, state: GateRunState): void {
  const raw = readStateRaw()
  raw[name] = state
  atomicWriteFileSync(STATE_PATH, JSON.stringify(raw, null, 2))
}
