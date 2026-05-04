#!/usr/bin/env bash
set -euo pipefail

REPO="solosky/pixl.js"
API_URL="https://api.github.com/repos/${REPO}/releases/latest"
OUT_DIR="app/firmware"

mkdir -p "$OUT_DIR"

echo "Fetching latest release from ${REPO}..."
RELEASE_JSON=$(curl -fsSL ${GITHUB_TOKEN:+-H} ${GITHUB_TOKEN:+"Authorization: Bearer $GITHUB_TOKEN"} "$API_URL")

TAG=$(echo "$RELEASE_JSON" | jq -r '.tag_name')
EXISTING_TAG=$(jq -r '.tag_name // empty' "$OUT_DIR/release.json" 2>/dev/null || true)

if [ "$TAG" != "$EXISTING_TAG" ] && [ -n "$EXISTING_TAG" ]; then
  echo "  New release $TAG (was $EXISTING_TAG), cleaning old files..."
  rm -f "$OUT_DIR"/*.zip "$OUT_DIR"/release.json
fi

echo "$RELEASE_JSON" | jq '{
  tag_name,
  html_url,
  assets: [.assets[] | select(.name | test("\\.zip$"; "i")) | {name}]
}' > "$OUT_DIR/release.json"

echo "Wrote $OUT_DIR/release.json ($TAG)"

echo "$RELEASE_JSON" | jq -r '.assets[] | select(.name | test("\\.zip$"; "i")) | "\(.name) \(.browser_download_url)"' | while read -r NAME URL; do
  DEST="$OUT_DIR/$NAME"
  if [ -f "$DEST" ]; then
    echo "  [skip] $NAME (already exists)"
  else
    echo "  [download] $NAME"
    curl -fsSL -o "$DEST" -L "$URL"
  fi
done

echo "Done."
