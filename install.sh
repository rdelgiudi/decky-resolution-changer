#!/usr/bin/env bash
# Installs or updates the Dock Resolution Decky plugin.
#
# One-step install (latest GitHub release):
#   curl -fsSL https://raw.githubusercontent.com/rdelgiudi/decky-resolution-changer/main/install.sh | bash
#
# Plugin settings live in ~/homebrew/settings and logs in ~/homebrew/logs, so
# replacing the plugin directory does not lose configuration.

# Must stay POSIX so that `curl ... | sh` fails with a clear message.
if [ -z "${BASH_VERSION:-}" ]; then
  echo "error: this installer needs bash. Run: curl -fsSL <url> | bash" >&2
  exit 1
fi

# Everything lives in main() so bash parses the whole script before running
# any of it. That matters for `curl | bash`, where the script arrives on stdin.
main() {
set -euo pipefail

local NAME=decky-resolution-changer
local DEFAULT_REPO="rdelgiudi/decky-resolution-changer"   # GitHub OWNER/NAME
local HOMEBREW="${DECKY_HOME:-$HOME/homebrew}"
local PLUGINS="$HOMEBREW/plugins"
local DEST="$PLUGINS/$NAME"

# Build from source only when run as a file inside a checkout. When piped,
# BASH_SOURCE is empty, so we never run a stray package.sh from the cwd.
local SRC_DIR="" self="${BASH_SOURCE[0]:-}"
if [[ -n "$self" && -f "$self" ]]; then
  SRC_DIR="$(cd "$(dirname "$self")" && pwd)"
  [[ -f "$SRC_DIR/package.sh" ]] || SRC_DIR=""
fi

local mode zip_src="" repo="$DEFAULT_REPO" check=0 force=0
if [[ -n "$SRC_DIR" ]]; then mode=build; else mode=release; fi

die() { echo "error: $*" >&2; exit 1; }
log() { echo "==> $*"; }
usage() {
  cat <<EOF
Usage: install.sh [options]

With no options, builds from the checkout the script sits in, or installs the
latest GitHub release when run via curl | bash.

  --release            install the latest GitHub release (default when piped)
  --repo OWNER/NAME    use this GitHub repo's latest release (default: $DEFAULT_REPO)
  --zip FILE|URL       install a prebuilt plugin zip from a local path or URL
  --check              only report whether an update is available
  --force              reinstall even if the installed copy is identical
  --uninstall          remove the plugin (settings and logs are kept)
  -h, --help           show this help

Pass options through a pipe with: curl -fsSL <url> | bash -s -- --uninstall
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --release) mode=release ;;
    --repo) mode=release; repo="${2:?--repo needs OWNER/NAME}"; shift ;;
    --zip) mode=zip; zip_src="${2:?--zip needs a path or URL}"; shift ;;
    --check) check=1 ;;
    --force) force=1 ;;
    --uninstall) mode=uninstall ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1 (see --help)" ;;
  esac
  shift
done

if [[ $EUID -eq 0 && -z "${DECKY_HOME:-}" ]]; then
  die "do not run as root; run as your normal user (sudo is used where needed)"
fi
[[ -d "$PLUGINS" ]] || die "$PLUGINS not found. Is Decky Loader installed?"
for cmd in unzip sha256sum; do command -v "$cmd" >/dev/null || die "missing '$cmd'"; done

local SUDO=""
[[ -w "$PLUGINS" ]] || SUDO="sudo"

restart_loader() {
  if [[ -n "${DECKY_HOME:-}" && "$DECKY_HOME" != "$HOME/homebrew" ]]; then
    echo "DECKY_HOME is set; not restarting Decky Loader."
  elif systemctl list-unit-files plugin_loader.service >/dev/null 2>&1; then
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

local WORK; WORK="$(mktemp -d)"
trap "rm -rf '$WORK'" EXIT
local ZIP="$WORK/$NAME.zip"

# Prints the first .zip asset URL from a GitHub release JSON on stdin.
zip_asset_url() {
  if command -v jq >/dev/null; then
    jq -r '[.assets[]? | select(.name | endswith(".zip"))][0].browser_download_url // empty'
  elif command -v python3 >/dev/null; then
    python3 -I -c 'import json,sys
a=[x["browser_download_url"] for x in json.load(sys.stdin).get("assets",[]) if x["name"].endswith(".zip")]
print(a[0] if a else "")'
  else
    grep -o '"browser_download_url": *"[^"]*\.zip"' | head -1 | cut -d'"' -f4
  fi
}

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
  release)
    command -v curl >/dev/null || die "missing 'curl'"
    log "Looking up latest release of $repo"
    local json url
    json="$(curl -fsSL -H 'Accept: application/vnd.github+json' \
      "https://api.github.com/repos/$repo/releases/latest" </dev/null)" \
      || die "could not fetch the latest release of $repo (no release published yet, or GitHub is unreachable)"
    url="$(zip_asset_url <<<"$json")"
    [[ -n "$url" ]] || die "latest release of $repo has no .zip asset"
    log "Downloading $url"
    curl -fL --retry 3 -o "$ZIP" "$url" </dev/null
    ;;
esac

# 2. Unpack and validate
unzip -q "$ZIP" -d "$WORK/x" </dev/null
local NEW
NEW="$(dirname "$(find "$WORK/x" -maxdepth 3 -name plugin.json -print -quit)")"
[[ -f "$NEW/plugin.json" && -f "$NEW/dist/index.js" ]] || die "zip does not look like a Decky plugin"

version_of() { sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$1/package.json" 2>/dev/null | head -1; }
fingerprint() { (cd "$1" && find . -type f ! -path '*/__pycache__/*' -print0 | sort -z | xargs -0 sha256sum | sha256sum | cut -d' ' -f1); }

local new_ver old_ver
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
if [[ -n "$SUDO" ]]; then $SUDO chown -R root:root "$DEST.new"; fi
if [[ -d "$DEST" ]]; then $SUDO mv "$DEST" "$DEST.old"; fi
$SUDO mv "$DEST.new" "$DEST"
$SUDO rm -rf "$DEST.old"

restart_loader
log "Done."
}

main "$@"
