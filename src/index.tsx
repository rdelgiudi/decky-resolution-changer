import {
  ButtonItem,
  DropdownItem,
  PanelSection,
  PanelSectionRow,
  ToggleField,
  staticClasses,
} from "@decky/ui";
import { callable, definePlugin } from "@decky/api";
import { useEffect, useState } from "react";
import { MdMonitor } from "react-icons/md";
import { controller } from "./controller";
import * as steam from "./steamSetting";

const saveDiagnostics = callable<[text: string], string>("save_diagnostics");

// "Native" is Steam's own value for "no cap" (confirmed on-device).
const RESOLUTIONS = [
  "Native",
  "1280x720",
  "1280x800",
  "1600x900",
  "1680x1050",
  "1920x1080",
  "1920x1200",
  "2560x1440",
  "2560x1600",
  "3840x2160",
];

function options(current?: string) {
  const list = current && !RESOLUTIONS.includes(current) ? [current, ...RESOLUTIONS] : RESOLUTIONS;
  return list.map((r) => ({ data: r, label: r === "Native" ? "Native (no cap)" : r.replace("x", " × ") }));
}

const small = { fontSize: "12px", lineHeight: "16px", wordBreak: "break-word" as const };

let stopSpy: (() => void) | null = null;
const spyLines: string[] = [];

function Content() {
  // Plain subscribe pattern (works on any React version Steam ships).
  const [state, setState] = useState(controller.state);
  useEffect(() => controller.subscribe(() => setState(controller.state)), []);
  const [diag, setDiag] = useState<string | null>(null);
  const [spyOn, setSpyOn] = useState(!!stopSpy);
  const [, forceRender] = useState(0);

  useEffect(() => {
    if (!spyOn) return;
    const t = setInterval(() => forceRender((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [spyOn]);

  const { settings, dock, probe } = state;
  if (!settings || !dock) {
    return (
      <PanelSection>
        <PanelSectionRow>Loading…</PanelSectionRow>
      </PanelSection>
    );
  }

  const mode = dock.docked ? "Docked" : "Handheld";

  return (
    <>
      <PanelSection title="Status">
        <PanelSectionRow>
          <div style={small}>
            <div>
              <b>Mode:</b> {mode}
              {dock.docked && dock.external.length > 0 ? ` (${dock.external.join(", ")})` : ""}
            </div>
            <div>
              <b>Last applied:</b> {state.lastApplied ?? "—"}
            </div>
            <div>
              <b>Result:</b> {state.lastResult}
            </div>
            {state.pending && <div>⏳ Waiting for the running game to exit</div>}
            <div>
              <b>Setter:</b> {probe?.ok ? `found ${probe.key}${steam.VERIFIED ? "" : " (unverified — auto-apply is dry-run)"}` : `unavailable — ${probe?.reason ?? "not probed"}`}
            </div>
          </div>
        </PanelSectionRow>
      </PanelSection>

      <PanelSection title="Maximum Game Resolution">
        <PanelSectionRow>
          <DropdownItem
            label="Handheld"
            layout="below"
            rgOptions={options(settings.handheld)}
            selectedOption={settings.handheld}
            onChange={(o) => controller.updateSettings({ handheld: o.data })}
          />
        </PanelSectionRow>
        <PanelSectionRow>
          <DropdownItem
            label="Docked"
            layout="below"
            rgOptions={options(settings.docked)}
            selectedOption={settings.docked}
            onChange={(o) => controller.updateSettings({ docked: o.data })}
          />
        </PanelSectionRow>
        <PanelSectionRow>
          <ToggleField
            label="Auto-switch on dock/undock"
            description="Takes effect at the next game launch."
            checked={settings.autoSwitch}
            onChange={(v) => controller.updateSettings({ autoSwitch: v })}
          />
        </PanelSectionRow>
        <PanelSectionRow>
          <ButtonItem layout="below" onClick={() => controller.requestApply("manual")}>
            Apply now ({dock.docked ? settings.docked : settings.handheld})
          </ButtonItem>
        </PanelSectionRow>
      </PanelSection>

      <PanelSection title="Diagnostics">
        <PanelSectionRow>
          <ButtonItem
            layout="below"
            description="Dumps Steam settings internals to diagnostics.txt in the plugin's log folder."
            onClick={async () => {
              const text = steam.diagnostics();
              console.log(text);
              try {
                const path = await saveDiagnostics(text);
                setDiag(`Saved to ${path}\n\n${text.split("\n").slice(0, 14).join("\n")}`);
              } catch (e) {
                setDiag(`Could not save (${e}); see the console.\n\n${text}`);
              }
            }}
          >
            Run diagnostics
          </ButtonItem>
        </PanelSectionRow>
        <PanelSectionRow>
          <ToggleField
            label="Record setter calls"
            description="Turn on, then change Maximum Game Resolution in Settings → Display. Calls are logged to the plugin log."
            checked={spyOn}
            onChange={(v) => {
              if (v && !stopSpy) {
                spyLines.length = 0;
                stopSpy = steam.startSpy((line) => {
                  spyLines.push(line);
                  if (spyLines.length > 20) spyLines.shift();
                  controller.log(`[spy] ${line}`);
                });
              } else if (!v && stopSpy) {
                stopSpy();
                stopSpy = null;
              }
              setSpyOn(v);
            }}
          />
        </PanelSectionRow>
        {spyOn && spyLines.length > 0 && (
          <PanelSectionRow>
            <pre style={{ ...small, whiteSpace: "pre-wrap" }}>{spyLines.slice(-6).join("\n")}</pre>
          </PanelSectionRow>
        )}
        {diag && (
          <PanelSectionRow>
            <pre style={{ ...small, whiteSpace: "pre-wrap" }}>{diag}</pre>
          </PanelSectionRow>
        )}
      </PanelSection>
    </>
  );
}

export default definePlugin(() => {
  controller.init().catch((e) => controller.log(`init failed: ${e}`, "error"));

  return {
    name: "Dock Resolution",
    titleView: <div className={staticClasses.Title}>Dock Resolution</div>,
    content: <Content />,
    icon: <MdMonitor />,
    onDismount() {
      stopSpy?.();
      stopSpy = null;
      controller.dispose();
    },
  };
});
