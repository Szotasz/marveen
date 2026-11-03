import { isAbsolute, join } from 'node:path'
import { PROJECT_ROOT } from '../config.js'

// The ONE rule for where a scheduled task's preCheck script lives. The registry
// hash (preCheckHashTarget in scheduled-tasks-io.ts) and the runner
// (resolvePreCheckPath in schedule-runner.ts) both call this and nothing else,
// so the script the runner executes is always the script the hash covered
// (unless it is repo-shipped code, isRepoShippedScript), and a value that is no
// script for the hash is no script for the runner either. They used to carry
// two copies of the rule and disagreed on a non-string preCheck: the hash
// ignored it, the runner took any truthy value for a path and threw.
//
// Forms, given the task's own directory:
//   not a non-empty string  -> null: no preCheck;
//   relative                -> beside the task's SKILL.md (an escaping `../x` too);
//   absolute                -> as given;
//   {{PROJECT_ROOT}}/x, {{INSTALL_DIR}}/x
//                           -> the install root. The placeholder counts only
//                              when a '/' follows: '{{PROJECT_ROOT}}x' is a
//                              plain relative name.
// The placeholder form exists for SHIPPED tasks that gate on a repo script:
// the node seeder copies task-config.json without template rendering, and
// update.sh's seed refresh never adds a new file to an existing task dir, so
// neither a hard-coded path nor a script beside the SKILL.md would reach every
// install.
export function preCheckScriptPath(taskDir: string, preCheck: unknown): string | null {
  if (typeof preCheck !== 'string' || preCheck.length === 0) return null
  const rooted = preCheck.replace(/^\{\{(PROJECT_ROOT|INSTALL_DIR)\}\}(?=\/)/, PROJECT_ROOT)
  return isAbsolute(rooted) ? rooted : join(taskDir, rooted)
}
