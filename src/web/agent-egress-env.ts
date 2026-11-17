import { lstatSync } from 'node:fs'
import { join } from 'node:path'
import { STORE_DIR } from '../config.js'

/**
 * The launch-command piece that gives the Bash egress hook the agent's own vendor list
 * (AGENTEGRESS1111). It adds to the global list; only a regular file for a plausible agent
 * name qualifies. Otherwise unset the variable, so a value inherited from the tmux server's
 * environment never selects another agent's list. Only the PATH is exported, never its content.
 * Not an isolation boundary: the agent runs as the same OS user and can override the variable.
 * This keeps an agent from inheriting another agent's exceptions by accident.
 */
export function agentVendorHostsEnv(name: string, quote: (s: string) => string, storeDir: string = STORE_DIR): string {
  try {
    if (/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name)) {
      const file = join(storeDir, 'egress-vendor-hosts-' + name + '.json')
      if (lstatSync(file).isFile()) return `export BASH_EGRESS_AGENT_VENDOR_HOSTS=${quote(file)} && `
    }
  } catch { /* AGENTEGRESS1111: any lookup error clears the inherited path too. */ }
  return 'unset BASH_EGRESS_AGENT_VENDOR_HOSTS && '
}
