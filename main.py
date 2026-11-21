"""Backend for the Dock Resolution plugin.

Responsibilities:
  * Watch DRM connectors in /sys/class/drm and decide whether an external
    display is connected ("docked") or not ("handheld"), with a debounce so
    hotplug flapping produces one state change.
  * Persist the user's settings ({handheld, docked, autoSwitch}).
  * Write frontend diagnostics to a file so they are easy to copy off the device.

The backend never touches Steam itself; the frontend owns the Steam setter.
"""

import asyncio
import glob
import json
import os
import time

import decky

DRM_GLOB = "/sys/class/drm/card*-*"
POLL_INTERVAL_S = 1.0
DEBOUNCE_S = 2.0

# Connector types that are built into the device, never an external display.
INTERNAL_PREFIXES = ("eDP", "DSI", "LVDS")
IGNORED_PREFIXES = ("Writeback",)

DEFAULT_SETTINGS = {
    "handheld": "1920x1200",
    "docked": "1920x1080",
    "autoSwitch": True,
}


# --------------------------------------------------------------------------- #
# Dock detection (pure functions, unit-testable without decky)
# --------------------------------------------------------------------------- #

def connector_type(path: str) -> str:
    """'/sys/class/drm/card1-eDP-1' -> 'eDP';  'card0-HDMI-A-1' -> 'HDMI-A'."""
    name = os.path.basename(path)
    _, _, rest = name.partition("-")          # drop 'cardN'
    kind, _, _ = rest.rpartition("-")         # drop trailing index
    return kind or rest


def scan_connectors(drm_glob: str = DRM_GLOB) -> dict:
    """Return {connector_name: status} for every DRM connector."""
    result = {}
    for path in sorted(glob.glob(drm_glob)):
        status_file = os.path.join(path, "status")
        try:
            with open(status_file, "r") as f:
                result[os.path.basename(path)] = f.read().strip()
        except OSError:
            continue
    return result


def external_connected(connectors: dict) -> list:
    """Names of connected connectors that are not internal panels."""
    out = []
    for name, status in connectors.items():
        if status != "connected":
            continue
        kind = connector_type(name)
        if kind.startswith(INTERNAL_PREFIXES) or kind.startswith(IGNORED_PREFIXES):
            continue
        out.append(name)
    return out


class DockWatcher:
    """Debounced docked/handheld state machine.

    `poll()` is called periodically with the current time; it returns True
    exactly once each time the debounced state changes.
    """

    def __init__(self, drm_glob: str = DRM_GLOB, debounce_s: float = DEBOUNCE_S):
        self.drm_glob = drm_glob
        self.debounce_s = debounce_s
        connectors = scan_connectors(drm_glob)
        ext = external_connected(connectors)
        self.connectors = connectors
        self.external = ext
        self.docked = bool(ext)
        self.changed_at = time.time()
        self._pending = None          # (docked, since) of an unconfirmed raw change

    def poll(self, now: float) -> bool:
        connectors = scan_connectors(self.drm_glob)
        ext = external_connected(connectors)
        raw = bool(ext)
        self.connectors = connectors

        if raw == self.docked:
            self._pending = None
            self.external = ext
            return False

        if self._pending is None or self._pending[0] != raw:
            self._pending = (raw, now)
            return False

        if now - self._pending[1] >= self.debounce_s:
            self.docked = raw
            self.external = ext
            self.changed_at = now
            self._pending = None
            return True
        return False

    def snapshot(self) -> dict:
        return {
            "docked": self.docked,
            "external": self.external,
            "connectors": self.connectors,
            "changedAt": self.changed_at,
        }


# --------------------------------------------------------------------------- #
# Settings
# --------------------------------------------------------------------------- #

def _settings_path() -> str:
    return os.path.join(decky.DECKY_PLUGIN_SETTINGS_DIR, "settings.json")


def load_settings() -> dict:
    data = dict(DEFAULT_SETTINGS)
    try:
        with open(_settings_path(), "r") as f:
            stored = json.load(f)
        for key in DEFAULT_SETTINGS:
            if key in stored and isinstance(stored[key], type(DEFAULT_SETTINGS[key])):
                data[key] = stored[key]
    except FileNotFoundError:
        pass
    except Exception as e:  # corrupt file: fall back to defaults
        decky.logger.warning(f"Could not read settings, using defaults: {e}")
    return data


def save_settings(data: dict) -> None:
    os.makedirs(decky.DECKY_PLUGIN_SETTINGS_DIR, exist_ok=True)
    tmp = _settings_path() + ".tmp"
    with open(tmp, "w") as f:
        json.dump(data, f, indent=2)
    os.replace(tmp, _settings_path())


# --------------------------------------------------------------------------- #
# Plugin
# --------------------------------------------------------------------------- #

class Plugin:
    watcher: DockWatcher = None
    settings: dict = None
    _task: asyncio.Task = None

    # ---- callables from the frontend ----

    async def get_state(self) -> dict:
        if self.watcher is None:          # frontend asked before _main ran
            self.watcher = DockWatcher()
        return self.watcher.snapshot()

    async def get_settings(self) -> dict:
        if self.settings is None:
            self.settings = load_settings()
        return dict(self.settings)

    async def set_settings(self, new: dict) -> dict:
        if self.settings is None:
            self.settings = load_settings()
        for key in DEFAULT_SETTINGS:
            if key in new and isinstance(new[key], type(DEFAULT_SETTINGS[key])):
                self.settings[key] = new[key]
        save_settings(self.settings)
        decky.logger.info(f"Settings saved: {self.settings}")
        return dict(self.settings)

    async def log(self, level: str, message: str) -> None:
        getattr(decky.logger, level if level in ("info", "warning", "error") else "info")(
            f"[frontend] {message}")

    async def save_diagnostics(self, text: str) -> str:
        """Write the frontend's Phase-0 diagnostics to a file; returns its path."""
        path = os.path.join(decky.DECKY_PLUGIN_LOG_DIR, "diagnostics.txt")
        os.makedirs(decky.DECKY_PLUGIN_LOG_DIR, exist_ok=True)
        with open(path, "w") as f:
            f.write(text)
        decky.logger.info(f"Diagnostics written to {path}")
        return path

    # ---- lifecycle ----

    async def _watch(self):
        while True:
            try:
                if self.watcher.poll(time.time()):
                    snap = self.watcher.snapshot()
                    decky.logger.info(
                        f"Dock state -> {'docked' if snap['docked'] else 'handheld'} "
                        f"(external: {snap['external']})")
                    await decky.emit("dock_state", snap)
            except Exception as e:
                decky.logger.error(f"Dock watcher error: {e}")
            await asyncio.sleep(POLL_INTERVAL_S)

    async def _main(self):
        if self.settings is None:
            self.settings = load_settings()
        if self.watcher is None:
            self.watcher = DockWatcher()
        snap = self.watcher.snapshot()
        decky.logger.info(
            f"Started: {'docked' if snap['docked'] else 'handheld'}, "
            f"connectors={snap['connectors']}, settings={self.settings}")
        self._task = asyncio.get_event_loop().create_task(self._watch())

    async def _unload(self):
        if self._task:
            self._task.cancel()
        decky.logger.info("Unloaded")

    async def _uninstall(self):
        pass
