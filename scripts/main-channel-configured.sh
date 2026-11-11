# shellcheck shell=bash
# CHANNELUNCONF1110 (GROMZONOPROVIDER1108 / Samu 75055, 75584): is the main agent's primary channel configured?
# For every shell launcher of the main session (channels.sh, channel-watchdog.sh, stuck-modal-guard.sh) and
# verify-channels-health.sh. src/web/main-channel-configured.ts is the TS twin (channel-monitor, the dashboard);
# a test runs both on the same fixture dirs.
#
# Why: a provider that needs a token (telegram, discord, slack, teams) and has none -- the paid Bridge installs the
# telegram default with no token, an interactive install can skip it, a token can be removed later -- used to launch
# the main session with `--channels plugin:<provider>` anyway. The plugin exits at once without its token, so
# channels.sh's never-started guard restarted the whole session every 600/1200/2400 s forever, its post-init unlock
# typed into the /mcp menu on every start, and the dashboard's main-down ladder hard-restarted on top (owner VPS
# 11-07/08: 13-14 restarts overnight). Now such a session is "unconfigured": it starts WITHOUT the primary channel
# (the dashboard, the scheduler and the fleet keep their main session), nothing restarts or types, and channels.sh
# restarts it exactly once when the token appears.
#
# The rule is the dashboard's own (src/channel-provider.ts readChannelToken + resolveMainChannelStateDir): the token
# key per provider, a whole-line `KEY=<value>` match with a non-blank value, looked up in the install-scoped
# <install>/.claude/channels/<provider>/.env, or in the legacy ~/.claude/channels/<provider>/.env while only the
# legacy one exists (channels.sh migrates it into the install-scoped dir before the launch). Any other provider
# (gromzo, googlechat, whatsapp, an unknown one) is never "unconfigured" here: its launch path stays as it was.
# The value is only tested, never printed or exported.

# main_channel_token_key <provider>: the .env key whose presence makes the channel configured; rc 1 for a provider
# this rule does not cover.
main_channel_token_key() {
  case "${1:-}" in
    telegram) printf '%s' TELEGRAM_BOT_TOKEN ;;
    discord) printf '%s' DISCORD_BOT_TOKEN ;;
    slack) printf '%s' SLACK_BOT_TOKEN ;;
    teams) printf '%s' TEAMS_BOT_APP_ID ;;
    *) return 1 ;;
  esac
}

# _main_channel_env_has_token <env_file> <key>: rc 0 when the FIRST candidate line `KEY=<value>` has a non-blank value,
# exactly as readChannelToken's `^\s*KEY=(.+)$` takes it (Dani #2691 K2): a candidate needs at least one character
# after `=` before a CR or the line end (an empty `KEY=` or a CR-only one is skipped, as JS `.` does not match CR), and
# that first candidate decides, so a blank `KEY=   ` above a real one reads as unconfigured in both twins. A
# commented-out `# KEY=old` or a prefixed `OLD_KEY=` is never a candidate.
_main_channel_env_has_token() {
  [ -f "$1" ] || return 1
  # The whole decision runs inside awk, so the value never sits in a shell variable (a `set -x` trace of the caller
  # would print it): only the program text and the file name are traced.
  awk -v k="$2" '
    BEGIN { re = "^[[:space:]]*" k "=" }
    $0 ~ re {
      v = $0; sub(re, "", v)
      i = index(v, "\r"); if (i) v = substr(v, 1, i - 1)
      if (v == "") next
      if (v ~ /[^[:space:]]/) ok = 1
      exit
    }
    END { exit (ok ? 0 : 1) }' "$1" 2>/dev/null
}

# main_channel_unconfigured <provider> <install_dir> <home>: rc 0 when the provider needs a token and none is set.
main_channel_unconfigured() {
  local _mcu_key _mcu_scoped _mcu_legacy
  _mcu_key="$(main_channel_token_key "${1:-}")" || return 1
  _mcu_scoped="$2/.claude/channels/$1/.env"
  _mcu_legacy="$3/.claude/channels/$1/.env"
  if [ ! -f "$_mcu_scoped" ] && [ -f "$_mcu_legacy" ]; then
    _main_channel_env_has_token "$_mcu_legacy" "$_mcu_key" && return 1
    return 0
  fi
  _main_channel_env_has_token "$_mcu_scoped" "$_mcu_key" && return 1
  return 0
}

# The marker channels.sh writes when it launched an unconfigured session (the provider on one line) and removes when
# it launched a configured one. Readers that ask "how does the RUNNING session stand" read this; launchers ask the
# rule above.
main_channel_unconfigured_marker() {
  printf '%s' "$1/store/.channel-unconfigured"
}
