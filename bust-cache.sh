#!/usr/bin/env bash
# Cache-busts local script/style references in a built site directory by
# appending ?v=<sha> to them, and stamps the build commit into index.html.
# Run against a directory shaped like app/ (already has fetch-firmware.sh's
# output, if applicable) right before publishing.
#
# Usage: bust-cache.sh <site-dir> <sha>
set -euo pipefail

site="$1"
sha="$2"

python3 - "$site" "$sha" <<'PY'
import pathlib
import sys

site, sha = pathlib.Path(sys.argv[1]), sys.argv[2]

index = site / "index.html"
index.write_text(
    index.read_text()
    .replace('content="dev"', f'content="{sha}"')
    .replace('"./vendor/secure-dfu.js"', f'"./vendor/secure-dfu.js?v={sha}"')
    .replace('"./styles.css"', f'"./styles.css?v={sha}"')
    .replace('"./app.js"', f'"./app.js?v={sha}"')
)

app_js = site / "app.js"
app_js.write_text(
    app_js.read_text()
    .replace('"./client.js"', f'"./client.js?v={sha}"')
    .replace('"./search.js"', f'"./search.js?v={sha}"')
)
PY
