/**
 * The ONLY place that touches Steam client internals.
 *
 * Steam's "Maximum Game Resolution" setter is undocumented. Phase 0 findings
 * (Legion Go 2, Bazzite, Steam client 2026-11-14):
 *   - The value lives in CMsgClientSettings.gamescope_game_resolution_global
 *     (settingsStore.m_ClientSettings), a string: "Native" or "WIDTHxHEIGHT".
 *   - Settings → Display writes it with SteamClient.Settings.SetSetting(base64)
 *     of a one-field message, captured as:
 *       "1920x1080" -> "oqEKCTE5MjB4MTA4MA=="  (a2 a1 0a 09 "1920x1080")
 *       "Native"    -> "oqEKBk5hdGl2ZQ=="      (a2 a1 0a 06 "Native")
 *     i.e. field number 21012, wire type 2 (length-delimited string).
 *
 * Design:
 *   - probe()  finds a readable value and a way to write it, or explains why not.
 *   - read()   returns the current value.
 *   - write()  only writes a value in the same shape that read() returned
 *              (e.g. a "1920x1080" string) and refuses unknown shapes.
 *   - diagnostics() dumps everything relevant so the user can report it back.
 */
import { findModuleExport, modules } from "@decky/ui";

// Confirmed field name. If a Steam update renames it, a heuristic search over
// the store's keys is used and the probe reports what it found.
const KNOWN_KEYS = ["gamescope_game_resolution_global"];

// Confirmed protobuf field number of gamescope_game_resolution_global.
const FIELD_NUMBER = 21012;

// Keys that look like "resolution" but are certainly not the one we want.
const KEY_EXCLUDE = /background|recording|remote|stream|export|broadcast|time_res|screenshot/i;
const KEY_INCLUDE = /(game.?res|max.?res|resolution)/i;

export const RES_PATTERN = /^\d{3,5}x\d{3,5}$/;

/**
 * Phase 0 gate. While false, automatic applies (load / dock / settings change)
 * only log what they WOULD write; only the manual "Apply now" button really
 * calls the setter. Set to true after the setter was captured on-device; every
 * write is still verified by reading the value back.
 */
export const VERIFIED = true;

// Method names that must never be invoked while reading/dumping settings.
const UNSAFE_METHOD = /^(set|clear|add|remove|merge|serialize|deserialize|clone|copy|to|read|write|get[A-Z]|has[A-Z]|constructor$)/;

export interface ProbeResult {
  ok: boolean;
  reason: string;
  key?: string;
  current?: unknown;
  setter?: string;
}

interface Located {
  store: any;
  settings: any; // the m_ClientSettings-like object
}

// ----------------------------------------------------------------------------
// Locating the settings store
// ----------------------------------------------------------------------------

let cachedStore: Located | null | undefined;

function locateStore(): Located | null {
  if (cachedStore !== undefined) return cachedStore;
  cachedStore = null;
  try {
    // UNVERIFIED: Steam has historically exposed `settingsStore` on window in
    // SharedJSContext, holding the client settings in `m_ClientSettings`.
    const w = window as any;
    if (w.settingsStore?.m_ClientSettings) {
      cachedStore = { store: w.settingsStore, settings: w.settingsStore.m_ClientSettings };
      return cachedStore;
    }
    const store = findModuleExport(
      (e: any) => e && typeof e === "object" && e.m_ClientSettings && typeof e.m_ClientSettings === "object",
    );
    if (store) cachedStore = { store, settings: store.m_ClientSettings };
  } catch (e) {
    console.error("[DockRes] locateStore failed", e);
  }
  return cachedStore;
}

function isSafeGetter(key: string, fn: Function): boolean {
  return fn.length === 0 && !UNSAFE_METHOD.test(key);
}

function readField(settings: any, key: string): unknown {
  const v = settings?.[key];
  if (typeof v !== "function") return v;
  // Protobuf message instances expose fields as zero-arg getter methods.
  // Never call anything that could mutate Steam's live settings.
  if (!isSafeGetter(key, v)) return "<method, not called>";
  return v.call(settings);
}

/** Own keys plus the FIRST prototype only (never the jspb base Message class). */
function allKeys(obj: any): string[] {
  if (!obj) return [];
  const keys = new Set<string>(Object.keys(obj));
  const proto = Object.getPrototypeOf(obj);
  if (proto && proto !== Object.prototype) {
    Object.getOwnPropertyNames(proto).forEach((k) => keys.add(k));
  }
  return [...keys];
}

/** Keys that are plain data or safe zero-arg getters. */
function fieldKeys(obj: any): string[] {
  return allKeys(obj).filter((k) => {
    try {
      const v = obj[k];
      return typeof v !== "function" || isSafeGetter(k, v);
    } catch {
      return false;
    }
  });
}

function findKey(settings: any): { key?: string; reason: string } {
  const keys = fieldKeys(settings);
  for (const k of KNOWN_KEYS) {
    if (keys.includes(k)) return { key: k, reason: `known key ${k}` };
  }
  const candidates = keys.filter((k) => KEY_INCLUDE.test(k) && !KEY_EXCLUDE.test(k));
  if (candidates.length === 1) return { key: candidates[0], reason: `heuristic match ${candidates[0]}` };
  if (candidates.length === 0) return { reason: "no resolution-like key in client settings" };
  return { reason: `ambiguous keys: ${candidates.join(", ")}` };
}

// ----------------------------------------------------------------------------
// Write strategies (all UNVERIFIED)
// ----------------------------------------------------------------------------

type Writer = {
  name: string;
  encode: (key: string, value: string) => string;
  write: (base64: string) => Promise<void>;
};

function varint(n: number): number[] {
  const out: number[] = [];
  while (n > 0x7f) {
    out.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  out.push(n);
  return out;
}

/** Protobuf: one length-delimited string field, base64-encoded. */
export function encodeStringField(field: number, value: string): string {
  const bytes = new TextEncoder().encode(value);
  const all = [...varint((field << 3) | 2), ...varint(bytes.length), ...bytes];
  return btoa(String.fromCharCode(...all));
}

function findWriters(key: string): Writer[] {
  const writers: Writer[] = [];

  if (typeof SteamClient?.Settings?.SetSetting !== "function") return writers;
  const send = async (b64: string) => {
    const ok = await SteamClient.Settings.SetSetting(b64);
    if (ok === false) throw new Error("SetSetting returned false");
  };

  // Strategy 1 (preferred): Steam's own CMsgClientSettings class, exactly what
  // Settings → Display does. Survives a field renumbering.
  const MsgClass = findModuleExport(
    (e: any) =>
      typeof e === "function" &&
      typeof e.deserializeBinary === "function" &&
      typeof e.prototype?.[key] === "function" &&
      typeof e.prototype?.[`set_${key}`] === "function",
  );
  if (MsgClass) {
    writers.push({
      name: `SetSetting(CMsgClientSettings.set_${key})`,
      encode: (k, v) => {
        const msg = new MsgClass();
        msg[`set_${k}`](v);
        return msg.serializeBase64String();
      },
      write: async (b64) => send(b64),
    });
  }

  // Strategy 2 (fallback): hand-encode the captured wire format. Only valid
  // for the confirmed key, since the field number is pinned.
  if (key === KNOWN_KEYS[0]) {
    writers.push({
      name: `SetSetting(raw field ${FIELD_NUMBER})`,
      encode: (_k, v) => encodeStringField(FIELD_NUMBER, v),
      write: async (b64) => send(b64),
    });
  }
  return writers;
}

// ----------------------------------------------------------------------------
// Public API
// ----------------------------------------------------------------------------

let probeCache: (ProbeResult & { writer?: Writer }) | null = null;

/** Shape check. Cheap after the first call; pass force=true to re-probe. */
export function probe(force = false): ProbeResult {
  if (probeCache && !force) return strip(probeCache);
  if (force) cachedStore = undefined;

  const loc = locateStore();
  if (!loc) return (probeCache = { ok: false, reason: "Steam settings store not found" });

  const { key, reason: keyReason } = findKey(loc.settings);
  if (!key) return (probeCache = { ok: false, reason: keyReason });

  const current = readField(loc.settings, key);
  if (typeof current !== "string") {
    return (probeCache = {
      ok: false,
      key,
      current,
      reason: `value of ${key} is ${typeof current} (${JSON.stringify(current)}); only string values are supported until the format is confirmed`,
    });
  }

  const writers = findWriters(key);
  if (writers.length === 0) {
    return (probeCache = { ok: false, key, current, reason: "no setter found for " + key });
  }
  probeCache = { ok: true, key, current, setter: writers[0].name, reason: keyReason, writer: writers[0] };
  return strip(probeCache);
}

function strip(p: ProbeResult & { writer?: Writer }): ProbeResult {
  const { writer: _w, ...rest } = p;
  return rest;
}

/** The last base64 payload sent, for logging/diagnostics. */
export let lastPayload: string | null = null;

export function read(): unknown {
  const p = probe();
  if (!p.key) return undefined;
  const loc = locateStore();
  return loc ? readField(loc.settings, p.key) : undefined;
}

export interface WriteResult {
  ok: boolean;
  reason: string;
  /** True when nothing was attempted because the setter is not verified yet. */
  skipped?: boolean;
}

/**
 * Write a value like "1920x1080". Never throws.
 * `explicit` = the user pressed "Apply now"; only then may an unverified setter run.
 */
export async function write(value: string, explicit = false): Promise<WriteResult> {
  try {
    const p = probe(true);
    if (!p.ok || !probeCache?.writer || !p.key) return { ok: false, reason: p.reason };
    if (!RES_PATTERN.test(value) && !["Default", "Native"].includes(value)) {
      return { ok: false, reason: `refusing to write unexpected value ${value}` };
    }
    if (read() === value) return { ok: true, reason: "already set" };
    if (!VERIFIED && !explicit) {
      return {
        ok: false,
        skipped: true,
        reason: `setter not verified yet: would write ${value} via ${p.setter} (use Apply now to test)`,
      };
    }

    const payload = probeCache.writer.encode(p.key, value);
    lastPayload = `${p.setter}: ${payload}`;
    await probeCache.writer.write(payload);

    // Verify: the store should reflect the new value shortly after.
    for (let i = 0; i < 10; i++) {
      if (read() === value) return { ok: true, reason: `set via ${p.setter}` };
      await new Promise((r) => setTimeout(r, 100));
    }
    return { ok: false, reason: `wrote via ${p.setter} but value reads back as ${JSON.stringify(read())}` };
  } catch (e) {
    return { ok: false, reason: `setter threw: ${e}` };
  }
}

/** Phase 0 helper: dump everything that could identify the real setter. */
export function diagnostics(): string {
  const out: string[] = [];
  const safe = (label: string, fn: () => unknown) => {
    try {
      out.push(`${label}: ${JSON.stringify(fn(), null, 0)}`);
    } catch (e) {
      out.push(`${label}: <error ${e}>`);
    }
  };
  out.push(`# Dock Resolution diagnostics ${new Date().toISOString()}`);
  safe("SteamClient.Settings keys", () => Object.keys(SteamClient?.Settings ?? {}));
  safe("SteamClient.System keys", () => Object.keys((SteamClient as any)?.System ?? {}));
  safe("SteamClient.System.Display keys", () => Object.keys((SteamClient as any)?.System?.Display ?? {}));
  safe("SteamClient.System.DisplayManager keys", () =>
    Object.keys((SteamClient as any)?.System?.DisplayManager ?? {}),
  );
  safe("window.settingsStore present", () => !!(window as any).settingsStore);

  const loc = locateStore();
  safe("store found", () => !!loc);
  if (loc) {
    safe("store methods", () => allKeys(loc.store).filter((k) => typeof loc.store[k] === "function"));
    safe("client settings: resolution/gamescope keys", () =>
      Object.fromEntries(
        fieldKeys(loc.settings)
          .filter((k) => /res|gamescope|display/i.test(k))
          .map((k) => {
            try {
              return [k, readField(loc.settings, k)];
            } catch {
              return [k, "<unreadable>"];
            }
          }),
      ),
    );
  }

  // Any webpack export whose own keys mention a game resolution.
  safe("webpack exports mentioning game resolution", () => {
    const hits: string[] = [];
    for (const [id, m] of modules) {
      for (const mod of [m?.default, m]) {
        if (!mod || typeof mod !== "object" || mod === window) continue;
        for (const name of Object.keys(mod)) {
          if (/game.?res|maxgameres|GameResolution/i.test(name)) hits.push(`${id}.${name}`);
        }
      }
      if (hits.length > 50) break;
    }
    return hits;
  });

  safe("probe()", () => probe(true));

  if (loc) {
    out.push("");
    out.push("# All client settings (diff two dumps to find the changed key)");
    for (const k of fieldKeys(loc.settings).sort()) {
      try {
        const v = readField(loc.settings, k);
        if (v === null || ["string", "number", "boolean"].includes(typeof v)) out.push(`${k} = ${JSON.stringify(v)}`);
      } catch {
        /* skip */
      }
    }
  }
  return out.join("\n");
}

/**
 * Phase 0 helper: wrap SteamClient.Settings.SetSetting and the store's Set*
 * methods so their arguments are reported while the user changes Maximum Game
 * Resolution in Settings → Display. Returns a function that removes the spy.
 */
export function startSpy(report: (line: string) => void): () => void {
  const restores: (() => void)[] = [];
  const wrap = (owner: any, name: string, label: string) => {
    const orig = owner?.[name];
    if (typeof orig !== "function") return;
    const wasOwn = Object.prototype.hasOwnProperty.call(owner, name);
    owner[name] = function (this: any, ...args: any[]) {
      let decoded = "";
      if (label.endsWith("SetSetting") && typeof args[0] === "string") {
        decoded = ` (base64, ${args[0].length} chars)`;
      }
      try {
        report(`${label}(${args.map((a) => JSON.stringify(a)).join(", ")})${decoded}`);
      } catch {
        report(`${label}(<unserialisable args>)`);
      }
      return orig.apply(this, args);
    };
    restores.push(() => {
      if (wasOwn) owner[name] = orig;
      else delete owner[name];
    });
  };

  wrap(SteamClient?.Settings, "SetSetting", "SteamClient.Settings.SetSetting");
  const loc = locateStore();
  if (loc) {
    for (const k of allKeys(loc.store)) {
      if (/^Set/.test(k) && typeof loc.store[k] === "function") wrap(loc.store, k, `settingsStore.${k}`);
    }
  }
  report(`spy armed on ${restores.length} function(s)`);
  return () => restores.forEach((r) => r());
}
