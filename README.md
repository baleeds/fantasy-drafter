# fantasy-drafter

A board for running my fantasy draft. See [SPEC.md](SPEC.md) for what it is and
why it is built this way.

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
through July–September, and on manual dispatch for the morning of the draft.

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
