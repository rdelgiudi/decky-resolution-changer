# Dock Resolution

A [Decky Loader](https://github.com/SteamDeckHomebrew/decky-loader) plugin that switches Steam's **Maximum Game Resolution** between a *handheld* value and a *docked* value whenever an external display connects or disconnects.

Built for a Legion Go 2 running Bazzite in Game Mode, but it should work on any SteamOS-style Game Mode handheld with Decky installed. By default it caps games at 1920×1200 handheld and 1920×1080 docked, and gamescope upscales to the external display's native output.

## Features

- Detects docking automatically: any connected external display (HDMI, DisplayPort, USB-C) counts as docked.
- Lets you pick a separate resolution for handheld and docked: `Native`, 720p, 800p, 900p, 1050p, 1080p, 1200p, 1440p, 1600p or 2160p.
- Waits while a game is running and switches after the game exits.
- Checks every write by reading the value back, and turns auto-switching off with a toast if Steam's setter is missing or has changed.
- Includes an *Apply now* button and built-in diagnostics.

## Installation

### From a release zip

1. Download `decky-resolution-changer.zip` from the releases page.
2. In Game Mode, open Decky → Settings → Developer and turn on developer mode.
3. Choose **Install plugin from zip** and select the file.

### From source (on the device)

```sh
git clone https://git.giudi.me/rdelgiudi/decky-resolution-changer.git
cd decky-resolution-changer
./install.sh
```

`install.sh` builds the plugin, installs or updates it in `~/homebrew/plugins`, and restarts Decky. It asks for sudo. Other options:

| Option | Effect |
| --- | --- |
| `--zip FILE\|URL` | Install a prebuilt plugin zip from a local path or URL |
| `--repo OWNER/NAME` | Install the latest GitHub release's zip |
| `--check` | Only report whether an update is available |
| `--force` | Reinstall even if the installed copy is identical |
| `--uninstall` | Remove the plugin (settings and logs are kept) |

## Usage

Open the Quick Access menu (`…`) and select **Dock Resolution**.

- **Handheld** / **Docked**: the Maximum Game Resolution to use in each state.
- **Auto-switch on dock/undock**: turns automatic switching on or off.
- **Apply now**: applies the value for the current state right away.
- **Run diagnostics**: writes a dump of Steam's settings internals to `~/homebrew/logs/decky-resolution-changer/diagnostics.txt`. Attach it when you report a bug.

Settings are stored in `~/homebrew/settings/decky-resolution-changer/settings.json`.

## Limitations

- **The new value only takes effect at game launch.** Steam reads the cap when a game starts, so if you dock or undock mid-game, relaunch the game.
- Some games save their own resolution in their config files and ignore the cap. Set the resolution once in the game's own menu.
- The plugin only changes this one setting. Output mode, refresh rate, scaling filter and per-game overrides are left alone.
- It uses an undocumented Steam client API, so a Steam update can break it. When that happens the plugin turns auto-switching off and shows a toast instead of failing silently.

## How it works

Steam stores the cap as `CMsgClientSettings.gamescope_game_resolution_global`, a string that is either `"Native"` or `"WIDTHxHEIGHT"`. Settings → Display writes it by calling `SteamClient.Settings.SetSetting()` with a base64 protobuf that holds only field 21012. The plugin sends the same message, then reads the value back to confirm it.

| Part | File | Role |
| --- | --- | --- |
| Dock detection | `main.py` | Polls `/sys/class/drm/card*-*/status` every second. Any connected connector except `eDP`/`DSI`/`LVDS`/`Writeback` counts as docked. A new state must hold for 2 s before it counts, which absorbs hotplug flapping. |
| Settings | `main.py` | Saves `{handheld, docked, autoSwitch}`. |
| Steam setter | `src/steamSetting.ts` | The only file that touches Steam internals: `probe()`, `read()`, `write()`, `diagnostics()`, `startSpy()`. |
| Controller | `src/controller.ts` | Applies the matching value when the plugin loads and on each dock change, waits while a game is running, and turns auto-switch off on failure. |
| Quick Access panel | `src/index.tsx` | The UI. |

## Development

Requires Node.js and Python 3.

```sh
npx pnpm@9 install
npx pnpm@9 run build           # builds dist/index.js
npx pnpm@9 run watch           # rebuilds on change
python3 -I tests/test_dock.py  # backend dock detection and debounce tests (no Decky needed)
node tests/test_encode.mjs     # protobuf encoding test
./package.sh                   # builds out/decky-resolution-changer.zip
```

To inspect Steam's frontend while you work, turn on CEF remote debugging in Decky's developer settings and attach Chrome DevTools to `SharedJSContext` at `http://<device-ip>:8081`. The **Record setter calls** toggle in the panel logs every intercepted settings call to the plugin log.

## License

[BSD 3-Clause](LICENSE)
