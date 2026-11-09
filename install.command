#!/bin/bash
set -euo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "$0")" && pwd -P)"
exec /bin/bash "$SCRIPT_DIR/scripts/install.sh" "$@"
