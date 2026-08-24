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

  const first = await nameAt(0);
  const second = await nameAt(1);
  await rows().nth(0).click();
  await page.waitForTimeout(400);

  check("tapping a row takes him off the board", (await nameAt(0)) === second);
  check("the board shrinks by one", (await visibleCount()) === 299);
  check("undo appears and names him", (await page.locator("#undo").innerText()).includes(first));

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

  // --- Search reaches drafted players --------------------------------------
  await page.fill("#search", first);
  check("search finds a drafted player", (await visibleCount()) >= 1);
  check(
    "and marks him GONE",
    (await page.locator(".row").first().locator(".tag.gone").count()) === 1,
  );
  await page.click("#search-clear");
  check("clearing search restores the board", (await visibleCount()) === 298);

  // --- Show drafted ---------------------------------------------------------
  await page.check("#show-drafted");
  check("show drafted brings them back inline", (await visibleCount()) === 300);
  await page.uncheck("#show-drafted");

  // --- Undo -----------------------------------------------------------------
  await page.click("#undo");
  await page.click("#undo");
  check("undo walks the whole log back", (await visibleCount()) === 300);
  check("and the undo control goes away", await page.locator("#undo").isHidden());

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

  // --- Prep mode: the sheet, do-not-draft, notes ---------------------------
  await page.click('.modes button[data-mode="prep"]');
  const prepTarget = await nameAt(2);
  await rows().nth(2).click();
  check("tapping in prep opens the sheet, not a pick", await page.locator("#sheet").isVisible());
  check("the sheet names the right player", (await page.locator("#sheet-name").innerText()) === prepTarget);

  await page.fill("#sheet-note", "handcuff");
  await page.check("#sheet-dnd");
  await page.click("#sheet-close");

  const sunkIndex = await page.evaluate(
    (name) =>
      [...document.querySelectorAll(".row .name")].findIndex((n) => n.textContent === name),
    prepTarget,
  );
  check("a do-not-draft player sinks to the bottom", sunkIndex === 299, `at ${sunkIndex}`);
  check(
    "the note shows on the row",
    (await rows().nth(299).locator(".meta").innerText()).includes("handcuff"),
  );

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

  await checkDesktop();
} finally {
  await browser.close();
  server.kill();
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);

/** Drive a long-press drag through raw touch events. */
async function touchDrag(target, fromY, toY, { holdMs = 500, steps = 20 } = {}) {
  const cdp = await context.newCDPSession(target);
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
