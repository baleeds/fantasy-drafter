# Fantasy Drafter — Specification

A single-purpose tool for running my fantasy football draft. Open it on draft
night, work down a ranked board, tap players off as they go, and know who the
best available guy is at a glance.

Deliberately small. It is useful for about four hours a year and should be
judged on how well it works during those four hours.

## Design constraints

| Constraint | Decision |
|---|---|
| Devices | Laptop and phone. Phone is the priority — that's what's in my hand at the table. |
| Hosting | GitHub Pages. Static, no backend. |
| Storage | `localStorage`, autosaved on every change. |
| Network | Must work fully offline. Draft venue wifi is unreliable. |
| Users | One. No accounts, no sync, no sharing. |
| League format | **Redraft, 1QB** is the default. Superflex and dynasty available as toggles. |

## Rankings source: KeepTradeCut

Rankings are imported from [KeepTradeCut](https://keeptradecut.com) rather than
entered by hand.

### How the data is obtained

Both KTC ranking pages embed the full player list as a JavaScript array
directly in the HTML:

```
https://keeptradecut.com/fantasy-rankings   → 376 players (redraft)
https://keeptradecut.com/dynasty-rankings   → 500 players (dynasty)
```

Each page contains `var playersArray = [ ... ];` — a plain JSON array. No API
key, no authentication, no client-side request to intercept. A regex extracts
it in one step.

### Fields we consume

| KTC field | Use |
|---|---|
| `playerName`, `position`, `team` | identity |
| `playerID` | stable key — this is what our overrides are keyed on |
| `byeWeek` | bye-week display and filter (populated for 359/376) |
| `startSitOverallRank` | the baseline board order |
| `startSitPositionalRank` | "RB4", "WR7" labels |
| `startSitOverallTier` | tier grouping |
| `injury` | injury badge — status, body area, expected return |
| `age`, `rookie` | secondary display |

Rank/tier/injury fields live under either `oneQBValues` or `superflexValues`,
which are **separate orderings, not minor reshuffles**. Josh Allen is QB1 and
overall #8 in 1QB, but overall #1 in superflex. Loading the wrong one produces
a board that is wrong from the first pick.

Positions cover `QB / RB / WR / TE / PK / DST`, so kickers and defenses are
included and the board is complete.

### Pipeline

KTC sends no `Access-Control-Allow-Origin` header, so **the browser cannot
fetch this directly** from a GitHub Pages origin. The fetch happens at build
time instead:

```
GitHub Action  →  fetch both KTC pages
               →  extract playersArray
               →  slim to the fields above (1.3MB HTML → ~40KB JSON)
               →  commit players.json
App           →  loads the committed JSON
```

This is preferable to a live fetch regardless of CORS: it loads instantly and
works with no internet at all.

**Schedule:** daily during preseason, plus `workflow_dispatch` so I can refresh
manually the morning of the draft. The UI displays a **"rankings as of <date>"**
line — injury data in particular goes stale within days, and I need to know
what I'm looking at.

### Data quirks to handle

- **Tiers are not strictly monotonic.** Observed: rank 25 is tier 5 while rank
  26 is tier 4. Group tiers by rank order, don't assume tier increases cleanly.
- **17 players have no `byeWeek`.** Render blank, don't render `undefined`.
- **`injury` is present on nearly every player** but healthy ones are just
  `{injuryCode: 1}`. Only badge when `injuryCode > 1` (66 players currently).
- **KTC values are crowd-sourced player value, not ADP.** They indicate who is
  good, not when players actually come off the board. Fine as a starting order
  for a board I hand-reorder anyway, but not a source of "he'll last another
  round."

## Data model

The critical structural decision: **the KTC baseline and my personal edits are
separate layers, merged at load time.**

```
Baseline  (players.json, from KTC)   — replaced wholesale on every refresh
My layer  (localStorage)             — never touched by a refresh
```

```jsonc
// My layer, keyed by KTC playerID
{
  "1508": {
    "sortKey": 8500,          // see "How ordering is stored" below; absent if never moved
    "doNotDraft": false,
    "note": "handcuff is available late",
    "status": "available"     // available | drafted | mine
  }
}
```

Flattening these into one list would mean every rankings refresh destroys my
prep work. Keeping them separate means I can refresh the morning of the draft
and keep my order, my flags, and my notes — while newly added players merge in
automatically.

### How ordering is stored

Ordering is a **sparse sort key**, not a delta against KTC and not a positional
anchor to a neighbouring player. Players I have never moved store no ordering
data at all and inherit KTC's rank as their key:

```js
sortKey(player) = override.sortKey ?? (player.ktcRank * 1000)
// board order = sort ascending by sortKey
```

Dragging a player between neighbours A and B assigns him the midpoint:

```js
override.sortKey = (sortKey(A) + sortKey(B)) / 2
```

Properties this gives us:

- **The personal layer stays sparse.** Only players I actually moved are stored.
- **Moving one player renumbers nobody else.** No cascading rewrite, no
  collision handling.
- **Refreshes behave correctly by default.** Untouched players pick up KTC's new
  ranks automatically — correct, because I have no opinion about them. New
  players merge in at their natural position with no special handling.
- **Players I placed stay placed.** Their key is frozen.

The `* 1000` spacing keeps keys as integers rather than floats. Roughly ten
midpoint insertions into the *same* gap will exhaust it; when any adjacent gap
closes to less than 2, renormalise the entire board back to clean `* 1000`
spacing. On 376 players that is instantaneous and in practice will rarely fire.

**Rejected: a delta** (`offset: -12`). A delta means "always twelve spots better
than whatever KTC currently thinks", which permanently couples my override to
the opinion I was trying to override. Bump a player from 20 to 8, then watch him
fall to 90 on an injury, and the board says 78 — when what I meant was "top ten".

**Rejected: a positional anchor** (`{after: playerID}`). Semantically richer, but
it propagates baseline volatility in the wrong direction: if the anchor player
collapses 80 spots, everyone anchored behind him is dragged down too. It also
needs handling for broken chains when an anchor leaves the list, and for cycles.

### Consequences to handle

- **Stale pins.** A frozen key drifts in meaning as the baseline moves. A player
  pinned at `8500` still reads as top-ten even if his KTC rank has since
  collapsed. This makes the "moved" indicator load-bearing rather than
  decorative, and calls for a post-refresh prompt: *"3 players you placed have
  moved 20+ spots in KTC — review?"*
- **Non-contiguous tiers.** Once the board is reordered, KTC's tiers no longer
  appear in contiguous runs — a tier 3 player can sit between two tier 5s. Tier
  must therefore render as a per-player badge once a custom order exists.
  Manual tier breaks are what provide real section grouping.
- **Orphaned overrides.** A player dropped from KTC leaves an override behind.
  Harmless at this scale — keep them, since players do get re-added.

## Feature set

### Prep mode — before the draft

- **Load the KTC board** — ordered, tiered, ready to use with zero setup.
- **Format toggles** — Redraft/Dynasty and 1QB/Superflex. Defaults to Redraft
  1QB.
- **Reorder players** — drag-and-drop on desktop; up/down and "move to #N"
  buttons that work on a phone. Drag-only is unusable on a touchscreen.
- **Do-not-draft flag** on any player.
- **Per-player notes** — short free text.
- **Edit tier breaks** — KTC's tiers are the starting point, not the last word.
- **Manual add** for anyone missing. Minor, given 376 players covering K and DST.
- **"Moved" indicator** — how far a player sits from KTC's rank (`↑12` / `↓8`),
  so my own biases are visible.
- **Reset to KTC order** — undo for the whole board.

### Draft mode — the screen I live in

- **Best available at top**, sorted by my order, grouped by tier.
- **Position filter chips** — ALL / QB / RB / WR / TE / K / DST / FLEX / MINE.
  K and DST are excluded from ALL by default and reachable via their own chips;
  they are drafted in the last two rounds and are noise for the other fourteen.
- **One tap marks a player drafted.** A second, distinct action marks
  **"I drafted him"** (long-press or a separate button).
- **Undo.** Non-negotiable — mis-taps happen constantly when the board moves fast.
- **Search** to jump to a name. I'll hear a name announced and need to find it
  in two seconds.
- **Injury badges** — "Q — Knee/ACL" inline, for deciding whether to take the risk.
- **Do-not-draft players** render dimmed and struck through, sunk to the bottom.
- **My roster panel** — counts by position, so I know I still need a TE.
- **Tier countdown** — "4 left in this tier." This is the app's answer to "can I
  wait?", and it is deliberately not a prediction. It is grounded entirely in my
  own board and answers the question that actually matters at the table: not
  "will this specific player survive", but "if I wait and lose him, is there an
  equivalent player left?"

### The three player states

Available, taken-by-someone, and mine are three distinct kinds of information
and must not share a visual treatment. In particular, **strike-through is wrong
for my own picks** — it reads as "lost, unavailable, stop looking" when the
player was in fact acquired.

| State | Default visibility | Treatment |
|---|---|---|
| Available | Shown | Normal |
| Taken by someone else | Hidden | Dimmed, struck through, in place |
| Mine | Hidden in board, always in roster panel | Accent colour + badge, never struck |

- **"Show drafted" toggle** brings taken players back inline, for scanning and
  confirming whether someone actually went.
- **`MINE` filter chip** shows only my team by name. This reuses the existing
  filter row rather than introducing a separate view mode.
- **Fade-out animation** whenever a player leaves the visible list, in every
  mode. The half-second of motion is what catches a mis-tap; without it, a
  wrong tap removes a player silently and I spend the rest of the draft
  believing he is gone.

### Persistence & safety

- Autosave to `localStorage` on every change.
- **The board encodes into the URL.** `localStorage` is not durable enough to
  trust on its own: Safari deletes all script-writable storage for a site after
  7 days of browser use without interaction, which is exactly the gap between
  prepping a board in August and drafting in September. The full personal layer
  compresses into the URL hash, so bookmarking the page preserves the board
  through any storage wipe, with no file management and no export to remember.
  The hash fragment is never sent to the server, so length limits are generous.
- **Scope limit, deliberate:** the URL is a *prep* backup — order, do-not-draft
  flags, notes. Live draft state stays in `localStorage`, since eviction happens
  between sessions rather than during one.
- **Export / import JSON** stays as the mechanism for moving a board between
  laptop and phone.
- **Two separate resets** — "reset draft" (clears drafted flags, keeps my
  rankings) and "reset everything."
- Confirmation before anything destructive.

### Later, not day one

- **ADP as a second source**, deferred until I have seen how far the KTC board
  diverges from how a room actually drafts.
- Multiple saved boards (different leagues, or a redraft after a mock).
- Bye-week filter, for spotting bye pileups.
- Position-run indicator — last N picks by position, to see a RB run forming.
- Dark mode.
- PWA install + offline cache. Also exempts storage from Safari eviction.

## Implementation decisions

- **Vanilla TypeScript + Vite, no framework.** The app is one sorted list with
  filters. Nothing to upgrade when I come back to this next August.
- **`players.json` is committed** rather than generated at deploy time. Daily
  data commits are noisy, but the last good file always exists in git.
- **The refresh Action validates before committing.** Player count in a sane
  range, required fields present, top-ranked player is a plausible skill
  position. On failure it fails loudly and leaves the previous `players.json`
  untouched. A stale board beats an empty one, and a KTC redesign must not be
  able to break the app during draft week.

## Non-goals

No accounts, no backend, no sync with ESPN/Yahoo/Sleeper, no projections engine,
no auction support, no multi-user, no league or draft-slot configuration.

**No pick countdown, and this is a considered exclusion rather than a cut for
scope.** "Will he last until my next pick?" is by definition an ADP question —
it requires knowing when players come off the board, which crowd-sourced KTC
value does not encode. A countdown beside a KTC-ranked board would be worse
than absent: it presents a real number (11 picks away) with no way to estimate
who disappears during those picks, and so reads as actionable when it is not.
Pick timing is therefore coupled to ADP, and returns only if ADP does.

## Open questions

- Does `startSitOverallRank` hold up once the regular season starts, or does KTC
  repurpose the redraft page for in-season start/sit? Worth re-checking closer
  to draft day.
- Is a "run the refresh workflow" button worth adding to the UI, or is the
  GitHub Actions manual-dispatch page good enough?
- How large does the encoded URL get with a heavily reordered board plus notes?
  If it becomes unwieldy, notes are the first thing to drop from the encoding.
