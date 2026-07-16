# signalk-ships-bells

A [SignalK Server](https://github.com/SignalK/signalk-server) plugin that plays traditional ship's bell audio on the watch schedule (one strike every half hour, up to eight bells).

## Status

Watch-bell scheduling and playback are both implemented: `index.js` computes
the strike schedule and emits a notification delta; the `public/` webapp
listens for it over the SignalK websocket and plays the matching audio file.

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
- Audio playback: each strike is sent as a `notifications.plugins.signalkShipsBell.strike`
  delta. The bundled webapp (open it from the SignalK admin UI's webapps list,
  or at `/signalk-ships-bells/`) subscribes to that delta over the websocket and
  plays the matching file via `<audio>` — so it sounds wherever that page is
  open (e.g. a browser tab on an MFD or tablet at the helm). A "play test
  bell" button is included for checking that audio works without waiting for
  the next half hour.

## Recommended companion plugins

- [signalk-autostate](https://github.com/meri-imperiumi/signalk-autostate) —
  automatically sets `navigation.state` (e.g. `anchored`, `moored`, `sailing`,
  `motoring`) from GPS and propulsion data. The "mute at anchor or moored"
  option here depends on `navigation.state` being set by something; if you
  don't already have a source for it, this plugin is a good fit.

## Audio assets

`public/bells/` bundles one WAV file per strike count, `bell-strikes-1.wav` through
`bell-strikes-8.wav`, served statically by SignalK server's signalk-webapp hosting
at `/signalk-ships-bells/bells/`. These are sourced from Benboncan's "Bells / Gongs"
pack on Freesound (CC BY 4.0) — see `public/bells/NOTICE.md` for full attribution.

## Install

Not yet published. For local development, clone into your SignalK server's `node_modules`, or use `npm link`.

## License

MIT
