/**
 * localStorage persistence for the personal layer and the pick log.
 *
 * The baseline (players.json) is never stored here — it is replaced wholesale
 * on every rankings refresh, and flattening the two together would mean each
 * refresh destroyed my prep work.
 */

import type { Overrides, Pick } from "./model.ts";

const KEYS = {
  overrides: "fd:overrides",
  picks: "fd:picks",
  settings: "fd:settings",
} as const;

/** Keys written by the drag prototype, which used a throwaway data model. */
const PROTOTYPE_KEYS = ["prototype:order", "prototype:settings"];

export interface Settings {
  mode: "prep" | "draft";
  filter: string;
  showDrafted: boolean;
  longPressMs: number;
  autoscrollMaxSpeed: number;
}

export const DEFAULT_SETTINGS: Settings = {
  mode: "prep",
  filter: "ALL",
  showDrafted: false,
  longPressMs: 350,
  autoscrollMaxSpeed: 14,
};

export function loadOverrides(): Overrides {
  return read<Overrides>(KEYS.overrides, {});
}

export function loadPicks(): Pick[] {
  return read<Pick[]>(KEYS.picks, []);
}

export function loadSettings(): Settings {
  return { ...DEFAULT_SETTINGS, ...read<Partial<Settings>>(KEYS.settings, {}) };
}

export function saveOverrides(overrides: Overrides): void {
  write(KEYS.overrides, overrides);
}

export function savePicks(picks: Pick[]): void {
  write(KEYS.picks, picks);
}

export function saveSettings(settings: Settings): void {
  write(KEYS.settings, settings);
}

export function clearEverything(): void {
  for (const key of Object.values(KEYS)) localStorage.removeItem(key);
}

/**
 * The prototype stored a flat array of player ids. That cannot be converted
 * into sort keys without pinning all 300 players and breaking the property
 * that untouched players follow KTC, so it is dropped rather than migrated.
 */
export function discardPrototypeData(): void {
  for (const key of PROTOTYPE_KEYS) localStorage.removeItem(key);
}

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    // A corrupt entry should cost me my prep, not the whole app on draft night.
    return fallback;
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Quota or a private-window restriction. Nothing useful to do mid-draft.
  }
}
