/**
 * Renders the board and reconciles it in place.
 *
 * Rows are keyed by player id and reused rather than rebuilt, for two reasons:
 * a full re-render would destroy the element a drag is holding, and it would
 * make the leave animation impossible. Every row is a fixed height — the drag's
 * slot arithmetic depends on a uniform pitch, and test/drag-check.mjs asserts it.
 */

import type { BoardRow } from "./model.ts";

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

  render(visible: BoardRow[], mode: "prep" | "draft"): void {
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
      updateRow(el, row, mode);

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
  row.innerHTML = `<span class="rank"></span>
    <span class="main">
      <span class="name"></span>
      <span class="meta"></span>
    </span>
    <span class="tags"></span>
    <span class="moved"></span>
    <button class="mine-btn" type="button" aria-label="I drafted him">ME</button>
    <span class="grip" aria-hidden="true"></span>`;
  return row;
}

function updateRow(el: HTMLLIElement, row: BoardRow, mode: "prep" | "draft"): void {
  const { player } = row;

  el.className = `row state-${row.state}${row.doNotDraft ? " dnd" : ""} mode-${mode}`;
  text(el, ".rank", String(row.position));
  text(el, ".name", player.name);

  const meta = [
    `${player.position}${player.positionalRank}`,
    player.team,
    player.byeWeek ? `bye ${player.byeWeek}` : null,
    row.note ? `“${row.note}”` : null,
  ].filter(Boolean);
  text(el, ".meta", meta.join(" · "));

  // Injury and status live on one line so the row height never changes.
  const tags = el.querySelector(".tags")!;
  tags.textContent = "";
  if (row.state === "gone") tags.append(tag("GONE", "gone"));
  if (row.state === "mine") tags.append(tag("MINE", "mine"));
  // Flagged players are hidden from the board, so this badge is what identifies
  // them when they turn up in a search or under the DND chip.
  if (row.doNotDraft) tags.append(tag("DND", "dnd"));
  if (player.injury) {
    tags.append(tag(`${player.injury.status.slice(0, 1)} ${player.injury.area}`, "injury"));
  }

  const moved = el.querySelector(".moved") as HTMLElement;
  const delta = row.moved;
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
