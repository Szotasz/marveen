// Single source of truth for settings the dashboard's "Beallitasok" page can
// show and edit. Each entry describes one .env-backed config key: its type
// (drives the input widget + validation), default, human description, the
// module it belongs to (drives UI grouping), whether it is secret (drives
// API redaction), and whether changing it needs a process restart to take
// effect (drives the UI warning badge).
//
// v1 scope is intentionally narrow: the 9 Kanban WIP keys. Extending this
// array is how a future setting becomes editable from the UI -- no route or
// frontend change needed beyond what already reads the registry.

export type SettingType = 'int' | 'string' | 'color'

export interface SettingDefinition {
  key: string
  type: SettingType
  default: string | number
  description: string
  module: string
  secret: boolean
  requiresRestart: boolean
  /** Optional fixed set of allowed values (enum-style settings). */
  valueSet?: string[]
  /** Inclusive bounds, only meaningful for type 'int'. */
  min?: number
  max?: number
}

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/

export const SETTINGS_REGISTRY: SettingDefinition[] = [
  {
    key: 'KANBAN_WIP_PLANNED',
    type: 'int',
    default: 0,
    min: 0,
    max: 100,
    description: 'A "planned" oszlop WIP-limitje (max. kártyaszám). 0 = korlátlan.',
    module: 'kanban',
    secret: false,
    requiresRestart: false,
  },
  {
    key: 'KANBAN_WIP_IN_PROGRESS',
    type: 'int',
    default: 0,
    min: 0,
    max: 100,
    description: 'Az "in_progress" oszlop WIP-limitje (max. kártyaszám). 0 = korlátlan.',
    module: 'kanban',
    secret: false,
    requiresRestart: false,
  },
  {
    key: 'KANBAN_WIP_WAITING',
    type: 'int',
    default: 0,
    min: 0,
    max: 100,
    description: 'A "waiting" oszlop WIP-limitje (max. kártyaszám). 0 = korlátlan.',
    module: 'kanban',
    secret: false,
    requiresRestart: false,
  },
  {
    key: 'KANBAN_WIP_DONE',
    type: 'int',
    default: 0,
    min: 0,
    max: 100,
    description: 'A "done" oszlop WIP-limitje (max. kártyaszám). 0 = korlátlan.',
    module: 'kanban',
    secret: false,
    requiresRestart: false,
  },
  {
    key: 'KANBAN_WIP_WARN_PCT',
    type: 'int',
    default: 80,
    min: 1,
    max: 100,
    description: 'Kihasználtsági százalék, amely felett a WIP-badge sárgára vált. 0 nem értelmes (azonnali figyelmeztetés), ezért tiltott.',
    module: 'kanban',
    secret: false,
    requiresRestart: false,
  },
  {
    key: 'KANBAN_WIP_OK_COLOR',
    type: 'color',
    default: '#6b7280',
    description: 'A WIP-badge színe, amikor az oszlop kihasználtsága a figyelmeztetési küszöb alatt van.',
    module: 'kanban',
    secret: false,
    requiresRestart: false,
  },
  {
    key: 'KANBAN_WIP_WARN_COLOR',
    type: 'color',
    default: '#c9a000',
    description: 'A WIP-badge színe a figyelmeztetési küszöb (WARN_PCT) felett, limit előtt.',
    module: 'kanban',
    secret: false,
    requiresRestart: false,
  },
  {
    key: 'KANBAN_WIP_FULL_COLOR',
    type: 'color',
    default: '#d46b00',
    description: 'A WIP-badge színe, amikor az oszlop pontosan a limiten áll.',
    module: 'kanban',
    secret: false,
    requiresRestart: false,
  },
  {
    key: 'KANBAN_WIP_OVER_COLOR',
    type: 'color',
    default: '#c53030',
    description: 'A WIP-badge színe, amikor az oszlop túllépte a limitet.',
    module: 'kanban',
    secret: false,
    requiresRestart: false,
  },
]

export function getSettingDefinition(key: string): SettingDefinition | undefined {
  return SETTINGS_REGISTRY.find((s) => s.key === key)
}

export function listSettingModules(): string[] {
  return [...new Set(SETTINGS_REGISTRY.map((s) => s.module))]
}

export interface SettingValidationResult {
  ok: boolean
  error?: string
  /** Normalised value (e.g. parsed int) to persist when ok === true. */
  value?: string | number
}

// Pure validation against a single registry entry. No I/O, no DB -- callers
// (the /api/settings route, tests) decide what happens with the result.
export function validateSettingValue(def: SettingDefinition, raw: unknown): SettingValidationResult {
  if (def.valueSet && def.valueSet.length > 0) {
    const str = String(raw)
    if (!def.valueSet.includes(str)) {
      return { ok: false, error: `Érvénytelen érték. Megengedett: ${def.valueSet.join(', ')}` }
    }
    return { ok: true, value: str }
  }

  if (def.type === 'int') {
    const n = typeof raw === 'number' ? raw : parseInt(String(raw), 10)
    if (!Number.isInteger(n)) return { ok: false, error: 'Egész szám szükséges.' }
    if (def.min !== undefined && n < def.min) return { ok: false, error: `Az érték legalább ${def.min} lehet.` }
    if (def.max !== undefined && n > def.max) return { ok: false, error: `Az érték legfeljebb ${def.max} lehet.` }
    return { ok: true, value: n }
  }

  if (def.type === 'color') {
    const str = String(raw)
    if (!HEX_COLOR_RE.test(str)) return { ok: false, error: 'Érvénytelen szín (várható formátum: #rrggbb).' }
    return { ok: true, value: str }
  }

  // 'string'
  return { ok: true, value: String(raw) }
}
