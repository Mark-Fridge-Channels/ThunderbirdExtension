#!/usr/bin/env bash
# Build extension.xpi / extension-<version>.xpi from extension/ directory.
# Requirements:
# - Every run bumps extension/manifest.json "version"
# - Every run updates browser_specific_settings.gecko.update_url to updates.json raw HTTPS
# - updates.json in repo root is updated with latest version + GitHub Release asset link
# Output:
# - extension-<version>.xpi
# - extension.xpi (compat copy of the latest versioned one)

set -euo pipefail

cd "$(dirname "$0")/.."

if [[ ! -f extension/manifest.json ]]; then
  echo "Missing extension/manifest.json" >&2
  exit 1
fi

REMOTE_URL="$(git remote get-url origin 2>/dev/null || true)"
# Extract "owner/repo" from either HTTPS or SSH remote URL.
REPO_SLUG="${REMOTE_URL%.git}"
REPO_SLUG="${REPO_SLUG#https://github.com/}"
REPO_SLUG="${REPO_SLUG#http://github.com/}"
REPO_SLUG="${REPO_SLUG#git@github.com:}"
if [[ "$REPO_SLUG" != */* ]]; then
  echo "Unable to parse GitHub repo from origin: $REMOTE_URL (parsed: '$REPO_SLUG')" >&2
  exit 1
fi

RELEASE_BRANCH="${RELEASE_BRANCH:-notion-brain-real-email}"
UPDATES_JSON_PATH="updates.json"
UPDATE_URL="https://raw.githubusercontent.com/${REPO_SLUG}/${RELEASE_BRANCH}/${UPDATES_JSON_PATH}"

MANIFEST_PATH="extension/manifest.json"
GECKO_ID="mail_automation_agent@markbai.thunderbird.local"
XPI_BASE="extension"
XPI_DIR="extension"

NEW_VERSION="$(node -e '
  const fs = require("fs");
  const manifestPath = process.argv[1];
  const updateUrl = process.argv[2];
  const raw = fs.readFileSync(manifestPath, "utf8");
  const m = JSON.parse(raw);

  const v = String(m.version || "").trim();
  const m2 = v.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!m2) {
    throw new Error(`manifest.version must be x.y.z semver, got: ${v}`);
  }
  const major = Number(m2[1]);
  const minor = Number(m2[2]);
  const patch = Number(m2[3]) + 1;
  const next = `${major}.${minor}.${patch}`;

  m.version = next;
  m.browser_specific_settings = m.browser_specific_settings || {};
  m.browser_specific_settings.gecko = m.browser_specific_settings.gecko || {};
  m.browser_specific_settings.gecko.update_url = updateUrl;

  fs.writeFileSync(manifestPath, JSON.stringify(m, null, 2) + "\n");
  process.stdout.write(next);
' "$MANIFEST_PATH" "$UPDATE_URL")"

XPI_VERSIONED="${XPI_BASE}-${NEW_VERSION}.xpi"
UPDATE_LINK="https://github.com/${REPO_SLUG}/releases/download/v${NEW_VERSION}/${XPI_VERSIONED}"

node -e '
  const fs = require("fs");
  const path = process.argv[1];
  const geckoId = process.argv[2];
  const version = process.argv[3];
  const updateLink = process.argv[4];

  let doc = { addons: {} };
  if (fs.existsSync(path)) {
    doc = JSON.parse(fs.readFileSync(path, "utf8"));
    doc.addons = doc.addons || {};
  }

  doc.addons[geckoId] = doc.addons[geckoId] || {};
  const updates = Array.isArray(doc.addons[geckoId].updates) ? doc.addons[geckoId].updates : [];

  const filtered = updates.filter((u) => u && String(u.version) !== String(version));
  filtered.unshift({ version, update_link: updateLink });
  doc.addons[geckoId].updates = filtered;

  fs.writeFileSync(path, JSON.stringify(doc, null, 2) + "\n");
' "$UPDATES_JSON_PATH" "$GECKO_ID" "$NEW_VERSION" "$UPDATE_LINK"

# Create versioned xpi, and keep legacy name as a compat copy.
rm -f "${XPI_VERSIONED}" "${XPI_BASE}.xpi"
( cd "$XPI_DIR" && zip -r "../${XPI_VERSIONED}" . >/dev/null )
cp "./${XPI_VERSIONED}" "./${XPI_BASE}.xpi"

echo "Built ./${XPI_VERSIONED} (and copied to ./${XPI_BASE}.xpi)"
echo "  version bumped to: ${NEW_VERSION}"
echo "  updates.json update_link: ${UPDATE_LINK}"

PUBLISH_MODE="${PUBLISH_MODE:-0}" # 0=off, 2=release+commit+push
if [[ "$PUBLISH_MODE" == "2" ]]; then
  if ! command -v gh >/dev/null 2>&1; then
    echo "PUBLISH_MODE=2 requires 'gh' CLI in PATH." >&2
    exit 1
  fi

  TAG="v${NEW_VERSION}"

  # 1) Commit updated manifest + updates.json.
  git add "${MANIFEST_PATH}" "${UPDATES_JSON_PATH}"
  if [[ -n "$(git status --porcelain "${MANIFEST_PATH}" "${UPDATES_JSON_PATH}")" ]]; then
    git commit -m "chore(release): bump extension to ${TAG}"
  else
    echo "Nothing to commit for ${MANIFEST_PATH} / ${UPDATES_JSON_PATH}"
  fi

  # 2) Push commit (so GitHub can resolve the tag target).
  BRANCH="$(git rev-parse --abbrev-ref HEAD)"
  if [[ "$BRANCH" == "HEAD" || -z "$BRANCH" ]]; then
    echo "Detached HEAD; refusing to push." >&2
    exit 1
  fi
  git push --follow-tags origin "${BRANCH}"

  # 3) Create release / upload asset.
  # If the release already exists, just upload (clobber).
  if gh release view "${TAG}" --repo "${REPO_SLUG}" >/dev/null 2>&1; then
    gh release upload "${TAG}" "${XPI_VERSIONED}" --repo "${REPO_SLUG}" --clobber
  else
    gh release create "${TAG}" --repo "${REPO_SLUG}" --title "${TAG}" --notes "${TAG}" "${XPI_VERSIONED}"
  fi
fi

