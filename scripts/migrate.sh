#!/bin/bash
# Marveen - Rendszer költöztetés
# Korábbi AI asszisztens rendszer átmigrálása Marveen-be

set -e

BOLD='\033[1m'
GREEN='\033[0;32m'
ORANGE='\033[0;33m'
DIM='\033[2m'
NC='\033[0m'

INSTALL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
API="http://localhost:3420/api"

clear
echo ""
echo -e "${BOLD}Marveen - Rendszer költöztetés${NC}"
echo -e "${DIM}Korábbi AI asszisztens átmigrálása${NC}"
echo ""

# Step 1: Source
echo -e "${BOLD}[1/4] Forrás megadása${NC}"
echo ""
echo -e "  Honnan költözöl?"
echo -e "  ${DIM}1. OpenClaw workspace${NC}"
echo -e "  ${DIM}2. Egyéni Claude bot / más rendszer${NC}"
echo -e "  ${DIM}3. Egyetlen mappa (általános)${NC}"
echo ""
read -p "  Válassz (1/2/3): " SOURCE_TYPE
echo ""

read -p "  Workspace / mappa útvonala: " SOURCE_PATH
if [ ! -e "$SOURCE_PATH" ]; then
  echo -e "${ORANGE}Hiba: $SOURCE_PATH nem létezik${NC}"
  exit 1
fi

read -p "  Melyik ágenshez importáljak? [marveen]: " AGENT_ID
AGENT_ID=${AGENT_ID:-marveen}

echo ""
echo -e "${BOLD}[2/4] Rendszer feltérképezése...${NC}"
echo ""

# Discover files based on source type
FOUND_MEMORY=()
FOUND_SOUL=""
FOUND_USER=""
FOUND_CRON=()
FOUND_HEARTBEAT=""
FOUND_CONFIG=()

discover_openclaw() {
  [ -f "$SOURCE_PATH/MEMORY.md" ] && FOUND_MEMORY+=("$SOURCE_PATH/MEMORY.md") && echo -e "  ${GREEN}✓${NC} MEMORY.md (cold memória)"
  [ -f "$SOURCE_PATH/memory/hot/HOT_MEMORY.md" ] && FOUND_MEMORY+=("$SOURCE_PATH/memory/hot/HOT_MEMORY.md") && echo -e "  ${GREEN}✓${NC} HOT_MEMORY.md"
  [ -f "$SOURCE_PATH/memory/warm/WARM_MEMORY.md" ] && FOUND_MEMORY+=("$SOURCE_PATH/memory/warm/WARM_MEMORY.md") && echo -e "  ${GREEN}✓${NC} WARM_MEMORY.md"
  [ -f "$SOURCE_PATH/SOUL.md" ] && FOUND_SOUL="$SOURCE_PATH/SOUL.md" && echo -e "  ${GREEN}✓${NC} SOUL.md (személyiség)"
  [ -f "$SOURCE_PATH/USER.md" ] && FOUND_USER="$SOURCE_PATH/USER.md" && echo -e "  ${GREEN}✓${NC} USER.md (felhasználói profil)"
  [ -f "$SOURCE_PATH/HEARTBEAT.md" ] && FOUND_HEARTBEAT="$SOURCE_PATH/HEARTBEAT.md" && echo -e "  ${GREEN}✓${NC} HEARTBEAT.md"
  [ -f "$SOURCE_PATH/AGENTS.md" ] && FOUND_CONFIG+=("$SOURCE_PATH/AGENTS.md") && echo -e "  ${GREEN}✓${NC} AGENTS.md (ágens konfig)"
  [ -f "$SOURCE_PATH/TOOLS.md" ] && FOUND_CONFIG+=("$SOURCE_PATH/TOOLS.md") && echo -e "  ${GREEN}✓${NC} TOOLS.md (eszközök)"

  # Daily logs
  for logfile in "$SOURCE_PATH"/memory/20*.md; do
    [ -f "$logfile" ] && FOUND_MEMORY+=("$logfile") && echo -e "  ${GREEN}✓${NC} $(basename "$logfile") (napi napló)"
  done

  # Cron/scheduled tasks
  for cronfile in "$SOURCE_PATH"/.claude/scheduled_tasks* "$SOURCE_PATH"/cron-registry.json; do
    [ -f "$cronfile" ] && FOUND_CRON+=("$cronfile") && echo -e "  ${GREEN}✓${NC} $(basename "$cronfile") (ütemezés)"
  done
}

discover_general() {
  find "$SOURCE_PATH" -maxdepth 3 -type f \( \
    -name "MEMORY.md" -o -name "memory.md" -o -name "memories.md" \
    -o -name "SOUL.md" -o -name "soul.md" -o -name "personality.md" \
    -o -name "USER.md" -o -name "user.md" -o -name "profile.md" \
    -o -name "HEARTBEAT.md" -o -name "heartbeat.md" \
    -o -name "*.memory.md" -o -name "*.memory.json" \
    -o -name "HOT_MEMORY.md" -o -name "WARM_MEMORY.md" -o -name "COLD_MEMORY.md" \
    -o -name "CLAUDE.md" -o -name "AGENTS.md" -o -name "TOOLS.md" \
  \) -not -path "*/node_modules/*" -not -path "*/.git/*" 2>/dev/null | while read file; do
    basename_lower=$(basename "$file" | tr '[:upper:]' '[:lower:]')
    case "$basename_lower" in
      *soul* | *personality*) echo "SOUL:$file" ;;
      *user* | *profile*) echo "USER:$file" ;;
      *heartbeat*) echo "HEARTBEAT:$file" ;;
      *memory* | *hot_memory* | *warm_memory* | *cold_memory* | claude.md | agents.md | tools.md) echo "MEMORY:$file" ;;
    esac
  done | while IFS=: read type filepath; do
    case "$type" in
      SOUL) FOUND_SOUL="$filepath"; echo -e "  ${GREEN}✓${NC} $(basename "$filepath") (személyiség)" ;;
      USER) FOUND_USER="$filepath"; echo -e "  ${GREEN}✓${NC} $(basename "$filepath") (felhasználói profil)" ;;
      HEARTBEAT) FOUND_HEARTBEAT="$filepath"; echo -e "  ${GREEN}✓${NC} $(basename "$filepath") (heartbeat)" ;;
      MEMORY) FOUND_MEMORY+=("$filepath"); echo -e "  ${GREEN}✓${NC} $(basename "$filepath") (memória)" ;;
    esac
  done

  # Also find any .md/.txt files in memory-like directories
  for dir in memory memories bank notes; do
    if [ -d "$SOURCE_PATH/$dir" ]; then
      find "$SOURCE_PATH/$dir" -type f \( -name "*.md" -o -name "*.txt" -o -name "*.json" \) 2>/dev/null | while read f; do
        FOUND_MEMORY+=("$f")
        echo -e "  ${GREEN}✓${NC} $(basename "$f") (memória - $dir/)"
      done
    fi
  done
}

case "$SOURCE_TYPE" in
  1) discover_openclaw ;;
  *) discover_general ;;
esac

# Collect all discoverable files into a temp list
MEMORY_FILES="/tmp/marveen-migrate-files.txt"
> "$MEMORY_FILES"

# Re-scan since the subshell above doesn't persist variables
find "$SOURCE_PATH" -maxdepth 4 -type f \( -name "*.md" -o -name "*.txt" -o -name "*.json" \) \
  -not -path "*/node_modules/*" -not -path "*/.git/*" -not -name ".DS_Store" \
  -not -name "package*.json" -not -name "tsconfig.json" -not -name ".mcp.json" \
  2>/dev/null > "$MEMORY_FILES"

FILE_COUNT=$(wc -l < "$MEMORY_FILES" | tr -d ' ')
echo ""
echo -e "  Összesen: ${BOLD}$FILE_COUNT fájl${NC} található"

# Step 3: Migration
echo ""
echo -e "${BOLD}[3/4] Migráció...${NC}"
echo ""

# Process SOUL.md
SOUL_FILE=$(grep -i "soul\|personality" "$MEMORY_FILES" | head -1)
if [ -n "$SOUL_FILE" ] && [ -f "$SOUL_FILE" ]; then
  echo -e "  Személyiség átmentése..."
  curl -s -X POST "$API/memories" \
    -H "Content-Type: application/json" \
    -d "{\"agent_id\": \"$AGENT_ID\", \"content\": $(echo "Importált személyiség (SOUL.md): $(cat "$SOUL_FILE" | head -100)" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))'), \"tier\": \"warm\", \"keywords\": \"személyiség, soul, import\"}" > /dev/null 2>&1
  echo -e "  ${GREEN}✓${NC} Személyiség mentve a memóriába"
fi

# Process USER.md
USER_FILE=$(grep -i "user\|profile" "$MEMORY_FILES" | head -1)
if [ -n "$USER_FILE" ] && [ -f "$USER_FILE" ]; then
  echo -e "  Felhasználói profil átmentése..."
  curl -s -X POST "$API/memories" \
    -H "Content-Type: application/json" \
    -d "{\"agent_id\": \"$AGENT_ID\", \"content\": $(cat "$USER_FILE" | head -200 | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))'), \"tier\": \"warm\", \"keywords\": \"felhasználó, profil, import\"}" > /dev/null 2>&1
  echo -e "  ${GREEN}✓${NC} Felhasználói profil mentve"
fi

# Process all memory files via the API with AI categorization
echo -e "  Memóriák importálása AI kategorizálással..."

# Collect chunks from all files
python3 -c "
import json, re, sys, os

files_path = '$MEMORY_FILES'
soul_file = '$(echo $SOUL_FILE)'
user_file = '$(echo $USER_FILE)'
skip_files = {soul_file, user_file} if soul_file or user_file else set()

chunks = []
with open(files_path) as fl:
    for filepath in fl:
        filepath = filepath.strip()
        if not filepath or filepath in skip_files:
            continue
        if not os.path.isfile(filepath):
            continue
        try:
            with open(filepath, 'r', encoding='utf-8', errors='ignore') as f:
                content = f.read()

            ext = filepath.rsplit('.', 1)[-1].lower()

            if ext == 'json':
                try:
                    data = json.loads(content)
                    if isinstance(data, list):
                        for item in data:
                            text = item.get('content', item.get('text', str(item))) if isinstance(item, dict) else str(item)
                            if len(str(text).strip()) > 20:
                                chunks.append(str(text)[:2000])
                    elif isinstance(data, dict):
                        for k, v in data.items():
                            text = f'{k}: {v}'
                            if len(text) > 20:
                                chunks.append(text[:2000])
                except:
                    if len(content.strip()) > 20:
                        chunks.append(content[:2000])
            else:
                # Split markdown by headings, or text by paragraphs
                sections = re.split(r'\n(?=##?\s)', content) if ext == 'md' else content.split('\n\n')
                for section in sections:
                    text = section.strip()
                    if len(text) > 20:
                        chunks.append(text[:2000])
        except Exception as e:
            pass

print(json.dumps(chunks))
" > /tmp/marveen-migrate-chunks.json

CHUNK_COUNT=$(python3 -c "import json; print(len(json.load(open('/tmp/marveen-migrate-chunks.json'))))")
echo -e "  ${BOLD}$CHUNK_COUNT${NC} memória chunk feldolgozása..."

if [ "$CHUNK_COUNT" -gt 0 ]; then
  curl -s -X POST "$API/memories/import" \
    -H "Content-Type: application/json" \
    -d "{\"agent_id\": \"$AGENT_ID\", \"chunks\": $(cat /tmp/marveen-migrate-chunks.json)}" | python3 -c "
import json, sys
d = json.load(sys.stdin)
if d.get('ok'):
    stats = d.get('stats', {})
    print(f'  Importálva: {d.get(\"imported\", 0)} emlék')
    print(f'    Hot: {stats.get(\"hot\", 0)}')
    print(f'    Warm: {stats.get(\"warm\", 0)}')
    print(f'    Cold: {stats.get(\"cold\", 0)}')
    print(f'    Shared: {stats.get(\"shared\", 0)}')
else:
    print(f'  Hiba: {d.get(\"error\", \"Ismeretlen\")}')
"
fi

# Step 4: Summary
echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo -e "${BOLD}${GREEN}  ✓ Költöztetés kész!${NC}"
echo ""
echo -e "  ${DIM}Az importált memóriák a dashboardon tekinthetők meg:${NC}"
echo -e "  ${DIM}http://localhost:3420 -> Memória${NC}"
echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"

# Cleanup
rm -f /tmp/marveen-migrate-files.txt /tmp/marveen-migrate-chunks.json
