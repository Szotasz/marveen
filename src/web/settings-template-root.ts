// templates/settings.json.template carries curl examples in the PreCompact agent-hook prompt. The prompt is one
// JSON string, and the token path inside it is the raw project root wrapped in double quotes:
//   $(cat \"{{PROJECT_ROOT}}/store/.dashboard-token\")
// Double quotes keep a space or an apostrophe in the root from splitting or ending the path. They do NOT protect
// against the characters below: $ and a backtick would be expanded by the shell, a double quote or a backslash
// would already break the JSON string (the template then fails to parse and the hooks are silently dropped), and
// any control character (U+0000..U+001F, which includes a tab, a newline and a carriage return, and U+007F) makes
// the JSON invalid as well. The first-settings seed writes the rendered text without parsing it, so there the
// invalid file would be written silently. A root with one of them gets a loud error instead.
//
// Scope: this covers the PreCompact prompt's token path ONLY. The template's command hooks (bash -c / python3 with the
// raw root, unquoted) are a separate, older question: they do not survive a space or an apostrophe in the root either.
const UNSAFE_ROOT_CHARS = /[\x00-\x1f\x7f$`"\\]/

/** The first character of the root that the settings template cannot carry, or null when the root is fine. */
export function settingsRootProblem(projectRoot: string): string | null {
  const m = UNSAFE_ROOT_CHARS.exec(projectRoot)
  return m ? m[0] : null
}

/** Throws when the project root holds a character the settings template cannot carry (see above). */
export function assertSettingsRootSafe(projectRoot: string): void {
  const bad = settingsRootProblem(projectRoot)
  if (bad === null) return
  const what = /[\x00-\x1f\x7f]/.test(bad) ? `a control character ${JSON.stringify(bad)}` : JSON.stringify(bad)
  throw new Error(
    `settings.json.template: the project root ${JSON.stringify(projectRoot)} contains ${what}, ` +
      'which the double-quoted token path in the PreCompact prompt cannot carry ($, a backtick, a double quote, ' +
      'a backslash and any control character such as a tab or a newline are not supported). Install to a path without them.',
  )
}
