// Support access: the sh LAUNCHER of the kit (SUPPORTMENTOUT1114), made from
// scripts/support-access.in by filling in the values below. One source for
// every name, number and the loader text: the routine's constants. The build
// (scripts/build-support-standby.mjs) writes scripts/support-access; a test
// fails when the committed file is not what this gives.
//
// The loader text goes into the launcher between single quotes, word for word
// the same as KIT_LOADER_SOURCE (the dashboard's opening path runs the same
// text), so it must hold no single quote; the render refuses one.
import { KIT_LOADER_EXIT, KIT_LOADER_SOURCE, KIT_RUN_ENV } from './support-kit-loader.js'
import { KIT_DISPATCHER_NAME, KIT_LAUNCHER_NAME, KIT_ROUTINE_NAME } from './support-kit-sources.js'
import { KIT_MANIFEST_MAX_BYTES, KIT_MANIFEST_NAME, KIT_MAX_FILES, KIT_SUBFOLDER } from './support-kit.js'
import { SUPPORT_DIR_IN_HOME } from './support-kit-install.js'
import { SUPPORT_CODE_SHAPE } from './support-access-redeem.js'

/** The template, relative to the install root. */
export const SUPPORT_LAUNCHER_TEMPLATE = 'scripts/support-access.in'
/** The launcher in the install tree; install-kit copies it into the kit as KIT_LAUNCHER_NAME (0700). */
export const SUPPORT_LAUNCHER_FILE = 'scripts/support-access'
/** The routine in the install tree: what `disable` runs (closing does not depend on the kit; N14/a). */
export const SUPPORT_TREE_ROUTINE = 'scripts/support-standby.mjs'

/** The code shape as a sh case pattern: `msc_` and 32 characters of the code alphabet. */
export function supportCodeGlob(): string {
  // The shape is pinned here; a test fails when the redeem module's pattern changes without this.
  if (SUPPORT_CODE_SHAPE.source !== '^msc_[A-Za-z0-9_-]{32}$') throw new Error('the one-time code shape changed; update supportCodeGlob')
  return 'msc_' + '[A-Za-z0-9_-]'.repeat(32)
}

/** The launcher text for the template text `template`. Throws on an unknown or missing placeholder. */
export function renderSupportLauncher(template: string): string {
  if (KIT_LOADER_SOURCE.includes("'")) throw new Error('the loader text holds a single quote; it cannot go between single quotes')
  const runPath = KIT_RUN_ENV.PATH
  if (Object.keys(KIT_RUN_ENV).join(',') !== 'PATH,LC_ALL' || KIT_RUN_ENV.LC_ALL !== 'C' || !/^[a-z/:]+$/.test(runPath)) {
    throw new Error('KIT_RUN_ENV changed; the launcher starts node with exactly PATH and LC_ALL=C')
  }
  const values: Record<string, string> = {
    GENERATED_NOTE: 'GENERATED FILE, DO NOT EDIT. Source: ' + SUPPORT_LAUNCHER_TEMPLATE + ' and src/support-access-launcher.ts. Rebuild: node scripts/build-support-standby.mjs',
    SUPPORT_DIR: SUPPORT_DIR_IN_HOME,
    KIT_DIR: KIT_SUBFOLDER,
    MANIFEST: KIT_MANIFEST_NAME,
    MANIFEST_MAX_BYTES: String(KIT_MANIFEST_MAX_BYTES),
    // One byte more than the limit is read, so a larger manifest is seen as larger, never as cut.
    MANIFEST_READ_BYTES: String(KIT_MANIFEST_MAX_BYTES + 1),
    MAX_FILES: String(KIT_MAX_FILES),
    LAUNCHER: KIT_LAUNCHER_NAME,
    DISPATCHER: KIT_DISPATCHER_NAME,
    ROUTINE: KIT_ROUTINE_NAME,
    TREE_ROUTINE: SUPPORT_TREE_ROUTINE,
    RUN_PATH: runPath,
    LOADER_USAGE: String(KIT_LOADER_EXIT.usage),
    LOADER_MISMATCH: String(KIT_LOADER_EXIT.mismatch),
    LOADER_UNREADABLE: String(KIT_LOADER_EXIT.unreadable),
    LOADER_FAILED: String(KIT_LOADER_EXIT.failed),
    CODE_GLOB: supportCodeGlob(),
    KIT_LOADER_SOURCE,
  }
  const used = new Set<string>()
  const out = template.replace(/@@([A-Z_]+)@@/g, (_m, key: string) => {
    if (!Object.prototype.hasOwnProperty.call(values, key)) throw new Error('unknown placeholder @@' + key + '@@')
    used.add(key)
    return values[key]
  })
  const unused = Object.keys(values).filter((k) => !used.has(k))
  if (unused.length > 0) throw new Error('placeholders not in the template: ' + unused.join(', '))
  return out
}
