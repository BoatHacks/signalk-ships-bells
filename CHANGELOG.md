# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [0.1.13] - 2026-08-24

### Fixed

- Night-volume reduction now applies to Alerts stream playback too — it
  previously only affected webapp and Mopidy playback; `playOnAlerts()`
  didn't even accept a `volumeFactor` argument, so Alerts always played at
  full volume regardless of the setting, contradicting its own schema
  description. Scaled into the ffmpeg resample via a `-af volume=<factor>`
  arg.

### Added

- A "Bell schedule reference" table in the webapp, laid out like
  [Wikipedia's Ship's bell page](https://en.wikipedia.org/wiki/Ship%27s_bell):
  the seven traditional watches, all 48 half-hour marks, bell count per
  mark (shown as a number and a dot pattern). Backed by a new `GET
  /bell-times` route (`buildBellScheduleTable()`), reusing the real
  schedule functions directly. Reflects the current watch scheme and, when
  the manual UTC offset is enabled, the offset itself — row times become
  UTC clock marks with bell counts shifted to match. The current
  half-hour's row is highlighted, refreshed client-side every minute.
  Rows within the configured quiet-hours range show strikethrough text;
  rows within the night-volume-reduction range show subdued text (muted
  wins if both overlap a row).

## [0.1.12] - 2026-08-24

### Changed

- Grouped the four "play on X" checkboxes together under one "Playback
  outputs" heading in the admin config UI, with a note that each one's
  detail settings are further down. Each checkbox now has its own
  settings subsection (web player, server speaker, Mopidy sound server,
  Alerts stream) instead of one long flat field list. `snapcastHost`
  stays a top-level field since it's shared by the Mopidy and Alerts
  subsections' own Snapcast connections.
- Existing installs migrate automatically on next start — no need to
  re-check or re-enter anything.

## [0.1.11] - 2026-08-23

### Added

- A fourth playback method, **Play via Alerts stream**: streams the bell
  directly into signalk-jukebox's own "Alerts" Snapcast stream instead of
  through Mopidy at all. Only zones currently switched to "Alerts" in
  signalk-jukebox's own webapp hear it; unlike Mopidy playback, this never
  interrupts anything, since the Alerts stream is entirely separate from
  whatever's playing on the jukebox stream.
- Resamples the bundled 44.1kHz bell files to the Alerts stream's fixed
  48kHz format via ffmpeg (required on this machine), piped directly into
  the connection. Confirmed end-to-end against a real signalk-jukebox
  instance that a real bell strike plays for its full, correct length
  this way.
- New/changed config fields: `playbackAlerts`, `alertsPort`,
  `alertsStreamName`, and a new shared `snapcastHost` (replacing an
  implicit reuse of `mopidyHost` for the Snapcast control connection used
  by the existing per-zone muting feature) — set it separately if
  Snapserver runs on different hardware than Mopidy.

## [0.1.10] - 2026-08-23

### Changed

- Playback method is now three independent checkboxes — **Play in web
  player**, **Play on server (local speaker)**, **Play via Mopidy sound
  server** — instead of a single-select, so any combination can be
  enabled at once (e.g. web player + Mopidy together). Existing installs
  migrate automatically the first time the plugin starts; nothing to
  re-check.
- Night-volume reduction now applies to Mopidy playback too: Mopidy's own
  mixer volume is lowered for the strike (scaled the same way the
  webapp's own volume is) and restored to whatever it was afterward.

## [0.1.9] - 2026-08-23

### Fixed

- Mopidy sound server playback now ducks and resumes properly: instead of
  clearing Mopidy's tracklist and replacing it with the bell (destroying
  whatever was playing), it pauses the current track for the strike's
  duration and resumes it at the exact position afterward. If nothing was
  playing, the bell just plays as before.

## [0.1.8] - 2026-08-23

### Added

- A "Mopidy sound server" playback method, for setups where another
  consumer (e.g. signalk-jukebox's Snapclient) already holds the sound
  card open and blocks the existing server-speaker playback path. Sends
  the bell audio through a configurable Mopidy JSON-RPC instance
  (defaulting to `localhost:6680`) instead of shelling out to a local
  player. New config fields: `mopidyHost`, `mopidyPort`,
  `mopidyAudioBaseUrl`, `snapcastControlPort`.
- Optional per-zone targeting: the webapp now shows a live checkbox list
  of Snapcast zones (fetched from signalk-jukebox); selecting one or more
  mutes every other zone for the strike's duration via the Snapserver
  control API, then restores each zone's own prior mute state.
- New REST endpoints: `GET /plugins/signalk-ships-bells/zones`, `GET`/
  `PUT /plugins/signalk-ships-bells/mopidy-zones`.

## [0.1.7] - 2026-08-19

### Added

- Manual UTC time offset for the watch-bell schedule (0-240 minutes),
  admin config UI only. When enabled, forces the watch scheme to Standard
  (simple-cycle), since the British Navy dog-watch reset is tied to real
  second-dog-watch clock time.
- `GET`/`PUT /plugins/signalk-ships-bells/offset` REST endpoint to
  read/write the UTC offset from external tooling, without going through
  the admin config UI. Supports partial updates.

## [0.1.6] - 2026-07-22

### Fixed

- The strike notification no longer implicitly gets a "sound" method flag
  — `method` is now explicitly set to an empty array.

## [0.1.5] - 2026-07-17

### Added

- Optional volume reduction during a time range ("reduce volume overnight"
  without muting entirely). New config: `nightVolumeEnabled`,
  `nightVolumeStart`, `nightVolumeEnd`, `nightVolumeLevel`. Applies to
  webapp playback only at this point — server-speaker playback via
  `play-sound` has no portable way to control output volume.

## [0.1.4] - 2026-07-17

### Added

- The traditional New Year's midnight bells: an extra 8-bell strike at
  23:59:47 on Dec 31, ship-local time, on top of the regular schedule's
  own 8-bell strike at 00:00:00.

### Changed

- Removed the redundant "pre-1797" schedule option (produced identical
  strikes to "Standard"/simple-cycle).

### Fixed

- A `setTimeout` overflow bug (delays over ~24.8 days silently fire
  almost immediately due to Node's 32-bit internal limit) that would have
  affected the yearly New Year's rescheduling; long delays are now
  chunked into safe hops.

## [0.1.3] - 2026-07-17

### Added

- A configurable time-range mute ("quiet hours"), e.g. 22:00-06:00,
  correctly spanning midnight. Independent of, and combinable with, the
  existing anchor/moored mute. New config options: `quietHoursEnabled`,
  `quietHoursStart`, `quietHoursEnd` (closes #3).

## [0.1.2] - 2026-07-16

### Added

- The webapp's "play test bell" button now also exercises server-speaker
  playback when the configured playback method is "server speaker" or
  "both" (previously it only played locally in the browser), via a new
  `POST /plugins/signalk-ships-bells/test-strike` endpoint. The manual
  test intentionally ignores the anchor/moored mute setting.

### Fixed

- A test-suite bug where testing server-speaker playback could hang on
  machines with certain audio players installed (e.g. ffplay), by adding
  a test-only injectable audio player hook.

## [0.1.1] - 2026-07-16

### Changed

- Renamed schedule labels for clarity: "Simple cycle" → "Standard",
  "Traditional" → "British Navy" (underlying stored values unchanged, so
  existing configs are unaffected).

## [0.1.0] - 2026-07-16

Initial release.

### Added

- Watch-bell scheduling: three selectable schemes (traditional,
  simple-cycle, pre-1797), configurable in the admin UI or via the
  webapp.
- Playback via a companion webapp (with volume/mute controls) and/or
  directly on the Signal K host via a system audio player.
- Mute automatically when at anchor or moored (via `navigation.state`).
