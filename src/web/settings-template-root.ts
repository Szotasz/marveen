// templates/settings.json.template carries curl examples in the PreCompact agent-hook prompt. The prompt is one
// JSON string, and the token path inside it is the raw project root wrapped in double quotes:
//   $(cat \"{{PROJECT_ROOT}}/store/.dashboard-token\")
// Double quotes keep a space or an apostrophe in the root from splitting or ending the path. They do NOT protect
// against the characters below: $ and a backtick would be expanded by the shell, a double quote or a backslash
// would already break the JSON string (the template then fails to parse and the hooks are silently dropped), and a
// newline ends the command. A root with one of them gets a loud error instead of a quietly broken command.
const UNSAFE_ROOT_CHARS = /[$`"\\\n\r]/

/** The first character of the root that the settings template cannot carry, or null when the root is fine. */
export function settingsRootProblem(projectRoot: string): string | null {
  const m = UNSAFE_ROOT_CHARS.exec(projectRoot)
  return m ? m[0] : null
}

/** Throws when the project root holds a character the settings template cannot carry (see above). */
export function assertSettingsRootSafe(projectRoot: string): void {
  const bad = settingsRootProblem(projectRoot)
  if (bad === null) return
  throw new Error(
    `settings.json.template: the project root ${JSON.stringify(projectRoot)} contains ${JSON.stringify(bad)}, ` +
      'which the double-quoted token path in the PreCompact prompt cannot carry ($, a backtick, a double quote, ' +
      'a backslash and a newline are not supported). Install to a path without them.',
  )
}
