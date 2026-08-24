/**
 * Fantasy Drafter — the board, filters, search, and the pick log.
 *
 * Two modes over one list. Prep is where I build the board; draft is the
 * screen I live in on the night. They share the same rows because switching
 * between them mid-draft has to be instant and lose nothing.
 */

import { enableDragReorder } from "./drag.ts";
import { BoardView } from "./board-view.ts";
import {
  Board,
  POSITIONS,
  type BoardRow,
  type Overrides,
  type Player,
  type PlayerState,
  type Position,
} from "./model.ts";
import { decodeBoard, encodeBoard, shareableOverrides } from "./share.ts";
import {
  DEFAULT_SETTINGS,
  clearEverything,
  discardPrototypeData,
  loadOverrides,
  loadPicks,
  loadSettings,
  makeBackup,
  readBackup,
  saveOverrides,
  savePicks,
  saveSettings,
  type Settings,
} from "./store.ts";
import "./styles.css";

const FILTERS = ["ALL", ...POSITIONS, "FLEX", "MINE", "DND"] as const;
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
    flash(`Could not load players.json (${res.status})`);
    return;
  }
  const data: { generatedAt: string; playerCount: number; players: Player[] } =
    await res.json();

  board = new Board(data.players, loadOverrides(), loadPicks());
  view = new BoardView(el<HTMLOListElement>("#board"), {
    onTap: handleTap,
    onMine: handleMine,
  });

  el("#generated").textContent =
    `${data.playerCount} players · as of ${new Date(data.generatedAt).toLocaleDateString()}`;

  restoreFromUrl();
  syncUrl();

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

    // Flagged players keep their board position but drop out of view — that is
    // the whole point of flagging one. This chip is how I get them back to
    // review or unflag.
    if (settings.filter === "DND") return row.doNotDraft;
    if (row.doNotDraft) return false;

    // Prep is about what I think of players, not what has happened to them.
    // Nobody is taken or mine while I am building the board, so draft state
    // does not hide anyone here.
    if (settings.mode === "draft") {
      // My own picks stay on the board whatever the toggle says. Hiding taken
      // players is for collapsing the run of players that went between my
      // picks — not for losing sight of my own team.
      if (row.state === "gone" && !settings.showDrafted) return false;
    }

    if (settings.filter === "ALL") return true;
    if (settings.filter === "FLEX") return FLEX.includes(row.player.position);
    return row.player.position === settings.filter;
  });
}

function render(): void {
  view.render(visibleRows(), settings.mode);
  renderRoster();
  document.body.dataset.mode = settings.mode;
}

function renderRoster(): void {
  const counts = board.rosterCounts();
  const taken = board.picks.length;
  el("#roster").textContent =
    POSITIONS.map((p) => `${p} ${counts[p]}`).join(" · ") + ` · ${taken} taken`;
}

// --- Actions ----------------------------------------------------------------

/**
 * Tapping a row in draft mode moves it between states, in both directions:
 *
 *   available -> gone      someone took him
 *   gone      -> available I recorded that wrong
 *   mine      -> available I did not take him after all
 *
 * A tap on one of my own players gives him back rather than marking him taken
 * by someone else, which is never what that tap means.
 */
function handleTap(id: number): void {
  if (settings.mode !== "draft") return openSheet(id);

  const state = board.stateOf(id);
  void setPlayerState(id, state === "available" ? "gone" : "available");
}

/** The ME button is a toggle: press to claim a player, press again to release. */
function handleMine(id: number): void {
  if (settings.mode !== "draft") return;
  void setPlayerState(id, board.stateOf(id) === "mine" ? "available" : "mine");
}

async function setPlayerState(id: number, state: PlayerState): Promise<void> {
  if (board.stateOf(id) === state) return;
  const player = board.players.find((p) => p.id === id);

  board.setState(id, state);
  savePicks(board.picks);

  // Animate only if the row is actually about to disappear — my own picks stay
  // put, and fading one out and straight back in would read as a glitch.
  // Asking the filter rather than reasoning about it keeps the two in step.
  const stillVisible = visibleRows().some((row) => row.player.id === id);
  if (!stillVisible) await view.playLeaving(id);

  render();

  // Undo covers the one case a toggle cannot: a mis-tap on a player who then
  // vanished from the board, so there is no row left to tap back.
  if (!stillVisible && player) showUndo(player.name);
  else hideUndo();
}

function undoPick(): void {
  const player = board.undo();
  if (!player) return;
  savePicks(board.picks);
  hideUndo();
  render();
  flash(`${player.name} is back on the board`);
}

/**
 * A brief floating offer, not a standing control.
 *
 * It used to be a permanent bar, on the reasoning that mis-taps need catching.
 * But every state is now reversible by tapping the player, so undo is only for
 * the moment a row leaves the screen before I can tap it — which is over in
 * seconds. A bar that never leaves is just a bar that is always in the way.
 */
let undoTimer = 0;

function showUndo(name: string): void {
  const undo = el<HTMLButtonElement>("#undo");
  undo.textContent = `Undo — ${name}`;
  undo.hidden = false;
  clearTimeout(undoTimer);
  undoTimer = window.setTimeout(hideUndo, 7000);
}

function hideUndo(): void {
  clearTimeout(undoTimer);
  el<HTMLButtonElement>("#undo").hidden = true;
}

/**
 * Save and re-encode the link together, always. If these ever drift apart the
 * bookmark silently goes stale, which is exactly the failure the link exists
 * to prevent and exactly the one you would not notice until you needed it.
 */
function persistOverrides(): void {
  saveOverrides(board.overrides);
  syncUrl();
}

function syncUrl(): void {
  const payload = encodeBoard(shareableOverrides(board.overrides));
  history.replaceState(null, "", `${location.pathname}${location.search}#b=${payload}`);
}

/**
 * A link carries ordering and do-not-draft flags. Notes are not in it, so an
 * incoming board is merged over whatever notes are already here rather than
 * replacing them.
 */
function applyLinkedBoard(incoming: Overrides): void {
  const merged: Overrides = {};
  for (const [id, override] of Object.entries(incoming)) merged[id] = { ...override };
  for (const [id, override] of Object.entries(board.overrides)) {
    if (override.note) merged[id] = { ...merged[id], note: override.note };
  }
  board.overrides = merged;
  persistOverrides();
  render();
}

/**
 * Read a board out of the address bar on load.
 *
 * With nothing stored this is the recovery case — a wiped browser opening a
 * bookmark — and applies silently. With a board already here that differs, it
 * asks: an old bookmark opened on a device carrying newer work should not
 * quietly overwrite it.
 */
function restoreFromUrl(): void {
  const payload = new URLSearchParams(location.hash.slice(1)).get("b");
  if (!payload) return;

  const decoded = decodeBoard(payload);
  if (!decoded) {
    flash("That link's board could not be read — leaving your board alone");
    return;
  }

  const current = encodeBoard(shareableOverrides(board.overrides));
  if (current === encodeBoard(decoded.overrides)) return;

  const stored = Object.keys(shareableOverrides(board.overrides)).length;
  const summary = `${decoded.placements} placement${decoded.placements === 1 ? "" : "s"} and ${decoded.doNotDraft} do-not-draft`;

  if (stored > 0) {
    if (!confirm(`This link holds a different board (${summary}). Replace the one on this device?`)) {
      // Put the address bar back in step with what is actually loaded.
      syncUrl();
      return;
    }
  }

  applyLinkedBoard(decoded.overrides);
  flash(`Restored ${summary} from the link`);
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
  const draftOnly = settings.mode !== "draft";
  for (const chip of document.querySelectorAll<HTMLElement>(".chip")) {
    // MINE means nothing in prep — nobody has been drafted yet.
    if (chip.dataset.filter === "MINE") chip.hidden = draftOnly;
    chip.classList.toggle("active", chip.dataset.filter === settings.filter);
  }
  // Leaving prep on a filter that no longer exists would show an empty board.
  if (draftOnly && settings.filter === "MINE") {
    settings.filter = "ALL";
    saveSettings(settings);
    for (const chip of document.querySelectorAll<HTMLElement>(".chip")) {
      chip.classList.toggle("active", chip.dataset.filter === "ALL");
    }
  }
  el(".strip").hidden = draftOnly;
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
      syncChips();
      hideUndo();
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

  wireBackup();
}

function wireBackup(): void {
  el("#copy-link").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(location.href);
      flash("Board link copied");
    } catch {
      // Clipboard access can be refused; the link is still in the address bar.
      flash("Couldn't copy — the link is in the address bar");
    }
    closeMenu();
  });

  el("#export").addEventListener("click", () => {
    const backup = makeBackup(board.overrides, board.picks);
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);

    const link = document.createElement("a");
    link.href = url;
    link.download = `fantasy-board-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(url);

    closeMenu();
    flash("Backup exported");
  });

  const fileInput = el<HTMLInputElement>("#import-file");
  el("#import").addEventListener("click", () => fileInput.click());

  fileInput.addEventListener("change", async () => {
    const file = fileInput.files?.[0];
    // Reset first, so picking the same file twice still fires a change event.
    fileInput.value = "";
    if (!file) return;

    const backup = readBackup(await file.text());
    if (!backup) {
      flash("That file isn't a Fantasy Drafter backup");
      return;
    }

    const placements = Object.keys(backup.overrides).length;
    const message =
      `Replace this device's board with the backup?\n\n` +
      `${placements} player${placements === 1 ? "" : "s"} edited, ${backup.picks.length} pick${backup.picks.length === 1 ? "" : "s"}, ` +
      `saved ${new Date(backup.savedAt).toLocaleString()}.`;
    if (!confirm(message)) return;

    board.overrides = backup.overrides;
    board.picks.length = 0;
    for (const pick of backup.picks) board.pick(pick.id, pick.mine);

    persistOverrides();
    savePicks(board.picks);
    closeMenu();
    render();
    flash(`Imported ${placements} edited players and ${backup.picks.length} picks`);
  });
}

function closeMenu(): void {
  el("#menu").hidden = true;
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
  syncSheetToggles();

  el("#sheet").hidden = false;
}

/**
 * Reflect the player's states as pressed toggles. Mine and Taken are draft-mode
 * ideas and are simply absent in prep, where nobody has been drafted.
 */
function syncSheetToggles(): void {
  if (sheetPlayerId === null) return;
  const row = board.rows().find((r) => r.player.id === sheetPlayerId);
  if (!row) return;

  const press = (selector: string, on: boolean) =>
    el(selector).setAttribute("aria-pressed", String(on));

  press("#toggle-mine", row.state === "mine");
  press("#toggle-taken", row.state === "gone");
  press("#toggle-dnd", row.doNotDraft);

  el(".toggles").hidden = settings.mode !== "draft";
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

  el("#toggle-dnd").addEventListener("click", () => {
    if (sheetPlayerId === null) return;
    board.setDoNotDraft(sheetPlayerId, !board.isDoNotDraft(sheetPlayerId));
    persistOverrides();
    syncSheetToggles();
    render();
  });

  for (const [selector, state] of [
    ["#toggle-mine", "mine"],
    ["#toggle-taken", "gone"],
  ] as const) {
    el(selector).addEventListener("click", () => {
      if (sheetPlayerId === null) return;
      // Pressing the state a player is already in releases him, so every one of
      // these is reversible without hunting for an undo.
      const next = board.stateOf(sheetPlayerId) === state ? "available" : state;
      board.setState(sheetPlayerId, next);
      savePicks(board.picks);
      syncSheetToggles();
      render();
    });
  }

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


}

// --- Drag -------------------------------------------------------------------

function wireDrag(): void {
  enableDragReorder({
    list: el<HTMLOListElement>("#board"),
    rowSelector: ".row",
    handleSelector: ".grip",
    topInset: () => el("#header").getBoundingClientRect().height,
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

/**
 * Transient feedback, floated over the board rather than given a permanent
 * 20px strip in the header it was empty in almost all the time.
 */
let flashTimer = 0;
function flash(message: string): void {
  const status = el("#status");
  status.textContent = message;
  status.hidden = false;
  clearTimeout(flashTimer);
  flashTimer = window.setTimeout(() => (status.hidden = true), 2500);
}

// Keep the settings object honest if a stored value predates a new default.
settings = { ...DEFAULT_SETTINGS, ...settings };
