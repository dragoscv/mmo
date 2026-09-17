"use client";

import { useEffect, useSyncExternalStore, type DependencyList } from "react";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ShortcutDef {
  id: string;
  /** Key combos, e.g. `["mod+k"]`, `["?"]`, `["space"]`, `["shift+/"]`. Any one triggers. */
  keys: string[];
  label: string;
  group: string;
  handler: (event: KeyboardEvent) => void;
  /** Extra predicate; the shortcut is skipped when it returns false. */
  when?: () => boolean;
  /** Fire even when focus is inside an input/textarea/contenteditable. */
  global?: boolean;
}

export type Platform = "mac" | "other";

// ─── Store ──────────────────────────────────────────────────────────────────

const registry = new Map<string, ShortcutDef>();
const listeners = new Set<() => void>();
let snapshot: ShortcutDef[] = [];

function emit() {
  snapshot = Array.from(registry.values());
  for (const l of listeners) l();
}

export function registerShortcut(def: ShortcutDef): () => void {
  registry.set(def.id, def);
  emit();
  return () => {
    if (registry.get(def.id) === def) {
      registry.delete(def.id);
      emit();
    }
  };
}

export function getShortcuts(): ShortcutDef[] {
  return snapshot;
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

const EMPTY: ShortcutDef[] = [];

/** Subscribes to the registry and returns the current list. */
export function useShortcuts(): ShortcutDef[] {
  return useSyncExternalStore(subscribe, getShortcuts, () => EMPTY);
}

/** Registers `def` for the lifetime of the component (re-registers when `deps` change). */
export function useRegisterShortcut(def: ShortcutDef, deps: DependencyList = []): void {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => registerShortcut(def), deps);
}

// ─── Key parsing ────────────────────────────────────────────────────────────

export interface ParsedCombo {
  key: string;
  mod: boolean;
  ctrl: boolean;
  meta: boolean;
  alt: boolean;
  shift: boolean;
}

const KEY_ALIASES: Record<string, string> = {
  esc: "escape",
  space: " ",
  return: "enter",
  up: "arrowup",
  down: "arrowdown",
  left: "arrowleft",
  right: "arrowright",
  plus: "+",
  del: "delete",
};

export function parseCombo(combo: string): ParsedCombo {
  const parts = combo.toLowerCase().split("+").filter(Boolean);
  const out: ParsedCombo = { key: "", mod: false, ctrl: false, meta: false, alt: false, shift: false };
  for (const raw of parts) {
    const p = raw.trim();
    if (p === "mod" || p === "cmd" || p === "command") out.mod = true;
    else if (p === "ctrl" || p === "control") out.ctrl = true;
    else if (p === "meta" || p === "win" || p === "super") out.meta = true;
    else if (p === "alt" || p === "option") out.alt = true;
    else if (p === "shift") out.shift = true;
    else out.key = KEY_ALIASES[p] ?? p;
  }
  // "a+b" edge case: literal "+" key
  if (!out.key && combo.includes("+") && parts.length === 0) out.key = "+";
  return out;
}

export function detectPlatform(): Platform {
  if (typeof navigator === "undefined") return "other";
  const ua = navigator.userAgent || "";
  const plat = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform ?? "";
  return /mac|iphone|ipad|ipod/i.test(plat) || /Mac|iPhone|iPad/.test(ua) ? "mac" : "other";
}

function matches(event: KeyboardEvent, combo: ParsedCombo, platform: Platform): boolean {
  const key = event.key.toLowerCase();
  // Shifted punctuation ("?" is shift+/) – compare on the produced key, ignore shift flag when key itself is a symbol.
  const isSymbol = combo.key.length === 1 && !/[a-z0-9]/.test(combo.key);
  if (key !== combo.key && !(combo.key === " " && event.code === "Space")) return false;

  const wantCtrl = combo.ctrl || (combo.mod && platform !== "mac");
  const wantMeta = combo.meta || (combo.mod && platform === "mac");
  if (event.ctrlKey !== wantCtrl) return false;
  if (event.metaKey !== wantMeta) return false;
  if (event.altKey !== combo.alt) return false;
  if (!isSymbol && event.shiftKey !== combo.shift) return false;
  return true;
}

export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (target.isContentEditable) return true;
  return target.closest('[contenteditable=""],[contenteditable="true"]') !== null;
}

/**
 * Installs ONE keydown listener that dispatches to registered shortcuts.
 * Returns an uninstall function. Idempotent per target.
 */
const installed = new WeakMap<EventTarget, () => void>();

export function installShortcutListener(target: EventTarget | undefined = typeof window !== "undefined" ? window : undefined): () => void {
  if (!target) return () => {};
  const existing = installed.get(target);
  if (existing) return existing;

  const platform = detectPlatform();
  const onKeyDown = (e: Event) => {
    const event = e as KeyboardEvent;
    if (event.defaultPrevented || event.isComposing || event.repeat) return;
    const editable = isEditableTarget(event.target);
    for (const def of snapshot) {
      if (editable && !def.global) continue;
      if (def.when && !def.when()) continue;
      for (const combo of def.keys) {
        if (matches(event, parseCombo(combo), platform)) {
          event.preventDefault();
          def.handler(event);
          return;
        }
      }
    }
  };
  target.addEventListener("keydown", onKeyDown);
  const uninstall = () => {
    target.removeEventListener("keydown", onKeyDown);
    installed.delete(target);
  };
  installed.set(target, uninstall);
  return uninstall;
}

/** React helper: installs the listener on mount. */
export function useInstallShortcutListener(target?: EventTarget): void {
  useEffect(() => installShortcutListener(target ?? window), [target]);
}

// ─── Formatting ─────────────────────────────────────────────────────────────

const MAC_SYMBOLS: Record<string, string> = { mod: "⌘", meta: "⌘", ctrl: "⌃", alt: "⌥", shift: "⇧" };
const OTHER_LABELS: Record<string, string> = { mod: "Ctrl", meta: "Win", ctrl: "Ctrl", alt: "Alt", shift: "Shift" };
const KEY_LABELS: Record<string, string> = {
  " ": "Space",
  escape: "Esc",
  enter: "↵",
  arrowup: "↑",
  arrowdown: "↓",
  arrowleft: "←",
  arrowright: "→",
  backspace: "⌫",
  delete: "Del",
  tab: "Tab",
};

/** Human-readable parts for one combo, e.g. `["⌘","K"]` or `["Ctrl","K"]`. */
export function formatKeyParts(combo: string, platform: Platform = detectPlatform()): string[] {
  const c = parseCombo(combo);
  const mods = platform === "mac" ? MAC_SYMBOLS : OTHER_LABELS;
  const out: string[] = [];
  if (c.ctrl) out.push(mods.ctrl!);
  if (c.mod) out.push(mods.mod!);
  if (c.meta && !c.mod) out.push(mods.meta!);
  if (c.alt) out.push(mods.alt!);
  if (c.shift) out.push(mods.shift!);
  const k = KEY_LABELS[c.key] ?? (c.key.length === 1 ? c.key.toUpperCase() : c.key.charAt(0).toUpperCase() + c.key.slice(1));
  out.push(k);
  return out;
}

/** `formatKeys(["mod+k"], "mac")` → `"⌘K"`; `"other"` → `"Ctrl K"`. Multiple combos joined with " / ". */
export function formatKeys(keys: string[], platform: Platform = detectPlatform()): string {
  return keys.map((k) => formatKeyParts(k, platform).join(platform === "mac" ? "" : " ")).join(" / ");
}
