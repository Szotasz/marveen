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
# DOCKERHTTPS1119: with a domain the setup runs on the HTTPS address with the one-time setup code the dashboard
# prints itself ("Marveen setup code"); the fleet's access token is not printed (a log line would keep it forever).
PUBLIC_URL="$(grep -m1 '^DASHBOARD_PUBLIC_URL=' /opt/marveen/.env | cut -d= -f2-)"
if [ -n "$PUBLIC_URL" ]; then
  cat <<EOF

  Marveen is running. Open the dashboard and finish the setup wizard:

    $PUBLIC_URL/

  It asks for the one-time setup code: the "Marveen setup code" line in this log. A restart of the container
  issues a new code while no dashboard password is set.

EOF
  exit 0
fi
cat <<EOF

  Marveen is running. Open the dashboard and finish the setup wizard:

    http://127.0.0.1:${PORT:-3420}/?token=$(cat /opt/marveen/store/.dashboard-token)

  The dashboard is bound to this server's 127.0.0.1 only. From your computer:
    - Marveen Bridge: connect to this server, or
    - an SSH tunnel:  ssh -L ${PORT:-3420}:127.0.0.1:${PORT:-3420} <user>@<server>   then open the link above.
  Set the dashboard password in the wizard first; after that the link with the token is no longer needed.

EOF
