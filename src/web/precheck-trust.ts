import { existsSync, realpathSync } from 'node:fs'
import { basename, dirname, join, normalize, sep } from 'node:path'
import { PROJECT_ROOT } from '../config.js'

// Scheduled-task registry: a preCheck script that is repo-shipped code, i.e.
// lives in <PROJECT_ROOT>/scripts/ both by its path AND after resolving
// symlinks. Such a script is updated with the install itself (an update that
// changes it does not touch the task dir), so it stays OUT of the task hash:
// hashing it would make every update that changes the script stop the task.
// The seeders render {{PROJECT_ROOT}} / {{INSTALL_DIR}} to the absolute root
// before writing, so a seeded task carries this absolute form.
//
// Anything else is hashed: a path outside scripts/ (the task dir, /tmp, an
// agent's working dir, <PROJECT_ROOT>/agents/...), and a path under scripts/
// whose symlinks resolve outside it. A missing file is judged by its directory
// (an update may remove and later restore a shipped script).
export function isRepoShippedScript(absPath: string): boolean {
  const scriptsDir = join(PROJECT_ROOT, 'scripts')
  const lexical = normalize(absPath)
  if (!lexical.startsWith(scriptsDir + sep)) return false
  try {
    const realScripts = realpathSync(scriptsDir)
    const real = existsSync(lexical) ? realpathSync(lexical) : join(realpathSync(dirname(lexical)), basename(lexical))
    return real.startsWith(realScripts + sep)
  } catch {
    return false
  }
}
