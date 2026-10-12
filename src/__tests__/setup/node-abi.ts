// Pure helpers for the native-ABI suite gate (see assert-supported-node.ts).
//
// Kept separate from the gate itself so they can be unit tested without the
// import-time side effect: importing the gate RUNS it.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** How a Node.js ABI mismatch announces itself, whatever the module. */
const ABI_MISMATCH_MARKER = 'NODE_MODULE_VERSION'

/**
 * True when the failure is "this native module was built for another Node",
 * not a genuine bug. Anything else must be rethrown untouched — swallowing a
 * real error behind a friendly message would be the worse failure.
 */
export function isNodeAbiMismatch(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes(ABI_MISMATCH_MARKER)
}

export type FileReader = (path: string) => string | null

export const defaultFileReader: FileReader = (path) => {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

/**
 * The Node major this checkout is meant to run on, from `.nvmrc` — the repo's
 * own declaration, so the message cannot drift from it. Returns null when
 * `.nvmrc` is missing or unreadable; the message then simply omits the target
 * rather than inventing one.
 */
export function readExpectedNodeMajor(
  repoRoot: string,
  readFile: FileReader = defaultFileReader,
): string | null {
  const raw = readFile(join(repoRoot, '.nvmrc'))
  if (raw === null) return null
  const trimmed = raw.trim().replace(/^v/, '')
  const major = /^(\d+)/.exec(trimmed)
  return major ? major[1] : null
}

/**
 * The refusal text. It has one job the raw bindings error does not do: say
 * that nothing in the suite is broken, and give the command that fixes it.
 */
export function buildNodeAbiMessage(input: {
  originalMessage: string
  runningVersion: string
  expectedMajor: string | null
}): string {
  const { originalMessage, runningVersion, expectedMajor } = input
  const target = expectedMajor === null ? 'the version this checkout was installed with' : `Node ${expectedMajor} (.nvmrc)`

  return [
    'REFUSING TO RUN TESTS: node_modules were built for a different Node.js version than the one running.',
    '',
    `  running:  ${runningVersion}`,
    `  expected: ${target}`,
    '',
    'Nothing in the suite is broken. The native better-sqlite3 binding cannot',
    'load under this Node, so every test that touches the database fails with an',
    'error that looks unrelated to its own subject.',
    '',
    'Run the suite on the Node version this checkout was installed with:',
    '  nvm use                                              # nvm/fnm read .nvmrc',
    expectedMajor === null
      ? '  export PATH="/opt/homebrew/opt/node/bin:$PATH"       # Homebrew on macOS'
      : `  export PATH="/opt/homebrew/opt/node@${expectedMajor}/bin:$PATH"    # Homebrew on macOS`,
    '',
    '`npm rebuild better-sqlite3` also clears it, but it rebinds node_modules to',
    'whatever Node is running — do not do that in a live install whose service is',
    'running on another version.',
    '',
    `Original error: ${originalMessage.split('\n')[0]}`,
  ].join('\n')
}
