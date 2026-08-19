# Handoff: signalk-ships-bells

Prepared for continuation in a Claude Code session. This document is the
single source of truth for "what exists, why, and what's left" — read this
before making changes.

## What this is

A SignalK Server plugin that plays traditional ship's bell audio (1-8 bells
on the half-hour watch schedule, plus a New Year's Eve extra strike) with
both a browser webapp and server-speaker playback path.

- **GitHub**: `BoatHacks/signalk-ships-bells`
- **npm**: [`signalk-ships-bells`](https://www.npmjs.com/package/signalk-ships-bells)
- **Current published version**: `0.1.6`
- **License**: MIT (code) + CC BY 4.0 (bundled bell audio) — see `LICENSE`

## Repo layout

```
index.js                    Plugin logic: scheduling, muting, volume, REST API
public/index.html           Webapp UI (navy/gold theme matching public/icons/icon.png)
public/app.js               Webapp client: websocket subscription, audio playback, controls
public/bells/*.wav          Bell audio, 1-8 strikes (CC BY 4.0, Benboncan/Freesound)
public/bells/NOTICE.md      Audio attribution
public/icons/               Project icon (user-supplied artwork)
test/plugin.test.js         Plugin lifecycle, REST endpoints, mocked-timer scheduling tests
test/bell-schedule.test.js  Pure bell-math/time-range function tests
.github/workflows/ci.yml    Calls the reusable SignalK plugin-ci.yml workflow
README.md                   User-facing docs — kept in sync with every feature
```

`index.js` is ~500 lines, `public/app.js` is ~200 lines. Both are single files,
no build step (plain CommonJS / vanilla JS + inline CSS).

## Architecture / key design decisions

**Bell-count math** (`bellCountForMinutes`, module-scope, pure, exported for
tests): two selectable `watchScheme` values, `traditional` and `simple-cycle`.
They're identical except in the second dog watch (18:00-20:00) — traditional
resets to 1 bell (post-Nore-mutiny convention), simple-cycle just keeps
cycling. A third option, `pre-1797`, was removed because it was mathematically
identical to `simple-cycle` (see git history / README for the reasoning).

**Scheduling**: a single self-rescheduling `setTimeout` loop
(`scheduleNextStrike`) aligned to each half-hour boundary — deliberately NOT
`setInterval`, to avoid drift. A **separate, independent** self-rescheduling
loop (`scheduleNextNewYearExtraStrike`) fires one extra 8-bell strike at
23:59:47 on Dec 31 (13s before midnight, chosen because `bell-strikes-8.wav`
is ~12.78s long, so it finishes right around the stroke of midnight). This
gives the traditional 16-bells-at-New-Year's effect using the *existing*
8-bell file and the *regular* 00:00:00 strike (which already rings 8 on every
scheme) — no dedicated 16-bell audio file or schedule override needed. An
earlier, more complex version (a dedicated `bell-strikes-16.wav` + boundary
override) was tried and deliberately simplified away; don't reintroduce it
without a reason.

**IMPORTANT gotcha already hit once**: `setTimeout` has a hard ~24.8 day
limit (2^31-1 ms, 32-bit signed int internally in Node/V8). The New Year's
extra-strike scheduler waits up to ~365 days between firings, which overflows
that limit and would fire almost immediately instead of waiting a year. Fixed
via `scheduleLongTimeout()`, which chunks long delays into safe 20-day hops.
**If you add any other long-delay scheduling, use `scheduleLongTimeout`, not
a raw `setTimeout`.**

**Muting**: two independent, combinable mute conditions, checked in
`isMuted(options)`:
1. `muteWhenAnchoredOrMoored` — checks `navigation.state` via
   `app.streambundle.getSelfStream('navigation.state')`. Depends on something
   populating that path (README recommends `signalk-autostate`).
2. `quietHoursEnabled` + `quietHoursStart`/`quietHoursEnd` — a `HH:MM` time
   range via `isWithinQuietHours()`, which correctly handles ranges that span
   midnight (e.g. `22:00`-`06:00`).

**Night-volume reduction** (separate from muting): `nightVolumeEnabled` +
start/end + `nightVolumeLevel` (%). Reuses `isWithinQuietHours` for the range
check. The server computes a `volumeFactor` (0-1) per strike and sends it in
the webapp notification's `data`; the webapp multiplies it against the user's
own volume slider. **Only affects webapp playback** — `play-sound` (used for
server-speaker output) has no portable cross-platform volume control, so
server-speaker strikes always play at full volume. This limitation is
documented in the config schema description and the README; don't let anyone
assume it's a bug.

**Manual UTC offset**: `utcOffsetEnabled` + `utcOffsetMinutes` (0-240, admin
config UI only, not exposed via the webapp or `/schedule` REST endpoint).
When enabled, `effectiveMinutesSinceMidnight()` computes minutes-since-midnight
from UTC (`date.getUTCHours/getUTCMinutes`) plus the offset, instead of local
wall-clock time — deliberately independent of the server's own
timezone/DST. `msUntilNextHalfHourBoundary()` shifts its "now" by the offset
(in UTC) too, so the self-rescheduling timer still lands on the correct
half-hour boundary of the *offset* clock, not the local one. `watchScheme` is
forced to `simple-cycle` via `effectiveWatchScheme()` whenever the offset is
enabled — the `traditional` scheme's dog-watch reset is tied to real
second-dog-watch clock time, which an arbitrary offset would no longer line
up with. This is a runtime override only; the stored `watchScheme` option
itself is untouched.

**Manual test button** (`POST /plugins/signalk-ships-bells/test-strike`):
deliberately bypasses *all* muting and the night-volume reduction — a manual
test should always be clearly audible. Also exercises whichever
`playbackMethod` is actually configured (webapp and/or server-speaker), not
just local browser playback.

**Notification shape**: strikes are broadcast as a delta on
`notifications.plugins.signalkShipsBell.strike`, with `value.data = { strikes,
file, volumeFactor }`. `value.method` is explicitly set to `[]` — signalk-server
was defaulting it to include `"sound"`, which wasn't wanted.

**REST API** (`plugin.registerWithRouter`): `GET`/`PUT
/plugins/signalk-ships-bells/schedule` (read/write `watchScheme` from the
webapp, not just the admin config UI), `GET`/`PUT .../offset` (read/write
`utcOffsetEnabled`/`utcOffsetMinutes`; PUT supports partial updates — either
field or both; not used by the webapp, for external tooling), and `POST
.../test-strike` (see above).

**Testing quirks worth knowing** (both discovered the hard way):
- `play-sound` will find and use *real* system audio players (this sandbox
  has `ffplay`, which hangs indefinitely with no audio device). Tests must
  never invoke real `play-sound` — use `plugin._setAudioPlayerForTesting()`,
  a test-only hook that injects a fake player.
- Node's `node:test` mock timers (`t.mock.timers.enable({ apis: ['setTimeout',
  'Date'] })`) are experimental and, when a `tick()` call advances further
  than a pending timer's exact scheduled instant, `Date.now()` during that
  timer's callback reflects the **full tick target**, not the timer's own
  scheduled time. Tests that assert on exact fire timestamps must tick by
  *exact* amounts to land precisely on the expected instant, not
  approximate/overshooting amounts, or assertions will be off by the
  overshoot.

## Test suite

`npm test` runs `node --test test/*.test.js`. Currently **42 tests**. Covers:
bell-count math for both schemes, quiet-hours/night-volume time-range math
(including midnight wraparound and invalid-input handling), the manual UTC
offset (`effectiveMinutesSinceMidnight`, `effectiveWatchScheme`), New Year's
trigger-time calculation (including year rollover and the long-delay
chunking), plugin lifecycle (start/stop/restart), schema consistency
(enum/enumNames stay in sync, defaults are valid), the `/schedule`, `/offset`,
and `/test-strike` REST endpoints, and a mocked-timer end-to-end regression
test for the New Year's transition.

**Known flaky test**: "New Year's Eve gets an extra 8-bell strike..." in
`test/plugin.test.js` fails intermittently depending on the date the suite is
run — pre-existing, reproduces on a clean `main` checkout too, unrelated to
the UTC-offset feature. Not investigated as part of this change.

## Release process (established pattern, repeat exactly)

1. `npm version patch --no-git-tag-version` (bumps `package.json` only)
2. `git add -A && git commit -m "Bump version to X.Y.Z" && git push`
3. `git tag -a vX.Y.Z -m "vX.Y.Z" && git push origin vX.Y.Z`
4. `gh release create vX.Y.Z --repo BoatHacks/signalk-ships-bells --title "vX.Y.Z" --notes "..."`
5. `npm publish` (requires an npm auth token — see below)

**Auth**: Neither GitHub nor npm credentials carry over from this session.
The person (Tobias, GitHub handle `humppafreak`) will need to either:
- Provide a fresh npm access token when asked to publish (never store it in
  any file that gets committed; use it only for the immediate `npm publish`
  call, then remove it), or
- Do the `gh auth login` / `npm login` themselves in the new environment.

Previously, GitHub auth was done via device flow (visit
`github.com/login/device`, enter a code) since no browser was available in
this sandbox — that may or may not be necessary in whatever environment picks
this up; use whatever auth method fits (if a browser is available, normal
`gh auth login` / `npm login` is simpler than reimplementing device flow by
hand).

## Open items

- **GitHub issue #1** (`enhancement`/`feature`, open): "Adjust bell schedule
  to actual watches via signalk-watch-schedule integration." Blocked — a
  comment on the issue explains that no `signalk-watch-schedule` package
  could be found published on npm as of this writing. Needs Tobias to either
  point at the actual package/repo, or confirm this should be designed from
  scratch. **Don't start implementing this without that clarification** —
  guessing at an integration against an unconfirmed API was explicitly
  avoided earlier.
- No other open issues as of this writing (issues #2 and #3 are closed,
  resolved in earlier commits — see git log / closed issue history for
  context if needed).
- App Store visibility: earlier in this project's history, the package
  didn't immediately show up in the SignalK admin UI's App Store after first
  publishing — this was npm's search-index lag (registry vs. search index
  update asynchronously), not a real problem, and resolved on its own within
  hours. Worth knowing if it comes up again after a version bump.

## Things NOT to reintroduce

- The dedicated `bell-strikes-16.wav` / `strikesForMoment` /
  `isNewYearMidnight` override approach for New Year's — deliberately
  replaced with the simpler independent extra-strike approach described
  above.
- The `pre-1797` watch scheme option — removed as a redundant duplicate of
  `simple-cycle`.
- Raw `setTimeout` for anything that might need to wait longer than ~24 days
  — use `scheduleLongTimeout`.
