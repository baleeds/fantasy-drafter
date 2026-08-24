/**
 * Fantasy Drafter — the board, filters, search, and the pick log.
 *
 * Two modes over one list. Prep is where I build the board; draft is the
 * screen I live in on the night. They share the same rows because switching
 * between them mid-draft has to be instant and lose nothing.
 */

import { enableDragReorder } from "./drag.ts";
import { BoardView } from "./board-view.ts";
import { Board, POSITIONS, type BoardRow, type Player, type Position } from "./model.ts";
import {
  DEFAULT_SETTINGS,
  clearEverything,
  discardPrototypeData,
  loadOverrides,
  loadPicks,
  loadSettings,
  saveOverrides,
  savePicks,
  saveSettings,
  type Settings,
} from "./store.ts";
import "./styles.css";

const FILTERS = ["ALL", ...POSITIONS, "FLEX", "MINE"] as const;
const FLEX: Position[] = ["RB", "WR", "TE"];

let board: Board;
let view: BoardView;
let settings: Settings = loadSettings();
let search = "";

const el = <T extends HTMLElement>(selector: string) =>
  document.querySelector<T>(selector)!;

void start();

async function start(): Promise<void> {
  discardPrototypeData();

  const res = await fetch(`${import.meta.env.BASE_URL}players.json`);
  if (!res.ok) {
    el("#status").textContent = `Could not load players.json (${res.status})`;
    return;
  }
  const data: { generatedAt: string; playerCount: number; players: Player[] } =
    await res.json();

  board = new Board(data.players, loadOverrides(), loadPicks());
  view = new BoardView(el<HTMLOListElement>("#board"), {
    onTap: handleTap,
    onMine: (id) => draftPlayer(id, true),
  });

  el("#generated").textContent =
    `${data.playerCount} players · as of ${new Date(data.generatedAt).toLocaleDateString()}`;

  buildFilters();
  wireHeader();
  wireSheet();
  wireDrag();
  render();
}

// --- What the board shows ---------------------------------------------------

function visibleRows(): BoardRow[] {
  const query = search.trim().toLowerCase();
  return board.rows().filter((row) => {
    // Search reaches drafted players on purpose. Often the answer I need is
    // "he went four picks ago", and a search that hides them fails at exactly
    // the moment it matters.
    if (query) return row.player.name.toLowerCase().includes(query);

    if (settings.filter === "MINE") return row.state === "mine";
    if (row.state === "mine") return settings.showDrafted;
    if (row.state === "gone") return settings.showDrafted;

    if (settings.filter === "ALL") return true;
    if (settings.filter === "FLEX") return FLEX.includes(row.player.position);
    return row.player.position === settings.filter;
  });
}

function render(): void {
  view.render(visibleRows(), settings.mode);
  renderRoster();
  renderUndo();
  document.body.dataset.mode = settings.mode;
}

function renderRoster(): void {
  const counts = board.rosterCounts();
  const taken = board.picks.length;
  el("#roster").textContent =
    POSITIONS.map((p) => `${p} ${counts[p]}`).join(" · ") + ` · ${taken} taken`;
}

function renderUndo(): void {
  const last = board.lastPick;
  const undo = el<HTMLButtonElement>("#undo");
  // A persistent control, not a toast: mis-taps are the common case this
  // exists for, and a toast disappears before I notice the mistake.
  undo.hidden = !last;
  if (last) undo.textContent = `Undo ${last.name}`;
}

// --- Actions ----------------------------------------------------------------

function handleTap(id: number): void {
  if (settings.mode === "draft") draftPlayer(id, false);
  else openSheet(id);
}

async function draftPlayer(id: number, mine: boolean): Promise<void> {
  if (board.stateOf(id) !== "available") return;
  board.pick(id, mine);
  savePicks(board.picks);

  // Animate before re-rendering, so the row is still on screen while it fades.
  if (!settings.showDrafted && settings.filter !== "MINE") {
    await view.playLeaving(id);
  }
  render();
}

function undoPick(): void {
  const player = board.undo();
  if (!player) return;
  savePicks(board.picks);
  render();
  flash(`Undid ${player.name}`);
}

function persistOverrides(): void {
  saveOverrides(board.overrides);
}

// --- Header -----------------------------------------------------------------

function buildFilters(): void {
  const container = el("#filters");
  for (const name of FILTERS) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip";
    chip.dataset.filter = name;
    chip.textContent = name;
    chip.addEventListener("click", () => {
      settings.filter = name;
      saveSettings(settings);
      syncChips();
      render();
    });
    container.append(chip);
  }
  syncChips();
}

function syncChips(): void {
  for (const chip of document.querySelectorAll<HTMLElement>(".chip")) {
    chip.classList.toggle("active", chip.dataset.filter === settings.filter);
  }
}

function wireHeader(): void {
  const modeButtons = [...document.querySelectorAll<HTMLButtonElement>(".modes button")];
  const syncMode = () => {
    for (const button of modeButtons) {
      const active = button.dataset.mode === settings.mode;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    }
  };
  for (const button of modeButtons) {
    button.addEventListener("click", () => {
      settings.mode = button.dataset.mode as Settings["mode"];
      saveSettings(settings);
      syncMode();
      render();
    });
  }
  syncMode();

  const searchInput = el<HTMLInputElement>("#search");
  searchInput.addEventListener("input", () => {
    search = searchInput.value;
    render();
  });
  el("#search-clear").addEventListener("click", () => {
    searchInput.value = "";
    search = "";
    searchInput.focus();
    render();
  });

  const showDrafted = el<HTMLInputElement>("#show-drafted");
  showDrafted.checked = settings.showDrafted;
  showDrafted.addEventListener("change", () => {
    settings.showDrafted = showDrafted.checked;
    saveSettings(settings);
    render();
  });

  el("#undo").addEventListener("click", undoPick);

  el("#menu-toggle").addEventListener("click", () => {
    const menu = el("#menu");
    menu.hidden = !menu.hidden;
  });

  el("#reset-draft").addEventListener("click", () => {
    if (board.picks.length === 0) return flash("No picks to clear");
    if (!confirm(`Clear all ${board.picks.length} picks? Your rankings are kept.`)) return;
    board.resetDraft();
    savePicks(board.picks);
    closeMenu();
    render();
    flash("Draft reset");
  });

  el("#reset-order").addEventListener("click", () => {
    if (!confirm("Reset the board to KTC's order? Your flags and notes are kept.")) return;
    board.resetOrder();
    persistOverrides();
    closeMenu();
    render();
    flash("Order reset to KTC");
  });

  el("#reset-all").addEventListener("click", () => {
    if (!confirm("Erase everything — rankings, flags, notes, and picks?")) return;
    clearEverything();
    location.reload();
  });

  bindSlider("#longpress", "longPressMs", (v) => `${v}ms`);
  bindSlider("#autoscroll", "autoscrollMaxSpeed", (v) => `${v}px`);
}

function closeMenu(): void {
  el("#menu").hidden = true;
}

function bindSlider(
  selector: string,
  key: "longPressMs" | "autoscrollMaxSpeed",
  format: (value: number) => string,
): void {
  const input = el<HTMLInputElement>(selector);
  const output = el(`${selector}-value`);
  input.value = String(settings[key]);
  output.textContent = format(settings[key]);
  input.addEventListener("input", () => {
    settings[key] = Number(input.value);
    output.textContent = format(settings[key]);
    saveSettings(settings);
  });
}

// --- The player sheet -------------------------------------------------------

let sheetPlayerId: number | null = null;

function openSheet(id: number): void {
  const row = board.rows().find((r) => r.player.id === id);
  if (!row) return;
  sheetPlayerId = id;

  const { player } = row;
  el("#sheet-name").textContent = player.name;
  el("#sheet-meta").textContent = [
    `${player.position}${player.positionalRank}`,
    player.team,
    player.byeWeek ? `bye ${player.byeWeek}` : null,
    `KTC #${player.boardRank}`,
    player.injury ? `${player.injury.status} — ${player.injury.area}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  el<HTMLInputElement>("#sheet-note").value = row.note;
  const dnd = el<HTMLInputElement>("#sheet-dnd");
  dnd.checked = row.doNotDraft;

  el("#sheet").hidden = false;
}

function closeSheet(): void {
  if (sheetPlayerId === null) return;
  const note = el<HTMLInputElement>("#sheet-note").value;
  board.setNote(sheetPlayerId, note);
  persistOverrides();
  sheetPlayerId = null;
  el("#sheet").hidden = true;
  render();
}

function wireSheet(): void {
  el("#sheet-close").addEventListener("click", closeSheet);
  el("#sheet-backdrop").addEventListener("click", closeSheet);

  el("#sheet-dnd").addEventListener("change", (e) => {
    if (sheetPlayerId === null) return;
    board.setDoNotDraft(sheetPlayerId, (e.target as HTMLInputElement).checked);
    persistOverrides();
  });

  for (const [selector, direction] of [
    ["#sheet-up", -1],
    ["#sheet-down", 1],
  ] as const) {
    el(selector).addEventListener("click", () => {
      if (sheetPlayerId === null) return;
      board.nudge(sheetPlayerId, direction);
      persistOverrides();
      render();
    });
  }

  el("#sheet-draft").addEventListener("click", () => {
    const id = sheetPlayerId;
    closeSheet();
    if (id !== null) void draftPlayer(id, true);
  });
}

// --- Drag -------------------------------------------------------------------

function wireDrag(): void {
  enableDragReorder({
    list: el<HTMLOListElement>("#board"),
    rowSelector: ".row",
    handleSelector: ".grip",
    topInset: () => el("#header").getBoundingClientRect().height,
    longPressMs: () => settings.longPressMs,
    autoscrollMaxSpeed: () => settings.autoscrollMaxSpeed,
    onReorder: (from, to) => {
      // The drag reports indices into the rendered list, which may be filtered
      // or searched. Hand the model the players either side of the drop and
      // let it work out the key — it knows what is hidden between them.
      const rendered = visibleRows();
      const moved = rendered[from];
      if (!moved) return;

      const others = rendered.filter((_, i) => i !== from);
      board.placeBetween(
        moved.player.id,
        to > 0 ? others[to - 1].player.id : null,
        to < others.length ? others[to].player.id : null,
      );
      persistOverrides();
      render();
    },
  });
}

// --- Odds and ends ----------------------------------------------------------

let flashTimer = 0;
function flash(message: string): void {
  const status = el("#status");
  status.textContent = message;
  clearTimeout(flashTimer);
  flashTimer = window.setTimeout(() => (status.textContent = ""), 2500);
}

// Keep the settings object honest if a stored value predates a new default.
settings = { ...DEFAULT_SETTINGS, ...settings };
