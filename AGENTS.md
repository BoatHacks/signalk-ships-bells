@no-slop.md

# signalk-ships-bells

SignalK plugin playing traditional ship's bell audio on the watch schedule
(1-8 bells every half hour), with a companion webapp for playback. Repo:
BoatHacks/signalk-ships-bells (renamed from the singular
"signalk-ships-bell").

## Features
- Three selectable watch-bell schemes: traditional (post-1797, resets to 1
  bell at second dog watch), simple-cycle (ignores the dog-watch split),
  pre-1797 (continues 5-6-7 through second dog watch).
- Admin UI config: enable toggle, watch scheme dropdown, "mute bell when at
  anchor or moored" checkbox (depends on `navigation.state`).
- Bundled bell audio (`bell-strikes-1.wav` through `bell-strikes-8.wav`) from
  Benboncan's "Bells / Gongs" Freesound pack, CC BY 4.0, in `public/bells/`
  with attribution `NOTICE.md`.
- Playback via a companion webapp (`public/index.html` + `app.js`) connecting
  to the SignalK websocket, subscribing to a strike notification, playing the
  matching audio file; volume slider and mute toggle persisted in
  localStorage.
- Four independent playback checkboxes (`playbackWebapp`,
  `playbackServerSpeaker`, `playbackMopidy`, `playbackAlerts` - any
  combination): server speaker shells out via `play-sound`; mopidy sends the
  bell through a configurable Mopidy JSON-RPC instance instead (for when
  something else, e.g. signalk-jukebox's Snapclient, already holds the sound
  card open), ducking/resuming whatever Mopidy was already playing and
  applying the night-volume reduction to its mixer too, with an optional
  per-zone selection (checkboxes in the webapp, muting other Snapcast zones
  for the strike via the Snapserver control API); alerts streams the bell
  (resampled via ffmpeg) directly into signalk-jukebox's own "Alerts"
  Snapcast stream instead of through Mopidy at all, heard only by zones
  currently switched to that stream. `snapcastHost`/`snapcastControlPort`
  are shared by the mopidy zone-muting and alerts methods.
- Recommends `signalk-autostate` as a companion plugin (it populates
  `navigation.state`, used by the mute-at-anchor feature).
