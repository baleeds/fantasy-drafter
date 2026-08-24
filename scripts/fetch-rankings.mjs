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

const SOURCE_URL = "https://keeptradecut.com/fantasy-rankings";
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

  const players = buildBoard(raw);
  console.log(`kept ${players.length} skill players (dropped PK and DST)`);

  const problems = validate(players);
  if (problems.length > 0) {
    console.error(`\nvalidation failed — players.json left untouched:`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log("validation passed");

  const board = {
    generatedAt: new Date().toISOString(),
    source: SOURCE_URL,
    format: "redraft-1qb",
    playerCount: players.length,
    players,
  };

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

function parseArgs(argv) {
  const args = { fromFile: null, out: DEFAULT_OUT, dryRun: false, onlyIfChanged: false };
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
  const tiers = new Set(players.map((p) => p.tier)).size;

  console.log(
    `\n  ${Object.entries(byPosition)
      .map(([pos, n]) => `${pos} ${n}`)
      .join("  ")}`,
  );
  console.log(`  ${tiers} tiers, ${injured} carrying an injury designation`);
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
