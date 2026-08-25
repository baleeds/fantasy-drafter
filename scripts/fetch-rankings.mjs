#!/usr/bin/env node
/**
 * Fetch the KeepTradeCut redraft rankings and write public/players.json.
 *
 * KTC sends no Access-Control-Allow-Origin header, so the browser cannot fetch
 * this from a GitHub Pages origin. The fetch happens here, at build time,
 * which is better anyway: the app loads instantly and works with no internet.
 *
 *   node scripts/fetch-rankings.mjs
 *   node scripts/fetch-rankings.mjs --from-file page.html      # offline
 *   node scripts/fetch-rankings.mjs --out some/path.json
 *   node scripts/fetch-rankings.mjs --dry-run                  # validate, no write
 *   node scripts/fetch-rankings.mjs --only-if-changed          # skip no-op writes
 */

import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { extractPlayersArray, buildBoard, validate } from "./lib/transform.mjs";
import { ADP_FIELD, adpQuery, extractAdp, joinAdp, orderByAdp, validateAdp } from "./lib/adp.mjs";

const SOURCE_URL = "https://keeptradecut.com/fantasy-rankings";
const ADP_URL = "https://sleeper.app/graphql";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OUT = resolve(ROOT, "public/players.json");

const RETRIES = 4;
const BACKOFF_MS = [2000, 4000, 8000, 16000];

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const html = args.fromFile
    ? await readFile(args.fromFile, "utf8")
    : await fetchWithRetry(SOURCE_URL);

  const raw = extractPlayersArray(html);
  console.log(`extracted ${raw.length} players from the page`);

  let players = buildBoard(raw);
  console.log(`kept ${players.length} skill players (dropped PK and DST)`);

  const problems = validate(players);
  if (problems.length > 0) {
    console.error(`\nvalidation failed — players.json left untouched:`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log("validation passed");

  // ADP is a second opinion about the same players, and a strictly optional
  // one: the board is useful without it and must not become unbuildable
  // because someone else's endpoint moved. A failure here costs the projection
  // lines their accuracy, not the app its board.
  const withAdp = args.skipAdp ? players : await attachAdp(players, args);

  const board = {
    generatedAt: new Date().toISOString(),
    source: SOURCE_URL,
    adpSource: withAdp.some((p) => p.adp !== undefined) ? `${ADP_URL} ${ADP_FIELD}` : null,
    format: "redraft-1qb",
    playerCount: withAdp.length,
    players: withAdp,
  };
  players = withAdp;

  if (args.dryRun) {
    console.log("dry run — nothing written");
    summarise(players);
    return;
  }

  // The daily job commits this file, so a timestamp-only rewrite would mean a
  // commit a day saying nothing. `generatedAt` therefore means "the rankings
  // last changed on this date", which is the more useful thing to display
  // anyway: if the board hasn't moved in five days, that is real information.
  if (args.onlyIfChanged && !(await playersChanged(args.out, players))) {
    console.log("player data is unchanged — leaving players.json alone");
    return;
  }

  await writeAtomic(args.out, JSON.stringify(board, null, 2) + "\n");
  console.log(`wrote ${args.out}`);
  summarise(players);
}

/**
 * Fetch ADP and join it on by name, or carry on without it.
 *
 * Deliberately non-fatal, unlike the KTC validators. A stale board beats an
 * empty one, and a board with no ADP beats no board at all — the app falls
 * back to projecting down my own ordering, which is what it did before ADP
 * existed. What must never happen is bad ADP passing silently, so the
 * validators still refuse the join outright rather than half-applying it.
 */
async function attachAdp(players, args) {
  try {
    const season = args.season ?? String(new Date().getFullYear());
    const body = JSON.stringify({ query: adpQuery(season, ADP_FIELD) });
    const response = await fetchJsonWithRetry(ADP_URL, body);

    const table = extractAdp(response, ADP_FIELD);
    console.log(`extracted ${table.size} ${ADP_FIELD} entries for ${season}`);

    const { players: joined, matched, missing } = joinAdp(players, table);
    console.log(`joined ADP onto ${matched.length}/${players.length} players`);

    const problems = validateAdp(joined, { field: ADP_FIELD });
    if (problems.length > 0) {
      console.warn(`\nADP rejected — the board is written without it:`);
      for (const p of problems) console.warn(`  - ${p}`);
      return players;
    }

    const shallowest = missing.sort((a, b) => a.boardRank - b.boardRank)[0];
    if (shallowest) console.log(`shallowest player with no ADP: ${shallowest.name} (KTC #${shallowest.ktcRank})`);

    // The board runs in draft order, not in KTC's order. See orderByAdp.
    const { players: reordered, interpolated } = orderByAdp(joined);
    console.log(`ordered the board by ADP; ${interpolated.length} placed by interpolation`);
    return reordered;
  } catch (err) {
    console.warn(`ADP fetch failed (${err.message}) — the board is written without it`);
    return players;
  }
}

async function fetchJsonWithRetry(url, body) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      return await res.json();
    } catch (err) {
      if (attempt >= RETRIES) throw new Error(`after ${RETRIES + 1} attempts: ${err.message}`);
      const wait = BACKOFF_MS[attempt];
      console.warn(`ADP attempt ${attempt + 1} failed (${err.message}); retrying in ${wait}ms`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

function parseArgs(argv) {
  const args = { fromFile: null, out: DEFAULT_OUT, dryRun: false, onlyIfChanged: false, skipAdp: false, season: null };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--from-file":
        args.fromFile = resolve(argv[++i]);
        break;
      case "--out":
        args.out = resolve(argv[++i]);
        break;
      case "--dry-run":
        args.dryRun = true;
        break;
      case "--only-if-changed":
        args.onlyIfChanged = true;
        break;
      case "--skip-adp":
        args.skipAdp = true;
        break;
      case "--season":
        args.season = argv[++i];
        break;
      default:
        throw new Error(`unknown argument: ${argv[i]}`);
    }
  }
  return args;
}

async function fetchWithRetry(url) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          // KTC serves the rankings inline in the document. A browser-ish UA
          // avoids being handed a stripped-down or blocked response.
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
            "(KHTML, like Gecko) Chrome/126.0 Safari/537.36",
          Accept: "text/html",
        },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      const html = await res.text();
      console.log(`fetched ${url} (${(html.length / 1024).toFixed(0)} KB)`);
      return html;
    } catch (err) {
      if (attempt >= RETRIES) {
        throw new Error(`fetch failed after ${RETRIES + 1} attempts: ${err.message}`);
      }
      const wait = BACKOFF_MS[attempt];
      console.warn(`fetch attempt ${attempt + 1} failed (${err.message}); retrying in ${wait}ms`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

/** True if the new player list differs from what is already on disk. */
async function playersChanged(path, players) {
  let existing;
  try {
    existing = JSON.parse(await readFile(path, "utf8"));
  } catch {
    return true; // no file yet, or an unreadable one — write.
  }
  return JSON.stringify(existing.players) !== JSON.stringify(players);
}

async function writeAtomic(path, contents) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, contents, "utf8");
  await rename(tmp, path);
}

function summarise(players) {
  const byPosition = players.reduce((acc, p) => {
    acc[p.position] = (acc[p.position] ?? 0) + 1;
    return acc;
  }, {});
  const injured = players.filter((p) => p.injury).length;

  console.log(
    `\n  ${Object.entries(byPosition)
      .map(([pos, n]) => `${pos} ${n}`)
      .join("  ")}`,
  );
  console.log(`  ${injured} carrying an injury designation`);
  const adp = players.filter((p) => typeof p.adp === "number");
  if (adp.length) {
    // Drift against KTC, not against ADP: the board is now ordered by ADP, so
    // drift against it is zero by construction. KTC is the overlay, and where
    // it disagrees is the interesting direction.
    const drift = (pos) => {
      const g = players.filter((p) => p.position === pos && p.boardRank <= 80);
      if (!g.length) return `${pos} -`;
      const mean = g.reduce((s, p) => s + (p.ktcRank - p.boardRank), 0) / g.length;
      return `${pos} ${mean > 0 ? "+" : ""}${mean.toFixed(0)}`;
    };
    console.log(
      `  ${adp.length} with ADP; KTC's drift vs draft order, top 80: ` +
        ["QB", "RB", "WR", "TE"].map(drift).join("  "),
    );
  }
  console.log(
    `  top of board: ${players
      .slice(0, 3)
      .map((p) => `${p.boardRank}. ${p.name}`)
      .join(", ")}`,
  );
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
