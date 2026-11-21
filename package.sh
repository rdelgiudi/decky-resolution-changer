#!/usr/bin/env bash
# Builds the frontend and produces out/decky-resolution-changer.zip,
# installable via Decky → Developer → Install plugin from zip.
set -euo pipefail
cd "$(dirname "$0")"
NAME=decky-resolution-changer
npx -y pnpm@9 install --frozen-lockfile
npx -y pnpm@9 run build
rm -rf out && mkdir -p "out/$NAME/dist"
cp dist/index.js "out/$NAME/dist/"
cp plugin.json package.json main.py README.md LICENSE "out/$NAME/"
(cd out && zip -qr "$NAME.zip" "$NAME")
echo "Built out/$NAME.zip"
