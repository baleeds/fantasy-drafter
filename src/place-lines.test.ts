import test from "node:test";
import assert from "node:assert/strict";
import { placeLines, type BoardRow, type Projection } from "./model.ts";

/**
 * Rows carrying only what placeLines reads: an id and an ADP rank. `adpRanks`
 * is given in *board* order, which is the whole point — it is not sorted.
 */
function rows(adpRanks: (number | null)[]): BoardRow[] {
  return adpRanks.map((adpRank, i) =>
    ({ player: { id: 100 + i }, adpRank }) as unknown as BoardRow,
  );
}

const at = (marks: Map<number, string>, pick: string) =>
  [...marks].find(([, picks]) => picks.split(" · ").includes(pick))?.[0];

/** Row index (1-based) of the line for a pick, for readable assertions. */
const rowOf = (marks: Map<number, string>, pick: string) => {
  const id = at(marks, pick);
  return id === undefined ? null : id - 100 + 1;
};

const projections = (...pairs: [number, number][]): Projection[] =>
  pairs.map(([pick, after]) => ({ pick, after }));

test("on a board that matches the market, lines land on their own pick numbers", () => {
  const marks = placeLines(
    rows(Array.from({ length: 60 }, (_, i) => i + 1)),
    projections([2, 1], [27, 26], [30, 29]),
  );
  assert.equal(rowOf(marks, "2"), 2);
  assert.equal(rowOf(marks, "27"), 27);
  assert.equal(rowOf(marks, "30"), 30);
});

test("a player dragged above the market does not drag every line up with him", () => {
  // Row 2 is someone I rate second but the room takes 50th. Anchoring to the
  // first *survivor* put every later line on him, because he genuinely does
  // survive all of them — true, and useless as a position marker.
  const ranks = [1, 50, ...Array.from({ length: 58 }, (_, i) => i + 2)];
  const marks = placeLines(rows(ranks), projections([27, 26], [30, 29], [55, 54]));

  assert.notEqual(rowOf(marks, "27"), rowOf(marks, "30"), "27 and 30 collapsed onto one row");
  assert.notEqual(rowOf(marks, "30"), rowOf(marks, "55"), "30 and 55 collapsed onto one row");
  // 25 picks separate 30 and 55, so 25 rows should separate their lines.
  assert.equal(rowOf(marks, "55")! - rowOf(marks, "30")!, 25);
});

test("lines keep the spacing of the picks behind them, however the board is dragged", () => {
  // Ten deep players hoisted to the top — a normal prep session.
  const hoisted = [90, 91, 92, 93, 94, 95, 96, 97, 98, 99];
  const ranks = [...hoisted, ...Array.from({ length: 80 }, (_, i) => i + 1)];
  const marks = placeLines(rows(ranks), projections([27, 26], [30, 29], [55, 54], [58, 57]));

  assert.equal(rowOf(marks, "30")! - rowOf(marks, "27")!, 3);
  assert.equal(rowOf(marks, "55")! - rowOf(marks, "30")!, 25);
  assert.equal(rowOf(marks, "58")! - rowOf(marks, "55")!, 3);
});

test("lines never run backwards", () => {
  const ranks = [40, 1, 39, 2, 38, 3, ...Array.from({ length: 60 }, (_, i) => i + 4)];
  const marks = placeLines(rows(ranks), projections([2, 1], [27, 26], [30, 29], [55, 54]));
  const placed = ["2", "27", "30", "55"].map((p) => rowOf(marks, p)).filter((r) => r !== null);
  assert.deepEqual(placed, [...placed].sort((a, b) => a! - b!));
});

test("drafted rows are skipped, not counted as survivors", () => {
  // Gone and flagged players carry no ADP rank; they must not anchor a line.
  const marks = placeLines(
    rows([1, null, 2, null, 3, 4, 5, 6, 7, 8]),
    projections([5, 4]),
  );
  const row = rowOf(marks, "5");
  assert.equal(row, 7, "the fourth surviving player sits at row 6, so the line is below him");
});

test("a pick past the end of the visible list draws no line at all", () => {
  const marks = placeLines(rows([1, 2, 3]), projections([200, 199]));
  assert.equal(marks.size, 0);
});
