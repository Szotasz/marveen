# The agent's own browser

A sub-agent that some vault web login allows gets its own Chrome (`src/web/agent-browser.ts`). Each one has:
- its own profile under `store/agent-browser/<agent>/profile`;
- CDP on 127.0.0.1 only;
- the password manager off.

The dashboard starts it, and a watchdog restarts it when it is down.

## Which browser it starts

`AGENT_BROWSER_CHROME`, when set, names the executable. Otherwise the first one that exists:
- **macOS:** `/Applications/Google Chrome.app/...`, then `/Applications/Chromium.app/...`;
- **Linux:** `/usr/bin/google-chrome`, `/usr/bin/google-chrome-stable`, `/usr/bin/chromium`, `/usr/bin/chromium-browser`.

### `AGENT_BROWSER_CHROME` is read from the service environment only, not from `.env`

On purpose. The value names a program that the dashboard executes. Whoever can write it decides what runs with the
dashboard's rights, which is the same reason `CLI_INVENTORY_DIRS` ignores its `.env` line. Set it where the
dashboard service is defined:

- **Linux (systemd user unit):** create a drop-in with `systemctl --user edit <the dashboard unit>`:
  ```
  [Service]
  Environment=AGENT_BROWSER_CHROME=/usr/bin/google-chrome-stable
  ```
  then run `systemctl --user restart <the dashboard unit>`.
- **macOS (launchd):** add the key to the `EnvironmentVariables` dict of the dashboard's plist, then reload the job.

## When it does not start

A failed start writes one warning to the dashboard log: `agent-browser: did not answer on its CDP port: <reason>`.
The warning carries the error lines from Chrome's stderr. The full stderr of the last start is in
`store/agent-browser/<agent>/chrome-stderr.log`, which is rewritten at every start.

**"No usable sandbox" (Ubuntu 23.10 and newer, 24.04 included).** These releases restrict unprivileged user namespaces
through AppArmor. A Chrome or Chromium without an AppArmor profile then stops at once; Playwright's bundled Chromium
and hand-built ones are affected. Two fixes:
- Install Google Chrome from its official `.deb`. It ships an AppArmor profile and is found at
  `/usr/bin/google-chrome-stable`.
- Point `AGENT_BROWSER_CHROME` at another browser that has a profile.

Turning the sandbox off (a wrapper adding `--no-sandbox`) also makes it start. It removes Chrome's own isolation
for every page the agent opens, so it is the owner's decision, not a default.
