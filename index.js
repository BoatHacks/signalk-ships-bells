const path = require('path');

module.exports = function (app) {
  const plugin = {};

  plugin.id = 'signalk-ships-bell';
  plugin.name = "Ship's Bell";
  plugin.description = "Plays traditional ship's bell audio on the watch schedule";

  // One audio file per strike count (1-8), e.g. bell-strikes-3.wav for three bells
  const bellsDir = path.join(__dirname, 'assets', 'bells');
  const bellFile = (strikes) => `bell-strikes-${strikes}.wav`;

  let halfHourTimer;
  let alignmentTimer;
  let unsubscribeNavState;
  let currentNavState;

  const MUTED_STATES = ['anchored', 'moored'];

  // ---- Bell-count calculation --------------------------------------------
  //
  // All three schemes share the same underlying idea: bells cycle 1-8 every
  // 240 minutes (a 4-hour watch), struck on the half hour. The only place
  // they can differ is the second dog watch (18:00-20:00), which is where
  // the historical variants diverge:
  //
  //  - "traditional" (post-1797 Royal Navy convention): the second dog watch
  //    resets the count to 1 instead of continuing 5-6-7, so that "five
  //    bells in the second dog watch" - the Nore mutiny signal - is never
  //    struck again. Sequence: 18:30=1, 19:00=2, 19:30=3, 20:00=8.
  //  - "pre-1797": the older convention, where the count simply continues
  //    5-6-7 before the full 8 at the watch change. Sequence: 18:30=5,
  //    19:00=6, 19:30=7, 20:00=8.
  //  - "simple-cycle": ignores the dog-watch split as a concept entirely and
  //    just cycles 1-8 every 240 minutes all day. This produces the exact
  //    same strikes as "pre-1797" (splitting a 4-hour watch into two 2-hour
  //    ones doesn't change the half-hour count unless something resets it),
  //    so it's offered as a separate, more approachable option/label rather
  //    than a different calculation.

  function bellCountForMinutes(minutesSinceMidnight, scheme) {
    const inSecondDogWatch = minutesSinceMidnight > 1080 && minutesSinceMidnight <= 1200;

    if (scheme === 'traditional' && inSecondDogWatch) {
      const offset = minutesSinceMidnight - 1080; // 30, 60, 90, 120
      const resetSequence = { 30: 1, 60: 2, 90: 3, 120: 8 };
      return resetSequence[offset];
    }

    // "pre-1797" and "simple-cycle" (and "traditional" outside the second
    // dog watch) all follow the plain 240-minute cycle.
    const cyclePosition = minutesSinceMidnight % 240;
    const idx = cyclePosition / 30;
    return idx === 0 ? 8 : idx;
  }

  function minutesSinceMidnight(date) {
    return date.getHours() * 60 + date.getMinutes();
  }

  // ---- Playback -----------------------------------------------------------

  function strikeBell(strikes, options) {
    const muted = options.muteWhenAnchoredOrMoored && MUTED_STATES.includes(currentNavState);

    if (muted) {
      app.debug(`ships-bell: ${strikes} bell(s) due, but muted (navigation.state=${currentNavState})`);
      return;
    }

    app.debug(`ships-bell: striking ${strikes} bell(s), file ${bellFile(strikes)}`);
    // TODO: actually trigger playback. Likely approach: emit a delta here that a
    // companion webapp (served from this plugin, connected via the SignalK
    // websocket) listens for and plays as <audio src=".../assets/bells/...">,
    // so it works wherever the webapp is open (helm tablet, MFD, etc). Emitting
    // it as a notification keeps it visible to any SignalK client in the
    // meantime, even before that webapp exists:
    app.handleMessage(plugin.id, {
      updates: [
        {
          values: [
            {
              path: 'notifications.plugins.signalkShipsBell.strike',
              value: {
                state: 'normal',
                message: `${strikes} bell(s)`,
                data: { strikes, file: bellFile(strikes) }
              }
            }
          ]
        }
      ]
    });
  }

  function scheduleNextStrike(options) {
    const now = new Date();
    const msPastHalfHour = ((now.getMinutes() % 30) * 60 + now.getSeconds()) * 1000 + now.getMilliseconds();
    const msUntilNextHalfHour = 30 * 60 * 1000 - msPastHalfHour;

    alignmentTimer = setTimeout(() => {
      const strikeTime = new Date();
      const strikes = bellCountForMinutes(minutesSinceMidnight(strikeTime), options.watchScheme);
      strikeBell(strikes, options);

      // Once aligned to the half hour, a plain interval keeps us there
      halfHourTimer = setInterval(() => {
        const t = new Date();
        strikeBell(bellCountForMinutes(minutesSinceMidnight(t), options.watchScheme), options);
      }, 30 * 60 * 1000);
    }, msUntilNextHalfHour);
  }

  // ---- Admin UI config ------------------------------------------------------

  plugin.schema = {
    type: 'object',
    properties: {
      enabled: {
        type: 'boolean',
        title: 'Enable bell strikes',
        default: true
      },
      watchScheme: {
        type: 'string',
        title: 'Watch bell schedule',
        description:
          "Which historical convention to use for the second dog watch (18:00-20:00). " +
          "All other watches (1-8 bells every half hour) are the same in every scheme.",
        enum: ['traditional', 'simple-cycle', 'pre-1797'],
        enumNames: [
          'Traditional (resets to 1 bell at the second dog watch, avoiding the old "five bells" mutiny signal)',
          'Simple cycle (ignores the dog-watch split, just cycles 1-8 all day)',
          'Pre-1797 (continues 5-6-7 bells through the second dog watch)'
        ],
        default: 'traditional'
      },
      muteWhenAnchoredOrMoored: {
        type: 'boolean',
        title: 'Mute bell when at anchor or moored',
        description: 'Requires navigation.state to be populated, e.g. by the signalk-autostate plugin.',
        default: true
      }
    }
  };

  // ---- Lifecycle ------------------------------------------------------------

  plugin.start = function (options) {
    app.debug('starting ships-bell plugin', options);

    if (options.enabled === false) {
      return;
    }

    unsubscribeNavState = app.streambundle
      .getSelfStream('navigation.state')
      .onValue((value) => {
        currentNavState = value;
      });

    scheduleNextStrike(options);
  };

  plugin.stop = function () {
    app.debug('stopping ships-bell plugin');
    if (alignmentTimer) {
      clearTimeout(alignmentTimer);
      alignmentTimer = undefined;
    }
    if (halfHourTimer) {
      clearInterval(halfHourTimer);
      halfHourTimer = undefined;
    }
    if (unsubscribeNavState) {
      unsubscribeNavState();
      unsubscribeNavState = undefined;
    }
  };

  return plugin;
};
