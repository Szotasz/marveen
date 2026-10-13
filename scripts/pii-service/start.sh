#!/bin/bash
# Start the PII anonymization service.
# Reads PII_ANONYMIZE from the project .env; exits cleanly if disabled.
set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$(dirname "$SCRIPT_DIR")")"

if [ -f "$PROJECT_DIR/.env" ]; then
    val=$(grep -m1 '^PII_ANONYMIZE=' "$PROJECT_DIR/.env" 2>/dev/null | cut -d= -f2- | tr -d '[:space:]"' )
    if [ "$val" = "false" ] || [ "$val" = "0" ] || [ "$val" = "" ]; then
        echo "PII_ANONYMIZE not enabled, exiting."
        exit 0
    fi
fi

exec "$SCRIPT_DIR/.venv/bin/python" "$SCRIPT_DIR/server.py"
