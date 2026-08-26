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

## ADP: Sleeper, via GraphQL

KTC is crowd-sourced **value** — who is good. ADP is **behaviour** — when
players actually come off the board. The app needs both and must never confuse
them.

Source: `POST https://sleeper.app/graphql`, public and unauthenticated,
`season_stats(category: "proj", order_by: "adp_half_ppr")`. Two findings worth
keeping, because neither is discoverable:

- **ADP is not under `category: "adp"`.** That category exists and returns zero
  rows for every season and season_type. The numbers live inside the `proj`
  category's stats map, supplied by Rotowire, alongside twelve scoring flavours
  (`adp_ppr`, `adp_half_ppr`, `adp_std`, `adp_2qb`, `adp_dynasty_*`, …). The
  column is named explicitly for the same reason `oneQBValues` is: they are
  interchangeable in shape and silently wrong in content.
- **The player object is inlined on every row**, so the join needs no second
  request for the 14MB player dump just to turn ids into names.

**`search_rank` on the player dump is not ADP.** It is a coarse bucketed
ordering — 290 draftable players share only 206 distinct values, with three-way
ties at the very top — drawn from a universe that includes IDP and kickers, and
carrying its own `9999999` and `999` sentinels. Measured against it, KTC appears
to wildly over-rate tight ends (+16 spots) and the whole TE cliff structure
looks like an artifact. Measured against real ADP that drift is +6, and the
actual outlier is quarterbacks. A bucketed popularity ranking is not a draft
order, and reading it as one produced confident nonsense for a whole round of
analysis.

### What the join found

Half-PPR ADP against my board, mean drift over my top 80 (positive = they go
later than I rate them):

| QB | RB | WR | TE |
|---|---|---|---|
| **+31** | −9 | +1 | +6 |

Every one of the sixteen quarterbacks in my top 80 falls. Allen at my #6 goes at
21.9; Mahomes at my #57 goes at 106; Jordan Love at #77 goes at 147. KTC rates
quarterbacks like a superflex crowd and my room is 1QB, so **I can wait far
longer at QB than my board implies.** This also retroactively justifies
normalising the cliff metric by mean rather than median spacing: those QB gaps
are largely an artifact of KTC over-rating the position, so suppressing them was
right for a better reason than the one I had.

Coverage is 282 of 300; the shallowest player with no ADP is #122, and past
about pick 200 "no ADP" is the honest answer rather than a gap. Missing ADP
sorts last, which is correct — nobody is taking those players soon.

### Failing safe

ADP is **optional**. A fetch failure, or a join the validators refuse, warns and
writes the board without it; the app then falls back to projecting down my own
ordering, which is what it did before ADP existed. A stale board beats an empty
one and a board with no ADP beats no board.

The validators are data-driven rather than name-based, for the same reason the
KTC ones are:

- **Coverage of the top 120**, so a half-broken name join cannot pass. Suffixes
  are stripped — KTC writes "Marvin Harrison Jr." where Sleeper writes "Marvin
  Harrison" — which takes the raw match from 290 to 298.
- **No sentinel survives.** 999 means "not drafted", and letting it through
  would seat a player at pick 999.
- **The column must carry decimals.** Real ADP is an average. A column of whole
  numbers is a *ranking* wearing ADP's name, which is precisely what
  `search_rank` is.
- **At most two quarterbacks in the twelve earliest ADPs.** In 1QB the first
  goes around 22; a top 12 stiff with them means a superflex column.

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

## The board runs in draft order

**The baseline is ordered by ADP, not by KTC.** KTC survives as `ktcRank`, an
overlay rather than the running order.

The two sources agree closely about *talent within a position* — the top ten at
each position share 8 to 10 of the same names, differing by one- and two-spot
swaps — and disagree sharply about how to **interleave** the positions. That is
the whole reason to switch: KTC does no replacement-value adjustment, while a
market does it implicitly by pricing scarcity. Quarterbacks are the clearest
case, going about 31 spots later than KTC ranks them, because the 15th-best
quarterback scores nearly as much as the best one. Ordering by ADP therefore
keeps almost all of KTC's talent read and replaces only the part KTC is not
equipped to have an opinion about.

Three things follow, and the second is the reason this was worth doing:

- **Pick lines stop collapsing.** They count down ADP; when the list also runs
  in ADP order they land one per row instead of piling several onto the first
  player whose ADP rank happens to clear the threshold. Divergence appears only
  where I have actually dragged someone, which is exactly where it should.

  **The line is a count, not a search.** For a pick with `after` players due to
  come off the board first, it sits immediately below the `after`-th player
  *still available* — so the row underneath it is what I would expect to be
  looking at on my turn, assuming the room drafts in ADP order. `after` shrinks
  as picks are recorded, and a pick already made drops its line entirely.

  Two earlier rules both searched for the anchor by inspecting `adpRank`, and
  both collapsed every line onto one row, in mirror-image ways. Anchoring to the
  *first survivor* failed when a late-ADP player was dragged **up**, because he
  genuinely survives all my remaining picks. Anchoring to the *last casualty*
  failed when an early-ADP player was dragged **down**. The mistake was shared:
  `adpRank` is not monotonic down the board — dragging is precisely how I say I
  disagree with the market — so no anchor can be found by scanning for a
  threshold crossing.

  Counting sidesteps it. Lines land at fixed spacing, always in order, never
  stacked, and **dragging a player does not move them**, which is right: where my
  next turn falls is a fact about the draft, not about my opinion of anybody.
  Rows I cannot draft into are skipped entirely — neither counted nor used as
  the anchor. My own players stay on the board at their position, and hanging a
  line on one reads as "your next pick gets you this guy" about somebody already
  on my roster.

- **The "moved" arrow becomes the availability signal.** `↑26` now means "I rate
  him 26 spots above where the room takes him", which is the same statement as
  **he will keep** — the pick is better spent on someone the market wants
  sooner. `↓15` means wanting him at all means reaching. One number, two jobs.
- **KTC becomes a prep tool**, and a prep-*mode* one. It is shown only where it
  disagrees with draft order by more than half the board position — proportional, because thirty
  spots is enormous at #20 and nothing at #250. That marks 38 of 300 rows, and
  inside the top 60 it lands on exactly two things: every older skill player KTC
  fades (McCaffrey, Barkley, Henry, Jacobs, McLaurin, Evans — all 28 and up) and
  the quarterbacks it inflates (Allen, Maye). Those are its two systematic
  biases for a redraft league, and that is the list worth my own opinion. The
  **`KTC` filter chip** collects exactly those rows, so working through them is
  a task rather than a scroll. Both are absent in draft mode: at the table the
  board is already built, and what a trade-value market thinks is clutter on the
  one screen that is time-pressured. `MINE` is hidden in prep for the mirror
  reason, and selecting a filter whose chip then hides falls back to `ALL` so
  the board can never strand itself empty.

**What KTC still does, invisibly.** Demoting it from the running order makes it
look vestigial in the UI — one annotation on 38 rows — but it remains the
substrate. It defines the player universe (ADP is a column of 282 numbers and
knows nothing of positions, teams, byes, injuries or `RB4` labels), it anchors
the interpolation for players without an ADP, it is the deterministic sort
tiebreak, and it is the fallback ordering when the ADP fetch fails. The board is
KTC; ADP is a lens that reorders it.

### The value is noisy; the order is not

Worth knowing before trusting a printed ADP. Between two fetches hours apart,
**695 of ~9,400 values changed**, and Gibbs — the consensus number one — moved
from 1.1 to 1.6. That is not how an average over thousands of drafts behaves;
most likely it is a rolling window small enough that a few new drafts shift the
mean, though the API gives no way to confirm that.

The **ordering**, however, barely moves at all:

| across the top 150 | |
|---|---|
| mean rank change between fetches | **0.3 spots** |
| median | 0 |
| worst | 2 |
| players moving 5+ | 0 |

The top 12 came back in exactly the same sequence. So the jitter is in the
decimal, not in who goes when.

**Nothing in the app consumes the value.** `orderByAdp` sorts by it, `adpRank`
sorts by it, projections compare ranks — every consumer collapses it to an
ordering first, and it is never displayed. The one raw use is interpolating the
players who have no ADP, where half a pick is irrelevant.

This also settles whether ADP is stable enough to be the baseline, which was an
open risk when the board was re-based: 0.3 spots of drift per refresh, against
the 23-spot median move that re-basing itself produced, and against KTC's own
values which re-rank within minutes. **Untouched players will not shuffle and
placements will hold.** Do not, however, put a printed ADP on a row and imply
it is precise to a tenth.

**A player with no ADP is interpolated between his nearest KTC neighbours who
have one**, not appended. Eighteen of the 300 have none and the shallowest sits
at KTC #122; appending would bury him 160 spots down.

**Timing matters if this is ever revisited.** Sort keys are anchored to the base
ordering — `sortKey = boardRank × 1000` means "between base #8 and #9" — so
changing what the base *is* moves every existing placement. Re-basing moved the
board a median of 23 spots, with 129 players moving 25 or more. Do it before
building a board, or not at all.

## Data model

The critical structural decision: **the baseline and my personal edits are
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
- **"Moved" indicator** — how far a player sits from where the room drafts him
  (`↑12` / `↓8`), which doubles as the availability signal: a player I rate well
  above market will keep. **Only players I actually placed carry one.**
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
- **Position colour.** A dot at the head of every row, coloured by position the
  way Sleeper does it. Reading positional shape off a colour column is far
  faster than reading it off the `RB1` text, because you only have to *see* it
  rather than look at it. This is a fact about the player, so unlike everything
  else below it, it is present in prep too.

- **Projection lines.** A rule drawn across the board at each of my remaining
  picks, labelled with the pick number, marking the first player I could still
  realistically get there. My seat is two numbers — league size and slot — and
  the snake order falls out of them.

  The arithmetic is only ever counting picks: with `made` picks recorded, the
  players who come off before my pick `P` number `P - made - 1`. So **the count
  is exact and only the composition is approximate.** KTC is crowd-sourced value
  rather than ADP, so *which* players disappear is a guess — but *how many* is
  not, and if the room reaches for someone I rank low he still leaves my
  available list and the line stays where it belongs. The line is a good deal
  more trustworthy than the data behind it sounds.

  A consequence worth knowing at the table: **when the room drafts in my order,
  the lines do not move.** One fewer pick to wait and one fewer player above
  cancel exactly. A line only shifts when someone reaches — and it shifts in my
  favour, because a pick spent on a player I don't rate hands me a better one.

  Drawn with an inset shadow and an absolutely-positioned label, never a border
  or an extra list item: the drag works out where a held player lands by
  arithmetic over a uniform row pitch, so two real pixels of border on one row
  would skew every drop below it.

- **Cliff markers.** Any available player with an unusually large drop behind him
  at his own position is badged with the size of it — `⌄24` meaning twenty-four
  available players until the next TE.

  **The threshold is per-position, and has to be.** Positions are not equally
  dense: on the shipped board the median gap between consecutive WRs is 2 and
  between QBs is 4, with mean spacings of 2.4 and 6.8. A raw gap of 5 is
  therefore twice normal at WR and *below* average at QB. So a gap is divided by
  its own position's mean spacing, which needs no per-position constants and
  re-derives itself as the board empties.

  **K = 3**, measured rather than guessed. Sweeping a whole 14-team draft with
  the flags gated by the pick line: K=2 fires 21 times, K=2.5 eight, K=3 seven,
  K=3.5 five. Three gives roughly one flag every other pick — sparse enough that
  each is worth reading. Normalising by *mean* rather than median spacing is
  also deliberate: the median is more robust and fires about three times as
  often, and the case that decides it is QB, where a 15-player gap reads 3.75x
  by median and 2.2x by mean. In a 1QB league, "reach for a quarterback" is
  exactly the advice not to give.

  A position too thin to have a normal spacing never produces a cliff — three
  TEs in fifty players have a mean gap of sixteen, so even a forty-player run
  behind one is unremarkable. With a sample that small there is no such thing as
  an unusual gap and claiming one would be noise.

- **The two features are one instrument.** A cliff only matters if it falls above
  my next pick: there I cross it whatever I do, so the only way to stay on the
  good side is to draft that position now. Below the line there are still
  pre-drop players left when my turn comes round. Same gap, opposite meaning, so
  they must not look alike — urgent cliffs are inverted and loud, the rest are
  muted. Urgency is judged against the pick *after* the imminent one, since
  almost everything survives a single pick.

  This is what kills the noise. Ungated, K=2 puts a mark on a third of the top
  40; gated, the whole draft produces seven, and every turn pick produces none —
  correctly, because with three players between picks 27 and 30 nothing can be a
  cliff inside that window.

- **ADP answers "will he be there".** Projection lines and cliff urgency both
  count down *ADP* rank among available players, never my own ordering. Project
  down consensus, decide down my board. Ordinal gaps are still not linear in
  scoring — a TE cliff and a QB cliff of the same ratio are not equally worth
  acting on, and the app cannot know that.

  Because ADP rank is **not monotonic down my board**, consecutive picks can
  share a first survivor and their lines collapse onto one row. "Picks 27 and 30
  both get you this player" is a true statement rather than a rendering fault,
  but the deep end of the board piles many picks onto one row, where it stops
  being informative. Open question: draw only the next two picks.

- **The pick log becomes load-bearing.** A missed tap used to leave one stale
  row; it now shifts every line for the rest of the night, silently. So the
  header shows the pick the draft is on — one glance against the real draft
  board catches a drift that nothing else would surface.

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
no auction support, no multi-user.

**Reversed: league size and draft slot are configurable.** They were a non-goal
on the reasoning that no setting should be able to be silently wrong on draft
night. Two integers that produce visibly wrong lines the moment they are wrong
are a different proposition from a lineup configuration, and the projection
lines are worth more than the risk. They default to my actual league rather than
to something neutral — this app already hard-codes redraft and 1QB because it
has exactly one user, and lines drawn for the wrong league look identical to
lines drawn for the right one.

**No pick countdown, and this is a considered exclusion rather than a cut for
scope.** "Will he last until my next pick?" is by definition an ADP question —
it requires knowing when players come off the board, which crowd-sourced KTC
value does not encode. A countdown beside a KTC-ranked board would be worse
than absent: it presents a real number (11 picks away) with no way to estimate
who disappears during those picks, and so reads as actionable when it is not.
Pick timing is therefore coupled to ADP, and returns only if ADP does.

**The projection lines are not that countdown**, and the distinction is the
whole reason they are allowed. A countdown says "11 picks away", a real number
implying knowledge of who vanishes during them. A line makes no such claim: it
marks a boundary in a list, its position comes from counting picks rather than
from any ranking, and it is honestly approximate about which players sit above
it. What it never does is put a confident number on a question the data cannot
answer.

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
