/**
 * Behavioural check for the long-press drag.
 *
 * This cannot tell us how the gesture *feels* — that is what a real phone is
 * for — but it pins the things that break silently:
 *
 *   1. A held row actually reorders.
 *   2. The held row tracks the finger rather than easing toward it.
 *   3. The page does not scroll out from under a held row.
 *   4. Holding near an edge autoscrolls.
 *   5. A plain swipe still scrolls instead of picking a row up.
 *
 * (5) is the one to care about most. Getting drag working is easy; getting it
 * working without breaking ordinary scrolling on a 300-row list is the hard
 * part, and a regression there makes the whole board unusable on a phone.
 *
 * (2) is here because it already happened: a transition added to .row for an
 * unrelated animation was inherited by the dragged row's clone, and the
 * gesture felt broken while every frame budget stayed green.
 *
 * Deliberately not in CI: it needs a browser download that would slow every
 * deploy. Run it locally after touching src/drag.ts.
 *
 *   npm run build && npm run test:drag
 */

import { spawn } from "node:child_process";
import { chromium } from "playwright";

const PORT = 4173;
const URL = `http://localhost:${PORT}/fantasy-drafter/`;
const EXECUTABLE = process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium";

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass });
  console.log(`${pass ? "ok  " : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};

const server = spawn("npx", ["vite", "preview", "--port", String(PORT)], {
  stdio: "ignore",
});
await waitForServer();

const browser = await chromium.launch({ executablePath: EXECUTABLE });
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true,
  deviceScaleFactor: 3,
});
const page = await context.newPage();

const failures = [];
page.on("pageerror", (e) => failures.push(String(e)));

try {
  await page.goto(URL, { waitUntil: "networkidle" });
  await page.waitForSelector(".row");

  const nameAt = (i) => page.locator(".row").nth(i).locator(".name").innerText();
  const scrollY = () => page.evaluate(() => window.scrollY);
  const toTop = () => page.evaluate(() => window.scrollTo(0, 0));

  check("300 rows render", (await page.locator(".row").count()) === 300);

  // 1. A long press followed by a drag reorders.
  const fourth = await nameAt(3);
  const from = await page.locator(".row").nth(3).boundingBox();
  const to = await page.locator(".row").nth(0).boundingBox();
  await drag(from.y + from.height / 2, to.y + 4);

  check("a held row reorders", (await nameAt(0)) === fourth, `4th "${fourth}" -> 1st`);
  check("the ghost is cleaned up", (await page.locator(".ghost").count()) === 0);
  check(
    "the rank column renumbers",
    (await page.locator(".row").nth(0).locator(".rank").innerText()) === "1",
  );

  // 2. The held row must track the finger exactly, not ease toward it.
  //
  // The ghost is a clone of a .row, so it picks up whatever transition the row
  // carries — and the drag drives its transform every frame. A transition
  // there makes the whole gesture feel laggy while every frame budget stays
  // green, so no amount of profiling finds it.
  const trackBox = await page.locator(".row").nth(6).boundingBox();
  const cdp = await context.newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: 195, y: trackBox.y + trackBox.height / 2 }],
  });
  await page.waitForTimeout(500);
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [{ x: 195, y: trackBox.y + trackBox.height / 2 - 200 }],
  });
  await page.waitForTimeout(30);

  const tracking = await page.evaluate(() => {
    const ghost = document.querySelector(".ghost");
    if (!ghost) return null;
    const target = Number(ghost.style.transform.match(/-?[\d.]+/)?.[0] ?? NaN);
    const actual = new DOMMatrix(getComputedStyle(ghost).transform).m42;
    return { drift: Math.abs(target - actual), duration: getComputedStyle(ghost).transitionDuration };
  });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await page.waitForTimeout(120);

  check(
    "the held row tracks the finger without easing",
    tracking !== null && tracking.drift < 1,
    tracking ? `${tracking.drift.toFixed(0)}px behind, transition ${tracking.duration}` : "no ghost",
  );

  // 3. The page must hold still while a row is held.
  await toTop();
  const held = await page.locator(".row").nth(5).boundingBox();
  const before = await scrollY();
  await drag(held.y + held.height / 2, held.y + 200);
  check("the page holds still during a drag", (await scrollY()) === before);

  // 4. Holding near the bottom edge scrolls the list.
  await toTop();
  const edge = await page.locator(".row").nth(4).boundingBox();
  await drag(edge.y + edge.height / 2, 830, { steps: 30 });
  const scrolled = await scrollY();
  check("holding at an edge autoscrolls", scrolled > 0, `scrolled to ${scrolled}`);

  // 5. The one that matters: an ordinary swipe must still scroll.
  await toTop();
  const top = await nameAt(0);
  await drag(400, 200, { holdMs: 0, steps: 12 });
  check(
    "a plain swipe scrolls instead of dragging",
    (await scrollY()) > 0 && (await nameAt(0)) === top,
  );

  // 6. The order survives a reload.
  const persisted = await nameAt(0);
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector(".row");
  check("the order survives a reload", (await nameAt(0)) === persisted);

  check("no uncaught page errors", failures.length === 0, failures.join("; "));

  /** Drive a long-press drag through raw touch events. */
  async function drag(fromY, toY, { holdMs = 500, steps = 24 } = {}) {
    const cdp = await context.newCDPSession(page);
    const x = 195;
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x, y: fromY }],
    });
    await page.waitForTimeout(holdMs);
    for (let i = 1; i <= steps; i++) {
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x, y: fromY + ((toY - fromY) * i) / steps }],
      });
      await page.waitForTimeout(16);
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await page.waitForTimeout(120);
  }
} finally {
  await browser.close();
  server.kill();
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);

async function waitForServer() {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(URL);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  server.kill();
  throw new Error(`preview server never came up at ${URL} — did you run npm run build?`);
}
