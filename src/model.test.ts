import test from "node:test";
import assert from "node:assert/strict";
import {
  Board,
  keyBetween,
  POSITIONS,
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

// --- What it costs to wait --------------------------------------------------

/** The cliff at one position, as "best→next", for readable assertions. */
const cliff = (board: Board, position: Position) => {
  const found = board.cliffs().find((c) => c.position === position)!;
  return `${found.best ?? "-"}→${found.next ?? "-"}`;
};

test("a cliff is the best two available, ranked among what is left", () => {
  // Fixture cycles RB, WR, QB, TE, so RBs sit at board 1, 5, 9 and TEs at 4, 8.
  const board = new Board(makePlayers(12));

  assert.deepEqual(board.cliffs(), [
    { position: "QB", best: 3, next: 7, gap: 4 },
    { position: "RB", best: 1, next: 5, gap: 4 },
    { position: "WR", best: 2, next: 6, gap: 4 },
    { position: "TE", best: 4, next: 8, gap: 4 },
  ]);
});

test("ranks close up as players are drafted", () => {
  const board = new Board(makePlayers(12));
  board.pick(100, false); // the top RB goes
  board.pick(101, false); // and the top WR

  // Everyone shifts up two, and RB/WR fall to their next men.
  assert.equal(cliff(board, "QB"), "1→5");
  assert.equal(cliff(board, "RB"), "3→7");
  assert.equal(cliff(board, "WR"), "4→8");
});

test("a player I took is not depth at his own position", () => {
  const board = new Board(makePlayers(12));
  assert.equal(cliff(board, "RB"), "1→5");

  board.pick(100, true);
  // Having got him, what an RB run costs me is about the RBs I do not have —
  // so the drop is now between the second and third, each a rank higher than
  // before because the player I took no longer sits above them.
  assert.equal(cliff(board, "RB"), "4→8");
});

test("a do-not-draft player is not depth either", () => {
  const board = new Board(makePlayers(12));
  board.setDoNotDraft(104, true); // the second RB

  // He keeps his board position but stops counting as an RB I could take, so
  // the drop is now to the third RB and everyone below him ranks one higher.
  assert.equal(cliff(board, "RB"), "1→8");
  assert.equal(board.rows()[4].player.id, 104);
});

test("the last player at a position has no next, rather than a bad number", () => {
  const board = new Board(makePlayers(12));
  board.pick(103, false); // two of the three TEs go
  board.pick(107, false);

  const te = board.cliffs().find((c) => c.position === "TE")!;
  assert.equal(te.best, 10);
  assert.equal(te.next, null);
  assert.equal(te.gap, null);
});

test("a position with nobody left reports nothing at all", () => {
  const board = new Board(makePlayers(12));
  for (const id of [102, 106, 110]) board.pick(id, false); // every QB

  assert.deepEqual(board.cliffs().find((c) => c.position === "QB"), {
    position: "QB",
    best: null,
    next: null,
    gap: null,
  });
});

test("a cliff follows my order, not KTC's", () => {
  const board = new Board(makePlayers(12));
  board.moveTo(108, 0); // the third RB to the very top

  assert.equal(cliff(board, "RB"), "1→2");
});

test("every position is reported, in a stable order", () => {
  const board = new Board(makePlayers(12));
  assert.deepEqual(board.cliffs().map((c) => c.position), POSITIONS);
});
