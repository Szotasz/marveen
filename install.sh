#!/bin/bash
# Marveen - OS-detect wrapper
# Detects the operating system and launches the appropriate installer.

case "$(uname -s)" in
  Darwin)
    exec "$(dirname "$0")/install-macos.sh" "$@"
    ;;
  Linux)
    exec "$(dirname "$0")/install-linux.sh" "$@"
    ;;
  *)
    echo "Nem tamogatott operacios rendszer: $(uname -s)"
    echo "Tamogatott: macOS (Darwin), Linux (Ubuntu/Debian)"
    exit 1
    ;;
esac
