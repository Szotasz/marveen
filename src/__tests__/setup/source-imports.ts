/**
 * Source-level import assertions shared by the suites that check a defence is
 * WIRED UP, not just present (TESZTIMPORTUTIL922).
 *
 * WHY THIS EXISTS: four suites used to compare an import line VERBATIM, e.g.
 *
 *   expect(src).toContain("import { isKnownAgent } from '../agent-config.js'")
 *
 * That fires on the first CO-IMPORT even though the defence is untouched, which
 * is exactly what happened to an outside contributor on #1448. Asking a
 * contributor to bend correct code around a brittle string of ours is the wrong
 * direction, so the assertion was relaxed (IMPORTKAPULAZ921) and now lives here,
 * in one place, rather than being re-invented per suite.
 *
 * The relaxation stays a GATE: it reads the value binding out of the import
 * statement, so removing the import still turns the assertion red.
 */

/**
 * True when `source` imports `binding` from `module` as a VALUE.
 *
 * Co-imports, any member order and multi-line import statements all count; a
 * type-only import does not, because it is erased at runtime and a guard that is
 * not there at runtime is not a guard. An aliased import still reports the
 * exported name -- the sibling assertion on the CALL is what catches an alias.
 */
export function importsValueBinding(source: string, binding: string, module: string): boolean {
  const spec = module.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`import\\s+(type\\s+)?\\{([^}]*)\\}\\s*from\\s*['"]${spec}['"]`, 'g')
  for (const m of source.matchAll(re)) {
    if (m[1]) continue                       // `import type { ... }` -- erased at runtime
    const members = m[2].split(',').map((raw) => raw.trim()).filter(Boolean)
    for (const member of members) {
      if (/^type\s/.test(member)) continue   // inline `type Foo` member
      const exported = member.split(/\s+as\s+/)[0].trim()
      if (exported === binding) return true
    }
  }
  return false
}
