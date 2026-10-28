import { homedir } from 'node:os'
import { expandAndValidateConfigDir } from './config-dir-path.js'
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

// The model a fresh install runs when DEFAULT_AGENT_MODEL is unset. Kept here
// (a zero-import module) so the registry default and the boot-time constant in
// config.ts cannot drift apart -- bumping the distribution default is a
// one-line change in exactly one place.
// MAINMODEL806 (Szabi: "everything on Opus 5"): the default for the OTHER
// agents and the background-worker sessions -- AND, via resolve_main_model's
// fallback (channels.sh), the effective default for the MAIN agent on any
// install whose settings.json has no model. So this value is INHERITED by NEW
// agents and by existing model-less installs; it is not a mere worker knob.
// It is ALSO, via model-suggest.ts's TOP_TIER_MODEL, the ceiling the "which
// model should this agent run" advisor recommends -- that reuse is
// deliberate (see model-suggest.ts's MODELSUGGEST807 comment), which means
// this constant must be bumped every time a strictly-better/cheaper tier
// ships, or the advisor starts recommending a regression.
// The [1m] suffix is DELIBERATE, and the real reason is that inheritance, not
// continuity: a new agent is as long-lived as the current fleet (all of whom
// run explicit [1m]), and a narrower window would reproduce the context-guard
// restarts we measured. (The prior worker default happening to be [1m] only
// proves precedent, not need -- do not read it as "it was always this".) It
// matches the main agent's template value, so the two do not quietly diverge.
// resolveModelId passes the [1m] id through unchanged (measured), exactly as
// the CLI already handles the 4.8[1m] default. The valueSet below carries BOTH
// claude-opus-5 and claude-opus-5[1m] so an operator can still pick the
// non-1M form.
// MODELSUGGEST923 (measured 2026-09-26): OPUS55SELECTOR922 (#1492, 2026-09-23)
// added claude-opus-5-5[1m] to the picker's valueSet but never bumped THIS
// constant, so model-suggest.ts kept recommending the older claude-opus-5[1m]
// as an "upgrade" over agents already running claude-opus-5-5[1m] -- a real
// regression suggestion, live on 5 of 5 fleet agents including two already on
// 5.5. The picker already offers 5.5, so the ceiling must follow. This is the
// exact drift class MODELSUGGEST807 already fixed once (for the 4.8->5
// transition); it recurred because that fix anchored the ceiling to this
// constant instead of to "whatever the newest tier is", and nothing bumps
// this constant automatically when a new tier ships.
export const DISTRIBUTION_DEFAULT_AGENT_MODEL = 'claude-opus-5-5[1m]'

// DEFAULTCLIGUARD927: the tier a MODEL-LESS launch falls back to when the
// installed Claude Code CLI is measured (claude-cli-support.ts) not to launch
// DISTRIBUTION_DEFAULT_AGENT_MODEL. The default above reaches every existing
// model-less install on a plain code update, and nothing else on that launch
// path checks the CLI: an AVX-less host is pinned to CLI 2.1.112 (CLAUDE_PIN
// in channels.sh / install-linux.sh / fix-avx.sh; 2.1.110 before #1494), DISABLE_AUTOUPDATER keeps
// any older CLI where it is, and on such a CLI claude-opus-5-5 answers every
// prompt with 400 unrecognized_model -- the session comes up and goes silent.
// This must be a model the OLDEST pinned CLI launches (a test pins that), and
// it moves one tier up whenever the default does. Explicit operator values
// (MAIN_AGENT_MODEL, a settings.json model, an agent's own model, a configured
// DEFAULT_AGENT_MODEL) are never replaced by it.
export const DISTRIBUTION_DEFAULT_FALLBACK_MODEL = 'claude-opus-5[1m]'

export type SettingType = 'int' | 'string' | 'color' | 'boolean'

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
  /**
   * Optional extra check for a 'string' value: returns an error message, or
   * null when the value is acceptable. Runs on every write through
   * validateSettingValue (SECSZIVEK1007).
   */
  validate?: (value: string) => string | null
  /**
   * Optional: does changing `oldValue` to `newValue` LOOSEN a security control? When it does, the
   * settings route refuses the change from a fleet-token caller (the shared Bearer every agent
   * holds) and accepts it only from an owner session or a full-scope device key; tightening stays
   * open to everyone. The token cannot tell the owner from an agent, so without this an agent the
   * control constrains could switch it off for itself (BASHSANDBOX1022 security review).
   */
  loosens?: (oldValue: string, newValue: string) => boolean
}

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/

// A '' (use the default) or a number in [0, 1], e.g. a cosine-similarity threshold.
function validUnitFraction(v: string): string | null {
  const t = v.trim()
  if (t === '') return null
  const n = Number(t)
  return Number.isFinite(n) && n >= 0 && n <= 1 ? null : '0 és 1 közötti szám szükséges (pl. 0.1).'
}

// A '' (nobody) or a comma-separated list of agent names, e.g. "pm,reviewer".
const AGENT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,49}$/
function validAgentNameList(v: string): string | null {
  const t = v.trim()
  if (t === '') return null
  return t.split(',').every((n) => AGENT_NAME_RE.test(n.trim()))
    ? null
    : 'Ügynöknevek vesszővel elválasztva (pl. pm vagy pm,reviewer).'
}

function validKeepAlive(v: string): string | null {
  const t = v.trim()
  if (t === '') return null
  if (/^-?\d+$/.test(t)) return Number.isSafeInteger(Number(t)) ? null : 'Túl nagy szám.'
  return /^-?(\d+(\.\d+)?(ns|us|µs|ms|s|m|h))+$/.test(t) ? null : 'Egész szám (másodperc) vagy időtartam szükséges, pl. 30m, 1h, -1.'
}

// OSS_INVENTORY_NOTES_DIRS: comma-separated folder names under each agent
// folder that hold research notes. Each name is one plain directory (no path
// separator, not '.' or '..'); '' means the default. Returns the list, or null
// when any name is invalid. Shared by the validator and the inventory route.
export const OSS_INVENTORY_DEFAULT_NOTES_DIRS = 'research'
export function parseOssNotesDirs(raw: string): string[] | null {
  const names = raw.split(',').map((n) => n.trim()).filter((n) => n !== '')
  if (names.length === 0) return OSS_INVENTORY_DEFAULT_NOTES_DIRS.split(',')
  for (const n of names) {
    if (n === '.' || n === '..' || n.includes('/') || n.includes('\\') || n.length > 64 || n.startsWith('-')) return null
  }
  return [...new Set(names)]
}

function validOssNotesDirs(v: string): string | null {
  return parseOssNotesDirs(v) ? null : 'Vesszővel elválasztott mappanevek kellenek (pl. research,kutatas), útvonal-elválasztó és .. nélkül.'
}

// OSS_INVENTORY_OWN_OWNERS: comma-separated repository owner names for the
// open-source inventory. Clones the scan reaches that have a readable http(s)
// or ssh origin are listed unless their origin owner name is in
// OSS_INVENTORY_OWN_OWNERS; what the scan does not look inside is listed in
// scripts/opensource-inventory.py ("Git clones"). The owner name is the first
// path segment of the clone's own origin URL, matched on any host (the host is
// not compared); a fork of third-party code kept under such an owner is
// matched too. Ownership is not inferred from the installation's remotes.
// Returns the list (lower case, deduplicated), or null when a name is invalid.
const OSS_OWNER_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/
export function parseOssOwnOwners(raw: string): string[] | null {
  const names = raw.split(',').map((n) => n.trim()).filter((n) => n !== '')
  for (const n of names) {
    if (!OSS_OWNER_RE.test(n)) return null
  }
  return [...new Set(names.map((n) => n.toLowerCase()))]
}

function validOssOwnOwners(v: string): string | null {
  return parseOssOwnOwners(v) ? null : 'Vesszővel elválasztott fióknevek kellenek (pl. sajat-nev,sajat-ceg), útvonal és szóköz nélkül.'
}

function validFusionWeight(v: string): string | null {
  const t = v.trim()
  if (t === '') return null
  const n = Number(t)
  return Number.isFinite(n) && n >= 0 && n <= 10 ? null : '0 és 10 közötti szám szükséges (pl. 0.5).'
}

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
    key: 'KANBAN_WIP_TESTING',
    type: 'int',
    default: 0,
    min: 0,
    max: 100,
    description: 'A "testing" oszlop WIP-limitje (max. kártyaszám). 0 = korlátlan.',
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
    description: 'Ennyi napnál régebbi "done" kártyák automatikusan archiválódnak. Az óránként futó kanban-archiváló runner végzi (nem a lekérdezés).',
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
  // --- Kanban dispatch skip list (opt-in, hot-reload via settings-store) ---
  {
    key: 'KANBAN_DISPATCH_SKIP_AGENTS',
    type: 'string',
    default: '',
    description: 'Ügynökök, akiket a kártya in_progress-be húzása nem ébreszt fel, vesszővel elválasztva. Ez olyan ügynöknek való, aki maga osztja tovább a munkát, vagy akinek a feladatát más kézbesíti. Üres = mindenki ébred, mint eddig.',
    module: 'kanban',
    secret: false,
    requiresRestart: false,
    validate: (v) => validAgentNameList(v),
  },
  // --- Kanban claim lock (opt-in, hot-reload via settings-store) ---
  {
    key: 'KANBAN_CLAIM_LOCK',
    type: 'boolean',
    default: '0',
    description: 'Kártya-foglalás (claim lock). Bekapcsolva a POST /api/kanban/:id/claim és /release végpont atomi foglalást ad: egy kártyát egyszerre egy ügynök foglalhat, a második 409-et kap. Kikapcsolva (alapértelmezés) a két végpont 404-et ad (reason: claim_lock_disabled), és semmi nem kéri, hogy az ügynök foglaljon, mielőtt dolgozik. A függőség-alapú feloldás és a done-bizonyíték figyelmeztetés ettől független.',
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
    key: 'AGENT_API_ORIGIN',
    type: 'string',
    default: '',
    description: 'Az a cím, amin az ÜGYNÖKÖK érik el a dashboard API-ját onnan, ahol futnak (pl. http://localhost:3420 egy gépes telepítésnél, vagy egy belső szolgáltatás-név k8s-en). Üres = a régi viselkedés: DASHBOARD_PUBLIC_URL, annak hiányában localhost. Ez NEM a böngészőnek szóló publikus cím.',
    module: 'system',
    secret: false,
    requiresRestart: true,
  },
  {
    key: 'FLEET_PYTHON_VENV',
    type: 'string',
    default: '',
    description: 'A flotta közös Python venv mappája, abszolút útvonal (kezdő ~ = home; relatív útvonal nem érvényes). Ha a <mappa>/bin létezik, minden ügynök indítási PATH-jának elejére kerül, így a skillek sima python3 hívása és a venv CLI-jei (markitdown stb.) a venv-ből jönnek. Nincs beállítva (alapértelmezés) vagy nem létező mappa = kikapcsolva. Az itt üresen hagyott mező NEM kapcsolja ki a .env-ben megadott értéket: kikapcsoláshoz a .env-ből kell törölni, vagy itt nem létező mappát megadni (pl. /nonexistent).',
    module: 'system',
    secret: false,
    requiresRestart: true,
  },
  {
    key: 'MEMORY_CONTENT_FILTER_STRICT_COMMANDS',
    type: 'boolean',
    default: '0',
    description: 'A memória-tartalomszűrő szigorú parancs-szintaxis csoportja (curl http(s), bash -c, eval(, exec(, import subprocess, rm -rf). Alapértelmezés: kikapcsolva, a szűrő csak injekciós fordulatokat utasít el. Bekapcsolva ezek a minták is 400-at adnak a memória POST/PUT/PATCH-en. Ára: a parancsot csak IDÉZŐ szöveget (pl. biztonsági dokumentációt) is elutasítja. Akkor érdemes, ha a tárolt emlékeket olyan ügynök olvassa vissza, amelyen nincs bekötve a destructive-gate hook. A módosítás a dashboard újraindításakor lép életbe.',
    module: 'system',
    secret: false,
    requiresRestart: true,
  },
  {
    key: 'OSS_INVENTORY_NOTES_DIRS',
    type: 'string',
    default: OSS_INVENTORY_DEFAULT_NOTES_DIRS,
    description: 'Az átvett nyílt forrású projektek leltára (Kapcsolatok oldal) ezekből a mappákból olvassa az ügynökök kutatási jegyzeteit (csillagszám, mért előtte/utána hatás): vesszővel elválasztott mappanevek az ügynök mappáján belül, pl. research,kutatas. Üres = research. A következő leltár-frissítéskor érvényes.',
    module: 'system',
    secret: false,
    requiresRestart: false,
    validate: validOssNotesDirs,
  },
  {
    key: 'OSS_INVENTORY_OWN_OWNERS',
    type: 'string',
    default: '',
    description: 'Repó-tulajdonosnevek az átvett nyílt forrású projektek leltárához (Kapcsolatok oldal), vesszővel elválasztva, pl. a saját fiók(ok). A bejárás által elért, olvasható http(s)- vagy ssh-originű klónok a listán vannak, hacsak az origin-tulajdonosnevük nem szerepel az OSS_INVENTORY_OWN_OWNERS beállításban. A bejárás nem néz bele másik klónba, node_modules-ba, gyorsítótárakba, virtuális környezetekbe, kicsomagolt vendor-csomagokba és szimbolikus linkkel bekötött mappákba. A név a klón saját origin-címének első útvonal-tagja, bármelyik hoszton (a hosztot nem nézi); az egyező klónt megszámolja, nem listázza, egy ilyen tulajdonosnál tartott, harmadik féltől származó forkot is. A tulajdonjogot nem a telepítés remote-jaiból következteti ki. Az olvasható http(s)- vagy ssh-origin nélküli klónt megszámolja, nem listázza. A következő leltár-frissítéskor érvényes.',
    module: 'system',
    secret: false,
    requiresRestart: false,
    validate: validOssOwnOwners,
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
  {
    key: 'EMBED_URL',
    type: 'string',
    default: '',
    description: 'Az embedding-hívások Ollama alap-URL-je. Üres = az OLLAMA_URL-t használja. Külön kulcs, mert az OLLAMA_URL-t négy másik hívó a natív ollama API-ra használja, és az ágensek ANTHROPIC_BASE_URL-je is abból jön.',
    module: 'system',
    secret: false,
    requiresRestart: true,
  },
  {
    key: 'EMBED_MODEL',
    type: 'string',
    default: 'nomic-embed-text',
    description: 'A memória-embedding modellje. Váltás után MINDEN emléket újra kell embeddelni: a különböző dimenziójú vektorok nem összehasonlíthatók.',
    module: 'system',
    secret: false,
    requiresRestart: true,
  },
  {
    key: 'EMBED_DIMS',
    type: 'int',
    default: 0,
    min: 0,
    max: 8192,
    description: 'Matryoshka-csonkolás: a natív vektor első N eleme (a koszinusz újranormalizál). 0 = nincs csonkolás. Csak CSÖKKENTHET, rövidebb vektort nem told fel.',
    module: 'system',
    secret: false,
    requiresRestart: true,
  },
  {
    key: 'AGENT_LOCAL_BASE_URL',
    type: 'string',
    default: '',
    description: 'A lokál modellen futó ágensek ANTHROPIC_BASE_URL-je. Üres = az OLLAMA_URL-t használja. Külön kulcs, mert az OLLAMA_URL-t másik négy hívó a natív ollama API-ra (/api/tags, /api/generate) használja, amit egy Anthropic-kompatibilis proxy nem szolgál ki.',
    module: 'system',
    secret: false,
    requiresRestart: true,
  },
  {
    key: 'MEMORY_VECTOR_MIN_MARGIN',
    type: 'string',
    default: '0.1',
    description: 'Memória-keresés (hybrid), a vektor-ág küszöbe: egy csak vektor alapján talált emlék akkor marad a válaszban, ha a hasonlósága legalább ennyivel a lekérdezés medián-hasonlósága fölött van. 0 és 1 közötti szám, üres = 0.1. A 0.1 a nomic-embed-text modellen kalibrált érték; más EMBED_MODEL-nél újra kell mérni.',
    module: 'system',
    secret: false,
    requiresRestart: false,
    validate: (v) => validUnitFraction(v),
  },
  {
    key: 'MEMORY_VECTOR_BASELINE_MIN_ROWS',
    type: 'int',
    default: 10,
    min: 1,
    max: 100000,
    description: 'Memória-keresés (hybrid): ennyi pontozott emlék alatt (az ágens- és tier-szűrés UTÁN számolva) a medián helyett az abszolút küszöb (MEMORY_VECTOR_SMALL_CORPUS_MIN_SIMILARITY) érvényes.',
    module: 'system',
    secret: false,
    requiresRestart: false,
  },
  {
    key: 'MEMORY_VECTOR_SMALL_CORPUS_MIN_SIMILARITY',
    type: 'string',
    default: '0.72',
    description: 'Memória-keresés (hybrid), kis korpusz: a csak vektor alapján talált emlék minimális koszinusz-hasonlósága, ha kevesebb emlék van, mint a MEMORY_VECTOR_BASELINE_MIN_ROWS. 0 és 1 közötti szám, üres = 0.72. A nomic-embed-text modellen kalibrált érték; más EMBED_MODEL-nél újra kell mérni.',
    module: 'system',
    secret: false,
    requiresRestart: false,
    validate: (v) => validUnitFraction(v),
  },
  {
    key: 'EMBED_QUERY_PREFIX',
    type: 'string',
    default: '',
    description: 'A memória-keresés LEKÉRDEZÉSE elé fűzött szöveg az embedding előtt. Üres = nincs előtag (a korábbi viselkedés). Egyes modellek így tanultak, és előtag nélkül gyengébben keresnek. Pl. nomic-embed-text v2: "search_query: "; qwen3-embedding: "Instruct: <egymondatos feladatleírás>\\nQuery:" (a modellkártya Transformers-példája; a TEI-példája a "Query:" után szóközt tesz). A \\n az értékben sortörést jelent; a záró szóköz számít. Az EMBED_DOCUMENT_PREFIX-szel együtt állítandó; váltás után az emlékeket újra kell embeddelni (az embedding oszlop NULL-ra állítása után a POST /api/memories/backfill újraszámolja).',
    module: 'system',
    secret: false,
    requiresRestart: false,
  },
  {
    key: 'EMBED_DOCUMENT_PREFIX',
    type: 'string',
    default: '',
    description: 'A tárolt EMLÉK szövege elé fűzött szöveg az embedding előtt. Üres = nincs előtag (a korábbi viselkedés). Pl. nomic-embed-text v2: "search_document: "; a qwen3-embedding a dokumentumot előtag nélkül várja. A \\n az értékben sortörést jelent; a záró szóköz számít. Váltás után az emlékeket újra kell embeddelni (az embedding oszlop NULL-ra állítása után a POST /api/memories/backfill újraszámolja): a régi és az új vektorok nem összehasonlíthatók.',
    module: 'system',
    secret: false,
    requiresRestart: false,
  },
  {
    key: 'EMBED_KEEP_ALIVE',
    type: 'string',
    default: '',
    description: 'Az embedding-kéréssel küldött Ollama keep_alive (pl. "30m", "-1" = mindig betöltve, "0" = minden kérés után kirakja). Üres = nem küldjük, az Ollama alapértéke érvényes. Megosztott GPU-n a hosszabb érték megspórolja a modell újratöltését keresésenként, cserébe a modell tovább foglalja a memóriát.',
    module: 'system',
    secret: false,
    requiresRestart: false,
    validate: (v) => validKeepAlive(v),
  },
  {
    key: 'MEMORY_RRF_FTS_WEIGHT',
    type: 'string',
    default: '1',
    description: 'Memória-keresés (hybrid): a kulcsszó-ág súlya a rangsor-fúzióban (RRF). 0 és 10 közötti szám, üres = 1. 0 = a kulcsszó-ág nem befolyásolja a sorrendet (a csak általa talált emlékek a lista végére kerülnek; a küszöb alatti vektor-találatot attól még bent tartja, ha a kulcsszó-ág is megtalálta).',
    module: 'system',
    secret: false,
    requiresRestart: false,
    validate: (v) => validFusionWeight(v),
  },
  {
    key: 'MEMORY_RRF_VECTOR_WEIGHT',
    type: 'string',
    default: '1',
    description: 'Memória-keresés (hybrid): a vektor-ág súlya a rangsor-fúzióban (RRF). 0 és 10 közötti szám, üres = 1. A két súly aránya számít: pl. MEMORY_RRF_FTS_WEIGHT=0.5 és MEMORY_RRF_VECTOR_WEIGHT=1 a vektor-ágat részesíti előnyben, ha a kulcsszó-ág laza (VAGY-os) találatai lerontják a jó vektor-találatokat. Legalább az egyik súly legyen pozitív: két 0-s súllyal minden pontszám 0.',
    module: 'system',
    secret: false,
    requiresRestart: false,
    validate: (v) => validFusionWeight(v),
  },
  {
    key: 'MEMORY_IMPORT_CATEGORIZE_MODEL',
    type: 'string',
    default: '',
    description: 'Memória-importkor ezzel az Ollama modellel sorolja be az emlékeket (hot/warm/cold/shared), pl. gemma3:4b. FELÜLBÍRÁLÁS: ha be van állítva, pontosan ez a modell fut, helyettesítés nincs. Üres = a telepített gemma4 felismerése; ha nincs gemma4 és nincs beállítás, minden emlék warm, modellhívás nélkül. 4 GB VRAM-on a gemma3:4b bevált; gondolkodó modell (pl. qwen3) nagyon lassú.',
    module: 'system',
    secret: false,
    requiresRestart: true,
  },
  {
    key: 'TELEGRAM_PROGRESS_MODE',
    type: 'string',
    default: 'indicator',
    valueSet: ['silent', 'indicator', 'verbose'],
    description: 'Mennyit lásson a tulajdonos Telegramon a munkából. silent = semmi; indicator = egy eltűnő "gondolkodom" üzenet élő token-számlálóval, ami a kör végén törlődik; verbose = ugyanez, plusz a gondolatmenet megmaradó üzenetekben. Ez a flotta alapértelmezése -- egy ügynök felülírhatja a store/progress-config.json-ban.',
    module: 'channels',
    secret: false,
    requiresRestart: false,
  },
  {
    key: 'DASHBOARD_LANG',
    type: 'string',
    default: 'hu',
    valueSet: ['hu', 'en'],
    description: 'A dashboard alapértelmezett megjelenítési nyelve (hu = magyar, en = angol). A böngészőben mentett preferencia (localStorage) felülírja.',
    module: 'system',
    secret: false,
    requiresRestart: false,
  },
  {
    key: 'OWNER_DRIVE_FOLDER',
    type: 'string',
    default: '',
    description: 'A flotta közös Google Drive mappájának ID-je (a mappa-URL /folders/ utáni része). A generált kolléga-asszisztensek ide írják az eredmény-fájlokat. Üres = a generált agent a tulajdonostól kéri el a mappát. Hot-reload: agent-generáláskor olvasódik, nem igényel újraindítást.',
    module: 'system',
    secret: false,
    requiresRestart: false,
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
    // OFF by default, matching config.ts: an unset key resolves to false there
    // (deliberate opt-in -- a fresh/upgrading install must not silently spawn a
    // sub-agent that reads the operator's calendar and database). The registry
    // previously advertised '1', so the settings UI showed the feature as
    // enabled while it never booted -- a silent mismatch that can hide for
    // months.
    default: '0',
    valueSet: ['0', '1'],
    description: 'Heartbeat sub-ágens engedélyezése. 1 = bekapcsolva (újraindítás után lép életbe). Alapértelmezés: kikapcsolva.',
    module: 'heartbeat',
    secret: false,
    requiresRestart: true,
  },
  {
    key: 'HEARTBEAT_CALENDAR_ACCOUNT',
    type: 'string',
    default: '',
    description: 'Google Calendar fiók neve/e-mailje a heartbeat naptár-összefoglalóhoz. Üresen hagyva a heartbeat nem kérdez le naptáreseményeket.',
    module: 'heartbeat',
    secret: false,
    // Consumed as a boot-time const (src/config.ts) -- a saved override takes
    // effect on the next restart, and the UI must say so.
    requiresRestart: true,
  },
  {
    key: 'HEARTBEAT_CALENDAR_ID',
    type: 'string',
    default: '',
    description: 'Google Calendar naptár-azonosítója a heartbeat összefoglalóhoz (pl. primary). Üresen hagyva a heartbeat nem kérdez le naptáreseményeket.',
    module: 'heartbeat',
    secret: false,
    // Boot-time const, see HEARTBEAT_CALENDAR_ACCOUNT above.
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
  {
    key: 'VAULT_ACL_MODE',
    type: 'string',
    default: 'audit',
    valueSet: ['audit', 'enforce'],
    description: 'A vault-olvasás hozzáférés-szabálya. audit = minden olvasás naplózva, semmi nem tiltva; enforce = egy ügynök-nevet bevalló hívó (X-Agent-Id) csak a store/vault-acl.json-ban neki engedett titkot kapja meg, és a feloldó szkriptek nem oldanak fel helyben, ha a dashboard nem érhető el. Nyom és hozzáférés-szabály, nem elzárás: minden ügynök ugyanazzal a felhasználóval fut, és a mesterkulcs-fájl olvasható.',
    module: 'audit',
    secret: false,
    requiresRestart: false,
    loosens: (oldValue: string, newValue: string) => oldValue.trim() === 'enforce' && newValue.trim() !== 'enforce',
  },
  // --- Token usage module ---
  {
    key: 'TOKEN_USAGE_RETENTION_DAYS',
    type: 'int',
    default: 90,
    min: 7,
    max: 3650,
    description: 'A token-használati napló (token_usage tábla) megőrzési ideje napokban. A napi sweep ennél régebbi sorokat törli, így a tábla nem nő korlátlanul. A modell-javaslat csak az utolsó 30 napot nézi, de a token-dashboard (from nélkül a teljes táblát olvassa) és a havi költség-ledger (bármely korábbi hónap) annyira nyúl vissza, amennyit a megőrzés enged: a csökkentése ezek előzményét is rövidíti.',
    module: 'system',
    secret: false,
    requiresRestart: false,
  },
  {
    key: 'CONVERSATION_LOG_RETENTION_DAYS',
    type: 'int',
    default: 0,
    min: 0,
    max: 3650,
    description: 'A csatorna-beszélgetés napló (conversation_log tábla) megőrzési ideje napokban. 0 = örökre megőrzi (ez az alapértelmezés, a napi sweep ilyenkor semmit nem töröl). Ha bekapcsolod, a javasolt érték 90 nap: a napi digest és a heartbeat csak az utolsó napokat nézi. Figyelem: ha a naplót audit-forrásnak használod, a bekapcsolás az ennél régebbi sorokat véglegesen törli.',
    module: 'system',
    secret: false,
    requiresRestart: false,
  },
  {
    key: 'OTEL_SPAN_RETENTION_DAYS',
    type: 'int',
    default: 0,
    min: 0,
    max: 365,
    description: 'A trace-telemetria (otel_spans tábla) megőrzési ideje napokban. 0 = örökre megőrzi (ez az alapértelmezés, a napi sweep ilyenkor semmit nem töröl). Ha bekapcsolod, a javasolt érték 14 nap: tisztán diagnosztikai adat, ezért rövidebb a többinél.',
    module: 'system',
    secret: false,
    requiresRestart: false,
  },
  {
    key: 'AGENT_MESSAGE_RETENTION_DAYS',
    type: 'int',
    default: 0,
    min: 0,
    max: 3650,
    description: 'A lezárt (done/failed) ágensközi üzenetek (agent_messages tábla) megőrzési ideje napokban. 0 = örökre megőrzi (ez az alapértelmezés, a napi sweep ilyenkor semmit nem töröl). Ha bekapcsolod, a javasolt érték 30 nap. A pending és delivered sorok SOHA nem törlődnek koruk miatt, mert azok még kézbesítés/feldolgozás alatt állnak.',
    module: 'system',
    secret: false,
    requiresRestart: false,
  },
  {
    key: 'TOOL_CALL_LOG_RETENTION_DAYS',
    type: 'int',
    default: 0,
    min: 0,
    max: 365,
    description: 'A tool-hívás napló (tool_call_log tábla) megőrzési ideje napokban. 0 = örökre megőrzi (ez az alapértelmezés, a napi sweep ilyenkor semmit nem töröl). Ha bekapcsolod, a javasolt érték 30 nap: a workflow-jelölt elemzés az utolsó napokból dolgozik.',
    module: 'system',
    secret: false,
    requiresRestart: false,
  },
  // --- Channels module ---
  {
    key: 'MAIN_AGENT_ISOLATED_CONFIG',
    type: 'boolean',
    default: '0',
    description: 'Bármely platformon: a fő channels-agent kapjon-e saját, izolált CLAUDE_CONFIG_DIR-t (mint a sub-agentek). Bekapcsolva a fő agent a hosszú élettartamú fleet setup-tokenből (store/.claude-oauth-token) hitelesít, nem a megosztott, önmagát frissítő session-hitelesítésből (macOS: rotálódó Keychain OAuth-session; Linux: megosztott ~/.claude/.credentials.json) -- mindkettő periodikusan lejár. Ha a token exportálva van, a dokumentált precedencia szerint az nyer a /login session-nel szemben. A korábbi "a lejárt fájl nyer" állítás (2026-07-23) FELÜLMÉRVE 10-09 (flotta-mérés, msg 36667, issue #1805): Claude Code 2.1.294-en lejárt credentials-fájl mellett az érvényes env-token hitelesített; a Keychainben tárolt login esetét ez nem mérte. Token hiányában no-op. A módosítás a channels session újraindításakor lép életbe.',
    module: 'channels',
    secret: false,
    requiresRestart: true,
  },
  {
    key: 'BASH_EGRESS_HOST_ALLOW',
    type: 'boolean',
    default: '0',
    description: 'Bash-letöltés hoszt szerint (curl https:// és wget). Kikapcsolva (alapértelmezés) a "Bash(curl *https://*)" és "Bash(wget *)" deny-szabályok minden ágensen tiltják ezt a két parancsot, hoszttól függetlenül; a store/egress-vendor-hosts.json listája rájuk nem hat, mert a deny minden engedélyt felülír. Bekapcsolva ez a négy deny-sor lekerül azokról az ágensekről, amelyeken a bash-egress-parser hook fut (a fő ágensen ehhez a dashboard a projekt .claude/settings.local.json fájljába --main-scope bejegyzést tesz, kikapcsoláskor kiveszi; a követett .claude/settings.json egyik állásban sem változik), és a hook dönt: localhost, helyi hálózat és a vendor-listán szereplő hoszt átmegy, minden más tiltva marad. A rövidített kapcsolót a hook úgy oldja fel, ahogy a curl és a wget; tiltva marad az ismeretlen vagy kétértelmű kapcsoló, a wget -e (néhány ártalmatlan beállítás kivételével), a konfigfájlból olvasott cél (curl -K, wget -i/--config), a proxy- vagy rc-változó (https_proxy, WGETRC, CURL_HOME, HOME) megadása a parancsban, és a futásidőben kiszámított cél (változóból, fájlból vagy $(...)-ből jövő hoszt, pl. a vaultból kiolvasott URL): a hosztnak szó szerint a parancsban kell állnia. MARADÉK KOCKÁZAT: egy korábbi hívással megírt ~/.wgetrc vagy ~/.curlrc proxyt vagy további URL-t adhat minden curl/wget futásnak, ezt a hook nem látja; és az átirányítás (a wget alapból, a curl -L-lel követi) a vendor-hosztról más hosztra is vihet. A gazda saját Claude-sessionje egyik állásban sem korlátozott. Az nc/ncat/telnet tiltás mindkét állásban marad. A módosítás a dashboard újraindításakor és az ágensek következő indításakor lép életbe.',
    module: 'system',
    secret: false,
    requiresRestart: true,
  },
  {
    key: 'BASH_SANDBOX_AGENTS',
    type: 'string',
    default: '',
    // Taking an agent OFF the list loosens it; adding one does not.
    loosens: (oldValue, newValue) => {
      const ids = (v: string) => new Set(v.split(/[\s,]+/).map((w) => w.trim().toLowerCase()).filter(Boolean))
      const next = ids(newValue)
      return [...ids(oldValue)].some((id) => !next.has(id))
    },
    description: 'Bash-sandbox ágensenként (Claude Code beépített sandboxa, macOS). Az itt felsorolt ágensek (azonosító, vesszővel vagy szóközzel elválasztva, pl. "soma") minden Bash-parancsa és annak minden gyerekfolyamata, a fájlba írt és úgy futtatott szkript is (python3 crawl.py), csak a store/egress-vendor-hosts.json listáján szereplő hosztot éri el (a "domains" bejegyzés aldomainjeivel együtt), a localhostot és a helyi hálózatot. Minden más hoszt kérdés nélkül tiltva, nyers sockettel is. Írni a saját mappájába, a ~/worktrees/<azonosító> alá, a temp-mappába és a store/bash-sandbox-write-paths.json-ban neki megadott helyekre tud. A beállítást a dashboard minden indításkor a store/bash-sandbox/<azonosító>.settings.json fájlba írja, és --settings kapcsolóval adja át; ha nem tudja megírni, vagy az ágens távoli gépen fut, az ágens NEM indul el. Üresen (alapértelmezés) senki nincs sandboxban. A fő ágensre nem hat. Ágenst felvenni bármely hívó tud, LEVENNI csak bejelentkezett gazda-session vagy teljes jogú eszközkulcs (a közös tokennel nem, mert azt minden ágens is birtokolja), illetve a store/config-overrides.json kézi szerkesztése. NEM fedi: a hookok és az MCP-szerverek hálózatát (azok a sandboxon kívül futnak), a Write/Edit eszközt, és a headless Chrome-ot (a sandboxban nem indul el). A módosítás az ágens következő indításakor lép életbe.',
    module: 'system',
    secret: false,
    requiresRestart: true,
  },
  {
    key: 'NOTIFY_SLACK_TARGET',
    type: 'string',
    default: '',
    description: 'A tulajdonosnak szóló értesítések (heartbeat-összefoglaló, biztonsági és egyéb gazda-értesítések) Slack-célja: "dm" (a gazda DM-je), egy csatorna neve a store/slack-channels.json térképből, vagy egy C/G/D-vel kezdődő Slack-azonosító. Üresen (alapértelmezés) nincs Slack-küldés. A küldés a fő ágens Slack-bot tokenjével megy.',
    module: 'channels',
    secret: false,
    requiresRestart: false,
  },
  {
    key: 'NOTIFY_SLACK_ALERT_TARGET',
    type: 'string',
    default: '',
    description: 'Az üzemeltetési riasztások (watchdog, újraindítás, beragadt munkamenet, context-guard) Slack-célja, ugyanabban az alakban, mint a NOTIFY_SLACK_TARGET. Üresen a NOTIFY_SLACK_TARGET-et használja.',
    module: 'channels',
    secret: false,
    requiresRestart: false,
  },
  {
    key: 'NOTIFY_TELEGRAM',
    type: 'boolean',
    default: '1',
    description: 'Menjen-e az értesítés Telegramra is. Bekapcsolva (alapértelmezés) a Telegram-küldés változatlan, a Slack mellé kerül. Kikapcsolva, ha van Slack-cél, csak Slackre megy; ha a Slack-küldés elbukik, a Telegram tartalékként mégis kimegy, hogy semmi ne vesszen el.',
    module: 'channels',
    secret: false,
    requiresRestart: false,
  },
  {
    key: 'NOTIFY_TELEGRAM_FALLBACK',
    type: 'boolean',
    default: '1',
    description: 'Mehet-e Telegram TARTALÉKKÉNT, ha a Slack-értesítés nem megy ki (nincs Slack-cél, a Slack-modul nem töltődik be, vagy a küldés hibát ad). Bekapcsolva (alapértelmezés) semmi nem vész el: a Telegram átveszi. Kikapcsolva a Telegram SOHA nem kap értesítést tartalékként: a Slack-hiba hangos naplósor (a notify.sh nem nullával lép ki), és az ütemezett feladatok tartalék-utasítása is a notify.sh-t nevezi meg. A NOTIFY_TELEGRAM a "menjen-e MELLÉ" kérdés, ez a "menjen-e HELYETTE".',
    module: 'channels',
    secret: false,
    requiresRestart: false,
  },
  {
    key: 'SLACK_OWNER_USER_ID',
    type: 'string',
    default: '',
    description: 'A gazda Slack user-azonosítója (U...), a "dm" cél ehhez nyit DM-et. Üresen a fő ágens Slack access.json-jából veszi, ha ott pontosan egy engedélyezett felhasználó áll.',
    module: 'channels',
    secret: false,
    requiresRestart: false,
  },
  {
    key: 'SCHEDULED_DELIVERY_CHANNEL',
    type: 'string',
    default: '',
    description: 'Hova menjen a fő ágens ütemezett feladatainak eredménye, "<csatorna>:<chat id>" alakban (csatorna: telegram, slack, discord, googlechat, teams), pl. "slack:D0123456789". Üresen (alapértelmezés) a fő ágens saját csatornája marad. Az al-ágensek feladataira nem hat, és az a feladat, amelyik saját chatet vagy "none"-t ad meg, megtartja. Ha a cél nem Telegram, és ott a küldés nem megy, a gazda Telegram-chatje (ALLOWED_CHAT_ID) a tartalék. Hibás érték esetén nincs felülírás, csak naplóbejegyzés.',
    module: 'channels',
    secret: false,
    requiresRestart: false,
  },
  {
    key: 'MAIN_AGENT_CONFIG_DIR',
    type: 'string',
    default: '',
    // SECSZIVEK1007: the same path rules as an agent's claudeConfigDir and a
    // plan's configDir (expandAndValidateConfigDir); the value reaches the
    // channels launch command. Empty = unset, allowed.
    validate: (v) => (v.trim() === '' || expandAndValidateConfigDir(v, homedir()) !== null
      ? null
      : 'Érvénytelen könyvtár: csak betű, szám és a _ . / ~ - karakterek, ".." nélkül, a ~ csak az elején (~/...).'),
    description: 'A fő channels-agent explicit CLAUDE_CONFIG_DIR-je (pl. ~/.claude-bot). Akkor kell, ha a botnak SAJÁT Claude-loginja van, külön a flottáétól: a MAIN_AGENT_ISOLATED_CONFIG erre nem alkalmas, mert az a fleet setup-tokenből hitelesít, tehát a flotta identitását adja a botnak (és token nélkül no-op). Üresen hagyva a fő agent a közös ~/.claude-ot használja (alapértelmezés). Ha a megadott könyvtár nem létezik, a beállítás no-op és figyelmeztetést logol. Elsőbbséget élvez a MAIN_AGENT_ISOLATED_CONFIG-gal szemben. A módosítás a channels session újraindításakor lép életbe.',
    module: 'channels',
    secret: false,
    requiresRestart: true,
  },
  // The opt-in switches below are boot-time consts in src/config.ts
  // (cfg(): config-overrides.json > .env), so a value saved here takes effect
  // only after the dashboard restarts. Default '0' matches config.ts, where an
  // unset key resolves to false.
  {
    key: 'SUBAGENT_INBOX_TEE',
    type: 'boolean',
    default: '0',
    description: 'Telegramos sub-agentek bejövő üzeneteinek lemezre tükrözése (inbound-tee). Bekapcsolva a sub-agent a csatorna-plugint egy saját mcp.json-on keresztül, a scripts/channel-inbound-tee.mjs burkolóval tölti be (--channels helyett), és minden bejövő üzenet a <state>/inbox-pending.jsonl fájlba is kerül, ahonnan a channel-inbox-drain hook a következő körbe húzza be. Ez a bejövő üzenetek tartalmát lemezre írja. A fő agentre és a nem Telegramos agentekre nem vonatkozik. Alapértelmezés: kikapcsolva (változatlan --channels út). A SUBAGENT_TELEGRAM_WAKE_ENABLED csak ezzel együtt csinál bármit. A módosítás a dashboard újraindítása után, és agentenként a sub-agent következő indításakor lép életbe.',
    module: 'channels',
    secret: false,
    requiresRestart: true,
  },
  {
    key: 'SUBAGENT_TELEGRAM_WAKE_ENABLED',
    type: 'boolean',
    default: '0',
    description: 'A message-router felébreszti azt a tétlen Telegramos sub-agentet, akinek a <state>/inbox-pending.jsonl fájljában beragadt bejövő üzenet van, hogy a drain hook behúzza őket. Csak SUBAGENT_INBOX_TEE=1 mellett van hatása: anélkül nem keletkezik inbox-fájl, és a figyelő no-op. Alapértelmezés: kikapcsolva. A módosítás a dashboard újraindításakor lép életbe.',
    module: 'channels',
    secret: false,
    requiresRestart: true,
  },
  {
    key: 'WORKER_AUTOUPDATE',
    type: 'boolean',
    default: '0',
    description: 'Egyetlen kijelölt Claude Code frissítő. Alapból minden indított claude DISABLE_AUTOUPDATER=1-gyel fut, hogy két session ne írja egyszerre a közös telepítést. Bekapcsolva PONTOSAN egy session, a lassú worker indul nélküle, és natív telepítésen naprakészen tartja a Claude Code-ot; a gyors worker, a channels session és a sub-agentek továbbra is rögzítve maradnak. npm-es telepítésen hatástalan (ott a channels.sh claude_ensure frissít). A futó sessionök a régi verzión maradnak, az újat a következő indításukkor veszik fel. A módosítás a dashboard újraindítása után, a lassú worker következő indításakor lép életbe.',
    module: 'agents',
    secret: false,
    requiresRestart: true,
  },
  {
    key: 'VOICE_TRANSCRIBE_INBOUND',
    type: 'boolean',
    default: '0',
    description: 'Telepítés-szintű alapértelmezés a bejövő hangüzenetek átiratához a text módú ügynököknél. Bekapcsolva minden olyan text módú ügynöknél helyi faster-whisper átirat készül, amelynek az agent-config.json-jában nincs voice.transcribeInbound beállítás (az ügynökönkénti érték felülírja ezt). A voice/auto módú ügynököknél az átirat ettől függetlenül mindig elkészül. Hangüzenetenként CPU-időbe kerül. Alapértelmezés: kikapcsolva. A módosítás a dashboard újraindításakor lép életbe.',
    module: 'channels',
    secret: false,
    requiresRestart: true,
  },
  {
    key: 'TELEGRAM_TOPICS_ENABLED',
    type: 'boolean',
    default: '0',
    description: 'Telegram-témák: ha a bot privát chatjében témák vannak, a válasz abba a témába megy, ahonnan az üzenet jött, és a gépelés-jelzés is ott látszik. Bekapcsolva a csatorna-indítás egy kiegészítést tesz a Telegram plugin forrására (scripts/patch-telegram-plugin.py), ami a bejövő üzenet téma-azonosítóját átadja az ügynöknek, és a reply toolt témába küldésre is képessé teszi; kikapcsolva a kiegészítést leveszi, és a plugin pontosan a mai. A privát chatben a témákat a BotFather-ben kell bekapcsolni. A riasztások, a jóváhagyás-kérések és a többi rendszerüzenet ettől függetlenül téma nélkül megy ki. Alapértelmezés: kikapcsolva. A módosítás a csatorna következő indításakor lép életbe.',
    module: 'channels',
    secret: false,
    requiresRestart: true,
  },
  {
    key: 'PERMISSION_ALERT_MARKS',
    type: 'string',
    default: '15m,30m,1h,2h,8h,24h',
    description: 'Mikor szóljon a figyelő egy megválaszolatlan engedélykérő dialógusról: vesszővel elválasztott időpontok a dialógus megjelenésétől számítva, például 15m,30m,1h,2h,8h,24h (s = másodperc, m = perc, h = óra, d = nap; a mértékegység nélküli szám perc). Az utolsó érték egyben az ismétlési idő is, az alapértelmezéssel tehát az első nap után naponta egy üzenet megy, amíg a kérdés áll. A 0 első értékként azonnali jelzést jelent. Egy al-ügynök engedélykéréséről a fő ügynök azonnal üzenetet kap; az első érték az ő előnye, utána szól a figyelő neked. Értelmezhetetlen érték esetén az alapértelmezés marad érvényben, és ez a naplóba kerül. Billentyűt a figyelő ilyenkor sosem küld, csak üzen. A módosítás a dashboard újraindításakor lép életbe.',
    module: 'channels',
    secret: false,
    requiresRestart: true,
  },
  // --- System module ---
  {
    key: 'SCHEDULER_TZ',
    type: 'string',
    default: '',
    description: 'A telepítés időzónája (IANA, pl. Europe/Budapest). EGY zóna vezérli az ütemezést (cron) ÉS minden megjelenített időt (heartbeat, napi napló, memória-címkék). Üresen hagyva a gép saját időzónáját használja. A módosítás a szolgáltatás újraindításakor lép életbe.',
    module: 'system',
    secret: false,
    requiresRestart: true,
    valueSet: ['Europe/London', 'Europe/Budapest', 'UTC', 'Europe/Dublin', 'Europe/Berlin', 'Europe/Bucharest', 'America/New_York'],
  },
  {
    key: 'AGENT_INHERITED_MCP_SERVERS',
    type: 'string',
    default: '',
    description: 'Vesszővel elválasztott MCP-szerver-nevek, amelyeket egy ÚJ ügynök örökölhet (pl. aiam-blog). Minden más kimarad, amíg valaki név szerint oda nem adja. Üresen hagyva az új ügynök semmilyen connectort nem örököl (szűk alapértelmezés). Két helyről örököl: a projekt-gyökér .mcp.json-jából és a közös ~/.claude.json-ból, és a lista mindkettőre vonatkozik. A meglévő ügynöktől semmit nem vesz el. A fő ügynökre nem vonatkozik.',
    module: 'agents',
    secret: false,
    requiresRestart: false,
  },
  // Opt-in (#1705 maintainer decision, 2026-10-14): read per spawn by
  // agent-scaffold.ts (ytDlpIngestOnly / bashEgressDeny). Off == the generated
  // settings are byte-identical to an install without the switch.
  {
    key: 'YT_DLP_INGEST_ONLY',
    type: 'boolean',
    default: '0',
    description: 'yt-dlp csak a scripts/yt-ingest/yt-ingest.sh izolált lépésén át. Bekapcsolva minden ügynök (a fő ügynök is, ha saját config-könyvtára van) deny-szabályt kap a közvetlen yt-dlp hívásra (yt-dlp, <út>/yt-dlp, python -m yt_dlp), a ytIngest-es profil (researcher) pedig engedélyt a yt-ingest.sh és a yt-read.sh futtatására. Figyelem: a yt-dlp-t közvetlenül hívó skillek ezután megtagadást kapnak. Önmagában nem elég: a yt-ingest.sh csak akkor tölt le, ha a store/egress-allowlist.json binary_egress["yt-dlp"] kulcsa engedi (Linuxon bwrap is kell). Az ügynökök következő indításakor lép életbe.',
    module: 'agents',
    secret: false,
    requiresRestart: true,
  },
  {
    key: 'DEFAULT_AGENT_MODEL',
    type: 'string',
    default: DISTRIBUTION_DEFAULT_AGENT_MODEL,
    description: 'Az új ügynökök alapértelmezett modellje, egyben a háttér-worker sessionök modellje. Meglévő ügynökök NEM változnak: akinek az agent-config.json-jában konkrét modell van, az marad. A módosítás a szolgáltatás újraindításakor lép életbe.',
    module: 'agents',
    secret: false,
    requiresRestart: true,
    valueSet: [
      // Opus 5.5: ONLY the 1M variant is offered (owner decision 2026-09-23, Marveen 28541).
      'claude-opus-5-5[1m]',
      'claude-opus-5',
      'claude-opus-5[1m]',
      'claude-sonnet-5-5',
      'claude-sonnet-5',
      'claude-fable-5',
      'claude-fable-5-1',
      'claude-opus-4-8[1m]',
      'claude-haiku-5-5',
      'claude-haiku-4-5-20251001',
    ],
  },
  // --- Claude plans module (PR2b/PR2c) ---
  // Gates BOTH POST /api/claude-plans/rotate (returns 409 while off) and the
  // heartbeat script's decision to call it (scripts/claude-plan-rotate-check.ts)
  // -- see docs/superpowers/specs/2026-09-11-claude-key-rotation-design.md
  // sections 6-7. Default OFF: staging verification (live session-restart,
  // the riskiest part of this feature) happens before an operator ever flips
  // this to '1'.
  {
    key: 'CLAUDE_ROTATION_ENABLED',
    type: 'boolean',
    default: '0',
    description: 'Automata Claude-kulcs rotáció: ha a fő agent aktív előfizetése kifogy, automatikusan váltson egy másik regisztrált planre. Előfeltétel: MAIN_AGENT_ISOLATED_CONFIG=1 és legalább 2 regisztrált plan a claude-plans.json-ban. A váltás a fő agent session-jének újraindításával jár. Bekapcsoláskor a 10 percenkénti rotációs heartbeat ütemezés (claude-plan-rotate-check) automatikusan létrejön, ha még nincs; a hiányzó előfeltételeket a Claude plans fül figyelmeztetése mutatja.',
    module: 'claude-plans',
    secret: false,
    requiresRestart: false,
  },
  // Opt-in: the shared fleet token (store/.claude-oauth-token) follows the
  // main agent's rotation. Default OFF -- with it off, a rotation touches the
  // main agent only, exactly as before. Read at rotation time by
  // POST /api/claude-plans/rotate (src/web/claude-plan-fleet-wiring.ts).
  {
    key: 'CLAUDE_ROTATION_FLEET',
    type: 'boolean',
    default: '0',
    description: 'A flotta is kövesse a rotációt: amikor a fő agent egy token-módú planre vált, a közös flotta-token (store/.claude-oauth-token) is erre a plan tokenjére cserélődik (mentéssel), és minden olyan sub-agent újraindul, amely ezt a közös tokent használja. Saját tokenes / saját configDir-os agenteket nem érint. configDir-módú célplannél a flotta-lépés kimarad. Előfeltétel: CLAUDE_ROTATION_ENABLED=1.',
    module: 'claude-plans',
    secret: false,
    requiresRestart: false,
  },
  // On-demand refresh of IDLE plans' 5h/7d usage by the rotation heartbeat
  // (scripts/claude-plan-rotate-check.ts -> refreshIdlePlans). Each probe is a
  // real Messages API call that spends the probed plan's own quota, so it only
  // fires while the ACTIVE plan is near a limit (IDLE_PROBE_GATE in
  // claude-plan-rotation.ts), right before the rotation decision that uses the
  // numbers. With a healthy active plan it costs nothing, hence default ON;
  // this key is the operator's off switch. Independent of
  // CLAUDE_ROTATION_ENABLED.
  {
    key: 'CLAUDE_PLAN_USAGE_REFRESH',
    type: 'boolean',
    default: '1',
    description: 'Igény szerinti lekérdezés engedélyezése: a rotációs heartbeat a tétlen (épp nem használt) token-módú planek 5 órás és heti keretét CSAK akkor kérdezi le élőben, ha az aktív plan közel jár a határhoz (5 órás keret legalább 80%, vagy heti legalább 85%), közvetlenül a váltási döntés előtt, hogy az friss számokkal dolgozzon. Planenként legfeljebb 30 percenként. Minden lekérdezés egy valódi, minimális API-hívás az adott plan saját keretéből, de amíg az aktív plan rendben van, egyetlen hívás sem történik, ezért alapból BE. Kikapcsolva a tétlen planek utolsó ismert értéke marad érvényben.',
    module: 'claude-plans',
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

  if (def.type === 'boolean') {
    // Normalise any of true/false, 1/0, "1"/"0", "true"/"false" to the
    // canonical "1"/"0" string so it round-trips through .env and the bash
    // launcher (which compares against "1") identically.
    const s = String(raw).trim().toLowerCase()
    if (raw === true || s === '1' || s === 'true') return { ok: true, value: '1' }
    if (raw === false || s === '0' || s === 'false' || s === '') return { ok: true, value: '0' }
    return { ok: false, error: 'Logikai érték szükséges (be/ki).' }
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
  if (def.validate) {
    const err = def.validate(String(raw))
    if (err) return { ok: false, error: err }
  }
  return { ok: true, value: String(raw) }
}
