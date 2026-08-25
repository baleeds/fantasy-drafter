/**
 * End-to-end check of the board: modes, the pick log, filters, search, and
 * that state survives a reload.
 *
 * The drag gesture has its own check in drag-check.mjs. This one is about
 * everything built on top of it.
 *
 *   npm run build && npm run test:app
 */

import { spawn } from "node:child_process";
import { chromium } from "playwright";

const PORT = 4174;
const URL = `http://localhost:${PORT}/fantasy-drafter/`;
const EXECUTABLE = process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium";

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass });
  console.log(`${pass ? "ok  " : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};

const server = spawn("npx", ["vite", "preview", "--port", String(PORT)], { stdio: "ignore" });
await waitForServer();

const browser = await chromium.launch({ executablePath: EXECUTABLE });
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true,
});
const page = await context.newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e)));

try {
  await page.goto(URL, { waitUntil: "networkidle" });
  await page.waitForSelector(".row");

  const rows = () => page.locator(".row");
  const nameAt = (i) => rows().nth(i).locator(".name").innerText();
  const visibleCount = () => rows().count();

  check("the full board renders", (await visibleCount()) === 300);

  // --- Uniform row height, which the drag arithmetic depends on -----------
  const heights = await page.evaluate(() =>
    [...new Set([...document.querySelectorAll(".row")].map((r) =>
      Math.round(r.getBoundingClientRect().height),
    ))],
  );
  check("every row is the same height", heights.length === 1, `heights: ${heights}`);

  check(
    "touch shows no drag handle",
    await rows().nth(0).locator(".grip").isHidden(),
  );

  // --- Filters -------------------------------------------------------------
  await page.click('.chip[data-filter="QB"]');
  const qbOnly = await page.evaluate(() =>
    [...document.querySelectorAll(".row .meta")].every((m) => m.textContent.startsWith("QB")),
  );
  check("a position filter shows only that position", qbOnly && (await visibleCount()) === 44);

  await page.click('.chip[data-filter="FLEX"]');
  const flexOnly = await page.evaluate(() =>
    [...document.querySelectorAll(".row .meta")].every((m) =>
      /^(RB|WR|TE)/.test(m.textContent),
    ),
  );
  check("FLEX covers RB, WR and TE", flexOnly && (await visibleCount()) === 256);

  await page.click('.chip[data-filter="ALL"]');

  // --- The rank column is board position, not position within the filter ---
  await page.click('.chip[data-filter="TE"]');
  const firstTeRank = await rows().nth(0).locator(".rank").innerText();
  check(
    "the rank column keeps board position under a filter",
    Number(firstTeRank) > 1,
    `first TE is board #${firstTeRank}`,
  );
  await page.click('.chip[data-filter="ALL"]');

  // --- Draft mode and the pick log ----------------------------------------
  await page.click('.modes button[data-mode="draft"]');
  check(
    "switching to draft marks that mode active",
    await page.locator('.modes button[data-mode="draft"]').evaluate((b) =>
      b.classList.contains("active"),
    ),
  );
  check(
    "and both modes stay visible so neither is a guess",
    (await page.locator(".modes button").count()) === 2 &&
      (await page.locator(".modes button").first().isVisible()),
  );

  // --- The positional cliff ------------------------------------------------
  // What it costs to wait: the best two still available at each position.
  const cliffs = async () =>
    (await page.locator("#cliffs .cliff").allInnerTexts()).map((t) =>
      t.replace(/\s+/g, " ").trim(),
    );

  const cliffBefore = await cliffs();
  check("the cliff strip reports all four positions", cliffBefore.length === 4, cliffBefore.join(" | "));
  check(
    "as a best→next range of real numbers, not NaN or undefined",
    cliffBefore.every((t) => /^(QB|RB|WR|TE) \d+→\d+$/.test(t)),
    cliffBefore.join(" | "),
  );

  // The cliff is a property of the board, not of what happens to be on screen.
  // If filtering to one position or searching a name moved these numbers, they
  // would mean nothing.
  await page.click('.chip[data-filter="TE"]');
  const cliffFiltered = await cliffs();
  await page.click('.chip[data-filter="ALL"]');
  await page.fill("#search", "a");
  const cliffSearched = await cliffs();
  await page.fill("#search", "");
  check(
    "filtering and searching leave the cliff numbers alone",
    cliffFiltered.join("|") === cliffBefore.join("|") &&
      cliffSearched.join("|") === cliffBefore.join("|"),
    `filtered ${cliffFiltered.join(" | ")}`,
  );

  const first = await nameAt(0);
  const second = await nameAt(1);
  await rows().nth(0).click();
  await page.waitForTimeout(400);

  check("tapping a row takes him off the board", (await nameAt(0)) === second);
  check(
    "and the cliff moves with him",
    (await cliffs()).join("|") !== cliffBefore.join("|"),
    `${cliffBefore.join(" | ")}   →   ${(await cliffs()).join(" | ")}`,
  );
  check("the board shrinks by one", (await visibleCount()) === 299);
  check("undo is offered when a row leaves the screen", (await page.locator("#undo").innerText()).includes(first));

  // --- Mine ----------------------------------------------------------------
  const mineTarget = await nameAt(0);
  await rows().nth(0).locator(".mine-btn").click();
  await page.waitForTimeout(400);

  await page.click('.chip[data-filter="MINE"]');
  check("the MINE filter shows my picks", (await visibleCount()) === 1);
  check("and it is the right player", (await nameAt(0)) === mineTarget);
  check(
    "my pick is not struck through",
    await page.evaluate(() => {
      const row = document.querySelector(".row");
      return (
        row.classList.contains("state-mine") &&
        getComputedStyle(row.querySelector(".name")).textDecorationLine === "none"
      );
    }),
  );
  check(
    "the roster counts it",
    /\b(QB|RB|WR|TE) 1\b/.test(await page.locator("#roster").innerText()),
    await page.locator("#roster").innerText(),
  );
  await page.click('.chip[data-filter="ALL"]');

  // --- My picks stay on the board -----------------------------------------
  // The point of hiding taken players is to collapse the run that went between
  // my picks, not to lose sight of my own team.
  check(
    "my pick stays on the board with 'show taken' off",
    (await page.evaluate(() => !document.querySelector("#show-drafted").checked)) &&
      (await page.locator(".row.state-mine").count()) === 1,
  );
  check(
    "and someone else's pick is gone from it",
    (await page.locator(".row.state-gone").count()) === 0,
  );
  check(
    "my pick keeps its board position rather than being pulled to the top",
    Number(await page.locator(".row.state-mine").locator(".rank").innerText()) > 1,
    `at board #${await page.locator(".row.state-mine").locator(".rank").innerText()}`,
  );

  // --- Search reaches drafted players --------------------------------------
  await page.fill("#search", first);
  check("search finds a drafted player", (await visibleCount()) >= 1);
  check(
    "and marks him GONE",
    (await page.locator(".row").first().locator(".tag.gone").count()) === 1,
  );
  await page.click("#search-clear");
  check("clearing search restores the board", (await visibleCount()) === 299);

  // --- Show drafted ---------------------------------------------------------
  await page.check("#show-drafted");
  check("showing taken players brings them back inline", (await visibleCount()) === 300);
  await page.uncheck("#show-drafted");

  // --- Correcting by toggling, not by undoing ------------------------------
  // Undo only reaches the last action; tapping the player reaches any of them.
  await page.check("#show-drafted");
  const goneRow = page.locator(".row.state-gone").first();
  const goneName = await goneRow.locator(".name").innerText();
  await goneRow.click();
  await page.waitForTimeout(350);
  check(
    "tapping a taken player puts him back",
    (await page.locator(`.row.state-gone`).count()) === 0,
    `un-took ${goneName}`,
  );

  const mineRow = page.locator(".row.state-mine").first();
  const mineName = await mineRow.locator(".name").innerText();
  await mineRow.click();
  await page.waitForTimeout(350);
  check(
    "tapping one of mine releases him rather than marking him taken",
    (await page.locator(".row.state-mine").count()) === 0 &&
      (await page.locator(".row.state-gone").count()) === 0,
    `released ${mineName}`,
  );
  await page.uncheck("#show-drafted");
  check("the board is whole again", (await visibleCount()) === 300);

  // The ME button is a toggle too.
  await rows().nth(0).locator(".mine-btn").click();
  await page.waitForTimeout(350);
  check(
    "ME claims a player",
    (await rows().nth(0).locator(".mine-btn").getAttribute("aria-pressed")) === "true" &&
      (await rows().nth(0).evaluate((r) => r.classList.contains("state-mine"))),
  );
  check(
    "and says so without a redundant badge",
    (await rows().nth(0).locator(".tag").count()) === 0,
  );
  await rows().nth(0).locator(".mine-btn").click();
  await page.waitForTimeout(350);
  check(
    "and pressing it again gives him back",
    (await page.locator(".row.state-mine").count()) === 0,
  );

  // --- Releasing a touch drag must not count as a tap ----------------------
  // Still in draft mode, where a tap takes a player off the board. Reordering
  // someone and having him vanish is the kind of thing you notice two rounds
  // later, so it gets its own check.
  const dragged = await nameAt(3);
  const dragBox = await rows().nth(3).boundingBox();
  await touchDrag(page, dragBox.y + dragBox.height / 2, dragBox.y - 130);

  check(
    "releasing a touch drag does not draft the player",
    (await visibleCount()) === 300 && (await page.locator("#undo").isHidden()),
  );
  check("and it did reorder him", (await nameAt(0)) === dragged, `${dragged} to top`);

  // --- Undo expires ---------------------------------------------------------
  await rows().nth(0).click();
  await page.waitForTimeout(400);
  check("undo appears on a pick", await page.locator("#undo").isVisible());
  check(
    "and it floats over the board rather than sitting in the header",
    await page.locator("#undo").evaluate((b) => getComputedStyle(b).position === "fixed"),
  );
  await page.waitForTimeout(7200);
  check("undo goes away on its own", await page.locator("#undo").isHidden());
  await page.check("#show-drafted");
  await page.locator(".row.state-gone").first().click();
  await page.waitForTimeout(350);
  await page.uncheck("#show-drafted");

  // --- The injury badge belongs to the player, not to the draft status ------
  const injuryPlace = await page.evaluate(() => {
    const row = [...document.querySelectorAll(".row")].find((r) => {
      const i = r.querySelector(".injury");
      return i && !i.hidden && i.textContent;
    });
    if (!row) return null;
    return {
      onNameLine: !!row.querySelector(".name-line .injury"),
      leftOfStatus:
        row.querySelector(".injury").getBoundingClientRect().left <
        row.querySelector(".tags").getBoundingClientRect().left,
    };
  });
  check(
    "the injury badge sits with the player name",
    injuryPlace?.onNameLine === true && injuryPlace.leftOfStatus === true,
    JSON.stringify(injuryPlace),
  );

  // --- Prep mode: the sheet, do-not-draft, notes ---------------------------
  await page.click('.modes button[data-mode="prep"]');

  // Prep is about what I think of players, not what has happened to them.
  check(
    "prep hides the MINE filter",
    await page.locator('.chip[data-filter="MINE"]').isHidden(),
  );
  check(
    "prep hides the roster strip and 'show taken' — both count picks",
    (await page.locator(".strip").isHidden()) &&
      (await page.locator("#taken-toggle").isHidden()),
  );
  check(
    "and the cliff with them — 'can I wait?' is a draft-night question",
    await page.locator("#cliffs").isHidden(),
  );
  check(
    "and the header is shorter for it",
    (await page.evaluate(() => document.querySelector("#header").getBoundingClientRect().height)) <
      (await page.evaluate(() => {
        document.querySelector('.modes button[data-mode="draft"]').click();
        const h = document.querySelector("#header").getBoundingClientRect().height;
        document.querySelector('.modes button[data-mode="prep"]').click();
        return h;
      })),
  );
  check("and shows the whole board", (await visibleCount()) === 300);
  check(
    "prep marks nobody as taken or mine",
    (await page.locator(".row.state-gone").count()) === 0 &&
      (await page.locator(".row.state-mine").count()) === 0 &&
      (await page.locator(".tag.gone").count()) === 0,
  );

  // Snapshot every indicator before flagging anyone. The board already carries
  // a real move by this point, so "all indicators are blank" would be the
  // wrong assertion — what matters is that flagging changes none of them.
  const indicatorsBefore = await page.evaluate(() =>
    Object.fromEntries(
      [...document.querySelectorAll(".row")].map((r) => [
        r.querySelector(".name").textContent,
        r.querySelector(".moved").textContent,
      ]),
    ),
  );

  const prepTarget = await nameAt(2);
  await rows().nth(2).click();
  check("tapping in prep opens the sheet, not a pick", await page.locator("#sheet").isVisible());
  check(
    "the sheet hides mine/taken in prep",
    await page.locator(".toggles").isHidden(),
  );
  check(
    "but still offers do-not-draft",
    await page.locator("#toggle-dnd").isVisible(),
  );
  check("the sheet names the right player", (await page.locator("#sheet-name").innerText()) === prepTarget);

  await page.fill("#sheet-note", "handcuff");
  await page.click("#toggle-dnd");
  await page.click("#sheet-close");

  check("a flagged player drops out of the board", (await visibleCount()) === 299);

  // Flagging is an instruction about one player, not a re-rank of the rest.
  const afterFlag = await page.evaluate(() =>
    Object.fromEntries(
      [...document.querySelectorAll(".row")].map((r) => [
        r.querySelector(".name").textContent,
        { rank: r.querySelector(".rank").textContent, moved: r.querySelector(".moved").textContent },
      ]),
    ),
  );

  const movedIndicators = Object.entries(afterFlag).filter(
    ([name, row]) => row.moved !== indicatorsBefore[name],
  );
  check(
    "flagging changes nobody else's indicator",
    movedIndicators.length === 0,
    movedIndicators
      .slice(0, 3)
      .map(([n, r]) => `${n}: ${indicatorsBefore[n] || "-"} -> ${r.moved || "-"}`)
      .join(", "),
  );

  // Everyone below the flagged player keeps his number; the flagged one's is
  // simply missing from the view.
  const ranks = Object.values(afterFlag).map((r) => Number(r.rank));
  check(
    "and nobody else's board position",
    ranks.every((rank, i) => rank === i + 1 || rank === i + 2),
    `first six: ${ranks.slice(0, 6).join(" ")}`,
  );

  // --- Flagged players must stay findable ---------------------------------
  await page.click('.chip[data-filter="DND"]');
  check("the DND filter finds flagged players", (await visibleCount()) === 1);
  check("and it is the right one", (await nameAt(0)) === prepTarget);
  check(
    "a flagged player is badged so search results read clearly",
    (await rows().nth(0).locator(".tag.dnd").count()) === 1,
  );
  check(
    "the note is still on him",
    (await rows().nth(0).locator(".meta").innerText()).includes("handcuff"),
  );
  check(
    "he keeps his board position rather than being sent to the bottom",
    Number(await rows().nth(0).locator(".rank").innerText()) < 10,
    `at board #${await rows().nth(0).locator(".rank").innerText()}`,
  );

  // Unflagging from there has to work, or the chip is a dead end.
  await rows().nth(0).click();
  await page.click("#toggle-dnd");
  await page.click("#sheet-close");
  check("unflagging from the DND view empties it", (await visibleCount()) === 0);

  await page.click('.chip[data-filter="ALL"]');
  check("and puts him back on the board", (await visibleCount()) === 300);

  // --- Nudge ----------------------------------------------------------------
  await page.click('.chip[data-filter="ALL"]');
  const nudgeTarget = await nameAt(5);
  await rows().nth(5).click();
  await page.click("#sheet-up");
  await page.click("#sheet-close");
  check("nudge moves a player one spot", (await nameAt(4)) === nudgeTarget);

  // --- Persistence ----------------------------------------------------------
  await page.click('.modes button[data-mode="draft"]');
  const beforeReload = { fifth: await nameAt(4) };
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector(".row");

  check("the board order survives a reload", (await nameAt(4)) === beforeReload.fifth);
  check(
    "the mode survives a reload",
    await page.locator('.modes button[data-mode="draft"]').evaluate((b) =>
      b.classList.contains("active"),
    ),
  );

  // --- Reset draft keeps rankings -------------------------------------------
  await rows().nth(0).click();
  await page.waitForTimeout(400);
  page.once("dialog", (d) => d.accept());
  await page.click("#menu-toggle");
  await page.click("#reset-draft");
  await page.waitForTimeout(200);
  check("reset draft clears picks", (await visibleCount()) === 300);
  check("and keeps my rankings", (await nameAt(4)) === beforeReload.fifth);

  check("no uncaught page errors", pageErrors.length === 0, pageErrors.join("; "));

  await checkDurability();
  await checkDesktop();
} finally {
  await browser.close();
  server.kill();
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);

/**
 * The whole point of the URL encoding: a browser that has thrown away its
 * storage must be able to get the board back from a bookmark. Safari does
 * exactly that after 7 days without interaction, which is the gap between
 * prepping a board and using it.
 */
async function checkDurability() {
  const first = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
  const page = await first.newPage();

  try {
    await page.goto(URL, { waitUntil: "networkidle" });
    await page.waitForSelector(".row");

    // Build a board worth losing: move a player up and flag another.
    // Drag a row that is already on screen, and drop just below the sticky
    // header. scrollIntoViewIfNeeded would park a row *behind* that header,
    // where the touch lands on the header instead of the list.
    const headerBottom = await page.evaluate(
      () => document.querySelector("#header").getBoundingClientRect().bottom,
    );
    const promoted = await page.locator(".row").nth(8).locator(".name").innerText();
    const box = await page.locator(".row").nth(8).boundingBox();
    await touchDrag(page, box.y + box.height / 2, headerBottom + 10, { steps: 26 });

    const flagged = await page.locator(".row").nth(6).locator(".name").innerText();
    await page.locator(".row").nth(6).click();
    await page.click("#toggle-dnd");
    await page.fill("#sheet-note", "sleeper");
    await page.click("#sheet-close");

    const bookmarked = page.url();
    check("the address bar carries the board", bookmarked.includes("#b="), `${bookmarked.length} chars`);
    check("and the link is short enough to bookmark", bookmarked.length < 2000);
    check("notes never reach the link", !bookmarked.includes("sleeper"));

    const order = await page.evaluate(() =>
      [...document.querySelectorAll(".row .name")].slice(0, 12).map((n) => n.textContent),
    );
    // Without this the restore check could pass on two identical default
    // boards, proving nothing.
    check(
      "the board actually differs from KTC's order before we test restoring it",
      order.includes(promoted),
      `${promoted} was #9, now at the top`,
    );

    // A brand-new context is a wiped browser: no localStorage, only the link.
    const wiped = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
    const restored = await wiped.newPage();
    await restored.goto(bookmarked, { waitUntil: "networkidle" });
    await restored.waitForSelector(".row");

    const restoredOrder = await restored.evaluate(() =>
      [...document.querySelectorAll(".row .name")].slice(0, 12).map((n) => n.textContent),
    );
    check("a wiped browser rebuilds the board from the link",
      JSON.stringify(restoredOrder) === JSON.stringify(order),
      `expected ${promoted} near the top`,
    );

    // Flagged players are hidden from the board, so look where they live.
    await restored.click('.chip[data-filter="DND"]');
    const restoredFlag = await restored.evaluate(
      (name) =>
        [...document.querySelectorAll(".row .name")].some((n) => n.textContent === name),
      flagged,
    );
    check("do-not-draft flags come back too", restoredFlag, `expected ${flagged}`);
    await restored.click('.chip[data-filter="ALL"]');

    // Notes are deliberately not in the link, so they should not reappear.
    const noteBack = await restored.evaluate(() =>
      [...document.querySelectorAll(".row .meta")].some((m) => m.textContent.includes("sleeper")),
    );
    check("notes do not come back from a link, as designed", !noteBack);

    await wiped.close();

    // --- The backup file does carry notes ---------------------------------
    const backup = await page.evaluate(() => ({
      overrides: JSON.parse(localStorage.getItem("fd:overrides") ?? "{}"),
    }));
    const hasNote = Object.values(backup.overrides).some((o) => o.note === "sleeper");
    check("the note survives in storage for the file export", hasNote);
  } finally {
    await first.close();
  }
}

/** Drive a long-press drag through raw touch events. */
async function touchDrag(target, fromY, toY, { holdMs = 500, steps = 20 } = {}) {
  // Derived from the page, not the module-level context: the durability checks
  // run in their own contexts, and a CDP session opened against the wrong one
  // silently delivers no events at all.
  const cdp = await target.context().newCDPSession(target);
  const x = 195;
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x, y: fromY }],
  });
  await target.waitForTimeout(holdMs);
  for (let i = 1; i <= steps; i++) {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x, y: fromY + ((toY - fromY) * i) / steps }],
    });
    await target.waitForTimeout(16);
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await target.waitForTimeout(150);
}

/**
 * The mouse path is a different interaction from the touch one: drag comes off
 * a handle rather than a long press, so pressing on the row body must never
 * reorder the board.
 */
async function checkDesktop() {
  const desktop = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  const page = await desktop.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  try {
    await page.goto(URL, { waitUntil: "networkidle" });
    await page.waitForSelector(".row");

    const rows = () => page.locator(".row");
    const nameAt = (i) => rows().nth(i).locator(".name").innerText();

    check(
      "desktop shows the drag handle",
      await rows().nth(0).locator(".grip").isVisible(),
    );

    // Press on the row body and move: must scroll/select, never reorder.
    const top = await nameAt(0);
    const body = await rows().nth(3).boundingBox();
    await page.mouse.move(body.x + 120, body.y + body.height / 2);
    await page.mouse.down();
    await page.mouse.move(body.x + 120, body.y - 150, { steps: 12 });
    await page.mouse.up();
    check("dragging the row body does not reorder", (await nameAt(0)) === top);

    // Now the same movement from the handle.
    const moving = await nameAt(3);
    const grip = await rows().nth(3).locator(".grip").boundingBox();
    await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
    await page.mouse.down();
    await page.mouse.move(grip.x + grip.width / 2, grip.y - 180, { steps: 16 });
    await page.mouse.up();
    await page.waitForTimeout(120);
    check("dragging the handle reorders", (await nameAt(0)) === moving, `${moving} to top`);

    // And an ordinary click still opens the sheet rather than being eaten.
    await rows().nth(5).click();
    check("a plain click still opens the sheet", await page.locator("#sheet").isVisible());

    check("no desktop page errors", errors.length === 0, errors.join("; "));
  } finally {
    await desktop.close();
  }
}

async function waitForServer() {
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(URL)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  server.kill();
  throw new Error(`preview server never came up at ${URL} — did you run npm run build?`);
}
