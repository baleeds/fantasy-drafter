import test from "node:test";
import assert from "node:assert/strict";
import { normaliseName, extractAdp, joinAdp, validateAdp } from "./adp.mjs";

const row = (first, last, position, adp, extra = {}) => ({
  player_id: `${first}${last}`,
  player: { first_name: first, last_name: last, position, ...extra },
  stats: { adp_half_ppr: adp, pts_half_ppr: 100 },
});

const response = (rows) => ({ data: { season_stats: rows } });

/** A board dense enough to satisfy the coverage guard. */
function board(overrides = {}) {
  const positions = ["RB", "WR", "WR", "TE"];
  return Array.from({ length: 200 }, (_, i) => ({
    id: 100 + i,
    name: `Player ${i + 1}`,
    position: positions[i % positions.length],
    boardRank: i + 1,
    adp: i + 1 + 0.5,
    ...(overrides[i + 1] ?? {}),
  }));
}

test("suffixes are stripped, because only one source writes them", () => {
  assert.equal(normaliseName("Marvin Harrison Jr."), normaliseName("Marvin Harrison"));
  assert.equal(normaliseName("Kenneth Walker III"), normaliseName("Kenneth Walker"));
  assert.equal(normaliseName("Ja'Marr Chase"), "jamarrchase");
  assert.equal(normaliseName("Amon-Ra St. Brown"), "amonrastbrown");
  // A surname that merely ends in those letters is not a suffix.
  assert.equal(normaliseName("Baker Mayfield"), "bakermayfield");
});

test("sentinels are dropped rather than read as a draft position", () => {
  // 999 is "not drafted", and letting it through would seat a player at pick
  // 999 — the same trap startSitOverallRank set with its 971.
  const table = extractAdp(response([row("Real", "Player", "RB", 12.4), row("Un", "Drafted", "WR", 999)]));
  assert.equal(table.get("realplayer"), 12.4);
  assert.equal(table.has("undrafted"), false);
});

test("positions from other people's leagues are ignored", () => {
  const table = extractAdp(response([row("Some", "Linebacker", "LB", 30), row("A", "Kicker", "K", 40)]));
  assert.equal(table.size, 0);
});

test("a duplicated player keeps his earliest ADP", () => {
  const table = extractAdp(response([row("Two", "Entries", "WR", 40), row("Two", "Entries", "WR", 25)]));
  assert.equal(table.get("twoentries"), 25);
});

test("a response missing the payload fails loudly", () => {
  assert.throws(() => extractAdp({ data: {} }), /season_stats missing/);
  assert.throws(() => extractAdp({ errors: [{ message: "nope" }] }), /season_stats missing/);
});

test("players with no ADP keep the field absent rather than getting a zero", () => {
  const table = new Map([["playerone", 3.2]]);
  const { players, matched, missing } = joinAdp(
    [
      { name: "Player One", boardRank: 1 },
      { name: "Player Two", boardRank: 2 },
    ],
    table,
  );
  assert.equal(players[0].adp, 3.2);
  assert.equal("adp" in players[1], false, "absent, not zero — zero would mean pick 1");
  assert.equal(matched.length, 1);
  assert.equal(missing[0].name, "Player Two");
});

test("a clean join passes", () => {
  assert.deepEqual(validateAdp(board()), []);
});

test("a broken name join is caught before it reaches the board", () => {
  // Everything past the top 20 loses its ADP: the join half-worked, which is
  // worse than not working at all because the lines would still draw.
  const holed = board().map((p) => (p.boardRank > 20 ? { ...p, adp: undefined } : p));
  const problems = validateAdp(holed);
  assert.ok(problems.some((p) => /top 120/.test(p)), problems.join("; "));
});

test("a whole-number column is rejected as a ranking wearing ADP's name", () => {
  // This is exactly what search_rank is, and it would look entirely plausible.
  const ranks = board().map((p) => ({ ...p, adp: p.boardRank }));
  const problems = validateAdp(ranks);
  assert.ok(problems.some((p) => /not an average/.test(p)), problems.join("; "));
});

test("a superflex column is caught by who sits at the top of it", () => {
  // In 1QB the earliest quarterback goes around 22. A top 12 full of them
  // means adp_2qb — same shape, different league, silently wrong board.
  const superflex = board().map((p) => (p.boardRank <= 6 ? { ...p, position: "QB" } : p));
  const problems = validateAdp(superflex);
  assert.ok(problems.some((p) => /2QB column/.test(p)), problems.join("; "));
});

test("a sentinel that somehow survived the extract is still refused", () => {
  const problems = validateAdp(board({ 5: { adp: 999 } }));
  assert.ok(problems.some((p) => /sentinel/.test(p)), problems.join("; "));
});

test("a mostly-empty join is refused outright", () => {
  const sparse = board().map((p) => (p.boardRank > 40 ? { ...p, adp: undefined } : p));
  assert.ok(validateAdp(sparse).length > 0);
});
