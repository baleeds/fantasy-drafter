/**
 * Drag prototype — step 2 of the build order.
 *
 * This is not the app. It is the 300-player list and the drag interaction,
 * deployed so the gesture can be judged on the actual phone before anything
 * gets built on top of it. Ordering is kept as a plain array here; the sparse
 * sort-key model from the spec lands with the real board in step 3.
 */

import { enableDragReorder } from "./drag";
import "./styles.css";

interface Player {
  id: number;
  name: string;
  position: string;
  team: string;
  boardRank: number;
  ktcRank: number;
  positionalRank: number;
  rookie: boolean;
  byeWeek?: number;
  age?: number;
  injury?: { status: string; area: string; returns: string };
}

interface Board {
  generatedAt: string;
  playerCount: number;
  players: Player[];
}

const ORDER_KEY = "prototype:order";
const SETTINGS_KEY = "prototype:settings";

const settings = {
  longPressMs: 350,
  autoscrollMaxSpeed: 14,
  ...readJSON<Partial<{ longPressMs: number; autoscrollMaxSpeed: number }>>(SETTINGS_KEY, {}),
};

let players: Player[] = [];

const listEl = document.querySelector<HTMLOListElement>("#board")!;
const statusEl = document.querySelector<HTMLElement>("#status")!;
const headerEl = document.querySelector<HTMLElement>("#header")!;

void start();

async function start(): Promise<void> {
  const res = await fetch(`${import.meta.env.BASE_URL}players.json`);
  if (!res.ok) {
    statusEl.textContent = `Could not load players.json (${res.status})`;
    return;
  }
  const board: Board = await res.json();

  players = applySavedOrder(board.players);
  render();
  wireControls(board);

  enableDragReorder({
    list: listEl,
    rowSelector: ".row",
    topInset: () => headerEl.getBoundingClientRect().height,
    longPressMs: () => settings.longPressMs,
    autoscrollMaxSpeed: () => settings.autoscrollMaxSpeed,
    onReorder: (from, to) => {
      const [moved] = players.splice(from, 1);
      players.splice(to, 0, moved);
      saveOrder();
      // The DOM is already in the right order — the drag moved it. Only the
      // rank column and the moved indicator need refreshing.
      refreshRowMeta();
      statusEl.textContent = `${moved.name} → ${to + 1}`;
    },
    onStateChange: (dragging) => {
      if (dragging) statusEl.textContent = "";
    },
  });
}

// --- Rendering -------------------------------------------------------------

function render(): void {
  listEl.replaceChildren(...players.map(rowFor));
  refreshRowMeta();
}

function rowFor(player: Player): HTMLLIElement {
  const row = document.createElement("li");
  row.className = "row";
  row.dataset.id = String(player.id);

  const rank = document.createElement("span");
  rank.className = "rank";

  const main = document.createElement("span");
  main.className = "main";

  const name = document.createElement("span");
  name.className = "name";
  name.textContent = player.name;

  const meta = document.createElement("span");
  meta.className = "meta";
  const bits = [
    `${player.position}${player.positionalRank}`,
    player.team,
    player.byeWeek ? `bye ${player.byeWeek}` : null,
  ].filter(Boolean);
  meta.textContent = bits.join(" · ");

  main.append(name, meta);

  if (player.injury) {
    const badge = document.createElement("span");
    badge.className = "injury";
    badge.textContent = `${player.injury.status.slice(0, 1)} — ${player.injury.area}`;
    main.append(badge);
  }

  const moved = document.createElement("span");
  moved.className = "moved";

  const grip = document.createElement("span");
  grip.className = "grip";
  grip.setAttribute("aria-hidden", "true");

  row.append(rank, main, moved, grip);
  return row;
}

/** Rank column and moved indicator, both of which change when anything moves. */
function refreshRowMeta(): void {
  const rows = listEl.children;
  for (let i = 0; i < players.length; i++) {
    const player = players[i];
    const row = rows[i] as HTMLElement;
    row.querySelector(".rank")!.textContent = String(i + 1);

    const delta = player.boardRank - (i + 1);
    const moved = row.querySelector(".moved") as HTMLElement;
    moved.textContent = delta === 0 ? "" : delta > 0 ? `↑${delta}` : `↓${-delta}`;
    moved.className = `moved ${delta > 0 ? "up" : delta < 0 ? "down" : ""}`;
  }
}

// --- Controls --------------------------------------------------------------

function wireControls(board: Board): void {
  document.querySelector("#generated")!.textContent =
    `${board.playerCount} players · rankings as of ${new Date(board.generatedAt).toLocaleDateString()}`;

  document.querySelector("#reset")!.addEventListener("click", () => {
    localStorage.removeItem(ORDER_KEY);
    players = [...players].sort((a, b) => a.boardRank - b.boardRank);
    render();
    statusEl.textContent = "Order reset";
  });

  const panel = document.querySelector<HTMLElement>("#tuning")!;
  document.querySelector("#tune")!.addEventListener("click", () => {
    panel.hidden = !panel.hidden;
  });

  bindSlider("#longpress", "longPressMs", (v) => `${v}ms`);
  bindSlider("#autoscroll", "autoscrollMaxSpeed", (v) => `${v}px/frame`);
}

/**
 * The tuning sliders exist so the gesture can be dialled in on the phone
 * itself. Guessing at a long-press delay from a laptop and redeploying to test
 * each value would turn one sitting into several.
 */
function bindSlider(
  selector: string,
  key: "longPressMs" | "autoscrollMaxSpeed",
  format: (value: number) => string,
): void {
  const input = document.querySelector<HTMLInputElement>(selector)!;
  const output = document.querySelector<HTMLElement>(`${selector}-value`)!;

  input.value = String(settings[key]);
  output.textContent = format(settings[key]);

  input.addEventListener("input", () => {
    settings[key] = Number(input.value);
    output.textContent = format(settings[key]);
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  });
}

// --- Persistence -----------------------------------------------------------

function applySavedOrder(fromKtc: Player[]): Player[] {
  const saved = readJSON<number[]>(ORDER_KEY, []);
  if (saved.length === 0) return fromKtc;

  const byId = new Map(fromKtc.map((p) => [p.id, p]));
  const ordered: Player[] = [];
  for (const id of saved) {
    const player = byId.get(id);
    if (player) {
      ordered.push(player);
      byId.delete(id);
    }
  }
  // Anyone the saved order didn't know about (a refresh added them) falls in
  // at their KTC position rather than being dropped.
  return [...ordered, ...byId.values()].sort(
    (a, b) => indexOrRank(a, saved) - indexOrRank(b, saved),
  );
}

function indexOrRank(player: Player, saved: number[]): number {
  const i = saved.indexOf(player.id);
  return i === -1 ? player.boardRank : i;
}

function saveOrder(): void {
  localStorage.setItem(ORDER_KEY, JSON.stringify(players.map((p) => p.id)));
}

function readJSON<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
