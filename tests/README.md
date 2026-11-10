# kiirtest tests

Zero npm dependencies, Node built-in runner (written on Node 24; needs >= 20 for `mock.timers` Date and
`String.prototype.isWellFormed`). Fully offline: `fetch` is replaced by a mock that **throws** on any host it does
not know, every secret is a dummy, every URL is on a reserved `*.test` host. Nothing in `api/`, the HTML files,
`vercel.json` or `CLAUDE.md` is modified.

## Run

```
node --test                        # from the repo root: discovers tests/*.test.mjs
node --test tests/*.test.mjs       # same, explicit
STRICT=1 node --test               # known bugs become hard FAILURES (to see the real fail count)
node --test tests/05-report-contract.test.mjs   # one file
```

`node --test tests/` (a bare directory) does **not** work on Node >= 22 - the runner treats `tests` as a module path
and reports one failed test. Use one of the commands above.

Current result (2026-11-10, master 5d76c15): `383 tests, 251 pass, 0 fail, 132 todo` (default);
with `STRICT=1`: `251 pass, 132 fail`. The 132 are **known bugs**, see below.

## How "known bugs" work

Tests written with `bug('F-XXX', 'desired behaviour', fn)` state what SHOULD happen. They fail today. By default
`bug()` registers them as `todo` (shown with a warning sign, exit code stays 0, so the suite is usable as a
regression guard now). When a bug is fixed its test starts passing - switch `bug(` to `test(` to lock it in.
Each id maps to a finding in the audit (`audit-code.md`). A failing plain `test(` is a regression or a harness
problem, never a known bug.

## How the api files are imported without editing them

`api/*.js` use ESM `export default` but `package.json` has no `"type":"module"`, and `draw-entry.js` is CommonJS.
`helpers/load-api.mjs` copies the untouched source to `tests/.tmp/<name>.<pid>.<n>.mjs|cjs` (git-ignored, deleted
on exit) and imports the copy. A fresh copy per test = fresh module state, which matters because the files read
`process.env` at import time. `conversion-health.js` has its single `./booking-completed.js` import re-pointed at the
copied sibling. Before every load all env names used by `api/` are wiped, then dummy values applied.

The quiz scripts of `index.html`/`en.html`/`ru.html` are run in `node:vm` against a small DOM stub
(`helpers/quiz.mjs`), so routing, link building and outgoing payloads are the production code.

## Files

| File | Guards |
|---|---|
| `01-eligibility` | `computeRoute()` identical in 3 files; age 17/18/45/46, -9/-9.25 D, hyperopia, presbyopia, no glasses, "don't know", "for my child"; numeric grid vs the written rule; server `mapAgeBand`/`deriveGroupHint`/qualification vs quiz for every answer combination in ET/EN/RU |
| `02-event-sink-contract` | which sinks (Slack x2, internal mail, customer mail, CRM, Brevo) each of the 13 event types writes to; what happens when each sink returns 500 / drops / hangs; CRM quiet4xx; alert rate limit (839c168) can only suppress ops alerts |
| `03-test-payload-suppression` | `isTestPayload()` markers drop silently with zero side effects; near-miss real patients are kept |
| `04-slack-limits` | every Slack payload valid (blocks, header 150, section 3000, 10 fields x 2000, no lone surrogates) for worst-case input; LP branches bypass the sanitizer |
| `05-report-contract` | every subject track.js / booking-completed.js emit -> which `analytics-report` counter it lands in (would have caught the 2026-09-15 blind counter); >100-email truncation; Tallinn day boundary; auth |
| `06-static-html` | inline scripts parse, same answers/RESULTS/BOOKING in 3 languages, codes/prices, booking URL params for every route x language, lead-id reuse, attribution capture, copy rules (forbidden words, ё, Таллинн, EN superlatives), lawyer questions, tracking/consent, repo hygiene |
| `07-escaping` | HTML/mrkdwn/CRLF injection into internal mail, Slack, subjects and the customer mail |
| `08-endpoints-security` | abuse (mail bombing, flooding, size), malformed bodies, booking-completed auth/idempotency, conversion-health auth, intake-flow3, draw-entry GDPR |

## Known-bug ids (all `todo`)

Lead loss: `F-LOSS-*` (12 events, silent sink failure), `F-VANISH-*`, `F-CRM-COVER`, `F-CRM-QUIET4XX`, `F-CRM-NOKEY`,
`F-CRM-PHONE`, `F-ENV-*`, `F-TIMEOUT`, `F-ORDER-*`, `F-INTAKE-NOKEY`, `F-CB-SILENT`, `F-GATE-SILENT`, `F-LP-*`.
Eligibility: `F-ELIG-1/2/4`. Abuse/security: `F-ABUSE-*`, `F-PHISH*`, `F-ESC-*`, `F-AUTH-*`, `F-INTAKE-*`, `F-DRAW-*`,
`F-ROBUST-*`. Reporting: `F-REPORT-*`. Attribution: `F-ATTR-*`, `F-MAIL-*`, `F-LANG-LINKS`. Copy/compliance:
`F-COPY-*`, `F-PRICE-*`, `F-DUR`, `LAWYER-Q1..6`, `F-CONSENT-1`. Hygiene: `F-PUBLIC-MIRROR`, `F-DOC-1`, `F-SEO-1`, `F-RESTART-BTN`.

## Adding an event type to track.js

1. Add a payload to `EVENT_PAYLOADS` in `helpers/harness.mjs` and its sink row to `CONTRACT` in `02`.
2. Add its ledger subject to `CONTRACT` in `05`. The "ghost detector" fails if a new subject increments no report
   counter and is not on the explicit allow-list.
