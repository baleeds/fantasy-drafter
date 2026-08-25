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
  /**
   * Average draft position — when this player actually comes off the board,
   * as opposed to how good he is. Absent past roughly pick 200, where nobody
   * is reliably drafted and "no ADP" is the honest answer.
   */
  adp?: number;
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
  /**
   * How far he sits from KTC's rank. Positive means I rate him higher.
   *
   * Only meaningful alongside `placed`: a player I never touched can still be
   * displaced by moves around him, and that displacement is not an opinion.
   */
  moved: number;
  /** True if I put him here, rather than his having been pushed here. */
  placed: boolean;
  state: PlayerState;
  doNotDraft: boolean;
  note: string;
  /**
   * Rank among the players still available to me, or null if he is not one of
   * them. A different scale from `position`, which counts drafted and flagged
   * players because it is my ranking of everybody.
   */
  availableRank: number | null;
  /**
   * Rank among available players by *ADP* rather than by my board — where the
   * room would take him, not where I rate him.
   *
   * This is what every prediction in the app counts down. My ordering decides
   * who I want; ADP decides who will still be there. Players with no ADP sort
   * last, which is correct: nobody is taking them soon.
   *
   * With no ADP anywhere in the data this collapses to `availableRank`, so a
   * board built before ADP existed still projects, just less well.
   */
  adpRank: number | null;
  /** The drop behind him, when it is large enough to be worth marking. */
  cliff: Cliff | null;
}

/**
 * The drop behind a player at his own position: how many available players sit
 * between him and the next one who plays where he does.
 *
 * `ratio` is what makes the gap comparable across positions, and it is the
 * whole idea. Positions are not equally dense on a board — on a fresh KTC 300
 * the median gap between consecutive WRs is 2 and between consecutive QBs is 4,
 * with mean spacings of 2.4 and 6.8. So a raw gap of 5 is twice the normal
 * spacing at WR and *below* average at QB. Dividing by the position's own mean
 * spacing puts every position on one scale, with no per-position constants to
 * tune and no re-tuning as the board empties.
 */
export interface Cliff {
  /** Available players between him and the next one at his position. */
  gap: number;
  /** Multiples of that position's normal spacing. */
  ratio: number;
}

/**
 * How many times normal spacing counts as a cliff.
 *
 * Measured against the real board rather than guessed. Gating on the pick line
 * (see `projections`) and sweeping a whole 14-team draft: K=2 fires 21 times,
 * K=2.5 eight, K=3 seven, K=3.5 five. Three lands on roughly one flag every
 * other pick — sparse enough that each one is worth reading.
 *
 * Normalising by *mean* spacing rather than median is deliberate. The median is
 * the more robust statistic and fires about three times as often; the place
 * that decides it is QB, where a 15-player gap reads 3.75x by median and 2.2x
 * by mean. In a 1QB league being told to reach for a quarterback is exactly the
 * advice not to take, so the conservative one wins.
 */
export const CLIFF_RATIO = 3;

/** Where one of my picks falls in the list of players still available to me. */
export interface Projection {
  /** Overall pick number in the draft. */
  pick: number;
  /** Available players who come off the board first. Zero means I am up. */
  after: number;
}

/**
 * The overall pick numbers for one seat in a snake draft.
 *
 * Odd rounds run 1..teams, even rounds run back the other way, which is what
 * gives a seat near the top its lopsided rhythm: at slot 2 of 14 the picks are
 * 2, 27, 30, 55, 58 — twenty-five players gone, then three, then twenty-five.
 */
export function snakePicks(teams: number, slot: number, rounds: number): number[] {
  const picks: number[] = [];
  for (let round = 1; round <= rounds; round++) {
    const forward = round % 2 === 1;
    picks.push((round - 1) * teams + (forward ? slot : teams + 1 - slot));
  }
  return picks;
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

  /**
   * Every player in board order.
   *
   * Do-not-draft players keep their place here. The flag is an instruction
   * about one player — don't take him — not an opinion that everyone below him
   * is a spot better than I thought. Moving flagged players to the end would
   * renumber the rest of the board and shift their "moved" indicators along
   * with it. Hiding them is the view's job; see visibleRows in main.ts.
   */
  rows(): BoardRow[] {
    const ordered = [...this.players].sort((a, b) => {
      const byKey = this.sortKeyOf(a) - this.sortKeyOf(b);
      return byKey !== 0 ? byKey : a.boardRank - b.boardRank;
    });

    const available = ordered.filter((player) => this.isAvailable(player.id));
    const rank = new Map(available.map((player, i) => [player.id, i + 1]));
    const cliffs = findCliffs(available);

    // Sorted by when the room takes them, with my own order as the tiebreak so
    // players sharing an ADP — and the whole undrafted tail, which shares none
    // at all — stay in a stable, sensible sequence.
    const byAdp = [...available].sort(
      (a, b) => (a.adp ?? Infinity) - (b.adp ?? Infinity) || a.boardRank - b.boardRank,
    );
    const adpRank = new Map(byAdp.map((player, i) => [player.id, i + 1]));

    return ordered.map((player, i) => ({
      player,
      position: i + 1,
      moved: player.boardRank - (i + 1),
      placed: this.isPlaced(player.id),
      state: this.stateOf(player.id),
      doNotDraft: this.isDoNotDraft(player.id),
      note: this.overrides[player.id]?.note ?? "",
      availableRank: rank.get(player.id) ?? null,
      adpRank: adpRank.get(player.id) ?? null,
      cliff: cliffs.get(player.id) ?? null,
    }));
  }

  /**
   * A player I could still take.
   *
   * Three exclusions, each of them a decision. Drafted players, obviously. **My
   * own players** — having got Gibbs, what an RB run costs me is a question
   * about the RBs I do *not* have. And **do-not-draft players**, because "don't
   * take him" means he is not depth, so counting him would report a position as
   * deeper than it is *for me*. That last one finally gives the flag a job
   * beyond hiding a row.
   */
  isAvailable(id: number): boolean {
    return this.stateOf(id) === "available" && !this.isDoNotDraft(id);
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
    const list = this.rows().filter((r) => r.player.id !== id);
    const clamped = Math.max(0, Math.min(list.length, toIndex));

    this.placeBetween(
      id,
      clamped > 0 ? list[clamped - 1].player.id : null,
      clamped < list.length ? list[clamped].player.id : null,
    );
  }

  /** Single-spot move, for when picking a player up is more effort than it's worth. */
  nudge(id: number, direction: -1 | 1): void {
    const list = this.rows();
    const from = list.findIndex((r) => r.player.id === id);
    if (from === -1) return;
    const to = from + direction;
    if (to < 0 || to >= list.length) return;
    this.moveTo(id, to);
  }

  /** Has an explicit key, meaning I put him where he is. */
  isPlaced(id: number): boolean {
    return this.overrides[id]?.sortKey !== undefined;
  }

  /** The key a player would inherit if I had never touched him. */
  private naturalKey(player: Player): number {
    return player.boardRank * SPACING;
  }

  /**
   * Midpoint insertion eventually exhausts a gap. When two adjacent keys get
   * within 2 of each other, reopen the spacing.
   *
   * Only the players I actually placed are respaced, and they are spread
   * between the untouched players either side of them rather than given
   * positional keys. Respacing the whole board would hand an explicit key to
   * every player merely *displaced* by my moves — 203 of 300 in a normal prep
   * session — and an explicit key means "I decided this", which would freeze
   * them against the next KTC refresh and light up their arrows for a move I
   * never made.
   */
  private renormaliseIfTight(): void {
    const rows = this.rows();
    const tight = rows.some(
      (r, i) =>
        i > 0 && this.sortKeyOf(r.player) - this.sortKeyOf(rows[i - 1].player) < 2,
    );
    if (!tight) return;

    const ordered = rows.map((r) => r.player);
    let i = 0;
    while (i < ordered.length) {
      if (!this.isPlaced(ordered[i].id)) {
        i++;
        continue;
      }

      // A run of placed players, bounded by whoever is untouched either side.
      let end = i;
      while (end < ordered.length && this.isPlaced(ordered[end].id)) end++;

      const count = end - i;
      const low = i > 0 ? this.naturalKey(ordered[i - 1]) : 0;
      const high =
        end < ordered.length
          ? this.naturalKey(ordered[end])
          : low + SPACING * (count + 1);

      const step = (high - low) / (count + 1);
      for (let k = 0; k < count; k++) {
        this.setOverride(ordered[i + k].id, { sortKey: Math.round(low + step * (k + 1)) });
      }
      i = end;
    }
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

  /**
   * Set a player's state directly, in either direction.
   *
   * Correcting a mistake by saying what is true beats correcting it by undoing
   * — undo only reaches the most recent action, and only for as long as you
   * remember it was the most recent. This is why the log is edited in place
   * rather than only appended to: a player who changes hands keeps his
   * position in the pick order, because he did go off the board when he did.
   */
  setState(id: number, state: PlayerState): void {
    const at = this.picks.findIndex((pick) => pick.id === id);

    if (state === "available") {
      if (at !== -1) this.picks.splice(at, 1);
    } else if (at !== -1) {
      this.picks[at].mine = state === "mine";
    } else {
      this.picks.push({ id, mine: state === "mine" });
    }

    this.deriveStates();
  }

  pick(id: number, mine: boolean): void {
    if (this.stateOf(id) !== "available") return;
    this.setState(id, mine ? "mine" : "gone");
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

  // --- Where my picks land --------------------------------------------------

  /**
   * How far down the available list each of my remaining picks falls.
   *
   * The arithmetic is only ever counting picks: with `made` picks recorded, the
   * number of players who come off the board before my pick `P` is
   * `P - made - 1`. So **the count is exact and only the composition is
   * approximate.** KTC is crowd-sourced value rather than ADP, so which players
   * disappear is a guess — but how many is not, and if the room reaches for
   * players I rank low they still leave my available list and the line stays
   * where it belongs. That makes the line considerably more trustworthy than
   * the data behind it sounds.
   *
   * What this does depend on is the pick log being complete. A missed tap used
   * to leave one stale row; now it shifts every line for the rest of the night,
   * and quietly. The header shows the current pick number so a drift can be
   * caught against the real draft board.
   *
   * Note a player drafted after I flagged him do-not-draft consumes a pick
   * without removing anyone from my available list — so the line moves up while
   * the list stays put, which is exactly right: his going brings my pick nearer
   * without costing me an option.
   */
  projections(teams: number, slot: number): Projection[] {
    if (!Number.isInteger(teams) || !Number.isInteger(slot)) return [];
    if (teams < 2 || slot < 1 || slot > teams) return [];

    let available = 0;
    for (const player of this.players) if (this.isAvailable(player.id)) available++;

    const made = this.picks.length;
    const rounds = Math.ceil(this.players.length / teams);

    return snakePicks(teams, slot, rounds)
      .map((pick) => ({ pick, after: pick - made - 1 }))
      .filter((p) => p.after >= 0 && p.after <= available);
  }
}

/**
 * Mark every available player who has an unusually large drop behind him.
 *
 * One backward pass, tracking the nearest player already seen at each position.
 * The last player of his kind gets no cliff — "nobody after him" is a different
 * fact from "a long way to the next one", and reporting it as an enormous gap
 * would flag the tail of every position.
 */
function findCliffs(available: Player[]): Map<number, Cliff> {
  const counts = new Map<Position, number>();
  for (const player of available) {
    counts.set(player.position, (counts.get(player.position) ?? 0) + 1);
  }

  const cliffs = new Map<number, Cliff>();
  const nextAt = new Map<Position, number>();

  for (let i = available.length - 1; i >= 0; i--) {
    const player = available[i];
    const next = nextAt.get(player.position);
    nextAt.set(player.position, i);
    if (next === undefined) continue;

    const spacing = available.length / counts.get(player.position)!;
    const gap = next - i;
    const ratio = gap / spacing;
    if (ratio >= CLIFF_RATIO) cliffs.set(player.id, { gap, ratio });
  }

  return cliffs;
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
