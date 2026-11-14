// Support access: which files of the install tree make up the kit, and the
// sha256 of each, STORED IN THE REPO.
//
// The stored values live in one committed text file, scripts/support-kit.sha256,
// in the format `sha256sum` prints (`<64 hex>  <name>`, one line per file, in
// name order). It is a separate file, not a constant in this module, because
// the routine's own file is one of the files it names, and a file cannot hold
// its own hash. scripts/build-support-standby.mjs writes it after the routine;
// a test fails when it does not match the files in the tree.
//
// Why stored and not computed at install time: a file that was already damaged
// in the tree (a half-finished update) must not be certified by hashing what is
// there. The kit writer measures each tree file against its stored value first.

/** The hashes file, relative to the install root. */
export const KIT_HASHES_FILE = 'scripts/support-kit.sha256'

export interface KitSource {
  /** The name in the kit (and in the hashes file). */
  readonly name: string
  /** Where the file is in the install tree, relative to the install root. */
  readonly treePath: string
  /** A file the user starts directly (0700). The dispatcher is started through `/bin/sh` and is not one. */
  readonly executable: boolean
}

/** Every file of the kit but the manifest, in name order. The launcher joins when it exists. */
export const KIT_SOURCES: readonly KitSource[] = [
  { name: 'support-dispatch.sh', treePath: 'scripts/support-dispatch.sh', executable: false },
  { name: 'support-standby.mjs', treePath: 'scripts/support-standby.mjs', executable: false },
]

const HASH_LINE = /^([0-9a-f]{64}) {2}([a-z0-9][a-z0-9._-]{0,63})$/

/**
 * The stored hashes, or null for anything but the exact format: one line per
 * kit file, every kit file named once and nothing else, in name order, LF line
 * ends, a final LF. What it says decides what may be written into the kit.
 */
export function parseKitHashes(text: string): ReadonlyMap<string, string> | null {
  if (!text.endsWith('\n')) return null
  const lines = text.slice(0, -1).split('\n')
  const out = new Map<string, string>()
  for (const line of lines) {
    const m = HASH_LINE.exec(line)
    if (m === null || out.has(m[2])) return null
    out.set(m[2], m[1])
  }
  const expected = KIT_SOURCES.map((s) => s.name)
  return [...out.keys()].join('\n') === expected.join('\n') ? out : null
}

/** The text of the hashes file for these values. */
export function formatKitHashes(hashes: ReadonlyMap<string, string>): string {
  return KIT_SOURCES.map((s) => {
    const hash = hashes.get(s.name)
    if (hash === undefined || !/^[0-9a-f]{64}$/.test(hash)) throw new Error('no stored hash for ' + s.name)
    return hash + '  ' + s.name + '\n'
  }).join('')
}
