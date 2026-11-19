#!/bin/bash
# DOCKERUX1118 (owner 33327/33329, Samu 80886/80891): the seeded skills' and scheduled tasks' part of the setup wizard's
# language switch. src/web/install-lang-switch.ts runs it AFTER it has written the new AGENT_TEXT_LANG into .env. The
# rules are an image update's seed refresh (docker_seed_refresh, scripts/lib/seed-refresh.sh): only a copy that is
# untouched, in either language, follows the install's language; an edited one is kept as it is. One line per file on
# stdout, through the lib's report hook:
#   seed <current|updated|kept|added> <path under $HOME>
# Anything else on stdout is the refresh's own text. The exit code is docker_seed_refresh's (0 = finished).
set -u
INSTALL_DIR="${MARVEEN_INSTALL_DIR:-/opt/marveen}"
DOCKER_DIR="${MARVEEN_DOCKER_DIR:-/opt/marveen-docker}"
cd "$INSTALL_DIR" || exit 1
. scripts/lib/seed-lang.sh || exit 1
. scripts/lib/seed-refresh.sh || exit 1
. "$DOCKER_DIR/seed-refresh-docker.sh" || exit 1

# The identity as first-boot hands it to the refresh (env_val, the first matching line).
env_val() { grep -m1 "^$1=" .env | cut -d= -f2-; }
# The three names below are read by the sourced refresh (render_seed_template, docker_seed_refresh).
# shellcheck disable=SC2034
MAIN_AGENT_ID="$(env_val MAIN_AGENT_ID)"
# shellcheck disable=SC2034
BOT_NAME="$(env_val BOT_NAME)"
# shellcheck disable=SC2034
OWNER_NAME="$(env_val OWNER_NAME)"
# shellcheck disable=SC2034 # read by the sourced refresh (seed_refresh_dir_lang)
SEED_LANG="$(seed_lang "$INSTALL_DIR")"

seed_refresh_report() { printf 'seed %s %s\n' "$2" "${1#"$HOME"/}"; }

# docker_seed_refresh works over a snapshot dir of the previous tree. An empty one compares every copy with this
# image's own tree only (its seam takes the current tree too), which is the whole question of a language switch;
# the function removes the dir when it finishes. A snapshot left by an unfinished update refresh is used as it is,
# as the next start would.
mkdir -p .seed-prev || exit 1
docker_seed_refresh
