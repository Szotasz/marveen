// ENVRELAXGATE1104 step 2: update.sh runs this after the build, so the update output names every .env line the
// overrides-only rule now ignores (a line that would loosen a security key). One key NAME per line on stdout, never a
// value; nothing when there is none. Always exits 0: a warning, never an update failure.
import { getIgnoredEnvKeys } from './settings-store.js'

try {
  for (const key of getIgnoredEnvKeys()) process.stdout.write(`${key}\n`)
} catch {
  // A broken read only loses the warning; the dashboard boot log still names the keys.
}
process.exit(0)
