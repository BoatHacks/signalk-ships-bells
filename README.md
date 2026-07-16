# signalk-ships-bell

A [SignalK Server](https://github.com/SignalK/signalk-server) plugin that plays traditional ship's bell audio on the watch schedule (one strike every half hour, up to eight bells).

## Status

Watch-bell scheduling logic is implemented; audio playback (the actual sound
output) is still a TODO — see `index.js`.

## Features

- Strikes the bell every half hour, 1–8 bells, following the traditional watch
  schedule. Configurable in the SignalK admin UI (Server → Plugin Config →
  Ship's Bell):
  - **Enable bell strikes** — on/off.
  - **Watch bell schedule** — three selectable conventions for the second dog
    watch (18:00–20:00), the one place historical practice diverges:
    - *Traditional* — resets to 1 bell at 18:30 instead of continuing 5-6-7,
      per the post-1797 Royal Navy convention adopted after the Nore mutiny
      (five bells in the second dog watch had been the mutiny's signal).
    - *Simple cycle* — ignores the dog-watch split as a concept and just
      cycles 1–8 every 4 hours all day.
    - *Pre-1797* — the older convention, continuing 5-6-7 bells through the
      second dog watch before the full 8 at the watch change.

      (Simple cycle and pre-1797 produce identical strike patterns — splitting
      a 4-hour watch into two 2-hour ones doesn't change the half-hourly count
      unless something resets it. They're offered as separate, differently
      labeled options rather than because the underlying schedule differs.)
  - **Mute bell when at anchor or moored** — skips playback while
    `navigation.state` is `anchored` or `moored`. Requires that path to be
    populated by something on your system — see below.
- Audio playback: likely via a SignalK webapp `<audio>` element triggered by a
  delta, so it plays wherever the webapp is open (e.g. on an MFD or tablet at
  the helm).

## Recommended companion plugins

- [signalk-autostate](https://github.com/meri-imperiumi/signalk-autostate) —
  automatically sets `navigation.state` (e.g. `anchored`, `moored`, `sailing`,
  `motoring`) from GPS and propulsion data. The "mute at anchor or moored"
  option here depends on `navigation.state` being set by something; if you
  don't already have a source for it, this plugin is a good fit.

## Audio assets

`assets/bells/` bundles one WAV file per strike count, `bell-strikes-1.wav` through
`bell-strikes-8.wav`. These are sourced from Benboncan's "Bells / Gongs" pack on
Freesound (CC BY 4.0) — see `assets/bells/NOTICE.md` for full attribution.

## Install

Not yet published. For local development, clone into your SignalK server's `node_modules`, or use `npm link`.

## License

MIT
