/**
 * Pure transforms for the KeepTradeCut rankings pipeline.
 *
 * Kept free of I/O so the whole thing can be exercised against a committed
 * fixture. See scripts/lib/transform.test.mjs.
 */

/** Positions this league uses. Everything else is dropped, not hidden. */
export const SKILL_POSITIONS = ["QB", "RB", "WR", "TE"];

/**
 * The value set we read. KTC ships `oneQBValues` and `superflexValues` with
 * identical shapes and genuinely different orderings, so this is named
 * explicitly rather than defaulted — picking the wrong one is silent.
 */
export const VALUE_SET = "oneQBValues";

/**
 * The ranking field we read. The same value set also carries
 * `startSitOverallRank`, which is KTC's weekly start/sit product and not a
 * draft ranking at all. Reading it produces a plausible-looking, badly wrong
 * board. The validators below exist to catch that specific mistake.
 */
const RANK_FIELD = "rank";
const POSITIONAL_RANK_FIELD = "positionalRank";

// KTC's `overallTier` is deliberately not carried through. See "Tiers are out,
// for now" in the spec — the tiers are lumpy and unstable enough to be
// misleading, and nothing in the app currently reads them.

/**
 * Pull `var playersArray = [...]` out of the rankings page HTML.
 *
 * The array is embedded directly in the document, so there is no API to call
 * and no client-side request to intercept.
 */
export function extractPlayersArray(html) {
  const match = html.match(/var\s+playersArray\s*=\s*(\[[\s\S]*?\]);/);
  if (!match) {
    throw new Error(
      "playersArray not found in the page — KTC's markup has probably changed",
    );
  }
  try {
    return JSON.parse(match[1]);
  } catch (cause) {
    throw new Error(`playersArray found but did not parse as JSON: ${cause.message}`);
  }
}

/**
 * Raw KTC players -> the slim board the app ships.
 *
 * Filters to skill positions, reads one value set, and assigns a dense
 * `boardRank` of 1..N. Densification matters: KTC's own `rank` is unique but
 * sparse (1..2100), with kickers and defenses interleaved into it, so board
 * position and KTC rank would otherwise sit on different scales and the
 * "moved" indicator would drift permanently.
 */
export function buildBoard(rawPlayers) {
  const skill = rawPlayers.filter((p) => SKILL_POSITIONS.includes(p.position));

  // Sort by KTC rank, breaking ties on name. `rank` has no ties today; the
  // tiebreak means a refresh can never reshuffle the board through iteration
  // order alone.
  const ordered = skill.sort((a, b) => {
    const byRank = values(a)[RANK_FIELD] - values(b)[RANK_FIELD];
    return byRank !== 0 ? byRank : a.playerName.localeCompare(b.playerName);
  });

  return ordered.map((p, i) => slim(p, i + 1));
}

function values(player) {
  const v = player[VALUE_SET];
  if (!v) throw new Error(`${player.playerName} has no ${VALUE_SET}`);
  return v;
}

function slim(player, boardRank) {
  const v = values(player);
  const out = {
    id: player.playerID,
    name: player.playerName,
    position: player.position,
    team: player.team,
    boardRank,
    ktcRank: v[RANK_FIELD],
    positionalRank: v[POSITIONAL_RANK_FIELD],
    rookie: Boolean(player.rookie),
  };

  // 17 of 300 players have no bye week. Omit the key rather than shipping null,
  // so the UI renders blank instead of "undefined".
  if (player.byeWeek != null) out.byeWeek = player.byeWeek;
  if (player.age != null) out.age = player.age;

  // `injury` is present on nearly every player, but healthy ones are just
  // {injuryCode: 1}. Only carry it when there is something to badge.
  if (player.injury && player.injury.injuryCode > 1) {
    out.injury = {
      status: player.injury.injuryName,
      area: player.injury.injuryArea,
      returns: player.injury.injuryReturn,
    };
  }

  return out;
}

/**
 * Reject a board rather than commit a bad one. A stale players.json beats an
 * empty or nonsensical one, especially during draft week.
 *
 * Returns an array of problems; empty means the board is good.
 */
export function validate(players) {
  const problems = [];
  const fail = (msg) => problems.push(msg);

  if (!Array.isArray(players)) return ["board is not an array"];

  // --- Shape -------------------------------------------------------------
  if (players.length < 200 || players.length > 400) {
    fail(`expected 200-400 players, got ${players.length}`);
  }

  const ids = new Set();
  for (const p of players) {
    const who = p?.name ?? `#${p?.id}`;
    if (!Number.isInteger(p?.id)) fail(`${who}: missing or non-integer id`);
    if (!p?.name) fail(`#${p?.id}: missing name`);
    if (!SKILL_POSITIONS.includes(p?.position)) {
      fail(`${who}: unexpected position ${p?.position}`);
    }
    if (!p?.team) fail(`${who}: missing team`);
    for (const field of ["boardRank", "ktcRank"]) {
      if (!Number.isInteger(p?.[field]) || p[field] < 1) {
        fail(`${who}: ${field} is not a positive integer (${p?.[field]})`);
      }
    }
    if (!p?.positionalRank) fail(`${who}: missing positionalRank`);
    if (ids.has(p?.id)) fail(`${who}: duplicate id ${p.id}`);
    ids.add(p?.id);
  }

  // --- Densification ------------------------------------------------------
  const dense = players.every((p, i) => p.boardRank === i + 1);
  if (!dense) fail("boardRank is not a contiguous 1..N sequence in array order");

  // --- Guards against reading the start/sit field -------------------------
  // These are the checks that would have caught the one real mistake this
  // pipeline has already made. They are deliberately data-driven rather than
  // asserting on specific player names, which go stale every season.
  const ktcRanks = players.map((p) => p.ktcRank);

  // The start/sit ranking treats "not a weekly lineup consideration" as
  // unranked and collapses those players onto a single sentinel value, so a
  // large tie cluster means we are reading the wrong field.
  const counts = new Map();
  for (const r of ktcRanks) counts.set(r, (counts.get(r) ?? 0) + 1);
  const worstTie = Math.max(...counts.values());
  if (worstTie > 2) {
    fail(
      `${worstTie} players share one ktcRank — the draft ranking has no ties, ` +
        `so this looks like the start/sit sentinel`,
    );
  }

  if (counts.size < players.length * 0.95) {
    fail(
      `only ${counts.size} distinct ktcRank values across ${players.length} players`,
    );
  }

  // Same failure from the other direction: the start/sit field buries rookies
  // in that sentinel, so a top-100 with no rookies in it is a red flag.
  const rookiesUpTop = players.slice(0, 100).filter((p) => p.rookie).length;
  if (rookiesUpTop < 3) {
    fail(
      `only ${rookiesUpTop} rookies in the top 100 — the draft ranking carries ` +
        `several, the start/sit ranking carries none`,
    );
  }

  // --- Plausibility -------------------------------------------------------
  const maxRank = Math.max(...ktcRanks);
  if (maxRank > 3000) fail(`highest ktcRank is ${maxRank}, which is out of range`);

  const top = players[0];
  if (top && !SKILL_POSITIONS.includes(top.position)) {
    fail(`board opens with a ${top.position}`);
  }

  return problems;
}
