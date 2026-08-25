/**
 * Average draft position, joined onto the KTC board.
 *
 * KTC is crowd-sourced *value*: who is good. ADP is *behaviour*: when players
 * actually come off the board. The app needs both and must never confuse them
 * — my board decides who I want, ADP decides who will still be there.
 *
 * The source is Sleeper's GraphQL endpoint, which is public and unauthenticated.
 * Two things about it are worth writing down, because neither is discoverable:
 *
 * - **ADP is not under `category: "adp"`.** That category exists and returns
 *   zero rows for every season. The numbers live inside the `proj` category's
 *   stats map, alongside the projections, supplied by Rotowire.
 * - **`search_rank` on the player dump is not ADP** and must not be substituted
 *   for it. It is a coarse bucketed ordering — 290 draftable players share only
 *   206 distinct values, with three-way ties at the very top — drawn from a
 *   universe that includes IDP and kickers. Measured against it, KTC looks like
 *   it wildly over-rates tight ends (+16 spots); measured against real ADP that
 *   drift is +7, and the actual outlier is quarterbacks. A bucketed popularity
 *   ranking is not a draft order, and reading it as one produces confident
 *   nonsense.
 */

/**
 * Which ADP column to read. Named explicitly rather than defaulted, for the
 * same reason the KTC pipeline names `oneQBValues`: the twelve columns are
 * interchangeable in shape and silently wrong in content. `adp_2qb` would
 * reorder the top of the board around quarterbacks; `adp_dynasty_*` would
 * reorder it around age.
 */
export const ADP_FIELD = "adp_half_ppr";

/** Above this, the value is a "not drafted" sentinel rather than a position. */
const SENTINEL = 999;

/** Positions this app knows about. Everything else is another league's game. */
const SKILL = new Set(["QB", "RB", "WR", "TE"]);

export const ADP_QUERY = `query {
  season_stats(sport: "nfl", season: "%SEASON%", season_type: "regular",
               category: "proj", order_by: "%FIELD%") {
    player_id player stats
  }
}`;

export function adpQuery(season, field = ADP_FIELD) {
  return ADP_QUERY.replace("%SEASON%", season).replace("%FIELD%", field);
}

/**
 * Names as a join key.
 *
 * Suffixes are the whole problem: KTC writes "Marvin Harrison Jr." where the
 * other side writes "Marvin Harrison". Stripping them takes the raw match from
 * 290 to 298 of 300.
 */
export function normaliseName(name) {
  return String(name ?? "")
    .toLowerCase()
    .replace(/[^a-z ]/g, "")
    .trim()
    .replace(/\b(jr|sr|ii|iii|iv|v)$/, "")
    .trim()
    .replace(/ /g, "");
}

/**
 * Pull a name-keyed ADP table out of the GraphQL response.
 *
 * The player object is inlined on every row, so this needs no second request
 * for the 14MB player dump just to turn ids into names.
 */
export function extractAdp(response, field = ADP_FIELD) {
  const rows = response?.data?.season_stats;
  if (!Array.isArray(rows)) throw new Error("season_stats missing from the ADP response");

  const table = new Map();
  for (const row of rows) {
    const value = row?.stats?.[field];
    const player = row?.player;
    if (typeof value !== "number" || value >= SENTINEL) continue;
    if (!player || !SKILL.has(player.position)) continue;

    const key = normaliseName(`${player.first_name ?? ""} ${player.last_name ?? ""}`);
    if (!key) continue;
    // A player can appear more than once; the earliest pick is the real one.
    if (!table.has(key) || table.get(key) > value) table.set(key, value);
  }
  return table;
}

/**
 * Attach ADP to each player, leaving it absent where there is none.
 *
 * Absent is a real answer, not a gap to paper over: beyond about pick 200 a
 * player has no meaningful ADP because he is not reliably drafted at all. The
 * app treats a missing ADP as "nobody is taking him soon", which is right.
 */
export function joinAdp(players, table) {
  const matched = [];
  const missing = [];

  const joined = players.map((player) => {
    const adp = table.get(normaliseName(player.name));
    if (adp === undefined) {
      missing.push(player);
      return player;
    }
    matched.push(player);
    return { ...player, adp };
  });

  return { players: joined, matched, missing };
}

/**
 * Guards against joining a plausible-looking but wrong column.
 *
 * Every one is data-driven rather than name-based, so they do not need
 * revisiting each season — the same discipline the KTC validators use, and for
 * the same reason: this has already gone wrong once with `startSitOverallRank`.
 */
export function validateAdp(players, { field = ADP_FIELD } = {}) {
  const problems = [];
  const fail = (m) => problems.push(m);
  const withAdp = players.filter((p) => typeof p.adp === "number");

  if (withAdp.length < 150) {
    fail(`only ${withAdp.length} players carry ${field} — expected at least 150`);
  }

  // Coverage has to be dense where decisions happen. The tail can be sparse.
  const top = players.filter((p) => p.boardRank <= 120);
  const covered = top.filter((p) => typeof p.adp === "number").length;
  if (covered < top.length * 0.95) {
    fail(`only ${covered}/${top.length} of the top 120 have an ADP — the name join is broken`);
  }

  if (withAdp.some((p) => p.adp >= SENTINEL)) {
    fail(`a sentinel value of ${SENTINEL}+ survived into the board`);
  }

  // Real ADP is an average, so it carries decimals. A column of whole numbers
  // is a *ranking* wearing ADP's name — which is exactly what `search_rank` is.
  if (withAdp.length > 0 && !withAdp.some((p) => !Number.isInteger(p.adp))) {
    fail(`every ${field} value is a whole number — this is a ranking, not an average`);
  }

  // In a 1QB league quarterbacks do not go early; measured, the best of them
  // lands around 22. A top 12 stiff with them means a superflex column.
  const earliest = [...withAdp].sort((a, b) => a.adp - b.adp).slice(0, 12);
  const quarterbacks = earliest.filter((p) => p.position === "QB").length;
  if (quarterbacks > 2) {
    fail(`${quarterbacks} of the 12 earliest ADPs are quarterbacks — this looks like a 2QB column`);
  }

  return problems;
}
