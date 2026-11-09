// ENVRELAXGATE1104: outgoing-copy-gate.py reads its name rules only from its OWN install
// (<install>/store/outgoing-copy-gate-rules.json) and writes its log next to that file; no environment
// variable points it elsewhere. A test that used to hand the hook a rules path through the environment runs
// it from a tmp install instead: <rulesPath>.inst/ with scripts/ linked to this repo's (the hook takes its
// root from abspath, not realpath) and store/outgoing-copy-gate-rules.json LINKED to the test's rules path,
// so a later write to that path, or a missing file, reaches the hook exactly as before.
import { existsSync, lstatSync, mkdirSync, symlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'

const REPO_SCRIPTS = resolve(__dirname, '..', '..', '..', 'scripts')

function exists(p: string): boolean {
  try { lstatSync(p); return true } catch { return false }
}

/** The hook path and store dir of the tmp install that reads `rulesPath`. */
export function copyGateInstall(rulesPath: string): { hook: string; store: string } {
  const root = resolve(rulesPath) + '.inst'
  const store = join(root, 'store')
  if (!existsSync(store)) mkdirSync(store, { recursive: true })
  const link = join(root, 'scripts')
  if (!exists(link)) symlinkSync(REPO_SCRIPTS, link)
  const rules = join(store, 'outgoing-copy-gate-rules.json')
  if (!exists(rules)) symlinkSync(resolve(rulesPath), rules)
  return { hook: join(link, 'hooks', 'outgoing-copy-gate.py'), store }
}
