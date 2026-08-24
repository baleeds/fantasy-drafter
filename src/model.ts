/**
 * The board: KTC's baseline plus my personal layer, and the draft state
 * derived from an append-only pick log.
 *
 * No DOM in here. The ordering maths in particular is the kind of thing that
 * is much easier to trust with tests than with careful reading, so it is kept
 * separable — see model.test.ts.
 */

export type Position = "QB" | "RB" | "WR" | "TE";

export const POSITIONS: Position[] = ["QB", "RB", "WR", "TE"];

/** Baseline player, straight from players.json. Never mutated. */
export interface Player {
  id: number;
  name: string;
  position: Position;
  team: string;
  boardRank: number;
  ktcRank: number;
  positionalRank: number;
  rookie: boolean;
  byeWeek?: number;
  age?: number;
  injury?: { status: string; area: string; returns: string };
}

/** My edits to one player. Absent entirely for players I have never touched. */
export interface Override {
  sortKey?: number;
  doNotDraft?: boolean;
  note?: string;
}

export type Overrides = Record<string, Override>;

/** One entry in the append-only pick log. */
export interface Pick {
  id: number;
  mine: boolean;
}

export type PlayerState = "available" | "gone" | "mine";

/**
 * Gap between adjacent sort keys on a clean board. Wide enough that midpoint
 * insertion has room to work without ever needing fractions in practice.
 */
export const SPACING = 1000;

/** Where a player sits on the board, and how far that is from KTC's opinion. */
export interface BoardRow {
  player: Player;
  /** 1-based position on the full board, independent of any active filter. */
  position: number;
  /** Positive means I rate him higher than KTC does. */
  moved: number;
  state: PlayerState;
  doNotDraft: boolean;
  note: string;
}

export class Board {
  readonly players: Player[];
  overrides: Overrides;
  picks: Pick[];

  private byId = new Map<number, Player>();
  private states = new Map<number, PlayerState>();

  constructor(players: Player[], overrides: Overrides = {}, picks: Pick[] = []) {
    this.players = players;
    this.overrides = overrides;
    this.picks = picks;
    for (const p of players) this.byId.set(p.id, p);
    this.deriveStates();
  }

  // --- Ordering ------------------------------------------------------------

  /**
   * A player's key on the board. Players I have never moved store nothing and
   * inherit KTC's rank, so a rankings refresh repositions them automatically —
   * which is correct, because I have no opinion about them.
   */
  sortKeyOf(player: Player): number {
    return this.overrides[player.id]?.sortKey ?? player.boardRank * SPACING;
  }

  /** Every player in board order, with do-not-draft players sunk to the end. */
  rows(): BoardRow[] {
    const ordered = [...this.players].sort((a, b) => {
      const byKey = this.sortKeyOf(a) - this.sortKeyOf(b);
      return byKey !== 0 ? byKey : a.boardRank - b.boardRank;
    });

    const keep: Player[] = [];
    const sunk: Player[] = [];
    for (const p of ordered) (this.isDoNotDraft(p.id) ? sunk : keep).push(p);

    return [...keep, ...sunk].map((player, i) => ({
      player,
      position: i + 1,
      moved: player.boardRank - (i + 1),
      state: this.stateOf(player.id),
      doNotDraft: this.isDoNotDraft(player.id),
      note: this.overrides[player.id]?.note ?? "",
    }));
  }

  /** The rows a drag can reorder — the sunk ones are not draggable. */
  draggableRows(): BoardRow[] {
    return this.rows().filter((r) => !r.doNotDraft);
  }

  /**
   * Place a player between two named neighbours, by giving him a key midway
   * between theirs. Nobody else is renumbered.
   *
   * A null neighbour means "nothing above/below him *in the list I was looking
   * at*", which is not the same as the end of the board — the view may be
   * filtered to one position. In that case the missing side is resolved
   * against the full board, so dragging an RB to the top of an RB-filtered
   * list puts him above the other RBs rather than above everyone.
   */
  placeBetween(id: number, beforeId: number | null, afterId: number | null): void {
    const ordered = this.rows()
      .filter((r) => r.player.id !== id)
      .map((r) => r.player);
    const keyOf = (pid: number) => {
      const player = this.byId.get(pid);
      return player ? this.sortKeyOf(player) : null;
    };

    let before = beforeId !== null ? keyOf(beforeId) : null;
    let after = afterId !== null ? keyOf(afterId) : null;

    if (before === null && afterId !== null) {
      const i = ordered.findIndex((p) => p.id === afterId);
      before = i > 0 ? this.sortKeyOf(ordered[i - 1]) : null;
    }
    if (after === null && beforeId !== null) {
      const i = ordered.findIndex((p) => p.id === beforeId);
      after = i !== -1 && i + 1 < ordered.length ? this.sortKeyOf(ordered[i + 1]) : null;
    }

    this.setOverride(id, { sortKey: keyBetween(before, after) });
    this.renormaliseIfTight();
  }

  /** Move a player to an index within the unfiltered draggable list. */
  moveTo(id: number, toIndex: number): void {
    const list = this.draggableRows().filter((r) => r.player.id !== id);
    const clamped = Math.max(0, Math.min(list.length, toIndex));

    this.placeBetween(
      id,
      clamped > 0 ? list[clamped - 1].player.id : null,
      clamped < list.length ? list[clamped].player.id : null,
    );
  }

  /** Single-spot move, for when picking a player up is more effort than it's worth. */
  nudge(id: number, direction: -1 | 1): void {
    const list = this.draggableRows();
    const from = list.findIndex((r) => r.player.id === id);
    if (from === -1) return;
    const to = from + direction;
    if (to < 0 || to >= list.length) return;
    this.moveTo(id, to);
  }

  /**
   * Midpoint insertion eventually exhausts a gap. When any two adjacent keys
   * get within 2 of each other, respace the whole board.
   *
   * Players whose respaced key matches what they would inherit anyway keep no
   * override — otherwise a single renormalise would pin all 300 players and
   * quietly break the "untouched players follow KTC" property.
   */
  private renormaliseIfTight(): void {
    const rows = this.rows();
    const tight = rows.some(
      (r, i) =>
        i > 0 && this.sortKeyOf(r.player) - this.sortKeyOf(rows[i - 1].player) < 2,
    );
    if (!tight) return;

    rows.forEach((row, i) => {
      const key = (i + 1) * SPACING;
      if (key === row.player.boardRank * SPACING) this.clearSortKey(row.player.id);
      else this.setOverride(row.player.id, { sortKey: key });
    });
  }

  resetOrder(): void {
    for (const id of Object.keys(this.overrides)) this.clearSortKey(Number(id));
  }

  // --- Flags and notes -----------------------------------------------------

  isDoNotDraft(id: number): boolean {
    return this.overrides[id]?.doNotDraft === true;
  }

  setDoNotDraft(id: number, value: boolean): void {
    this.setOverride(id, { doNotDraft: value || undefined });
  }

  setNote(id: number, note: string): void {
    this.setOverride(id, { note: note.trim() || undefined });
  }

  private setOverride(id: number, patch: Override): void {
    const next = { ...this.overrides[id], ...patch };
    for (const key of Object.keys(next) as (keyof Override)[]) {
      if (next[key] === undefined) delete next[key];
    }
    if (Object.keys(next).length === 0) delete this.overrides[id];
    else this.overrides[id] = next;
  }

  private clearSortKey(id: number): void {
    if (this.overrides[id]) this.setOverride(id, { sortKey: undefined });
  }

  // --- Draft state ---------------------------------------------------------

  /**
   * Derived by scanning the log rather than stored per player. At 300 players
   * this costs nothing, and it means undo is popping an entry and "reset
   * draft" is emptying an array — neither can leave a stale flag behind.
   */
  private deriveStates(): void {
    this.states.clear();
    for (const pick of this.picks) {
      this.states.set(pick.id, pick.mine ? "mine" : "gone");
    }
  }

  stateOf(id: number): PlayerState {
    return this.states.get(id) ?? "available";
  }

  pick(id: number, mine: boolean): void {
    if (this.stateOf(id) !== "available") return;
    this.picks.push({ id, mine });
    this.deriveStates();
  }

  /** Pop the most recent pick. Unlimited, because the log is the only state. */
  undo(): Player | undefined {
    const pick = this.picks.pop();
    if (!pick) return undefined;
    this.deriveStates();
    return this.byId.get(pick.id);
  }

  get lastPick(): Player | undefined {
    const pick = this.picks[this.picks.length - 1];
    return pick ? this.byId.get(pick.id) : undefined;
  }

  resetDraft(): void {
    this.picks.length = 0;
    this.deriveStates();
  }

  /**
   * Raw counts of what I have taken. Deliberately no starter requirements —
   * that would mean configuring a lineup, and the "do I need a TE yet"
   * arithmetic is easier to do in my head than to maintain as a setting.
   */
  rosterCounts(): Record<Position, number> {
    const counts = { QB: 0, RB: 0, WR: 0, TE: 0 };
    for (const pick of this.picks) {
      if (!pick.mine) continue;
      const player = this.byId.get(pick.id);
      if (player) counts[player.position]++;
    }
    return counts;
  }
}

/**
 * The key that places a player between two neighbours. A null neighbour means
 * the end of the board.
 */
export function keyBetween(before: number | null, after: number | null): number {
  if (before === null && after === null) return SPACING;
  if (before === null) return Math.floor(after! / 2);
  if (after === null) return before + SPACING;

  // Floored, so keys stay whole numbers. Repeated halving would otherwise
  // produce fractions, which survive into the URL encoding and turn a compact
  // integer into a decimal string. Flooring can close a gap to 1, but the
  // respace threshold is 2, so that triggers a renormalise on the same move.
  return Math.floor((before + after) / 2);
}
