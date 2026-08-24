# fantasy-drafter

A board for running my fantasy draft. See [SPEC.md](SPEC.md) for what it is and
why it is built this way.

**Live: https://baleeds.github.io/fantasy-drafter/**

Two modes over one list. **Prep** is where the board gets built — long-press to
drag a player, tap to open his sheet for notes, a do-not-draft flag, and
single-spot nudges. **Draft** is the screen for the night — tap takes a player
off the board, the **ME** button marks him mine, and undo is unlimited.

```sh
npm run dev                 # local dev server
npm run preview -- --host   # serve the built site on the LAN, for phone testing
npm run typecheck
npm run test                # model and pipeline
npm run build
```

Every push to the default branch deploys.

> **One-time setup:** Pages must be enabled on the repository with its source set
> to **GitHub Actions** (Settings → Pages → Build and deployment). The workflow
> cannot do this for itself — `GITHUB_TOKEN` can deploy to an existing Pages
> site but not create one, so `enablement: true` fails with "Resource not
> accessible by integration".

## How it is put together

| File | What lives there |
|---|---|
| `src/model.ts` | The board. Ordering, flags, and the pick log. No DOM. |
| `src/store.ts` | localStorage for the personal layer, separate from the KTC baseline. |
| `src/board-view.ts` | Renders and reconciles the list in place. |
| `src/drag.ts` | The long-press drag gesture. |
| `src/main.ts` | Modes, filters, search, the sheet, wiring. |

Two rules the code depends on and will not tell you about at runtime:

- **Every row is exactly one height.** The drag works out where a held player
  will land by arithmetic, not by hit-testing 300 elements, so anything that
  makes one row taller silently skews every drop. `test/app-check.mjs` asserts
  it.
- **The baseline and the personal layer never merge.** `players.json` is
  replaced wholesale on every refresh; my ordering, flags, and notes live apart
  and are keyed by KTC's `playerID`. Flattening them would mean each refresh
  destroyed the prep work.

## Not losing the board

`localStorage` is not durable enough on its own for something built weeks
before it is used: Safari deletes all script-writable storage for a site after
7 days of browser use without interaction, which is exactly the gap between
prepping in August and drafting in September.

So **the address bar always holds the board.** Ordering and do-not-draft flags
encode into the URL hash on every change, so a bookmark survives a storage
wipe with nothing to remember to do. A realistic board is a few hundred
characters; every player moved is still comfortably inside any browser's
limit. The hash is never sent to the server.

Notes are deliberately left out of the link — free text of unbounded length,
and the cheapest thing to lose. They stay in `localStorage` and travel in the
file export, which is the way to move a whole board between laptop and phone.

Opening a link on a device with **no** stored board restores it silently; that
is the recovery case. Opening one on a device that already has a *different*
board asks first, so an old bookmark cannot quietly overwrite newer work.

## Testing

```sh
npm run test                       # model and pipeline — fast, in CI
npm run build && npm run test:app  # the board in a real browser
npm run build && npm run test:drag # the drag gesture
```

The two browser checks are deliberately out of CI: the browser download would
slow every deploy. Run them after touching `src/drag.ts` or the board.

They exist for the failures that are silent rather than loud — an ordinary
swipe that stops scrolling and starts dragging instead, a `hidden` panel that
still swallows taps, a row tap that does nothing because the click was
attributed to a zero-distance drag. Every one of those shipped at some point
during the build and was caught here rather than at the table.

## The rankings pipeline

`public/players.json` is the KeepTradeCut redraft board, fetched at build time
and committed. The browser cannot fetch KTC directly — no CORS header — and
committing the result means the app loads instantly and works with no internet
at the draft venue.

```sh
npm test              # transform + validation tests, against a committed fixture
npm run refresh       # fetch KTC, validate, write public/players.json
npm run refresh:dry   # fetch and validate, write nothing
```

A [GitHub Action](.github/workflows/refresh-rankings.yml) runs the refresh daily
through July–September, and on manual dispatch for the morning of the draft. It
commits `players.json` only when the player data actually changed, so
`generatedAt` means "the rankings last moved on this date" rather than "a job ran
today". A successful refresh triggers a deploy, since a push made with
`GITHUB_TOKEN` deliberately does not trigger workflows on its own.

Useful flags:

```sh
node scripts/fetch-rankings.mjs --from-file page.html   # work offline from a saved page
node scripts/fetch-rankings.mjs --only-if-changed       # skip a timestamp-only rewrite
```

### If a refresh fails

The pipeline validates before it writes, and `players.json` is left untouched on
failure. A stale board beats an empty one, and this must not be able to break the
app during draft week.

Two validation failures are worth recognising on sight:

- **"N players share one ktcRank"** or **"only N rookies in the top 100"** — the
  pipeline is reading `startSitOverallRank` instead of `rank`. Those fields sit
  side by side in the same object and produce a plausible-looking but badly wrong
  board. This has happened once already; see "Use `rank`, not
  `startSitOverallRank`" in the spec.
- **"playersArray not found"** — KTC changed their markup. The rankings are
  embedded in the page as `var playersArray = [...]`; the extractor regex needs
  updating.
