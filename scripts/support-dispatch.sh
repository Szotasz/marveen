#!/bin/sh
# Support access dispatcher: a PLACEHOLDER that refuses every login.
#
# The bound command of a support line starts this file as
#   /bin/sh <kit>/support-dispatch.sh --key <name> --fp <fingerprint> --grant <id> --consent <n>
# The real dispatcher (a later PR) asks the licensing service on every start
# and runs a fixed diagnostic command only on a complete, valid yes. Until it
# exists, the kit carries this file, so a line that points at the kit opens
# nothing.
printf '%s\n' 'support access: refused (the dispatcher of this release does not open sessions)' >&2
exit 1
