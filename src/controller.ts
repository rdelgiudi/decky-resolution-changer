/**
 * Glue between the backend's dock state, the stored settings and the Steam
 * setter. One singleton, observable by the React panel.
 */
import { addEventListener, removeEventListener, callable, toaster } from "@decky/api";
import { Router } from "@decky/ui";
import * as steam from "./steamSetting";

export interface Settings {
  handheld: string;
  docked: string;
  autoSwitch: boolean;
}

export interface DockState {
  docked: boolean;
  external: string[];
  connectors: Record<string, string>;
  changedAt: number;
}

export interface State {
  settings: Settings | null;
  dock: DockState | null;
  lastApplied: string | null;
  lastResult: string;
  pending: boolean;
  probe: steam.ProbeResult | null;
}

const getSettings = callable<[], Settings>("get_settings");
const setSettingsBackend = callable<[Partial<Settings>], Settings>("set_settings");
const getState = callable<[], DockState>("get_state");
const backendLog = callable<[level: string, message: string], void>("log");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Reason = "load" | "dock" | "settings" | "game-exit" | "manual";

class Controller {
  state: State = {
    settings: null,
    dock: null,
    lastApplied: null,
    lastResult: "not applied yet",
    pending: false,
    probe: null,
  };
  private listeners = new Set<() => void>();
  private cleanups: (() => void)[] = [];
  private applying: Promise<void> = Promise.resolve();

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private set(patch: Partial<State>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((l) => l());
  }

  log(message: string, level: "info" | "warning" | "error" = "info") {
    console.log(`[DockRes] ${message}`);
    backendLog(level, message).catch(() => {});
  }

  async init() {
    const dockListener = addEventListener<[DockState]>("dock_state", (dock) => {
      this.set({ dock });
      this.log(`dock state changed: ${dock.docked ? "docked" : "handheld"} ${dock.external.join(",")}`);
      this.requestApply("dock");
    });
    this.cleanups.push(() => removeEventListener("dock_state", dockListener));

    try {
      const reg = SteamClient?.GameSessions?.RegisterForAppLifetimeNotifications?.((n) => {
        this.log(`app lifetime: app ${n.unAppID} running=${n.bRunning}`);
        if (!n.bRunning && this.state.pending) this.requestApply("game-exit");
      });
      if (reg) this.cleanups.push(() => reg.unregister());
    } catch (e) {
      this.log(`could not register for app lifetime notifications: ${e}`, "warning");
    }

    const [settings, dock] = await Promise.all([getSettings(), getState()]);
    this.set({ settings, dock, probe: steam.probe(true) });
    this.log(`loaded: ${dock.docked ? "docked" : "handheld"}, settings=${JSON.stringify(settings)}, probe=${JSON.stringify(this.state.probe)}`);
    this.requestApply("load");
  }

  dispose() {
    this.stopPendingWatch();
    this.cleanups.forEach((c) => c());
    this.cleanups = [];
  }

  async updateSettings(patch: Partial<Settings>) {
    const settings = await setSettingsBackend(patch);
    this.set({ settings });
    this.requestApply("settings");
  }

  private pendingTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * Fallback for the lifetime notification, which was seen on-device to never
   * arrive: while an apply is pending, poll every 2 s and apply as soon as no
   * game is running.
   */
  private startPendingWatch() {
    if (this.pendingTimer) return;
    this.pendingTimer = setInterval(() => {
      if (!this.state.pending) return this.stopPendingWatch();
      if (!this.isGameRunning()) {
        this.stopPendingWatch();
        this.log("no game running any more (poll); applying pending switch");
        this.requestApply("game-exit");
      }
    }, 2000);
  }

  private stopPendingWatch() {
    if (this.pendingTimer) clearInterval(this.pendingTimer);
    this.pendingTimer = null;
  }

  runningAppsDescription(): string {
    try {
      const apps = (Router.RunningApps ?? []).map((a: any) => `${a.display_name ?? "?"} (${a.appid})`);
      const main = Router.MainRunningApp as any;
      if (main && !apps.length) apps.push(`${main.display_name ?? "?"} (${main.appid})`);
      return apps.join(", ") || "none";
    } catch {
      return "unknown";
    }
  }

  isGameRunning(): boolean {
    try {
      return !!Router.MainRunningApp || (Router.RunningApps?.length ?? 0) > 0;
    } catch {
      return false;
    }
  }

  /** Serialise applies so overlapping dock/settings events cannot interleave. */
  requestApply(reason: Reason): Promise<void> {
    this.applying = this.applying.then(() => this.apply(reason)).catch((e) => this.log(`apply failed: ${e}`, "error"));
    return this.applying;
  }

  private async apply(reason: Reason) {
    const { settings, dock } = this.state;
    if (!settings || !dock) return;
    if (!settings.autoSwitch && reason !== "manual") {
      if (this.state.pending) this.set({ pending: false, lastResult: "auto-switch off; pending switch dropped" });
      return;
    }

    // The poll and the lifetime notification can both fire; only act once.
    if (reason === "game-exit" && !this.state.pending) return;

    if (reason !== "manual" && this.isGameRunning()) {
      const running = this.runningAppsDescription();
      this.set({ pending: true, lastResult: `waiting for ${running} to exit` });
      this.log(`deferring apply (${reason}): running apps: ${running}`);
      this.startPendingWatch();
      return;
    }

    const target = dock.docked ? settings.docked : settings.handheld;
    // Right after boot / a Steam restart, Decky loads us before Steam has
    // populated its client settings (seen on-device: the setting is missing for
    // >10 s). Wait for it instead of treating that as a broken setter.
    if (!steam.probe(true).ok) {
      const timeoutMs = reason === "load" ? 120_000 : 10_000;
      this.set({ lastResult: "waiting for Steam settings to load…" });
      const start = Date.now();
      while (!steam.probe(true).ok && Date.now() - start < timeoutMs) await sleep(1000);
      if (steam.probe().ok) this.log(`settings became available after ${Math.round((Date.now() - start) / 1000)} s`);
    }
    // The dock state may have changed while we waited.
    const finalTarget = this.state.dock?.docked ? this.state.settings!.docked : this.state.settings!.handheld;
    if (finalTarget !== target) {
      this.log(`target changed while waiting (${target} -> ${finalTarget}); re-queueing`);
      return;
    }
    const result = await steam.write(target, reason === "manual");
    const probe = steam.probe();
    const status = result.ok ? "ok" : result.skipped ? "dry-run" : "FAILED";
    this.log(
      `apply (${reason}) ${target}: ${status} — ${result.reason}` +
        (result.ok && steam.lastPayload ? ` [${steam.lastPayload}]` : ""),
      result.ok || result.skipped ? "info" : "error",
    );

    if (result.ok) {
      this.set({ lastApplied: target, lastResult: result.reason, pending: false, probe });
      return;
    }

    this.set({ lastResult: result.reason, pending: false, probe });
    if (result.skipped) return; // Phase 0 gate: not a failure, nothing written.
    const disabled = settings.autoSwitch;
    if (disabled) {
      const newSettings = await setSettingsBackend({ autoSwitch: false });
      this.set({ settings: newSettings });
    }
    toaster.toast({
      title: "Dock Resolution: could not set resolution",
      body: disabled ? `${result.reason}. Auto-switch has been turned off.` : result.reason,
    });
  }
}

export const controller = new Controller();
