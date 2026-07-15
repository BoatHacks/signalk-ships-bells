# signalk-ships-bell

A [SignalK Server](https://github.com/SignalK/signalk-server) plugin that plays traditional ship's bell audio on the watch schedule (one strike every half hour, up to eight bells).

## Status

Early scaffold — not yet functional.

## Planned features

- Strike the bell according to the traditional watch schedule (1–8 bells, repeating every 4 hours)
- Configurable enable/disable
- Audio playback, likely via a SignalK webapp `<audio>` element triggered by a delta, so it plays wherever the webapp is open (e.g. on an MFD or tablet at the helm)

## Install

Not yet published. For local development, clone into your SignalK server's `node_modules`, or use `npm link`.

## License

MIT
