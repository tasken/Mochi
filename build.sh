#!/usr/bin/env bash
set -e

DIST="dist"
rm -rf "$DIST"
mkdir -p "$DIST"

cp index.html styles.css app.js favicon.svg "$DIST/"

COMMIT=$(git rev-parse --short HEAD 2>/dev/null || echo "dev")
BRANCH="${CF_PAGES_BRANCH:-}"

sed -i "s/content=\"dev\"/content=\"$COMMIT\"/" "$DIST/index.html"
sed -i "s/name=\"build-branch\" content=\"\"/name=\"build-branch\" content=\"$BRANCH\"/" "$DIST/index.html"
