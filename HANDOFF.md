# Handoff: signalk-ships-bells

Prepared for continuation in a Claude Code session. This document is the
single source of truth for "what exists, why, and what's left" — read this
before making changes.

## What this is

A SignalK Server plugin that plays traditional ship's bell audio (1-8 bells
on the half-hour watch schedule, plus a New Year's Eve extra strike) via a
browser webapp, server-speaker, or Mopidy sound server playback path.

- **GitHub**: `BoatHacks/signalk-ships-bells`
- **npm**: [`signalk-ships-bells`](https://www.npmjs.com/package/signalk-ships-bells)
- **Current published version**: `0.1.7`
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
itself is untouched. `utcOffsetEnabled`/`utcOffsetMinutes` ARE now read by
the webapp indirectly, via `GET /bell-times` (below) — not exposed as a
webapp control of their own, just reflected in the reference table.

**Bell schedule reference table** (`buildBellScheduleTable()`, `GET
/plugins/signalk-ships-bells/bell-times`): a 48-row table, one row per
half-hour mark, laid out like Wikipedia's Ship's bell page — same seven
traditional watches (`WATCHES`, module scope), each row's `watch`/`time`/
`bells`. Reuses `bellCountForMinutes()`/`effectiveWatchScheme()` directly
(never re-derives the schedule, so it can't drift from what actually
rings). Watch-name boundaries are `(start, end]`, not `[start, end)` —
each watch owns the half-hour marks strictly after its own nominal start
up through its own end (the "eight bells" mark that concludes it), so
midnight (`00:00`) belongs to the First Watch (closing it out from the
day before), not the Middle Watch (which starts at `00:30`). That's why
the generating loop runs raw marks `30..1440` (not `0..1410`) and looks
the watch up by the *unwrapped* mark, only wrapping mod 1440 afterward for
the displayed clock time — using the wrapped value for the watch lookup
would put midnight in the wrong watch.

When the manual UTC offset is enabled, `usesUtc: true` and each row's
`time` is a UTC clock mark rather than local wall-clock — its `bells`
value is that same mark run through the identical `(minutes + offset +
1440) % 1440` shift `effectiveMinutesSinceMidnight()` itself uses, so the
table is never a separate approximation of the schedule, just the same
computation tabulated in advance. The webapp (`app.js`) renders this with
per-watch `rowSpan` grouping (merges consecutive same-watch rows into one
cell, matching Wikipedia's own table layout), a bell count shown both as a
number and as a dot pattern (`bellPattern()`: pairs of `●●` with a
trailing lone `●` for odd counts), and highlights whichever row matches
"now" — compared in UTC or local time depending on `usesUtc`, re-checked
client-side every 60s (`highlightCurrentRow()`) without re-fetching the
table, since the row-to-bells mapping itself doesn't change minute to
minute. The table is re-fetched (not just re-highlighted) after the watch
scheme dropdown save succeeds, since that changes the bells themselves.

**Manual test button** (`POST /plugins/signalk-ships-bells/test-strike`):
deliberately bypasses *all* muting and the night-volume reduction — a manual
test should always be clearly audible. Also exercises server-speaker and/or
Mopidy and/or Alerts playback for whichever of
`playbackServerSpeaker`/`playbackMopidy`/`playbackAlerts` are on, not just
local browser playback.

**Playback outputs are four independent booleans**
(`playbackWebapp`/`playbackServerSpeaker`/`playbackMopidy`/`playbackAlerts`,
admin-config checkboxes, `playbackWebapp` defaulting `true` and the rest
`false`), not a single-select - any combination can be on at once, e.g.
webapp + Mopidy together. Replaced the old single `playbackMethod` enum
(`'webapp'`/`'server-speaker'`/`'both'`/`'mopidy'`), which couldn't express
"webapp AND mopidy" or "server-speaker AND mopidy". `migratePlaybackMethod()`
runs once at `plugin.start()`: if `playbackMethod` is present and none of the
(then-three) new keys exist yet, it derives them (`'both'` → both
`playbackWebapp` and `playbackServerSpeaker`), deletes `playbackMethod`, and
saves via `app.savePluginOptions` - so installs configured before that change
keep working without the admin re-checking anything. `playbackAlerts` was
added afterward and isn't part of this migration at all - it just defaults
`false` like any other new field on an existing install. A no-op as soon as
any new key is present (including a deliberate `false`), and a no-op for a
fresh install with no legacy field at all.

**Schema grouping** (`playbackOutputs`/`webPlayerSettings`/
`serverSpeakerSettings`/`mopidySettings`/`alertsSettings`, all nested `type:
'object'` schema properties): the admin config UI renders a nested object
property as its own titled fieldset, which is how the four playback
checkboxes above got grouped into one "Playback outputs" subsection (with a
note that detail settings are further down) and each checkbox got its own
detail subsection below it. `mopidyHost`/`mopidyPort`/`mopidyAudioBaseUrl`/
`snapcastControlPort` live under `mopidySettings`; `alertsPort`/
`alertsStreamName` live under `alertsSettings`; `snapcastHost` stays a
top-level field (not nested under either) since it's shared by both
sections' own Snapcast connections. `migratePlaybackSettingsGrouping()` runs
right after `migratePlaybackMethod()` at `plugin.start()` — same no-op-once
pattern (a no-op as soon as `options.playbackOutputs` exists, and a no-op
for a fresh install with none of the old flat keys either), so an install
still on the even-older `playbackMethod` shape migrates through both steps
in one `plugin.start()` call. Every runtime read of these fields (in
`resolveMopidyAudioBaseUrl`/`playOnMopidy`/`playOnAlerts`/`strikeBell`/the
`/test-strike` route) reads `options.playbackOutputs`/`mopidySettings`/
`alertsSettings` — never the old flat keys, which only still appear as
migration *sources* inside `migratePlaybackSettingsGrouping()` itself.

**Mopidy sound server playback** (`playbackMopidy: true`, added because a
user's `signalk-jukebox` Snapclient was holding the sound card open, starving
`play-sound`'s server-speaker path): `playOnMopidy()` drives Mopidy over its
JSON-RPC HTTP API (`core.tracklist.clear` → `core.tracklist.add` →
`core.playback.play`, one async IIFE, single `try/catch` around the whole
sequence — an earlier draft caught `core.playback.play` errors inline and
silently dropped them; don't reintroduce that). Two directions of
connectivity are involved and must not be conflated: this plugin (in the
SignalK process, on the host) calls Mopidy at `mopidyHost`/`mopidyPort`
(default `localhost:6680`); separately, Mopidy fetches the bell `.wav` back
from this plugin's own webapp at
`resolveMopidyAudioBaseUrl()`/`signalk-ships-bells/bells/<file>.wav` — that
second direction is the hard one, since a non-host-networked container can't
reach the host's own loopback, hence `mopidyAudioBaseUrl` (falls back to
`http://localhost:<app.config.settings.port>` otherwise).

**Duck/resume**: `duckForBell()` checks `core.playback.get_state()` first —
if Mopidy is `'playing'`, it captures `core.playback.get_current_tl_track()`
(for its `tlid`) and `core.playback.get_time_position()`, then calls
`core.playback.pause()` (the duck). The bell is *added* to the tracklist
(not a `tracklist.clear`, unlike the first draft of this feature — clearing
would have destroyed the track being ducked) and played via
`core.playback.play({tlid})`. After the bell's duration (read off
`tracklist.add`'s response, `track.length`, falling back to `5000`ms) plus a
500ms buffer, `unduckAfterBell()` removes the bell's `tlid` from the
tracklist via `core.tracklist.remove` and, if something was ducked, calls
`core.playback.play({tlid: original})` followed by
`core.playback.seek({time_position: originalMs})` to resume at the exact
captured position. If nothing was playing (`get_state` returns anything but
`'playing'`), `duckForBell()` returns `null` and `unduckAfterBell()` is a
no-op — the bell just plays and gets cleaned out of the tracklist
afterward, nothing to resume.

**Night-volume reduction also applies to Mopidy playback**, via
`duckVolumeForBell()`/`restoreVolumeAfterBell()`: `strikeBell()` computes
`volumeFactor` once (via `nightVolumeFactorForMoment()`, same as the webapp
path) and passes it into `playOnMopidy()`. If `volumeFactor < 1`,
`duckVolumeForBell()` reads Mopidy's current mixer level
(`core.mixer.get_volume`), scales it by the factor
(`Math.round(originalVolume * volumeFactor)`, clamped 0-100), and sets it
(`core.mixer.set_volume`) before the bell plays; `restoreVolumeAfterBell()`
sets the mixer back to the *original* level afterward (not a hardcoded
value), so a level set elsewhere (e.g. signalk-jukebox's own volume control)
survives the strike unchanged. At `volumeFactor === 1` (the common case, no
reduction active right now) neither function makes any RPC call at all -
this is why most of the existing mopidy tests didn't need updating when this
was added. The manual test button bypasses this like it bypasses muting -
`playOnMopidy(strikes, currentOptions)` is called from `/test-strike` without
a `volumeFactor` argument, which defaults to `1` inside `playOnMopidy()`.

**Alerts stream playback** (`playbackAlerts: true`, `playOnAlerts()`):
streams the bell straight into signalk-jukebox's own "Alerts" Snapcast
stream (its `ALERTS_STREAM_ID`/`ALERTS_PORT`, a standing TCP intake -
signalk-jukebox project, `container.ts`), bypassing Mopidy entirely. Added
because `playOnMopidy`'s zone muting silences the whole Snapclient, which
also silences any announcement meant for a zone taken off the jukebox
stream - added specifically to give those zones something to still hear.
Only zones currently switched to `"Alerts"` in signalk-jukebox's own webapp
actually hear it (a Snapcast group can only be assigned one stream at a
time); this plugin doesn't do any zone-switching of its own, unlike
`muteOtherZones` below - a real, scoped-out follow-up if wanted later.

The bundled bell `.wav` files are `44100:16:2` (Benboncan/Freesound's own
format); signalk-jukebox's Alerts stream is fixed at `48000:16:2` (its own
`snapserver.conf.template`) - Snapcast's `tcp server` source type doesn't
resample, confirmed by build-testing. `playOnAlerts()` spawns `ffmpeg -i
<bellFilePath> -ar 48000 -ac 2 -sample_fmt s16 -f wav -` and pipes its
stdout directly into the socket (`ffmpeg.stdout.pipe(socket)`) - no temp
file. Confirmed end-to-end against a real signalk-jukebox instance: a real
`bell-strikes-8.wav` streamed through this exact invocation played for its
full, correct 12.78s (Snapserver's own `PcmStream` state transitions,
`idle → playing → idle`, matched that duration precisely). Night-volume
reduction is applied here too via an `-af volume=<factor>` ffmpeg arg
(same 0-1 `volumeFactor` `playOnMopidy` gets, added when originally
missing entirely from this function's signature — silently no-op'd for
Alerts even though the schema description claimed otherwise), added only
when `factor < 1` to skip the filter's re-encode overhead outside the
reduced-volume window. Requires ffmpeg
installed on this machine - same kind of external-binary requirement as
server-speaker's play-sound/mpg123/aplay. No duck/resume needed here (unlike
`playOnMopidy`): the Alerts stream is entirely separate from whatever's
playing on the jukebox stream, so this never interrupts anything.

`snapcastHost` (new, shared by both `playOnMopidy`'s zone muting below and
this) replaces what used to be an implicit reuse of `mopidyHost` for the
Snapcast control connection - Mopidy and Snapserver are the same host in a
default signalk-jukebox install (this field's own default, `localhost`),
but aren't necessarily the same host in general, e.g. someone running
Snapserver on separate hardware. `alertsStreamName` (default `'Alerts'`)
has no effect on the connection itself - Snapcast identifies a `tcp server`
stream by which port you connect to, not a name sent over the wire - it's
purely for this plugin's own log messages if the admin ever renames or
rebuilds their own Alerts-equivalent stream.

**Per-zone targeting** (`mopidyZoneIds`, `GET`/`PUT
.../mopidy-zones`): Mopidy has one shared stream reaching every Snapcast
zone equally, so "play in zone A only" means muting every *other* zone via
Snapserver's own raw-TCP JSON-RPC control API (`snapserverCall()` —
newline-delimited over `net.createConnection`, NOT HTTP, same protocol as
signalk-jukebox's own `snapserver-client.ts`) at `snapcastHost`/
`snapcastControlPort` (default `1705`), then restoring each excluded zone's
own prior mute state
afterward (`muteOtherZones`/`restoreZones` snapshot `wasMuted` per client
before touching it, so a zone already muted by the admin stays muted). The
restore is scheduled via `setTimeout(..., durationMs + 500)`, `durationMs`
read directly off `core.tracklist.add`'s response
(`added[0].track.length`), falling back to `5000` if absent. This can't be a
static admin-config checkbox list because the zone list is dynamic (fetched
live from signalk-jukebox), so it lives in the webapp instead
(`GET /plugins/signalk-jukebox/api/zones` proxied through this plugin's own
`GET /zones` route to avoid a cross-origin fetch from the browser) — an
explicit choice, made after confirming the admin schema (RJSF-based) can't
render options populated from a live API call, same limitation that forced
signalk-jukebox's own config panel into a custom React UI earlier.

**Notification shape**: strikes are broadcast as a delta on
`notifications.plugins.signalkShipsBell.strike`, with `value.data = { strikes,
file, volumeFactor }`. `value.method` is explicitly set to `[]` — signalk-server
was defaulting it to include `"sound"`, which wasn't wanted.

**REST API** (`plugin.registerWithRouter`): `GET`/`PUT
/plugins/signalk-ships-bells/schedule` (read/write `watchScheme` from the
webapp, not just the admin config UI), `GET`/`PUT .../offset` (read/write
`utcOffsetEnabled`/`utcOffsetMinutes`; PUT supports partial updates — either
field or both; not used by the webapp, for external tooling), `POST
.../test-strike` (see above), `GET .../zones` (proxies signalk-jukebox's own
zone list for the webapp), `GET`/`PUT .../mopidy-zones` (read/write
`mopidyZoneIds`, the webapp's per-zone checkbox selection), and `GET
.../bell-times` (the reference table, see "Bell schedule reference table"
above).

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

`npm test` runs `node --test test/*.test.js`. Currently **64 tests**. Covers:
bell-count math for both schemes, quiet-hours/night-volume time-range math
(including midnight wraparound and invalid-input handling), the manual UTC
offset (`effectiveMinutesSinceMidnight`, `effectiveWatchScheme`), New Year's
trigger-time calculation (including year rollover and the long-delay
chunking), plugin lifecycle (start/stop/restart), schema consistency
(enum/enumNames stay in sync, defaults are valid), the `/schedule`, `/offset`,
and `/test-strike` REST endpoints, a mocked-timer end-to-end regression test
for the New Year's transition, the mopidy playback method (RPC call order,
`mopidyHost`/`mopidyPort`/`mopidyAudioBaseUrl` resolution including the
`app.config.settings.port` fallback, an RPC failure logged via `app.error`
rather than thrown, and the duck/resume sequence when something was already
playing — using the `_setFetchForTesting` and `_setSnapConnectForTesting`
hooks, mirroring the pre-existing `_setAudioPlayerForTesting`),
`migratePlaybackMethod()` for all four legacy `playbackMethod` values plus
the fresh-install no-op case, that `playbackWebapp`+`playbackMopidy` can both
fire from one strike, and that Mopidy's mixer volume is ducked/restored
during the configured night-volume-reduction hours. Also covers Alerts
playback (`_setSpawnForTesting`/`_setAlertsConnectForTesting`): the ffmpeg
resampling args and the bytes piped into the Alerts connection, configured
`snapcastHost`/`alertsPort`, a failed ffmpeg spawn logged via `app.error`
rather than thrown, and (added when the gap was found — `playOnAlerts`
wasn't receiving `volumeFactor` at all, so night-volume reduction silently
did nothing for Alerts playback even though its own schema description
claimed it applied everywhere but server-speaker) that an `-af
volume=<factor>` ffmpeg arg appears during the reduced-volume window and
is absent outside it; and that `snapcastHost` (not `mopidyHost`)
is what `muteOtherZones` actually connects to, using a fake
`net.createConnection`-shaped socket (`makeFakeSnapSocket()`) that answers
`Server.GetStatus`/`Client.SetVolume` over the same raw newline-JSON wire
format the real code speaks.

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
- Per-zone Mopidy selection as an admin-config checkbox list — the zone list
  is fetched live from signalk-jukebox and can't be rendered by the static
  RJSF admin schema; it belongs in the webapp (`public/`), as implemented.
