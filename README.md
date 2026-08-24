# fantasy-drafter

A board for running my fantasy draft. See [SPEC.md](SPEC.md) for what it is and
why it is built this way.

**Live: https://baleeds.github.io/fantasy-drafter/**

Right now that URL serves the *drag prototype* — step 2 of the build order — not
the app. It is the 300-player list and the reorder gesture and nothing else,
deployed so the interaction can be judged on a real phone before the rest of the
draft UI is built on top of it.

```sh
npm run dev           # local dev server
npm run preview -- --host   # serve the built site on the LAN, for phone testing
npm run typecheck
npm run build
```

Every push to the default branch deploys.

> **One-time setup:** Pages must be enabled on the repository with its source set
> to **GitHub Actions** (Settings → Pages → Build and deployment). The workflow
> cannot do this for itself — `GITHUB_TOKEN` can deploy to an existing Pages
> site but not create one, so `enablement: true` fails with "Resource not
> accessible by integration".

## Testing the drag

`src/drag.ts` is the highest-risk piece of UI in the app. The reasoning behind
its shape is commented at the top of that file — the short version is that it
uses raw touch events rather than Pointer Events, because only those let a
handler stop the page scrolling out from under a held row.

```sh
npm run build && npm run test:drag
```

That pins the four behaviours that break silently, the important one being that
an ordinary swipe still scrolls rather than picking up a row. It is deliberately
not in CI: the browser download would slow every deploy. Run it after touching
`src/drag.ts`.

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
