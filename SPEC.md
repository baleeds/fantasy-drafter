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
| League format | **Redraft, 1QB.** Fixed, not configurable — no dynasty, no superflex. |

## Rankings source: KeepTradeCut

Rankings are imported from [KeepTradeCut](https://keeptradecut.com) rather than
entered by hand.

### How the data is obtained

The redraft rankings page embeds the full player list as a JavaScript array
directly in the HTML:

```
https://keeptradecut.com/fantasy-rankings   → 376 players (redraft)
```

It contains `var playersArray = [ ... ];` — a plain JSON array. No API key, no
authentication, no client-side request to intercept. A regex extracts it in one
step. (`/dynasty-rankings` carries 500 players in the same shape, but this app
does not fetch it.)

### Fields we consume

| KTC field | Use |
|---|---|
| `playerName`, `position`, `team` | identity |
| `playerID` | stable key — this is what our overrides are keyed on |
| `byeWeek` | bye-week display and filter (missing for 17 of 300) |
| `rank` | the baseline board order |
| `positionalRank` | "RB4", "WR7" labels |
| `injury` | injury badge — status, body area, expected return |
| `age`, `rookie` | secondary display |

These live under `oneQBValues`. A parallel `superflexValues` object exists with
the same shape and a **genuinely different ordering** — Josh Allen is 6th in
1QB but 4th in superflex, which also puts Drake Maye and Lamar Jackson in the
top 8 where 1QB has neither. We read `oneQBValues` and ignore the other; the
pipeline should name the value set explicitly rather than defaulting, since the
two are interchangeable in shape and silently wrong in content.

### Use `rank`, not `startSitOverallRank`

The redraft page carries **two unrelated rankings** in the same payload, and
picking the wrong one silently produces a nonsense board:

| Field | What it actually is |
|---|---|
| `rank` | **the draft ranking** — what the page displays, and what we want |
| `startSitOverallRank` | KTC's *weekly start/sit* ranking, a different product |

The start/sit ranking treats "not a weekly lineup consideration" as effectively
unranked, so it dumps rookies and deep prospects into a sentinel value of 971.
Jeremiyah Love is `startSitOverallRank` 971 but `rank` **24** — the page shows
him 24th, between Drake Maye and Tetairoa McMillan. Ordering a draft board by
the start/sit field would bury a fourth-round talent at the bottom of the list.

Verified against the live page: ordering by `oneQBValues.rank` reproduces KTC's
displayed order exactly across the 18–30 window.

The same distinction applies to the positional-rank field — use
`positionalRank`, never `startSitPositionalRank`.

The source covers `QB / RB / WR / TE / PK / DST`. Kickers and defenses are
filtered out in the pipeline — see "Positions: skill players only" below.

### Pipeline

KTC sends no `Access-Control-Allow-Origin` header, so **the browser cannot
fetch this directly** from a GitHub Pages origin. The fetch happens at build
time instead:

```
GitHub Action  →  fetch keeptradecut.com/fantasy-rankings
               →  extract playersArray
               →  filter PK and DST, read oneQBValues only
               →  assign dense boardRank
               →  slim to the fields above (1.3MB HTML → ~78KB JSON)
               →  validate, then commit players.json
App           →  loads the committed JSON
```

This is preferable to a live fetch regardless of CORS: it loads instantly and
works with no internet at all.

**One format only.** My league is redraft 1QB, so the pipeline fetches only the
redraft page and reads only `oneQBValues`. The dynasty page and the superflex
value set are not fetched, not shipped, and there is no format toggle in the UI.
This is a quarter of the data and removes a setting that could silently be wrong
on draft night. Adding a format back later is a pipeline change, not a redesign.

**Schedule:** daily during preseason, plus `workflow_dispatch` so I can refresh
manually the morning of the draft. The UI displays a **"rankings as of <date>"**
line — injury data in particular goes stale within days, and I need to know
what I'm looking at.

### Positions: skill players only

My league does not use kickers or defenses, so **PK and DST are dropped entirely
in the pipeline** — not hidden in the UI. There are no K or DST filter chips and
those players never enter the app. This takes the redraft board from 376 players
to **300**.

### Densification

`rank` is unique — 376 distinct values across 376 players, no ties — but it is
**not contiguous**. It runs 1..2100 with gaps, because KTC ranks against a
larger universe than this page lists. Kickers and defenses are also interleaved
into it (Denver DST at 133, Brandon Aubrey at 139), so filtering them opens
further gaps.

Left alone this would make the "moved" indicator drift permanently, since board
position and KTC rank would not share a scale.

So the pipeline filters K/DST, sorts by `(rank, playerName)`, and assigns a
**dense `boardRank` of 1..300**. The app orders by `boardRank`; raw `rank` is
retained as a display-only field. The `playerName` tiebreak is belt-and-braces
— `rank` has no ties today, but a deterministic sort means a refresh can never
reshuffle the board through iteration order alone.

### Data quirks to handle

- **17 players have no `byeWeek`.** Render blank, don't render `undefined`.
- **`injury` is present on nearly every player** but healthy ones are just
  `{injuryCode: 1}`. Only badge when `injuryCode > 1` (66 players currently).
- **`adp` exists in the payload but is empty** — present on every player,
  populated on none. Do not build against it without re-checking; see the
  pick-countdown reasoning under Non-goals.
- **KTC values are crowd-sourced player value, not ADP.** They indicate who is
  good, not when players actually come off the board. Fine as a starting order
  for a board I hand-reorder anyway, but not a source of "he'll last another
  round."

### Tiers are out, for now

**No tiers anywhere: not in the pipeline, not in the data, not in the UI.**
`overallTier` is not carried through into `players.json`, and there is no
tier-break editing, no tier grouping, and no tier countdown.

The finding that prompted this, recorded so it isn't rediscovered later: KTC's
`overallTier` is monotonic but **lumpy and unstable**.

| Capture | Tier count | Smallest tier | Largest tier |
|---|---|---|---|
| Morning | 13 | 1 player | 56 players |
| Two fetches later, minutes apart | 10, then 11 | 1 player | 78 players |

A 78-player tier is not a tier, and neither is a 1-player tier. The count and
the boundaries both move between fetches minutes apart, so tier identity is not
stable enough to store anything against — which rules out KTC's tiers as a base
layer that my own breaks could sit on top of.

Hand-drawn tier breaks would still work, since they need nothing from KTC beyond
the sort-key scale. They are deferred rather than impossible; see "Later, not
day one".

**What this costs — and what covers it.** The tier countdown was the app's answer
to "can I wait?", the feature standing in for the pick countdown we cut. Losing
tiers left that question unanswered, which was a real gap at the table.

The **positional cliff** covers it, and covers it better. A large gap between the
best two available players at a position *is* a tier break — computed from my own
ordering at the moment I ask, rather than read off boundaries that move between
fetches minutes apart. It needs no stable tier identity to store anything
against, which was the exact property KTC's tiers failed to have.

## Data model

The critical structural decision: **the KTC baseline and my personal edits are
separate layers, merged at load time.**

```
Baseline  (players.json, from KTC)   — replaced wholesale on every refresh
My layer  (localStorage)             — never touched by a refresh
```

```jsonc
{
  // Per-player, keyed by KTC playerID. Sparse — only players I touched.
  "overrides": {
    "1508": {
      "sortKey": 8500,        // see "How ordering is stored"; absent if never moved
      "doNotDraft": false,
      "note": "handcuff is available late"
    }
  },

  // Draft state. Append-only; see "The pick log".
  "picks": [
    { "playerID": 1508, "mine": false },
    { "playerID": 1414, "mine": true  }
  ]
}
```

Note there is **no `status` field on a player.** Drafted state is derived from
the pick log, not stored per player.

Flattening these into one list would mean every rankings refresh destroys my
prep work. Keeping them separate means I can refresh the morning of the draft
and keep my order, my flags, and my notes — while newly added players merge in
automatically.

### How ordering is stored

Ordering is a **sparse sort key**, not a delta against KTC and not a positional
anchor to a neighbouring player. Players I have never moved store no ordering
data at all and inherit KTC's rank as their key:

```js
sortKey(player) = override.sortKey ?? (player.boardRank * 1000)
// board order = sort ascending by sortKey
```

This uses the dense `boardRank` assigned by the pipeline, **not** KTC's raw
rank, which is sparse (1..2100) and would leave board position and rank on
different scales. See "Densification" above.

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

The `* 1000` spacing keeps keys as integers. Roughly ten midpoint insertions
into the *same* gap will exhaust it; when any adjacent gap closes to less than
2, the spacing is reopened.

**The respace touches only the players I placed.** They are redistributed
between the untouched players either side of them, rather than the whole board
being renumbered. Renumbering everything would hand an explicit key to every
player merely *displaced* by my moves — 203 of 300 in a normal prep session —
and an explicit key means "I decided this". That would freeze those players
against the next KTC refresh, which is the exact property this layer exists to
protect.

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
- **Orphaned overrides.** A player dropped from KTC leaves an override behind.
  Harmless at this scale — keep them, since players do get re-added.

## Feature set

### Prep mode — before the draft

**Prep has no draft state.** Nobody is taken or mine while I am building the
board, so there is no MINE chip, no roster strip, no "show taken" toggle, no
strike-through and no status badges — and the sheet offers only ordering, the
do-not-draft flag, and a note. The header is a third shorter for it. Mid-draft I can still drop into prep to reorder; it simply shows
the whole board as a ranking, which is what prep is for.

- **Load the KTC board** — ordered and ready to use with zero setup.
- **Reorder by dragging**, on both desktop and phone. On touch this is a
  long-press to pick a player up, with the list autoscrolling when the held
  player nears the top or bottom edge. See "Drag on touch" below — this is the
  highest-risk piece of UI in the app and gets validated first.
- **Up/down nudge buttons** alongside drag, for single-spot moves where picking
  a player up is more effort than the move is worth.
- **Do-not-draft flag** on any player.
- **Per-player notes** — short free text.
- **Manual add** for anyone missing. Minor, given a 300-player board.
- **"Moved" indicator** — how far a player sits from KTC's rank (`↑12` / `↓8`),
  so my own biases are visible. **Only players I actually placed carry one.**
  Moving one player up necessarily pushes everyone beneath him down a spot, and
  that displacement is arithmetic, not an opinion: showing it would put an
  arrow against 40 players for one decision, and cover two-thirds of the board
  after a normal prep session. The arrow means "I decided this", so it appears
  exactly where an explicit placement exists.
- **Reset to KTC order** — undo for the whole board.

### Draft mode — the screen I live in

- **Best available at top**, sorted by my order. One flat list, no grouping.
- **Position filter chips** — ALL / QB / RB / WR / TE / FLEX / MINE. No K or DST
  chips; those positions do not exist in this app.
- **Every state is a toggle, in both directions.** A tap moves a player between
  available and taken; the **ME** button claims him and releases him; a tap on
  one of my own players gives him back rather than marking him taken by someone
  else, which is never what that tap means. Correcting a mistake by saying what
  is true beats correcting it by undoing: undo only reaches the most recent
  action, and only for as long as I remember it was the most recent.
- **Undo is a brief floating offer, not a standing control.** It covers the one
  case a toggle cannot — a mis-tap on a player who then leaves the screen, so
  there is no row left to tap back. It appears at the bottom, and goes away
  after a few seconds. (This reverses an earlier decision to make it permanent:
  that was the right call when a pick was one-way, and became clutter once
  every state could be tapped back.)
- **Search** to jump to a name. I'll hear a name announced and need to find it
  in two seconds. **Search covers drafted players too**, marked `GONE` — often
  the answer I need is "he went four picks ago", and a search restricted to
  available players fails at exactly the moment it matters.
- **Injury badges** — "Q Knee/ACL" beside the player's name, not out with the
  draft-status badges. It is a fact about the player, and grouping it with GONE
  and MINE made it read as a kind of pick.
- **Do-not-draft players are hidden, not moved.** The flag says "don't take
  him"; it is not an opinion that everyone below him is a spot better than I
  thought. He keeps his board position, so flagging one player renumbers nobody
  and shifts nobody's "moved" indicator. He simply drops out of the board, and
  the **`DND` filter chip** is how I get him back to review or unflag. Search
  finds him too, badged `DND`.
- **My roster panel** — raw counts by position (2 RB, 3 WR). Deliberately no
  starter requirements: that would mean configuring a starting lineup, and I'd
  rather do the "do I need a TE yet" arithmetic myself than maintain a setting.
- **The positional cliff** — the best two still available at each position, as
  `QB 6→21 · RB 1→2 · WR 3→4 · TE 9→12`. This is the answer to "can I wait?".
  A wide gap says take him now; a narrow one says the position is deep and the
  pick is better spent elsewhere. Sits under the roster counts, which is the
  natural pairing: what I have above, what is left below.

  **Both numbers rank against what is available, not against the board.** So
  `RB 12→16` reads "the best RB is the 12th best player still available to me,
  and the next one is 16th". This is a different scale from the rank on a row,
  which counts drafted and flagged players because it is my ranking of
  everybody. Early on the two nearly agree and they drift apart as the board
  empties — worth knowing, since the two numbers sit inches apart on screen.

  **Three exclusions, each of them a decision.** Drafted players, obviously.
  **My own players** — having got Gibbs, what an RB run costs me is a question
  about the RBs I do *not* have. And **do-not-draft players**, because "don't
  take him" means he is not depth, so counting him would report the position as
  deeper than it is *for me*. That finally gives the DND flag a job beyond
  hiding a row.

  **Computed from the whole board, never from what is on screen.** If filtering
  to RB or searching a name moved these numbers they would mean nothing.

  **What it does not tell me:** whether the drop will actually happen. It is
  what the drop costs. Whether the top RB lasts another twelve picks is an ADP
  question and nothing here knows the answer — see Non-goals. Ordinal gaps are
  also not linear in value, so the number is most trustworthy in the early
  rounds and noisier late, when board positions get sparse. That is the right
  way round: the early rounds are where the decision is hard.

  Draft mode only. The meaning of the number — what it costs to wait — is
  entirely a draft-night meaning, and prep stays free of draft concepts.

### The pick log

Draft state is an **append-only log of picks**, not a mutable `status` field on
each player:

```jsonc
[
  { "playerID": 1508, "mine": false },
  { "playerID": 1414, "mine": true  }
]
```

A player's state is derived by scanning the log rather than stored. This costs
nothing at 300 players and buys three things:

- **Unlimited undo** — pop the last entry. No separate undo stack to maintain
  and keep consistent with the thing it is undoing.
- **A draft history** for free: pick order, and what went between my picks.
- **"Reset draft" is emptying an array**, which cannot leave stale flags behind
  on individual players.

Mis-taps are the common case this exists for, so undo is a persistent control,
not a transient toast that disappears before I notice the mistake.

### Drag on touch

Long-press-to-drag with edge autoscroll over a 300-player list is the most
failure-prone UI in this app, and it is the one piece I cannot verify by
reasoning about it. Known hazards:

- Long-press competes with the browser's own text selection and context menu on
  iOS, and with page scroll. Touch handlers need `touch-action` set and
  non-passive listeners to `preventDefault` reliably.
- Autoscroll speed has to be proportional to edge proximity, or dragging from
  120 to 15 is either unusably slow or overshoots wildly.
- The drop target must stay legible while scrolling, or I cannot tell where the
  player will land.

**This gets built and tested on the actual phone first**, before the rest of the
draft UI. If it proves unpleasant in practice, the fallback is pinning relative
to another player ("put him above Olave"), which needs no precise gesture and
maps just as cleanly onto the midpoint sort key.

### The three player states

Available, taken-by-someone, and mine are three distinct kinds of information
and must not share a visual treatment. In particular, **strike-through is wrong
for my own picks** — it reads as "lost, unavailable, stop looking" when the
player was in fact acquired.

| State | Default visibility | Treatment |
|---|---|---|
| Available | Shown | Normal |
| Taken by someone else | Hidden | Dimmed, struck through, in place |
| Mine | **Always shown**, in board position | Accent bar and a pressed ME button, never struck |

**My own picks never leave the board.** Hiding taken players is for collapsing
the run of players that went between my picks — it is not a reason to lose
sight of my own team. So with the toggle off, the board reads as: best
available, best available, *my guy*, best available — my roster threaded
through the list at the positions I took them, with everyone else's picks
closed up.

- **"Show taken" toggle** brings other people's picks back inline, for scanning
  and confirming whether someone actually went. It has no effect on mine.
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
  prepping a board in August and drafting in September. The personal layer
  compresses into the URL hash, so bookmarking the page preserves the board
  through any storage wipe, with no file management and no export to remember.
  The hash fragment is never sent to the server, so length limits are generous.
- **The URL encodes ordering and do-not-draft flags only. Notes are excluded** —
  they are free text with unbounded length, and they are the least costly thing
  to lose in a storage wipe. Keeping them out means the encoded URL has a
  predictable ceiling rather than growing with how much I happened to type.
  Notes still persist in `localStorage` and still travel in the JSON export.
- **Scope limit, deliberate:** the URL is a *prep* backup — ordering and
  do-not-draft flags. Live draft state stays in `localStorage`, since eviction
  happens between sessions rather than during one.
- **Export / import JSON** stays as the mechanism for moving a board between
  laptop and phone.
- **Two separate resets** — "reset draft" (clears drafted flags, keeps my
  rankings) and "reset everything."
- Confirmation before anything destructive.

### Later, not day one

- **Hand-drawn tier breaks**, and the "N left in this tier" countdown that runs
  on them. Deferred, not abandoned — they need nothing from KTC beyond the
  sort-key scale, so they can be added later without touching the pipeline.
  Whether the board actually wants sections is easier to judge after using a
  flat one. See "Tiers are out, for now".
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
- **Set Vite's `base` to the repo name.** GitHub Pages project sites serve from
  `/fantasy-drafter/`, and the default `base: "/"` yields a blank page with a
  404 on every asset.
- **`players.json` is committed** rather than generated at deploy time. Daily
  data commits are noisy, but the last good file always exists in git.
- **The refresh Action validates before committing.** Player count in a sane
  range, required fields present, top-ranked player is a plausible skill
  position. On failure it fails loudly and leaves the previous `players.json`
  untouched. A stale board beats an empty one, and a KTC redesign must not be
  able to break the app during draft week.

## Build order

The draft is two to four weeks out, which is enough time to build the MVP as
specced and then rehearse it. Order matters more than usual here, because the
two riskiest pieces are not the ones that look hardest:

1. **The KTC pipeline** — the Action, the field validation, `players.json`.
   Everything sits on it, and it is where the one real mistake has already
   happened.
2. **Touch drag** — on the actual phone, in isolation. If this doesn't work,
   I want to know in week one, not week three.
3. The board, filters, search, and the pick log.
4. URL encoding, export/import, resets.
5. **Rehearsal against a live mock draft, end to end.** This tool gets used once,
   under time pressure, with no opportunity to debug. Anything not exercised in
   a mock is untested. "Reset draft" exists precisely so a mock costs nothing.

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

- Is a "run the refresh workflow" button worth adding to the UI, or is the
  GitHub Actions manual-dispatch page good enough?

**Answered:** `startSitOverallRank` is a separate weekly start/sit product, not
a seasonal drift in the draft ranking. `rank` is the draft ranking and is stable
in meaning. See "Use `rank`, not `startSitOverallRank`".

**Answered:** the pipeline now asserts it is reading the draft ranking. The
originally-proposed check (top-50 players carrying a high `rank`) does not work
— the board is sorted by that field, so it is true by construction whichever
field you read. The guards that do work key on the start/sit sentinel instead:
it collapses non-lineup players onto one value, so a large tie cluster or a
top 100 containing no rookies means the wrong field. Both are data-driven rather
than name-based, so they don't need revisiting each season.

**Answered:** tiers are cut from day one entirely, which retires the question of
how my breaks would have related to KTC's. See "Tiers are out, for now".
