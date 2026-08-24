import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { extractPlayersArray, buildBoard, validate } from "./transform.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * A real capture of KTC's redraft payload, slimmed to the fields the pipeline
 * reads plus the start/sit fields the guards exist to reject. All 376 players
 * are present so the count-based validators mean something.
 */
const raw = JSON.parse(
  await readFile(resolve(ROOT, "test/fixtures/players-array.json"), "utf8"),
);

test("extractPlayersArray pulls the array out of page markup", () => {
  const html = `<html><body><script>
    var somethingElse = 1;
    var playersArray = [{"playerName":"A"},{"playerName":"B"}];
    var after = 2;
  </script></body></html>`;
  assert.deepEqual(extractPlayersArray(html), [
    { playerName: "A" },
    { playerName: "B" },
  ]);
});

test("extractPlayersArray fails loudly when the markup changes", () => {
  assert.throws(
    () => extractPlayersArray("<html><body>no array here</body></html>"),
    /playersArray not found/,
  );
});

test("kickers and defenses are dropped entirely", () => {
  const board = buildBoard(raw);
  assert.equal(raw.length, 376);
  assert.equal(board.length, 300);
  assert.equal(board.some((p) => p.position === "PK" || p.position === "DST"), false);
});

test("boardRank is dense 1..N even though KTC's rank is sparse", () => {
  const board = buildBoard(raw);
  board.forEach((p, i) => assert.equal(p.boardRank, i + 1));

  // The gap that makes densification necessary in the first place.
  const maxKtc = Math.max(...board.map((p) => p.ktcRank));
  assert.ok(maxKtc > board.length, `expected a sparse source rank, got max ${maxKtc}`);
});

test("board order reproduces what KTC displays", () => {
  const board = buildBoard(raw);
  // Jeremiyah Love sits 24th on the page. He is the player the start/sit field
  // buried, and the reason these tests exist.
  assert.equal(board[23].name, "Jeremiyah Love");
  assert.equal(board[0].name, "Jahmyr Gibbs");
});

test("ordering is deterministic across shuffles of the input", () => {
  const shuffled = [...raw].reverse();
  assert.deepEqual(
    buildBoard(shuffled).map((p) => p.id),
    buildBoard([...raw]).map((p) => p.id),
  );
});

test("optional fields are omitted rather than shipped as undefined", () => {
  const board = buildBoard(raw);

  const noBye = board.filter((p) => !("byeWeek" in p));
  assert.equal(noBye.length, 17);

  // Healthy players are {injuryCode: 1} at the source; they should carry no
  // injury key at all, so the UI has nothing to badge.
  const badged = board.filter((p) => p.injury);
  assert.equal(badged.length, 66);
  for (const p of badged) assert.ok(p.injury.status, `${p.name} has an empty injury status`);
});

test("tier is not carried through", () => {
  // KTC's tiers are lumpy and unstable; nothing reads them. Asserted so the
  // field cannot quietly reappear in the shipped board.
  const board = buildBoard(raw);
  assert.equal(board.some((p) => "tier" in p), false);
});

test("a board built from the real draft ranking validates", () => {
  assert.deepEqual(validate(buildBoard(raw)), []);
});

test("validate rejects a board built from the start/sit ranking", () => {
  // This is the exact mistake the pipeline made once: same value set, adjacent
  // field, plausible-looking output, completely wrong board.
  const wrong = raw
    .filter((p) => !["PK", "DST"].includes(p.position))
    .sort(
      (a, b) =>
        a.oneQBValues.startSitOverallRank - b.oneQBValues.startSitOverallRank ||
        a.playerName.localeCompare(b.playerName),
    )
    .map((p, i) => ({
      id: p.playerID,
      name: p.playerName,
      position: p.position,
      team: p.team,
      boardRank: i + 1,
      ktcRank: p.oneQBValues.startSitOverallRank,
      positionalRank: p.oneQBValues.startSitPositionalRank,
      rookie: Boolean(p.rookie),
    }));

  const problems = validate(wrong);
  assert.ok(problems.some((p) => /share one ktcRank/.test(p)), problems.join("; "));
  assert.ok(problems.some((p) => /rookies in the top 100/.test(p)), problems.join("; "));
});

test("validate catches a truncated board", () => {
  const problems = validate(buildBoard(raw).slice(0, 40));
  assert.ok(problems.some((p) => /expected 200-400 players/.test(p)), problems.join("; "));
});

test("validate catches a leaked kicker", () => {
  const board = buildBoard(raw);
  board[5] = { ...board[5], position: "PK" };
  const problems = validate(board);
  assert.ok(problems.some((p) => /unexpected position PK/.test(p)), problems.join("; "));
});

test("validate catches a hole in boardRank", () => {
  const board = buildBoard(raw);
  board[10] = { ...board[10], boardRank: 999 };
  const problems = validate(board);
  assert.ok(problems.some((p) => /contiguous/.test(p)), problems.join("; "));
});

test("validate catches duplicate ids", () => {
  const board = buildBoard(raw);
  board[7] = { ...board[7], id: board[6].id };
  const problems = validate(board);
  assert.ok(problems.some((p) => /duplicate id/.test(p)), problems.join("; "));
});
