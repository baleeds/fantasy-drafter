import test from "node:test";
import assert from "node:assert/strict";
import { placeLines, type BoardRow, type Projection } from "./model.ts";

/**
 * Rows carrying only what placeLines reads. `adpRanks` is given in *board*
 * order and is deliberately not sorted — that is the whole point.
 */
function rows(adpRanks: (number | null)[]): BoardRow[] {
  return adpRanks.map((adpRank, i) =>
    ({ player: { id: 100 + i }, adpRank }) as unknown as BoardRow,
  );
}

/** 1-based rendered row the line for `pick` sits above. */
const rowOf = (marks: Map<number, string>, pick: string) => {
  const found = [...marks].find(([, picks]) => picks.split(" · ").includes(pick));
  return found ? found[0] - 100 + 1 : null;
};

const projections = (...pairs: [number, number][]): Projection[] =>
  pairs.map(([pick, after]) => ({ pick, after }));

const straight = (n: number) => rows(Array.from({ length: n }, (_, i) => i + 1));

test("a line sits immediately below the last player due to come off the board", () => {
  // Nothing drafted yet, so pick 55 has 54 players ahead of it. Row 55 is what
  // I would expect to be looking at, so the line goes above it.
  const marks = placeLines(straight(80), projections([2, 1], [27, 26], [30, 29], [55, 54]));
  assert.equal(rowOf(marks, "2"), 2);
  assert.equal(rowOf(marks, "27"), 27);
  assert.equal(rowOf(marks, "30"), 30);
  assert.equal(rowOf(marks, "55"), 55);
});

test("lines keep the spacing of the picks between them", () => {
  const marks = placeLines(straight(120), projections([27, 26], [30, 29], [55, 54], [58, 57]));
  assert.equal(rowOf(marks, "30")! - rowOf(marks, "27")!, 3);
  assert.equal(rowOf(marks, "55")! - rowOf(marks, "30")!, 25);
  assert.equal(rowOf(marks, "58")! - rowOf(marks, "55")!, 3);
});

test("dragging a player does not move the lines", () => {
  // Where my next turn falls is a fact about the draft, not about my opinion of
  // anybody. Both earlier rules failed exactly here, in mirror-image ways: a
  // late-ADP player dragged up, and an early-ADP one dragged down.
  const plain = straight(120);
  const draggedUp = rows([90, ...Array.from({ length: 119 }, (_, i) => i + 1)]);
  const draggedDown = rows([
    ...Array.from({ length: 60 }, (_, i) => i + 2), 1,
    ...Array.from({ length: 59 }, (_, i) => i + 62),
  ]);

  const picks = projections([55, 54], [58, 57]);
  for (const board of [draggedUp, draggedDown]) {
    const marks = placeLines(board, picks);
    assert.equal(rowOf(marks, "55"), rowOf(placeLines(plain, picks), "55"));
    assert.notEqual(rowOf(marks, "55"), rowOf(marks, "58"), "the two lines collapsed");
    assert.equal(rowOf(marks, "58")! - rowOf(marks, "55")!, 3);
  }
});

test("players already off the board are passed over, not counted", () => {
  // Gone, mine and flagged rows carry no ADP rank. They cannot be drafted
  // again, so they must not consume any of the count.
  const marks = placeLines(
    rows([1, null, 2, null, 3, null, 4, 5, 6, 7]),
    projections([9, 4]),
  );
  // Four available players sit at rows 1, 3, 5 and 7, so the line is above row 8.
  assert.equal(rowOf(marks, "9"), 8);
});

test("being on the clock puts the line above the whole board", () => {
  const marks = placeLines(straight(20), projections([2, 0]));
  assert.equal(rowOf(marks, "2"), 1);
});

test("lines never run backwards, however the board is arranged", () => {
  const scrambled = rows([40, 1, 39, 2, 38, 3, ...Array.from({ length: 60 }, (_, i) => i + 4)]);
  const marks = placeLines(scrambled, projections([2, 1], [27, 26], [30, 29], [55, 54]));
  const placed = ["2", "27", "30", "55"].map((p) => rowOf(marks, p)!);
  assert.deepEqual(placed, [...placed].sort((a, b) => a - b));
});

test("a pick past the end of the visible list draws no line", () => {
  assert.equal(placeLines(straight(3), projections([200, 199])).size, 0);
});
