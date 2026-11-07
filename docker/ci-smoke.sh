#!/bin/bash
# HOSTINGERDOCKER1107: the image's offline smoke, for CI (.github/workflows/docker-image.yml) and by hand.
# Starts the image with no network (nothing reaches out: the channel plugin install fails softly, by design), then
# requires: the code synced and verified, the healthcheck healthy, the dashboard link printed, the dashboard and the
# main agent's channels.sh RUNNING under supervisor, Docker mode on, and a restart that does not sync again.
# Usage: docker/ci-smoke.sh <image>
set -u
IMG="${1:?usage: ci-smoke.sh <image>}"
NAME="marveen-ci-smoke-$$"
fail() { echo "SMOKE FAIL: $*"; docker logs "$NAME" 2>&1 | sed -E 's/token=[0-9a-f]+/token=<redacted>/' | tail -60; docker rm -f "$NAME" >/dev/null 2>&1; docker volume rm "$NAME-install" "$NAME-home" >/dev/null 2>&1; exit 1; }
docker run -d --name "$NAME" --network none -v "$NAME-install:/opt/marveen" -v "$NAME-home:/home/marveen" -e MARVEEN_OLLAMA_URL= "$IMG" >/dev/null || fail "the container did not start"

state=""
for _ in $(seq 1 90); do
  state="$(docker inspect -f '{{.State.Health.Status}}' "$NAME" 2>/dev/null)"
  [ "$state" = healthy ] && break
  [ "$(docker inspect -f '{{.State.Running}}' "$NAME" 2>/dev/null)" = true ] || fail "the container stopped"
  sleep 2
done
[ "$state" = healthy ] || fail "not healthy after 180 s (state: $state)"

logs="$(docker logs "$NAME" 2>&1)"
grep -q 'code-sync: code synced and verified' <<<"$logs" || fail "no verified code sync in the log"
for _ in $(seq 1 30); do grep -q 'Marveen is running' <<<"$(docker logs "$NAME" 2>&1)" && break; sleep 2; done
grep -q 'Marveen is running' <<<"$(docker logs "$NAME" 2>&1)" || fail "the dashboard link was not printed"
# The dashboard answers (healthy) before supervisor's startsecs window ends (5 s / 10 s): wait for RUNNING.
for p in dashboard channels; do
  for _ in $(seq 1 20); do
    status="$(docker exec "$NAME" supervisorctl -c /opt/marveen-docker/supervisord.conf status "$p")"
    grep -Eq "^$p +RUNNING" <<<"$status" && break
    sleep 1
  done
  grep -Eq "^$p +RUNNING" <<<"$status" || fail "$p is not RUNNING after 20 s: $status"
done
docker exec "$NAME" grep -qx 'MARVEEN_DEPLOYMENT=docker' /opt/marveen/.env || fail "Docker mode is not set in .env"
[ "$(docker exec "$NAME" id -u)" = 1000 ] || fail "not running as uid 1000"

docker restart "$NAME" >/dev/null || fail "restart failed"
for _ in $(seq 1 30); do grep -q 'code-sync: code is current' <<<"$(docker logs --since 2m "$NAME" 2>&1)" && break; sleep 2; done
grep -q 'code-sync: code is current' <<<"$(docker logs --since 2m "$NAME" 2>&1)" || fail "the restart synced the code again"

docker rm -f "$NAME" >/dev/null; docker volume rm "$NAME-install" "$NAME-home" >/dev/null
echo "SMOKE OK: $IMG"
