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
    "customRank": 3,          // my position in the board, if moved
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
- **Position filter chips** — ALL / QB / RB / WR / TE / K / DST / FLEX.
- **One tap marks a player drafted.** A second, distinct action marks
  **"I drafted him"** (long-press or a separate button).
- **Drafted players disappear** by default; toggle to show them struck through.
- **Undo.** Non-negotiable — mis-taps happen constantly when the board moves fast.
- **Search** to jump to a name. I'll hear a name announced and need to find it
  in two seconds.
- **Injury badges** — "Q — Knee/ACL" inline, for deciding whether to take the risk.
- **Do-not-draft players** render dimmed and struck through, sunk to the bottom.
- **My roster panel** — counts by position, so I know I still need a TE.
- **Tier countdown** — "4 left in this tier," the signal for whether I can wait.

### Persistence & safety

- Autosave to `localStorage` on every change.
- **Export / import JSON.** The safety net: a dead phone shouldn't cost me the
  board, and it lets me prep on the laptop and carry it to my phone.
- **Two separate resets** — "reset draft" (clears drafted flags, keeps my
  rankings) and "reset everything."
- Confirmation before anything destructive.

### Later, not day one

- Multiple saved boards (different leagues, or a redraft after a mock).
- Bye-week filter, for spotting bye pileups.
- Position-run indicator — last N picks by position, to see a RB run forming.
- Dark mode.
- PWA install + offline cache.

## Non-goals

No accounts, no backend, no sync with ESPN/Yahoo/Sleeper, no projections engine,
no auction support, no multi-user, no league/draft-slot configuration and
therefore no pick countdown. The tiered board carries that weight instead.

## Open questions

- Does `startSitOverallRank` hold up once the regular season starts, or does KTC
  repurpose the redraft page for in-season start/sit? Worth re-checking closer
  to draft day.
- Is a "run the refresh workflow" button worth adding to the UI, or is the
  GitHub Actions manual-dispatch page good enough?
