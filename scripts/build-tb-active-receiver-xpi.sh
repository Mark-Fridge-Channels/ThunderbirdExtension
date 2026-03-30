#!/usr/bin/env bash
# Pack tb-active-receiver/ into tb-active-receiver.xpi at repo root.
set -e
cd "$(dirname "$0")/.."
if [[ ! -f tb-active-receiver/manifest.json ]]; then
  echo "Missing tb-active-receiver/manifest.json" >&2
  exit 1
fi
cd tb-active-receiver
zip -r ../tb-active-receiver.xpi .
echo "Built ../tb-active-receiver.xpi"
