#!/usr/bin/env bash
# Build extension.xpi from extension/ directory (zip with manifest.json at root).
# Usage: ./scripts/build-xpi.sh   or   bash scripts/build-xpi.sh
# Output: extension.xpi in project root.

set -e
cd "$(dirname "$0")/.."
if [[ ! -f extension/manifest.json ]]; then
  echo "Missing extension/manifest.json" >&2
  exit 1
fi
cd extension
zip -r ../extension.xpi .
echo "Built ../extension.xpi"
