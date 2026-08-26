import test from "node:test";
import assert from "node:assert/strict";
import {
  Board,
  keyBetween,
  snakePicks,
  SPACING,
  type Player,
  type Position,
} from "./model.ts";

function makePlayers(n: number): Player[] {
  const positions: Position[] = ["RB", "WR", "QB", "TE"];
  return Array.from({ length: n }, (_, i) => ({
    id: 100 + i,
    name: `Player ${i + 1}`,
    position: positions[i % positions.length],
    team: "XXX",
    boardRank: i + 1,
    ktcRank: i + 1,
    positionalRank: Math.floor(i / 4) + 1,
    rookie: false,
  }));
}

const names = (board: Board) => board.rows().map((r) => r.player.name);

// --- Ordering ---------------------------------------------------------------

test("an untouched board follows KTC and stores nothing", () => {
  const board = new Board(makePlayers(5));
  assert.deepEqual(names(board), ["Player 1", "Player 2", "Player 3", "Player 4", "Player 5"]);
  assert.deepEqual(board.overrides, {});
});

test("moving a player renumbers nobody else", () => {
  const board = new Board(makePlayers(5));
  board.moveTo(104, 0); // Player 5 to the top

  assert.deepEqual(names(board), ["Player 5", "Player 1", "Player 2", "Player 3", "Player 4"]);
  // Only the moved player has an override.
  assert.deepEqual(Object.keys(board.overrides), ["104"]);
});

test("a moved player stays put when KTC re-ranks him", () => {
  const players = makePlayers(5);
  const board = new Board(players);
  board.moveTo(104, 0);

  // A refresh collapses Player 5 to the bottom of KTC's board. My placement
  // is an opinion about him, not an offset from KTC's, so it should hold.
  const refreshed = makePlayers(5).map((p) =>
    p.id === 104 ? { ...p, boardRank: 99, ktcRank: 400 } : p,
  );
  const after = new Board(refreshed, board.overrides, []);
  assert.equal(after.rows()[0].player.id, 104);
});

test("untouched players pick up a refreshed KTC order automatically", () => {
  const board = new Board(makePlayers(4));
  board.moveTo(103, 0); // pin Player 4 at the top

  // KTC reverses its opinion of the three I never touched.
  const refreshed = makePlayers(4).map((p) =>
    p.id === 103 ? p : { ...p, boardRank: 4 - p.boardRank + 1 },
  );
  const after = new Board(refreshed, board.overrides, []);
  assert.deepEqual(names(after), ["Player 4", "Player 3", "Player 2", "Player 1"]);
});

test("a new player merges in at his KTC position with no special handling", () => {
  const board = new Board(makePlayers(3));
  board.moveTo(102, 0);

  // A real refresh re-densifies, so the new player takes rank 2 and everyone
  // below him shifts down. boardRank is unique by construction in the pipeline.
  const withRookie = [
    ...makePlayers(3).map((p) =>
      p.boardRank >= 2 ? { ...p, boardRank: p.boardRank + 1 } : p,
    ),
    {
      id: 999,
      name: "Rookie",
      position: "WR" as Position,
      team: "XXX",
      boardRank: 2,
      ktcRank: 2,
      positionalRank: 1,
      rookie: true,
    },
  ];
  const after = new Board(withRookie, board.overrides, []);
  assert.deepEqual(names(after), ["Player 3", "Player 1", "Rookie", "Player 2"]);
});

test("nudging moves exactly one spot, and stops at the ends", () => {
  const board = new Board(makePlayers(4));
  board.nudge(102, -1);
  assert.deepEqual(names(board), ["Player 1", "Player 3", "Player 2", "Player 4"]);

  board.nudge(100, -1); // already top
  assert.equal(names(board)[0], "Player 1");
});

test("moving to the very top and very bottom both work", () => {
  const board = new Board(makePlayers(4));
  board.moveTo(100, 3);
  assert.equal(names(board)[3], "Player 1");
  board.moveTo(100, 0);
  assert.equal(names(board)[0], "Player 1");
});

test("keyBetween splits the difference and handles both ends", () => {
  assert.equal(keyBetween(1000, 2000), 1500);
  assert.equal(keyBetween(null, 1000), 500);
  assert.equal(keyBetween(5000, null), 6000);
  assert.equal(keyBetween(null, null), SPACING);
});

test("repeated insertion into one gap triggers a respace, and order survives", () => {
  const board = new Board(makePlayers(30));

  // Hammer the same gap. Midpoint insertion halves it each time, so this
  // exhausts the spacing and must force a renormalise.
  for (let i = 0; i < 40; i++) board.moveTo(120 + (i % 5), 1);

  const rows = board.rows();
  const keys = rows.map((r) => board.sortKeyOf(r.player));
  const gaps = keys.slice(1).map((k, i) => k - keys[i]);
  assert.ok(Math.min(...gaps) >= 2, `board got too tight: smallest gap ${Math.min(...gaps)}`);
  assert.equal(new Set(rows.map((r) => r.player.id)).size, 30, "lost or duplicated a player");
});

test("a respace pins exactly the players I moved, and nobody else", () => {
  const board = new Board(makePlayers(30));
  const moved = new Set([120, 121, 122, 123, 124]);
  for (let i = 0; i < 40; i++) board.moveTo(120 + (i % 5), 1);

  // The earlier version of this test only asserted "fewer than 30", which
  // passed while a respace was pinning every *displaced* player — 203 of 300
  // on a real board. An explicit key means "I decided this"; handing one to a
  // player I merely pushed aside freezes him against the next KTC refresh.
  assert.deepEqual(
    new Set(Object.keys(board.overrides).map(Number)),
    moved,
    "respace handed keys to players I never touched",
  );
});

test("a displaced player still follows KTC after a respace and a refresh", () => {
  const board = new Board(makePlayers(30));
  for (let i = 0; i < 40; i++) board.moveTo(120 + (i % 5), 1);

  // KTC reverses its opinion of everyone I never touched.
  const touched = new Set(Object.keys(board.overrides).map(Number));
  const refreshed = makePlayers(30).map((p) =>
    touched.has(p.id) ? p : { ...p, boardRank: 31 - p.boardRank },
  );

  const after = new Board(refreshed, board.overrides, []);
  const untouched = after.rows().filter((r) => !touched.has(r.player.id));
  assert.deepEqual(
    untouched.map((r) => r.player.boardRank),
    [...untouched.map((r) => r.player.boardRank)].sort((a, b) => a - b),
    "untouched players did not pick up the refreshed order",
  );
});

test("only players I placed carry a delta", () => {
  const board = new Board(makePlayers(50));
  board.moveTo(140, 0); // P41 to the top

  const withArrows = board.rows().filter((r) => r.placed && r.moved !== 0);
  assert.equal(withArrows.length, 1, "one move should produce one arrow");
  assert.equal(withArrows[0].player.name, "Player 41");
  assert.equal(withArrows[0].moved, 40);

  // The 40 players he displaced each sit one spot lower, but that is not an
  // opinion I expressed and must not be shown as one.
  const displaced = board.rows().find((r) => r.player.name === "Player 1")!;
  assert.equal(displaced.moved, -1, "displacement is still true");
  assert.equal(displaced.placed, false, "but it is not something I decided");
});

test("a placed player's delta tracks KTC moving underneath him", () => {
  const board = new Board(makePlayers(10));
  board.moveTo(104, 0); // Player 5 to the top: up 4
  assert.equal(board.rows()[0].moved, 4);

  // KTC comes round to my view: he is now their #2, so we barely disagree.
  const refreshed = makePlayers(10).map((p) =>
    p.id === 104 ? { ...p, boardRank: 2 } : p,
  );
  const after = new Board(refreshed, board.overrides, []);
  const row = after.rows().find((r) => r.player.id === 104)!;
  assert.equal(row.moved, 1, "the gap between my opinion and theirs should shrink");
});

// Positions cycle RB, WR, QB, TE, so the WRs are players 2, 6 and 10 — and
// crucially the top WR is not the top player overall, which is what makes
// "above every visible player" different from "above everyone".
test("dragging to the top of a filtered view does not fling a player to #1 overall", () => {
  const board = new Board(makePlayers(12));
  const wrs = board.rows().filter((r) => r.player.position === "WR");
  assert.deepEqual(wrs.map((r) => r.player.name), ["Player 2", "Player 6", "Player 10"]);

  // Drag the third WR to the top of a WR-only list: no visible player above
  // him, but Player 1 is still really there.
  board.placeBetween(wrs[2].player.id, null, wrs[0].player.id);

  const order = names(board);
  assert.ok(
    order.indexOf("Player 10") < order.indexOf("Player 2"),
    "should sit above the other WRs",
  );
  assert.equal(order[0], "Player 1", "should not have displaced the #1 overall player");
});

test("dragging to the bottom of a filtered view stays local too", () => {
  const board = new Board(makePlayers(12));
  const wrs = board.rows().filter((r) => r.player.position === "WR");

  board.placeBetween(wrs[0].player.id, wrs[2].player.id, null);

  const order = names(board);
  assert.ok(
    order.indexOf("Player 2") > order.indexOf("Player 10"),
    "should sit below the other WRs",
  );
  assert.equal(order[order.length - 1], "Player 12", "should not have sunk to last overall");
});

test("resetting the order clears placements but keeps flags and notes", () => {
  const board = new Board(makePlayers(4));
  board.moveTo(103, 0);
  board.setDoNotDraft(101, true);
  board.setNote(101, "handcuff");

  board.resetOrder();
  assert.deepEqual(names(board).slice(0, 2), ["Player 1", "Player 2"]);
  assert.equal(board.isDoNotDraft(101), true);
  assert.equal(board.rows().find((r) => r.player.id === 101)!.note, "handcuff");
});

// --- Do not draft -----------------------------------------------------------

test("a flagged player keeps his place in the order", () => {
  const board = new Board(makePlayers(4));
  board.setDoNotDraft(100, true);

  // The flag says "don't take him", not "everyone else is a spot better".
  // Hiding him is the view's job — see visibleRows in main.ts.
  assert.deepEqual(names(board), ["Player 1", "Player 2", "Player 3", "Player 4"]);
  assert.equal(board.rows()[0].doNotDraft, true);
});

test("flagging one player does not move everyone else's indicator", () => {
  const board = new Board(makePlayers(10));
  const before = new Map(board.rows().map((r) => [r.player.id, r.moved]));

  board.setDoNotDraft(102, true); // sink the third player

  for (const row of board.rows()) {
    assert.equal(
      row.moved,
      before.get(row.player.id),
      `${row.player.name}'s indicator moved because someone else was flagged`,
    );
  }
});

test("a flagged player's own indicator is unchanged too — a flag is not a move", () => {
  const board = new Board(makePlayers(10));
  board.setDoNotDraft(102, true);

  const flagged = board.rows().find((r) => r.player.id === 102)!;
  assert.equal(flagged.moved, 0, "flagging is an instruction, not an opinion about rank");
  assert.equal(flagged.position, 3, "and he keeps his board position");
});

test("the indicator still tracks moves I actually make", () => {
  const board = new Board(makePlayers(10));
  board.moveTo(105, 0); // Player 6 to the top

  const rows = board.rows();
  assert.equal(rows[0].player.name, "Player 6");
  assert.equal(rows[0].moved, 5, "was #6, now #1");
});

test("clearing a flag removes the override rather than leaving an empty one", () => {
  const board = new Board(makePlayers(3));
  board.setDoNotDraft(100, true);
  board.setDoNotDraft(100, false);
  assert.deepEqual(board.overrides, {});

  board.setNote(101, "something");
  board.setNote(101, "   ");
  assert.deepEqual(board.overrides, {});
});

// --- The pick log -----------------------------------------------------------

test("picks derive player state rather than storing it", () => {
  const board = new Board(makePlayers(4));
  board.pick(100, false);
  board.pick(101, true);

  assert.equal(board.stateOf(100), "gone");
  assert.equal(board.stateOf(101), "mine");
  assert.equal(board.stateOf(102), "available");
  assert.deepEqual(board.picks, [
    { id: 100, mine: false },
    { id: 101, mine: true },
  ]);
});

test("a state can be set in either direction", () => {
  const board = new Board(makePlayers(4));

  board.setState(100, "gone");
  assert.equal(board.stateOf(100), "gone");

  board.setState(100, "mine");
  assert.equal(board.stateOf(100), "mine");
  assert.equal(board.picks.length, 1, "changing hands should not add a second entry");

  board.setState(100, "available");
  assert.equal(board.stateOf(100), "available");
  assert.deepEqual(board.picks, []);
});

test("a player who changes hands keeps his place in the pick order", () => {
  const board = new Board(makePlayers(4));
  board.setState(100, "gone");
  board.setState(101, "gone");
  board.setState(102, "gone");

  // He did come off the board when he came off it, whoever ended up with him.
  board.setState(100, "mine");
  assert.deepEqual(board.picks.map((p) => p.id), [100, 101, 102]);
});

test("releasing a player mid-log leaves the rest in order", () => {
  const board = new Board(makePlayers(5));
  for (const id of [100, 101, 102, 103]) board.setState(id, "gone");

  board.setState(101, "available");
  assert.deepEqual(board.picks.map((p) => p.id), [100, 102, 103]);
  assert.equal(board.stateOf(101), "available");
});

test("setting the state a player is already in changes nothing", () => {
  const board = new Board(makePlayers(3));
  board.setState(100, "gone");
  board.setState(100, "gone");
  assert.equal(board.picks.length, 1);
});

test("undo is unlimited and walks the whole log back", () => {
  const board = new Board(makePlayers(4));
  board.pick(100, false);
  board.pick(101, true);
  board.pick(102, false);

  assert.equal(board.undo()!.id, 102);
  assert.equal(board.stateOf(102), "available");
  assert.equal(board.undo()!.id, 101);
  assert.equal(board.undo()!.id, 100);
  assert.equal(board.undo(), undefined);
  assert.deepEqual(board.picks, []);
});

test("a player cannot be picked twice", () => {
  const board = new Board(makePlayers(3));
  board.pick(100, false);
  board.pick(100, true);
  assert.equal(board.picks.length, 1);
  assert.equal(board.stateOf(100), "gone");
});

test("resetting the draft cannot leave a stale flag behind", () => {
  const board = new Board(makePlayers(4));
  board.pick(100, false);
  board.pick(101, true);
  board.resetDraft();

  assert.deepEqual(board.picks, []);
  for (const row of board.rows()) assert.equal(row.state, "available");
});

test("resetting the draft keeps my rankings", () => {
  const board = new Board(makePlayers(4));
  board.moveTo(103, 0);
  board.pick(100, false);
  board.resetDraft();
  assert.equal(names(board)[0], "Player 4");
});

test("roster counts only count my picks", () => {
  const board = new Board(makePlayers(8));
  board.pick(100, true); // RB
  board.pick(101, false); // WR, someone else
  board.pick(104, true); // RB
  board.pick(105, true); // WR

  assert.deepEqual(board.rosterCounts(), { QB: 0, RB: 2, WR: 1, TE: 0 });
});

// --- Cliffs -----------------------------------------------------------------

const rowFor = (board: Board, id: number) => board.rows().find((r) => r.player.id === id)!;

/** A board from an explicit position list, so every gap is exact and countable. */
function makeBoard(positions: Position[]): Board {
  return new Board(
    positions.map((position, i) => ({
      id: 100 + i,
      name: `Player ${i + 1}`,
      position,
      team: "XXX",
      boardRank: i + 1,
      ktcRank: i + 1,
      positionalRank: 1,
      rookie: false,
    })),
  );
}

const fill = (position: Position, n: number): Position[] => Array<Position>(n).fill(position);

/**
 * One TE up top, the next twenty down, and the rest of the position far below.
 * 100 players with 16 TEs mirrors the real board's TE density (47 of 300), so
 * the mean spacing is 6.25 and that 20-player gap lands at 3.2x.
 */
const sparseTE = (): Position[] => [
  "TE", ...fill("WR", 19), "TE", ...fill("WR", 65), ...fill("TE", 14),
];

test("the same gap is a cliff at one position and unremarkable at another", () => {
  const positions: Position[] = [
    "WR", ...fill("RB", 9), "WR",   // a WR gap of 10, at index 0
    ...fill("RB", 9),
    "TE", ...fill("RB", 9), "TE",   // a TE gap of 10, at index 20
    ...fill("WR", 38),
    ...fill("TE", 14),
    ...fill("RB", 17),
  ];
  // Assert the premise, so a miscounted fixture fails here and not below.
  assert.equal(positions.length, 100);
  assert.equal(positions.filter((p) => p === "WR").length, 40, "WR spacing 2.5");
  assert.equal(positions.filter((p) => p === "TE").length, 16, "TE spacing 6.25");

  const board = makeBoard(positions);
  assert.ok(rowFor(board, 100).cliff, "10 players is 4x normal for a WR");
  assert.equal(rowFor(board, 120).cliff, null, "the same 10 is only 1.6x for a TE");
});

test("a cliff carries the size of the drop and how unusual it is", () => {
  const board = makeBoard(sparseTE());
  const cliff = rowFor(board, 100).cliff!;
  assert.equal(cliff.gap, 20);
  assert.ok(Math.abs(cliff.ratio - 3.2) < 0.01, `ratio was ${cliff.ratio}`);
});

test("a position too thin to have a normal spacing is never called a cliff", () => {
  // Three TEs in fifty players: the mean gap is already 16, so even a 41-player
  // run behind one is only 2.5x. With a sample that small there is no such
  // thing as an unusual gap, and claiming one would be noise.
  const board = makeBoard(["TE", "WR", "TE", ...fill("WR", 40), "TE", ...fill("WR", 6)]);
  assert.equal(rowFor(board, 102).cliff, null);
});

test("the last player of his kind carries no cliff", () => {
  const board = makeBoard(["TE", ...fill("WR", 30)]);
  assert.equal(rowFor(board, 100).cliff, null, "nobody after him is not a gap");
});

test("drafting the far side of a gap makes the drop deeper", () => {
  const board = makeBoard(sparseTE());
  const before = rowFor(board, 100).cliff!.gap;
  board.pick(120, false); // the only TE in between goes
  assert.ok(rowFor(board, 100).cliff!.gap > before, "the drop should have opened up");
});

test("do-not-draft closes off depth exactly as a pick does", () => {
  const board = makeBoard(sparseTE());
  const before = rowFor(board, 100).cliff!.gap;
  board.setDoNotDraft(120, true);
  assert.ok(rowFor(board, 100).cliff!.gap > before, "a player I will not take is not depth");
});

test("available rank counts only what is left, unlike board position", () => {
  const board = new Board(makePlayers(12));
  board.pick(100, false);
  board.pick(101, true);
  board.setDoNotDraft(102, true);

  const row = rowFor(board, 103);
  assert.equal(row.position, 4, "still 4th on my board");
  assert.equal(row.availableRank, 1, "but the best player still available");
  assert.equal(rowFor(board, 100).availableRank, null);
  assert.equal(rowFor(board, 101).availableRank, null, "mine is not depth");
  assert.equal(rowFor(board, 102).availableRank, null);
});

// --- Handing one player back to the market ----------------------------------

test("resetting a player drops him back to where the market has him", () => {
  const board = new Board(makePlayers(30));
  board.moveTo(124, 0); // Player 25 to the top
  assert.equal(names(board)[0], "Player 25");

  board.resetPosition(124);
  assert.deepEqual(names(board).slice(0, 3), ["Player 1", "Player 2", "Player 3"]);
  assert.equal(board.rows().find((r) => r.player.id === 124)!.position, 25);
});

test("a reset player is untouched again, so a refresh moves him", () => {
  // The difference between "put him back at 25" and "I no longer have an
  // opinion about him" — only the second keeps working when ADP moves.
  const board = new Board(makePlayers(30));
  board.moveTo(124, 0);
  board.resetPosition(124);
  assert.equal(board.rows().find((r) => r.player.id === 124)!.placed, false);
  assert.equal(board.overrides[124], undefined, "no override left behind at all");

  // A real refresh re-densifies: ranks are unique, so moving him to 3 pushes
  // everyone from 3 to 24 down one. Colliding two players on rank 3 instead
  // would leave the tiebreak deciding the answer rather than the refresh.
  const refreshed = makePlayers(30).map((p) => {
    if (p.id === 124) return { ...p, boardRank: 3 };
    if (p.boardRank >= 3 && p.boardRank < 25) return { ...p, boardRank: p.boardRank + 1 };
    return p;
  });
  const after = new Board(refreshed, board.overrides, []);
  assert.equal(after.rows().find((r) => r.player.id === 124)!.position, 3);
});

test("resetting a position keeps the flag and the note", () => {
  // Those are opinions about the player, not about where he sits.
  const board = new Board(makePlayers(30));
  board.moveTo(124, 0);
  board.setDoNotDraft(124, true);
  board.setNote(124, "handcuff is available late");

  board.resetPosition(124);
  assert.equal(board.isDoNotDraft(124), true);
  assert.equal(board.overrides[124].note, "handcuff is available late");
  assert.equal(board.overrides[124].sortKey, undefined);
});

test("resetting someone I never moved changes nothing", () => {
  const board = new Board(makePlayers(10));
  const before = names(board);
  board.resetPosition(105);
  assert.deepEqual(names(board), before);
  assert.deepEqual(board.overrides, {});
});

test("resetting one player leaves my other placements alone", () => {
  const board = new Board(makePlayers(30));
  board.moveTo(124, 0);
  board.moveTo(125, 1);
  board.resetPosition(124);

  assert.equal(board.rows().find((r) => r.player.id === 125)!.placed, true);
  assert.deepEqual(Object.keys(board.overrides), ["125"]);
});

// --- Where KTC disagrees ----------------------------------------------------

test("KTC disagreement is proportional to depth, not a flat number of spots", () => {
  // The same 30-spot gap, once near the top and once deep. Thirty spots is an
  // enormous disagreement at #20 and nothing at #250, where both sources guess.
  const players = makePlayers(300).map((p) =>
    p.boardRank === 20 || p.boardRank === 250
      ? { ...p, ktcRank: p.boardRank + 30 }
      : { ...p, ktcRank: p.boardRank },
  );
  const board = new Board(players);
  const at = (rank: number) => board.rows().find((r) => r.position === rank)!;

  assert.equal(at(20).ktcDisagrees, true, "30 spots at #20 is 1.5x — a real argument");
  assert.equal(at(250).ktcDisagrees, false, "30 spots at #250 is 0.12x — noise");
});

test("a board KTC agrees with flags nobody", () => {
  const players = makePlayers(100).map((p) => ({ ...p, ktcRank: p.boardRank }));
  const board = new Board(players);
  assert.equal(board.rows().filter((r) => r.ktcDisagrees).length, 0);
});

// --- Projecting down ADP rather than down my board --------------------------

test("with no ADP at all, the projection falls back to my own order", () => {
  const board = new Board(makePlayers(20));
  for (const row of board.rows()) assert.equal(row.adpRank, row.availableRank);
});

test("dragging is what makes my order diverge from the room's", () => {
  // The board arrives in draft order, so untouched, the two agree exactly.
  const players = makePlayers(30).map((p) => ({ ...p, adp: p.boardRank }));
  const board = new Board(players);
  for (const row of board.rows()) assert.equal(row.adpRank, row.availableRank);

  // Dragging a player the room takes late up to the top splits them, and the
  // projection has to keep counting down the room's order, not mine.
  board.moveTo(125, 0); // board #26, ADP 26
  const rows = board.rows();
  assert.equal(rows[0].player.id, 125);
  assert.equal(rows[0].availableRank, 1, "top of my board");
  assert.equal(rows[0].adpRank, 26, "but the room is not taking him for a while");
});

test("a player the room does not rate survives past where my board puts him", () => {
  // He is my number one; the room takes him around pick 40. That is the whole
  // reason the line counts down ADP and not my ordering.
  const players = makePlayers(60).map((p) =>
    p.boardRank === 1 ? { ...p, adp: 40 } : { ...p, adp: p.boardRank },
  );
  const board = new Board(players);
  const mine = board.rows()[0];

  assert.equal(mine.availableRank, 1, "still the best player on my board");
  assert.ok(mine.adpRank! > 30, `but the room is in no hurry — adpRank ${mine.adpRank}`);
});

test("a player the room loves is counted as gone even if I rate him low", () => {
  const players = makePlayers(60).map((p) =>
    p.boardRank === 50 ? { ...p, adp: 1 } : { ...p, adp: p.boardRank + 10 },
  );
  const board = new Board(players);
  const row = board.rows().find((r) => r.player.boardRank === 50)!;
  assert.equal(row.adpRank, 1);
  assert.equal(row.availableRank, 50);
});

test("players with no ADP sort behind everyone who has one", () => {
  const players = makePlayers(20).map((p) =>
    p.boardRank <= 10 ? p : { ...p, adp: p.boardRank },
  );
  const board = new Board(players);
  const rows = board.rows();
  const rated = rows.filter((r) => r.player.adp !== undefined).map((r) => r.adpRank!);
  const unrated = rows.filter((r) => r.player.adp === undefined).map((r) => r.adpRank!);
  assert.ok(Math.max(...rated) < Math.min(...unrated), "nobody is taking an unranked player soon");
});

test("ADP rank ignores players who are gone, mine, or flagged", () => {
  const players = makePlayers(20).map((p) => ({ ...p, adp: p.boardRank }));
  const board = new Board(players);
  board.pick(100, false);
  board.pick(101, true);
  board.setDoNotDraft(102, true);

  const row = board.rows().find((r) => r.player.id === 103)!;
  assert.equal(row.adpRank, 1, "the three above him are not coming back");
  for (const id of [100, 101, 102]) {
    assert.equal(board.rows().find((r) => r.player.id === id)!.adpRank, null);
  }
});

// --- Where my picks land ----------------------------------------------------

test("a snake seat near the top gets a lopsided rhythm", () => {
  assert.deepEqual(snakePicks(14, 2, 6), [2, 27, 30, 55, 58, 83]);
  assert.deepEqual(snakePicks(14, 14, 4), [14, 15, 42, 43], "the wheel picks back to back");
  assert.deepEqual(snakePicks(10, 1, 4), [1, 20, 21, 40]);
});

test("a projection counts the players who come off before my pick", () => {
  const board = new Board(makePlayers(60));
  const [first, second] = board.projections(14, 2);

  // Nothing recorded yet, so pick 1 is still to come: one player goes, then me.
  assert.deepEqual(first, { pick: 2, after: 1 });
  assert.deepEqual(second, { pick: 27, after: 26 }, "picks 1 through 26 come first");
});

test("lines move up as the draft eats picks", () => {
  const board = new Board(makePlayers(60));
  for (let i = 0; i < 10; i++) board.pick(100 + i, false);

  const next = board.projections(14, 2).find((p) => p.pick === 27)!;
  assert.equal(next.after, 16, "27 - 10 recorded - 1");
});

test("a pick spent on someone I flagged brings my turn nearer for free", () => {
  const board = new Board(makePlayers(60));
  board.setDoNotDraft(105, true);
  const before = board.projections(14, 2).find((p) => p.pick === 27)!.after;
  const depth = board.rows().filter((r) => r.availableRank !== null).length;

  board.pick(105, false);
  const after = board.projections(14, 2).find((p) => p.pick === 27)!.after;

  assert.equal(after, before - 1, "the line moved up");
  assert.equal(
    board.rows().filter((r) => r.availableRank !== null).length,
    depth,
    "and cost me nothing, because he was never an option",
  );
});

test("a line only moves when the room departs from my board", () => {
  const board = new Board(makePlayers(60));
  const lineAt = () => {
    const after = board.projections(14, 2).find((p) => p.pick === 27)!.after;
    return board.rows().find((r) => r.availableRank === after + 1)!.player.boardRank;
  };
  assert.equal(lineAt(), 27, "nothing drafted, so board rank and available rank agree");

  // A pick that goes exactly as my board expects costs me a player and a pick
  // at the same time, and the two cancel: the line does not move at all.
  board.pick(100, false);
  assert.equal(lineAt(), 27);

  // A reach nobody on my board justifies consumes a pick without taking anyone
  // I wanted, so a better player survives to my turn.
  board.pick(149, false); // board #50
  assert.equal(lineAt(), 26, "a wasted pick hands me a better player");
});

test("picks already made drop off, rather than piling up behind me", () => {
  const board = new Board(makePlayers(60));
  for (let i = 0; i < 30; i++) board.pick(100 + i, false);

  const picks = board.projections(14, 2).map((p) => p.pick);
  assert.ok(!picks.includes(2) && !picks.includes(27) && !picks.includes(30));
  assert.equal(picks[0], 55);
});

test("projections stop at the end of the board rather than running off it", () => {
  const board = new Board(makePlayers(40));
  for (const p of board.projections(14, 2)) assert.ok(p.after <= 40);
});

test("a nonsense league draws no lines at all", () => {
  const board = new Board(makePlayers(20));
  for (const [teams, slot] of [[1, 1], [14, 0], [14, 15], [12, 1.5], [NaN, 1]]) {
    assert.deepEqual(board.projections(teams, slot), [], `${teams}/${slot}`);
  }
});
