// FLEETVENV923: the fleet's shared Python virtualenv, resolved ONCE, for every
// launcher. When `<dir>/bin` exists it goes first on the agent launch PATH, so a
// skill's plain `python3` and the venv's own CLIs (markitdown, ...) resolve to
// the venv without per-skill interpreter paths.
//
// Kept small on purpose (node builtins + the .env grammar only): the dashboard
// launchers reach it through config.ts, and scripts/channels.sh reaches the SAME
// functions through scripts/fleet-venv-prefix.mjs -> dist/fleet-venv.js. Before
// that, channels.sh parsed .env with grep/cut on its own and disagreed with the
// TypeScript side on quoted values, on an empty value and on a Settings-page
// override (#1626 review), so a normal boot and a recovery respawn of the same
// main session could get different PATHs.
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { parseEnvContent } from './env-parse.js'

export const FLEET_PYTHON_VENV_KEY = 'FLEET_PYTHON_VENV'

/**
 * The venv directory, in the settings-store order: a non-empty value in
 * store/config-overrides.json (the Settings page) wins, then .env, then the
 * default, which is EMPTY = off (the upstream ships no install-specific
 * directory; an install that has a venv sets the key). A leading `~` means
 * `home`. `envDir` is where .env lives (config.ts passes env.ts's own choice).
 */
export function resolveFleetVenvDir(projectRoot: string, home: string = homedir(), envDir: string = projectRoot): string {
  let raw = ''
  const override = readOverride(projectRoot)
  if (override !== undefined) {
    raw = override
  } else {
    try {
      raw = parseEnvContent(readFileSync(join(envDir, '.env'), 'utf-8'), [FLEET_PYTHON_VENV_KEY])[FLEET_PYTHON_VENV_KEY] ?? ''
    } catch {
      raw = ''
    }
  }
  return raw.startsWith('~') ? join(home, raw.slice(1)) : raw
}

// Same rule as config.ts cfg(): only a non-null, non-empty override counts.
function readOverride(projectRoot: string): string | undefined {
  try {
    const p = join(projectRoot, 'store', 'config-overrides.json')
    if (!existsSync(p)) return undefined
    const ov = (JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>)[FLEET_PYTHON_VENV_KEY]
    return ov !== undefined && ov !== null && String(ov).length > 0 ? String(ov) : undefined
  } catch {
    return undefined
  }
}

/**
 * The `<venv>/bin:` PATH prefix, or '' when the setting is off or `<venv>/bin`
 * does not exist. `refused` = the path is relative, or carries a shell-active character (`"`,
 * `$`, backtick, backslash) that the double-quoted `export PATH="..."` of a
 * launch command would re-interpret: skipped rather than escaped, because a
 * fleet venv at such a path is a config mistake. `exists` is the test seam.
 */
export function fleetVenvBin(venvDir: string, exists: (p: string) => boolean = existsSync): { prefix: string; refused: boolean } {
  if (!venvDir) return { prefix: '', refused: false }
  // Absolute only (after ~ expansion): a relative `venv` would resolve against
  // each launch command's own `cd`, i.e. a different directory per agent, and
  // the shell side rejects it anyway (#1626 review). Refused, not guessed.
  if (!isAbsolute(venvDir)) return { prefix: '', refused: true }
  const bin = join(venvDir, 'bin')
  if (!exists(bin)) return { prefix: '', refused: false }
  if (/["$`\\]/.test(bin)) return { prefix: '', refused: true }
  return { prefix: `${bin}:`, refused: false }
}
