import test from "node:test";
import assert from "node:assert/strict";
import { encodeBoard, decodeBoard, shareableOverrides } from "./share.ts";
import { Board, type Player, type Position } from "./model.ts";
import type { Overrides } from "./model.ts";

function makePlayers(n: number): Player[] {
  const positions: Position[] = ["RB", "WR", "QB", "TE"];
  return Array.from({ length: n }, (_, i) => ({
    id: 100 + i,
    name: `Player ${i + 1}`,
    position: positions[i % positions.length],
    team: "XXX",
    boardRank: i + 1,
    ktcRank: i + 1,
    positionalRank: 1,
    rookie: false,
  }));
}

test("a board survives a round trip", () => {
  const overrides: Overrides = {
    "1508": { sortKey: 8500 },
    "1414": { doNotDraft: true },
    "2020": { sortKey: 125, doNotDraft: true },
  };

  const decoded = decodeBoard(encodeBoard(overrides))!;
  assert.deepEqual(decoded.overrides, overrides);
  assert.equal(decoded.placements, 2);
  assert.equal(decoded.doNotDraft, 2);
});

test("an empty board round trips", () => {
  const decoded = decodeBoard(encodeBoard({}))!;
  assert.deepEqual(decoded.overrides, {});
  assert.equal(decoded.placements, 0);
});

test("notes never reach the link", () => {
  const overrides: Overrides = {
    "1508": { sortKey: 8500, note: "handcuff is available late" },
    "1414": { note: "just a note" },
  };

  const encoded = encodeBoard(overrides);
  assert.equal(encoded.includes("handcuff"), false);
  assert.equal(encoded.includes("note"), false);

  // The player who had only a note carries nothing at all.
  const decoded = decodeBoard(encoded)!;
  assert.deepEqual(Object.keys(decoded.overrides), ["1508"]);
  assert.deepEqual(decoded.overrides["1508"], { sortKey: 8500 });
});

test("shareableOverrides drops notes and note-only players", () => {
  assert.deepEqual(
    shareableOverrides({
      "1": { sortKey: 10, note: "x" },
      "2": { note: "y" },
      "3": { doNotDraft: true },
    }),
    { "1": { sortKey: 10 }, "3": { doNotDraft: true } },
  );
});

test("a real reordered board encodes small enough to bookmark", () => {
  const board = new Board(makePlayers(300));
  // Move 60 players around — a heavier prep session than I would really do.
  for (let i = 0; i < 60; i++) board.moveTo(100 + i * 4, i * 2);
  for (let i = 0; i < 25; i++) board.setDoNotDraft(100 + i * 11, true);

  const encoded = encodeBoard(board.overrides);
  assert.ok(encoded.length < 1200, `link payload was ${encoded.length} chars`);

  const decoded = decodeBoard(encoded)!;
  const restored = new Board(makePlayers(300), decoded.overrides, []);
  assert.deepEqual(
    restored.rows().map((r) => r.player.id),
    board.rows().map((r) => r.player.id),
    "restored board is in a different order",
  );
});

test("even every player moved stays inside a sane URL length", () => {
  const board = new Board(makePlayers(300));
  for (let i = 299; i >= 0; i--) board.moveTo(100 + i, 0);

  const encoded = encodeBoard(board.overrides);
  assert.ok(encoded.length < 8000, `link payload was ${encoded.length} chars`);
});

test("sort keys stay whole numbers, so the encoding stays compact", () => {
  const board = new Board(makePlayers(40));
  for (let i = 0; i < 60; i++) board.moveTo(100 + (i % 8), 3);

  for (const override of Object.values(board.overrides)) {
    if (override.sortKey === undefined) continue;
    assert.ok(
      Number.isInteger(override.sortKey),
      `fractional sort key ${override.sortKey} would encode as a decimal string`,
    );
  }
});

// --- A bad link must never destroy a good board -----------------------------

test("malformed input decodes to null rather than a partial board", () => {
  for (const bad of [
    "",
    "2~a-b~",           // unknown version
    "1~a-b",            // missing a section
    "1~a-b~c~d",        // too many sections
    "1~!!!~",           // not base36
    "1~a-~",            // missing key
    "1~-b~",            // missing id
    "1~~!!",            // bad do-not-draft id
    "1~a-b~ ",          // stray whitespace
  ]) {
    assert.equal(decodeBoard(bad), null, `should have rejected ${JSON.stringify(bad)}`);
  }
});

test("a decoded board is independent of the one it came from", () => {
  const original: Overrides = { "1508": { sortKey: 8500 } };
  const decoded = decodeBoard(encodeBoard(original))!;
  decoded.overrides["1508"].sortKey = 1;
  assert.equal(original["1508"].sortKey, 8500);
});
