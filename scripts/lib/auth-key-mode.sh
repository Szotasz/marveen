#!/bin/bash
# APIKEYSCOPE1107 (APIKULCSINDITAS1004 B): the install's auth mode, the bash twin of authKeyModeFrom in
# src/web/auth-key-mode.ts. Sourced, never executed. A parity test runs both on the same fixtures.
#   subscription: an OAuth token exists (.env CLAUDE_CODE_OAUTH_TOKEN, or a non-empty store/.claude-oauth-token);
#   keyonly:      no OAuth token, .env has ANTHROPIC_API_KEY;
#   none:         neither.
# .env is read the way channels.sh reads it: the first `KEY=` line, the raw value after the first `=`.

auth_key_mode() { # install dir -> prints subscription|keyonly|none
  local dir="$1" oauth="" key=""
  if [ -f "$dir/.env" ]; then
    oauth="$(grep -E '^CLAUDE_CODE_OAUTH_TOKEN=' "$dir/.env" | head -1 | cut -d= -f2-)"
    key="$(grep -E '^ANTHROPIC_API_KEY=' "$dir/.env" | head -1 | cut -d= -f2-)"
  fi
  # a whitespace-only token file is no token (the launchers read it with $(cat) / trim it)
  if [ -n "$oauth" ] || { [ -f "$dir/store/.claude-oauth-token" ] && [ -n "$(tr -d '[:space:]' < "$dir/store/.claude-oauth-token")" ]; }; then
    printf '%s\n' subscription
  elif [ -n "$key" ]; then
    printf '%s\n' keyonly
  else
    printf '%s\n' none
  fi
}

# The owner-facing sentence for a mode, HU or EN (Samu 72223). Names the key's VARIABLE, never its value.
auth_key_mode_notice() { # mode lang -> one paragraph, or nothing (none)
  case "$1:$2" in
    subscription:en) printf '%s\n' "Marveen: .env holds an API key (ANTHROPIC_API_KEY) next to the subscription login. Until this version that key could reach every sub-agent: their sessions stopped at Claude Code's API-key question, or background calls were billed to the key. From this version only the agents whose authentication is set to the API key on the dashboard get it; for the main agent that is on its card, Settings tab, in the Authentication group. To do: check the key's usage in the Anthropic Console; if an agent should run on the key, switch it to the API key on the dashboard; if none should, remove the line from .env." ;;
    subscription:*)  printf '%s\n' "Marveen: a .env-ben API-kulcs (ANTHROPIC_API_KEY) áll az előfizetéses belépés mellett. Eddig ez a kulcs minden al-ügynökhöz eljuthatott: a munkamenetek a Claude Code API-kulcs-kérdésénél álltak, vagy a háttérhívások a kulcson számláztak. Ettől a verziótól csak azok az ügynökök kapják meg, amelyeknél a dashboardon API-kulcsos hitelesítés van beállítva; a fő ügynöknél ez a kártyája Beállítások fülén, a Hitelesítés csoportban van. Teendő: nézd meg a kulcs használatát az Anthropic Console-ban; ha egy ügynöknek a kulcson kell futnia, állítsd át API-kulcsra a dashboardon; ha egyiknek sem, töröld a sort a .env-ből." ;;
    keyonly:en)      printf '%s\n' "Marveen: on this install the API key (ANTHROPIC_API_KEY) is the only Claude login, and the fleet runs on it (the Console bills per token). From this version every sub-agent gets its approval for the key, so no sub-agent session stops at Claude Code's API-key question. Nothing to do." ;;
    keyonly:*)       printf '%s\n' "Marveen: ezen a telepítésen az API-kulcs (ANTHROPIC_API_KEY) az egyetlen Claude-belépés, a flotta ezen fut (a Console tokenenként számláz). Ettől a verziótól minden al-ügynök megkapja a jóváhagyást a kulcsra, így egyik al-ügynök munkamenete sem áll meg a Claude Code API-kulcs-kérdésénél. Teendő nincs." ;;
    *) ;;
  esac
}

# MAINAUTH1107: the owner-facing sentence when the main agent's api mode did not take effect, HU or EN. Names no value.
# conflict: own-login | plan-token | custom-provider | no-key | own-team | -   failed: comma list or -
main_auth_problem_notice() { # conflict failed lang -> one paragraph, or nothing
  # Marveen copy round 72333: each cause says what the pane REALLY runs on now; where the code cannot tell (no key,
  # a file it could not write), the two outcomes are stated as conditions, not as a guess.
  local why_en="" why_hu="" now_en="" now_hu=""
  local todo_en="fix the cause, or set the main agent's authentication back to the subscription on the dashboard."
  local todo_hu="javítsd az okot, vagy a dashboardon állítsd vissza a fő ügynök hitelesítését előfizetésre."
  local cond_en="It does not run on the key now: it uses the subscription login, or, if there is none, it stops at Claude Code's key question."
  local cond_hu="Most nem a kulcson fut: az előfizetéses belépést használja, vagy ha az nincs, a Claude Code kulcs-kérdésénél áll."
  case "$1" in
    own-login)       why_en="it has its own Claude login (MAIN_AGENT_CONFIG_DIR or a plan switched to another Claude subscription), which takes precedence"; why_hu="saját Claude-belépése van (MAIN_AGENT_CONFIG_DIR vagy egy másik Claude-előfizetésre váltott plan), és az elsőbbséget kap"
                     now_en="It runs on that own login now."; now_hu="Most ezen a saját belépésén fut." ;;
    plan-token)      why_en="a plan switched to another Claude subscription is active"; why_hu="egy másik Claude-előfizetésre váltott plan aktív"
                     now_en="It runs on that plan's login now."; now_hu="Most annak a plan-nek a belépésén fut." ;;
    custom-provider) why_en="it runs on a custom provider"; why_hu="egyedi szolgáltatón fut"
                     now_en="It runs on the custom provider now."; now_hu="Most az egyedi szolgáltatón fut." ;;
    vault-unreadable) why_en="its vault, where the key is stored, could not be read"; why_hu="a széfet, ahol a kulcsa van, nem lehetett olvasni"
                     now_en="It runs on the previous start's authentication; if there was none yet, on the subscription login."; now_hu="Az előző indítás hitelesítésével fut tovább; ha még nem volt ilyen, az előfizetéses belépéssel."
                     todo_en="check that the dashboard's vault can be read, then restart the main agent; or set its authentication back to the subscription on the dashboard."
                     todo_hu="nézd meg, olvasható-e a dashboard széfje, és indítsd újra a fő ügynököt; vagy a dashboardon állítsd vissza a hitelesítését előfizetésre." ;;
    no-key)          why_en="no API key is stored for it"; why_hu="nincs hozzá tárolt API-kulcs"
                     # no key at all: there is no key question to stop at; without a subscription login it is "Not logged in"
                     now_en="It does not run on a key now: it uses the subscription login, or, if there is none, it waits without a login (\"Not logged in\")."
                     now_hu="Most nem kulcson fut: az előfizetéses belépést használja, vagy ha az nincs, belépés nélkül áll (\"Not logged in\")." ;;
  esac
  # whole list items only ("unstamp" is not "stamp")
  if [ -z "$why_en" ]; then
    case ",$2," in
      *,pane-auth,*|*,post,*)
        why_en="its credential files in the store/ folder could not be written"; why_hu="a hitelesítő fájljait a store/ mappában nem sikerült megírni"
        now_en="$cond_en"; now_hu="$cond_hu"
        todo_en="check that the disk has free space and that the Marveen folder is writable; or set the main agent's authentication back to the subscription on the dashboard."
        todo_hu="nézd meg, van-e hely a lemezen, és írható-e a Marveen mappája; vagy állítsd vissza a fő ügynök hitelesítését előfizetésre a dashboardon." ;;
      *,stamp,*)
        why_en="its key approval could not be written (its .claude.json is unreadable)"; why_hu="a kulcs jóváhagyását nem sikerült beírni (a .claude.json nem olvasható)"
        now_en="It stops at Claude Code's key question until the dashboard moves it on (about a minute), then it runs on the key."; now_hu="Most a Claude Code kulcs-kérdésénél áll, amíg a dashboard tovább nem lépteti (kb. egy perc), utána a kulcson fut." ;;
    esac
  fi
  [ -n "$why_en" ] || return 0
  if [ "$1" = vault-unreadable ]; then
    # Dani 72343: not "it does not run as set": with a previous api start it does, on that start's files.
    case "$3" in
      en) printf '%s\n' "Marveen: the main agent is set to run on an API key, but this start could not read the key again, because $why_en. $now_en To do: $todo_en" ;;
      *)  printf '%s\n' "Marveen: a fő ügynök API-kulcsos futásra van állítva, de ennél az indításnál a kulcsot nem tudta újra kiolvasni, mert $why_hu. $now_hu Teendő: $todo_hu" ;;
    esac
    return 0
  fi
  case "$3" in
    en) printf '%s\n' "Marveen: the main agent is set to run on an API key, but this start it does not run as set, because $why_en. $now_en To do: $todo_en" ;;
    *)  printf '%s\n' "Marveen: a fő ügynök API-kulcsos futásra van állítva, de ennél az indításnál nem így fut, mert $why_hu. $now_hu Teendő: $todo_hu" ;;
  esac
}
