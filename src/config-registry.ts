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
  // --- Kanban archiving (hot-reload via settings-store) ---
  {
    key: 'KANBAN_ARCHIVE_DONE_DAYS',
    type: 'int',
    default: 30,
    min: 1,
    max: 365,
    description: 'Ennyi napnál régebbi "done" kártyák automatikusan archiválódnak a listKanbanCards() hívásakor.',
    module: 'kanban',
    secret: false,
    requiresRestart: false,
  },
  {
    key: 'KANBAN_ARCHIVED_MAX_ROWS',
    type: 'int',
    default: 500,
    min: 10,
    max: 5000,
    description: 'Az archivált kártya-nézetben egyszerre megjelenített kártyák maximális száma.',
    module: 'kanban',
    secret: false,
    requiresRestart: false,
  },
  // --- Kanban aging thresholds and colours (hot-reload via settings-store) ---
  {
    key: 'KANBAN_AGING_WARN_H',
    type: 'int',
    default: 24,
    min: 1,
    max: 8760,
    description: 'Ennyi óra inaktivitás után jelenik meg az első (sárga) aging-jelzés a kártyán.',
    module: 'kanban',
    secret: false,
    requiresRestart: false,
  },
  {
    key: 'KANBAN_AGING_CAUTION_H',
    type: 'int',
    default: 72,
    min: 1,
    max: 8760,
    description: 'Ennyi óra inaktivitás után vált narancssárgára az aging-jelzés.',
    module: 'kanban',
    secret: false,
    requiresRestart: false,
  },
  {
    key: 'KANBAN_AGING_CRITICAL_H',
    type: 'int',
    default: 168,
    min: 1,
    max: 8760,
    description: 'Ennyi óra inaktivitás után vált pirosra (kritikus) az aging-jelzés.',
    module: 'kanban',
    secret: false,
    requiresRestart: false,
  },
  {
    key: 'KANBAN_AGING_WARN_COLOR',
    type: 'color',
    default: '#c9a000',
    description: 'Az aging-badge színe a figyelmeztetési küszöbnél (warn).',
    module: 'kanban',
    secret: false,
    requiresRestart: false,
  },
  {
    key: 'KANBAN_AGING_CAUTION_COLOR',
    type: 'color',
    default: '#d46b00',
    description: 'Az aging-badge színe az óvatossági küszöbnél (caution).',
    module: 'kanban',
    secret: false,
    requiresRestart: false,
  },
  {
    key: 'KANBAN_AGING_CRITICAL_COLOR',
    type: 'color',
    default: '#c53030',
    description: 'Az aging-badge színe a kritikus küszöbnél.',
    module: 'kanban',
    secret: false,
    requiresRestart: false,
  },
  // --- Kanban swimlanes (hot-reload via settings-store) ---
  {
    key: 'KANBAN_SWIMLANE_DEFAULT_GROUP',
    type: 'string',
    default: 'none',
    valueSet: ['none', 'assignee', 'priority'],
    description: 'A tábla alapértelmezett csoportosítása betöltéskor. none = lapos nézet.',
    module: 'kanban',
    secret: false,
    requiresRestart: false,
  },
  {
    key: 'KANBAN_SWIMLANE_SEPARATOR_COLOR',
    type: 'color',
    default: '#374151',
    description: 'Az swimlane-elválasztó fejléc háttérszíne.',
    module: 'kanban',
    secret: false,
    requiresRestart: false,
  },
  // --- System module (requiresRestart -- read at process init) ---
  {
    key: 'DASHBOARD_PUBLIC_URL',
    type: 'string',
    default: '',
    description: 'A dashboard nyilvánosan elérhető URL-je (pl. https://marveen.example.com). Üres = nincs CORS whitelist bővítés.',
    module: 'system',
    secret: false,
    requiresRestart: true,
  },
  {
    key: 'OLLAMA_URL',
    type: 'string',
    default: 'http://localhost:11434',
    description: 'Az Ollama API alap-URL-je. Memória-embedding és modell-javaslat ezt használja.',
    module: 'system',
    secret: false,
    requiresRestart: true,
  },
  // --- Heartbeat module (hot-reload via settings-store) ---
  {
    key: 'HEARTBEAT_START_HOUR',
    type: 'int',
    default: 9,
    min: 0,
    max: 22,
    description: 'A heartbeat aktív időablakának kezdete (helyi idő, 0-22). Előtte nem küld értesítést.',
    module: 'heartbeat',
    secret: false,
    requiresRestart: false,
  },
  {
    key: 'HEARTBEAT_END_HOUR',
    type: 'int',
    default: 23,
    min: 1,
    max: 24,
    description: 'A heartbeat aktív időablakának vége (helyi idő, 1-24). Ettől nem küld értesítést.',
    module: 'heartbeat',
    secret: false,
    requiresRestart: false,
  },
  {
    key: 'HEARTBEAT_AGENT_ENABLED',
    type: 'string',
    default: '1',
    valueSet: ['0', '1'],
    description: 'Heartbeat sub-ágens engedélyezése. 1 = bekapcsolva (újraindítás után lép életbe).',
    module: 'heartbeat',
    secret: false,
    requiresRestart: true,
  },
  {
    key: 'IDEA_BREAKDOWN_MAX_SUBTASKS',
    type: 'int',
    default: 10,
    min: 2,
    max: 20,
    description: 'Az "Kanbanra (AI)" ötlet-bontás során generált részfeladatok maximális száma.',
    module: 'ideabox',
    secret: false,
    requiresRestart: false,
  },
  {
    key: 'IDEA_STALE_DAYS',
    type: 'int',
    default: 7,
    min: 1,
    max: 365,
    description: 'Ennyi napnyi mozdulatlanság után kap "Elavult" jelzést egy "új" státuszú ötlet.',
    module: 'ideabox',
    secret: false,
    requiresRestart: false,
  },
  // --- Audit log module ---
  {
    key: 'AUDIT_LOG_RETENTION_DAYS',
    type: 'int',
    default: 90,
    min: 1,
    max: 3650,
    description: 'Az audit napló (config-változások, ötletláda-audit, store-fájl események) megőrzési ideje napokban. Régebbi bejegyzések a napi sweepkor törlődnek.',
    module: 'audit',
    secret: false,
    requiresRestart: false,
  },
  {
    key: 'AUDIT_LOG_MAX_ENTRIES',
    type: 'int',
    default: 10000,
    min: 100,
    max: 1000000,
    description: 'Az audit napló összes forrásra vetített maximális bejegyzésszáma. Az API lekérések ennél soha nem adnak vissza többet (forrásanként egyéni limit: AUDIT_LOG_MAX_ENTRIES / 3).',
    module: 'audit',
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
