#!/bin/bash
# HOSTINGERDOCKER1107: the first-run link, in the container log (`docker compose logs marveen`), as the Linux installer
# prints it at its end (install-linux.sh). The dashboard listens on the host's 127.0.0.1 only: open it through the
# Marveen Bridge or an SSH tunnel (docs/docker.md). The token is the install's access token (store/.dashboard-token):
# it is needed until the owner sets the dashboard password in the wizard.
for _ in $(seq 1 120); do
  [ -s /opt/marveen/store/.dashboard-token ] && break
  sleep 1
done
if [ ! -s /opt/marveen/store/.dashboard-token ]; then
  echo "dashboard-link: the dashboard did not write its access token in 120 s; see the log above"
  exit 0
fi
PORT="$(grep -m1 '^WEB_PORT=' /opt/marveen/.env | cut -d= -f2-)"
cat <<EOF

  Marveen is running. Open the dashboard and finish the setup wizard:

    http://127.0.0.1:${PORT:-3420}/?token=$(cat /opt/marveen/store/.dashboard-token)

  The dashboard is bound to this server's 127.0.0.1 only. From your computer:
    - Marveen Bridge: connect to this server, or
    - an SSH tunnel:  ssh -L ${PORT:-3420}:127.0.0.1:${PORT:-3420} <user>@<server>   then open the link above.
  Set the dashboard password in the wizard first; after that the link with the token is no longer needed.

EOF
