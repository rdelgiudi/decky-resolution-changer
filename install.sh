#!/usr/bin/env bash
# Installs or updates the Dock Resolution Decky plugin.
#
#   ./install.sh                     build from this checkout, then install/update
#   ./install.sh --zip FILE|URL      install a prebuilt plugin zip (local path or http(s) URL)
#   ./install.sh --repo OWNER/NAME   install the latest GitHub release's .zip asset
#   ./install.sh --check             only report whether an update is available
#   ./install.sh --force             reinstall even if the installed copy is identical
#   ./install.sh --uninstall         remove the plugin (settings and logs are kept)
#
# Plugin settings live in ~/homebrew/settings and logs in ~/homebrew/logs, so
# replacing the plugin directory does not lose configuration.
set -euo pipefail

NAME=decky-resolution-changer
SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
HOMEBREW="${DECKY_HOME:-$HOME/homebrew}"
PLUGINS="$HOMEBREW/plugins"
DEST="$PLUGINS/$NAME"

mode=build zip_src="" repo="" check=0 force=0

die() { echo "error: $*" >&2; exit 1; }
log() { echo "==> $*"; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --zip) mode=zip; zip_src="${2:?--zip needs a path or URL}"; shift ;;
    --repo) mode=repo; repo="${2:?--repo needs OWNER/NAME}"; shift ;;
    --check) check=1 ;;
    --force) force=1 ;;
    --uninstall) mode=uninstall ;;
    -h|--help) sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown option: $1 (see --help)" ;;
  esac
  shift
done

[[ -d "$PLUGINS" ]] || die "$PLUGINS not found — is Decky Loader installed?"
for cmd in unzip sha256sum; do command -v "$cmd" >/dev/null || die "missing '$cmd'"; done

SUDO=""
[[ -w "$PLUGINS" ]] || SUDO="sudo"

restart_loader() {
  if systemctl list-unit-files plugin_loader.service >/dev/null 2>&1; then
    log "Restarting Decky Loader"
    sudo systemctl restart plugin_loader.service
  else
    echo "plugin_loader.service not found; restart Decky manually to load the change."
  fi
}

if [[ $mode == uninstall ]]; then
  [[ -d "$DEST" ]] || { echo "Not installed."; exit 0; }
  log "Removing $DEST"
  $SUDO rm -rf "$DEST"
  restart_loader
  exit 0
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
ZIP="$WORK/$NAME.zip"

# 1. Get the plugin zip
case "$mode" in
  build)
    log "Building from $SRC_DIR"
    "$SRC_DIR/package.sh"
    cp "$SRC_DIR/out/$NAME.zip" "$ZIP"
    ;;
  zip)
    if [[ $zip_src =~ ^https?:// ]]; then
      log "Downloading $zip_src"
      curl -fL --retry 3 -o "$ZIP" "$zip_src"
    else
      [[ -f "$zip_src" ]] || die "no such file: $zip_src"
      cp "$zip_src" "$ZIP"
    fi
    ;;
  repo)
    command -v curl >/dev/null || die "missing 'curl'"
    command -v jq >/dev/null || die "missing 'jq'"
    log "Looking up latest release of $repo"
    url="$(curl -fsSL "https://api.github.com/repos/$repo/releases/latest" \
      | jq -r '[.assets[] | select(.name | endswith(".zip"))][0].browser_download_url // empty')"
    [[ -n "$url" ]] || die "latest release of $repo has no .zip asset"
    log "Downloading $url"
    curl -fL --retry 3 -o "$ZIP" "$url"
    ;;
esac

# 2. Unpack and validate
unzip -q "$ZIP" -d "$WORK/x"
NEW="$(dirname "$(find "$WORK/x" -maxdepth 3 -name plugin.json -print -quit)")"
[[ -f "$NEW/plugin.json" && -f "$NEW/dist/index.js" ]] || die "zip does not look like a Decky plugin"

version_of() { sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$1/package.json" 2>/dev/null | head -1; }
fingerprint() { (cd "$1" && find . -type f ! -path '*/__pycache__/*' -print0 | sort -z | xargs -0 sha256sum | sha256sum | cut -d' ' -f1); }

new_ver="$(version_of "$NEW")"
if [[ -d "$DEST" ]]; then
  old_ver="$(version_of "$DEST")"
  if [[ "$(fingerprint "$NEW")" == "$(fingerprint "$DEST")" ]]; then
    echo "Up to date (v${old_ver:-?})."
    [[ $force == 1 && $check == 0 ]] || exit 0
  else
    echo "Update available: v${old_ver:-?} -> v${new_ver:-?}"
  fi
else
  echo "Not installed; would install v${new_ver:-?}."
fi
[[ $check == 0 ]] || exit 0

# 3. Install: stage next to the target, then swap, so a failure never leaves a half-copied plugin
log "Installing v${new_ver:-?} to $DEST"
$SUDO rm -rf "$DEST.new" "$DEST.old"
$SUDO cp -r "$NEW" "$DEST.new"
[[ -n "$SUDO" ]] && $SUDO chown -R root:root "$DEST.new"
[[ -d "$DEST" ]] && $SUDO mv "$DEST" "$DEST.old"
$SUDO mv "$DEST.new" "$DEST"
$SUDO rm -rf "$DEST.old"

restart_loader
log "Done."
