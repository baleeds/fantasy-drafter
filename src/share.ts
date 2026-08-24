/**
 * Encoding the personal layer into a URL, and reading it back.
 *
 * `localStorage` alone is not durable enough to trust with a board built weeks
 * before it is used: Safari deletes all script-writable storage for a site
 * after 7 days of browser use without interaction, which is precisely the gap
 * between prepping in August and drafting in September. A bookmarked URL
 * survives that, needs no file management, and is nothing to remember to do.
 *
 * **Notes are deliberately excluded.** They are free text of unbounded length,
 * and the least costly thing to lose in a storage wipe. Leaving them out gives
 * the link a predictable ceiling instead of one that grows with how much I
 * happened to type. Notes still live in localStorage and still travel in the
 * JSON export.
 *
 * No compression. A realistic board — a few dozen placements and a handful of
 * do-not-drafts — encodes to well under a kilobyte, and even all 300 players
 * moved stays inside every browser's URL limit. `CompressionStream` would save
 * characters nobody reads at the cost of an async path and a support cliff.
 */

import type { Overrides } from "./model.ts";

const VERSION = "1";

/**
 * Sections are split on `~`, entries on `_`, and id from key on `-`. All three
 * sit outside the base36 alphabet, so no separator can appear inside a value.
 */
const SECTION = "~";
const ENTRY = "_";
const PAIR = "-";

export interface DecodedBoard {
  overrides: Overrides;
  placements: number;
  doNotDraft: number;
}

export function encodeBoard(overrides: Overrides): string {
  const placements: string[] = [];
  const doNotDraft: string[] = [];

  for (const [id, override] of Object.entries(overrides)) {
    const key36 = (n: number) => n.toString(36);
    if (override.sortKey !== undefined) {
      placements.push(`${key36(Number(id))}${PAIR}${key36(override.sortKey)}`);
    }
    if (override.doNotDraft) doNotDraft.push(key36(Number(id)));
  }

  return [VERSION, placements.join(ENTRY), doNotDraft.join(ENTRY)].join(SECTION);
}

/** Returns null for anything malformed — a bad link must not wipe a good board. */
export function decodeBoard(text: string): DecodedBoard | null {
  const sections = text.split(SECTION);
  if (sections.length !== 3 || sections[0] !== VERSION) return null;

  const overrides: Overrides = {};
  let placements = 0;
  let doNotDraft = 0;

  for (const entry of splitSection(sections[1])) {
    const [rawId, rawKey] = entry.split(PAIR);
    const id = base36(rawId);
    const sortKey = base36(rawKey);
    if (id === null || sortKey === null) return null;
    overrides[id] = { ...overrides[id], sortKey };
    placements++;
  }

  for (const entry of splitSection(sections[2])) {
    const id = base36(entry);
    if (id === null) return null;
    overrides[id] = { ...overrides[id], doNotDraft: true };
    doNotDraft++;
  }

  return { overrides, placements, doNotDraft };
}

function splitSection(section: string): string[] {
  return section ? section.split(ENTRY) : [];
}

function base36(text: string | undefined): number | null {
  if (!text || !/^[0-9a-z]+$/.test(text)) return null;
  const value = parseInt(text, 36);
  return Number.isSafeInteger(value) ? value : null;
}

/** Strips the personal layer down to what belongs in a link. */
export function shareableOverrides(overrides: Overrides): Overrides {
  const out: Overrides = {};
  for (const [id, override] of Object.entries(overrides)) {
    if (override.sortKey === undefined && !override.doNotDraft) continue;
    out[id] = {};
    if (override.sortKey !== undefined) out[id].sortKey = override.sortKey;
    if (override.doNotDraft) out[id].doNotDraft = true;
  }
  return out;
}
