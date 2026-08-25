/**
 * Renders the board and reconciles it in place.
 *
 * Rows are keyed by player id and reused rather than rebuilt, for two reasons:
 * a full re-render would destroy the element a drag is holding, and it would
 * make the leave animation impossible. Every row is a fixed height — the drag's
 * slot arithmetic depends on a uniform pitch, and test/drag-check.mjs asserts it.
 */

import type { BoardRow, Projection } from "./model.ts";

export interface RowCallbacks {
  onTap: (id: number) => void;
  onMine: (id: number) => void;
}

export class BoardView {
  private rows = new Map<number, HTMLLIElement>();

  constructor(
    private readonly list: HTMLOListElement,
    private readonly callbacks: RowCallbacks,
  ) {
    // One delegated listener rather than 300. The drag controller swallows the
    // click that follows a drag, so a reorder never registers as a tap.
    this.list.addEventListener("click", (e) => {
      const target = e.target as HTMLElement;
      const row = target.closest<HTMLLIElement>(".row");
      if (!row) return;
      const id = Number(row.dataset.id);
      if (target.closest(".mine-btn")) this.callbacks.onMine(id);
      else this.callbacks.onTap(id);
    });
  }

  /**
   * @param projections Where my remaining picks fall. Empty in prep, where a
   *   draft has not started and none of this means anything yet.
   */
  render(visible: BoardRow[], mode: "prep" | "draft", projections: Projection[] = []): void {
    const marks = placeLines(visible, projections);

    // Urgency is measured against my pick *after* this one, not the one I am
    // about to make. A cliff I can still reach at my upcoming pick but not at
    // the following one is the whole decision: take that position now, or lose
    // the tier. Measuring against the imminent pick instead marks nothing,
    // since by definition almost everything survives the next single pick.
    const horizon = (projections[1] ?? projections[0])?.after ?? null;

    const wanted = new Set(visible.map((r) => r.player.id));

    for (const [id, el] of this.rows) {
      if (!wanted.has(id)) {
        el.remove();
        this.rows.delete(id);
      }
    }

    let cursor: ChildNode | null = this.list.firstChild;
    for (const row of visible) {
      let el = this.rows.get(row.player.id);
      if (!el) {
        el = createRow(row.player.id);
        this.rows.set(row.player.id, el);
      }
      updateRow(el, row, mode, marks.get(row.player.id) ?? null, horizon);

      if (el === cursor) cursor = cursor.nextSibling;
      else this.list.insertBefore(el, cursor);
    }
  }

  elementFor(id: number): HTMLLIElement | undefined {
    return this.rows.get(id);
  }

  /**
   * Half a second of motion is what catches a mis-tap. Without it a wrong tap
   * removes a player silently and I spend the rest of the draft believing he
   * is gone.
   */
  async playLeaving(id: number): Promise<void> {
    const el = this.rows.get(id);
    if (!el) return;
    el.classList.add("leaving");
    await new Promise((resolve) => setTimeout(resolve, 280));
    el.classList.remove("leaving");
  }
}

function createRow(id: number): HTMLLIElement {
  const row = document.createElement("li");
  row.className = "row";
  row.dataset.id = String(id);
  // The injury badge sits on the name line because it describes the player.
  // Draft status sits on the right because it describes the board. Mixing the
  // two into one strip made "Q Groin" read as a kind of pick.
  row.innerHTML = `<span class="rank"></span>
    <span class="dot" aria-hidden="true"></span>
    <span class="main">
      <span class="name-line">
        <span class="name"></span>
        <span class="injury"></span>
      </span>
      <span class="meta"></span>
    </span>
    <span class="tags"></span>
    <span class="moved"></span>
    <button class="mine-btn" type="button">ME</button>
    <span class="grip" aria-hidden="true"></span>`;
  return row;
}

function updateRow(
  el: HTMLLIElement,
  row: BoardRow,
  mode: "prep" | "draft",
  line: string | null,
  horizon: number | null,
): void {
  const { player } = row;

  // Draft state is a draft-mode idea. In prep the board is just my ranking of
  // players, so nobody is struck through or badged as taken there.
  const state = mode === "draft" ? row.state : "available";

  // The cliff is a draft-mode idea for the same reason the rest of them are:
  // it is about what I can still get, and in prep nobody has taken anything.
  const cliff = mode === "draft" ? row.cliff : null;
  const urgent = cliff !== null && horizon !== null && (row.adpRank ?? 0) <= horizon;

  el.className =
    `row state-${state}${row.doNotDraft ? " dnd" : ""} mode-${mode}` +
    (cliff ? (urgent ? " cliff cliff-urgent" : " cliff") : "");
  el.dataset.pos = player.position;
  if (line) el.dataset.line = line;
  else delete el.dataset.line;
  text(el, ".rank", String(row.position));
  text(el, ".name", player.name);

  // KTC is a prep idea, like the rest of the opinion-forming machinery. At the
  // table I have already built my board and what a trade-value market thinks is
  // clutter on the one screen that is time-pressured. It also appears only
  // where KTC materially disagrees: the two sources broadly agree about talent
  // within a position, so printing it everywhere would be three hundred numbers
  // saying "yes, still agreed".
  const disagrees = mode === "prep" && row.ktcDisagrees;

  const meta = [
    `${player.position}${player.positionalRank}`,
    player.team,
    player.byeWeek ? `bye ${player.byeWeek}` : null,
    disagrees ? `KTC ${player.ktcRank}` : null,
    row.note ? `“${row.note}”` : null,
  ].filter(Boolean);
  text(el, ".meta", meta.join(" · "));

  const injury = el.querySelector(".injury") as HTMLElement;
  injury.textContent = player.injury
    ? `${player.injury.status.slice(0, 1)} ${player.injury.area}`
    : "";
  injury.hidden = !player.injury;

  // Status badges stay on one line so the row height never changes.
  const tags = el.querySelector(".tags")!;
  tags.textContent = "";
  // No MINE badge: the pressed ME button and the accent bar already say it,
  // and a third marker for one state is just width.
  if (state === "gone") tags.append(tag("GONE", "gone"));
  // The size of the drop, not just that there is one: a 9-player gap and a
  // 25-player gap are different decisions.
  if (cliff) {
    const badge = tag(`\u2304${cliff.gap}`, `cliff${urgent ? " urgent" : ""}`);
    badge.title =
      `${cliff.gap} players until the next ${player.position} — ` +
      `${cliff.ratio.toFixed(1)}x normal spacing` +
      (urgent ? ", and gone before your next pick" : "");
    tags.append(badge);
  }
  // Flagged players are hidden from the board, so this badge is what identifies
  // them when they turn up in a search or under the DND chip.
  if (row.doNotDraft) tags.append(tag("DND", "dnd"));

  // A toggle, not a one-way action: pressed means he is mine, and pressing it
  // again gives him back.
  const mine = el.querySelector(".mine-btn") as HTMLButtonElement;
  mine.setAttribute("aria-pressed", String(state === "mine"));
  mine.setAttribute(
    "aria-label",
    state === "mine" ? `${player.name} is mine — tap to release` : `I drafted ${player.name}`,
  );

  // Only players I actually placed carry an arrow. Everyone else can be
  // displaced by moves around them, and showing that as an arrow would put a
  // number against a decision I never made — one promotion pushes 40 players
  // down a spot, and a normal prep session would arrow two-thirds of the board.
  const moved = el.querySelector(".moved") as HTMLElement;
  const delta = row.placed ? row.moved : 0;
  moved.textContent = delta === 0 ? "" : delta > 0 ? `↑${delta}` : `↓${-delta}`;
  moved.className = `moved ${delta > 0 ? "up" : delta < 0 ? "down" : ""}`;
}

function tag(label: string, kind: string): HTMLSpanElement {
  const el = document.createElement("span");
  el.className = `tag ${kind}`;
  el.textContent = label;
  return el;
}

function text(root: HTMLElement, selector: string, value: string): void {
  const el = root.querySelector(selector)!;
  if (el.textContent !== value) el.textContent = value;
}

/**
 * Work out which rendered row each pick line sits above.
 *
 * A line belongs above the first row I could still get at that pick: the first
 * player the *room* has not already taken by then. That is a question about
 * ADP, not about my ordering — project down consensus, decide down my board.
 * So the players above a line are scattered through it rather than being a
 * contiguous block, and the line marks the first survivor. Anchoring to the first *visible*
 * such row rather than to an exact rank is what keeps the line meaningful under
 * a filter: with the RB chip on, it lands above the first RB who survives to my
 * pick, which is the question a filtered board is being asked.
 */
function placeLines(visible: BoardRow[], projections: Projection[]): Map<number, string> {
  const marks = new Map<number, string[]>();
  let next = 0;

  for (const row of visible) {
    if (row.adpRank === null) continue;
    while (next < projections.length && row.adpRank > projections[next].after) {
      const at = marks.get(row.player.id) ?? [];
      at.push(String(projections[next].pick));
      marks.set(row.player.id, at);
      next++;
    }
    if (next >= projections.length) break;
  }

  // Two picks land together when a filter hides everyone between them — at the
  // turn that is only three players, so it happens often enough to handle.
  return new Map([...marks].map(([id, picks]) => [id, picks.join(" · ")]));
}
