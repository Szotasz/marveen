#!/bin/bash
# DEPRECATED: redirects to install-channel-image-hook.sh
# Kept for backward compatibility with existing installs whose
# sync-hooks.sh glob still discovers this file.
exec "$(cd "$(dirname "$0")" && pwd)/install-channel-image-hook.sh"
