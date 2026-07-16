const path = require('path');

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
//
// Pulled out to module scope (rather than inside the plugin factory below)
// so the test suite can exercise this pure logic directly, without needing
// a mock SignalK app.

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

module.exports = function (app) {
  const plugin = {};

  plugin.id = 'signalk-ships-bells';
  plugin.name = "Ship's Bell";
  plugin.description = "Plays traditional ship's bell audio on the watch schedule";

  // One audio file per strike count (1-8), e.g. bell-strikes-3.wav for three bells.
  // Served statically from public/bells/ by SignalK server's signalk-webapp hosting,
  // at /signalk-ships-bells/bells/<file>, and also playable directly from disk for
  // server-side speaker output.
  const bellFile = (strikes) => `bell-strikes-${strikes}.wav`;
  const bellFilePath = (strikes) => path.join(__dirname, 'public', 'bells', bellFile(strikes));

  let halfHourTimer;
  let alignmentTimer;
  let unsubscribeNavState;
  let currentNavState;
  let audioPlayer;
  let audioPlayerLoadFailed = false;
  let currentOptions = {};

  // Lazily require play-sound so the plugin still loads (and its config UI still
  // works) on systems where that optional dependency isn't installed, unless
  // server-speaker playback is actually selected.
  function getAudioPlayer() {
    if (audioPlayer || audioPlayerLoadFailed) {
      return audioPlayer;
    }
    try {
      const playSound = require('play-sound');
      audioPlayer = playSound({});
    } catch (err) {
      audioPlayerLoadFailed = true;
      app.error(
        `ships-bells: could not load play-sound (${err.message}). ` +
        "Server-speaker playback needs the 'play-sound' npm dependency plus a " +
        "system audio player (e.g. mpg123 or aplay) installed on this machine."
      );
    }
    return audioPlayer;
  }

  const MUTED_STATES = ['anchored', 'moored'];

  // ---- Playback -----------------------------------------------------------

  function strikeBell(strikes, options) {
    const muted = options.muteWhenAnchoredOrMoored && MUTED_STATES.includes(currentNavState);

    if (muted) {
      app.debug(`ships-bells: ${strikes} bell(s) due, but muted (navigation.state=${currentNavState})`);
      return;
    }

    const method = options.playbackMethod || 'webapp';
    app.debug(`ships-bells: striking ${strikes} bell(s), file ${bellFile(strikes)}, method=${method}`);

    if (method === 'webapp' || method === 'both') {
      // The public/ webapp (served at /signalk-ships-bells/) subscribes to this
      // notification over the SignalK websocket and plays the referenced file
      // via <audio>, so it sounds wherever that webapp is open (helm tablet,
      // MFD browser, etc). Anything else on the SignalK bus can react to it too.
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

    if (method === 'server-speaker' || method === 'both') {
      // Plays directly on the machine running SignalK, via a speaker wired to it -
      // no browser/webapp needed. Same idea as signalk-audio-notifications, using
      // play-sound to shell out to a system player (mpg123, aplay, etc).
      const player = getAudioPlayer();
      if (player) {
        player.play(bellFilePath(strikes), (err) => {
          if (err) {
            app.error(`ships-bells: server-speaker playback failed: ${err.message || err}`);
          }
        });
      }
    }
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
          'British Navy (resets to 1 bell at the second dog watch, avoiding the old "five bells" mutiny signal)',
          'Standard (ignores the dog-watch split, just cycles 1-8 all day)',
          'Pre-1797 (continues 5-6-7 bells through the second dog watch)'
        ],
        default: 'traditional'
      },
      playbackMethod: {
        type: 'string',
        title: 'Playback method',
        description:
          "'Webapp' plays through the browser wherever this plugin's webapp is open " +
          "(e.g. a helm tablet). 'Server speaker' plays directly on the machine " +
          "running Signal K, via a speaker wired to it - no browser needed, but " +
          "requires the 'play-sound' npm package plus a system audio player " +
          "(e.g. mpg123 or aplay) installed on that machine.",
        enum: ['webapp', 'server-speaker', 'both'],
        enumNames: [
          'Webapp (play in browser)',
          'Server speaker (play on the Signal K host)',
          'Both'
        ],
        default: 'webapp'
      },
      muteWhenAnchoredOrMoored: {
        type: 'boolean',
        title: 'Mute bell when at anchor or moored',
        description: 'Requires navigation.state to be populated, e.g. by the signalk-autostate plugin.',
        default: true
      }
    }
  };

  // ---- Webapp API -----------------------------------------------------------
  //
  // Lets the public/ webapp read and change the watch schedule at runtime,
  // without needing the admin UI's plugin config screen.

  plugin.registerWithRouter = function (router) {
    router.get('/schedule', (req, res) => {
      const schemeSchema = plugin.schema.properties.watchScheme;
      res.json({
        watchScheme: currentOptions.watchScheme,
        options: schemeSchema.enum.map((value, i) => ({
          value,
          label: schemeSchema.enumNames[i]
        }))
      });
    });

    router.put('/schedule', (req, res) => {
      const validSchemes = plugin.schema.properties.watchScheme.enum;
      const watchScheme = req.body && req.body.watchScheme;

      if (!validSchemes.includes(watchScheme)) {
        res.status(400).json({ error: `watchScheme must be one of: ${validSchemes.join(', ')}` });
        return;
      }

      currentOptions.watchScheme = watchScheme;
      app.savePluginOptions(currentOptions, (err) => {
        if (err) {
          app.error(`ships-bells: failed to save schedule option: ${err.message || err}`);
          res.status(500).json({ error: 'Failed to save option' });
          return;
        }
        res.json({ watchScheme: currentOptions.watchScheme });
      });
    });
  };

  // ---- Lifecycle ------------------------------------------------------------

  plugin.start = function (options) {
    app.debug('starting ships-bell plugin', options);
    currentOptions = options;

    if (options.enabled === false) {
      return;
    }

    unsubscribeNavState = app.streambundle
      .getSelfStream('navigation.state')
      .onValue((value) => {
        currentNavState = value;
      });

    scheduleNextStrike(currentOptions);
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

// Exposed for unit testing (see test/bell-schedule.test.js). Attaching to the
// factory function is safe - signalk-server only checks that the module's
// default/CJS export is itself callable, which it still is.
module.exports.bellCountForMinutes = bellCountForMinutes;
module.exports.minutesSinceMidnight = minutesSinceMidnight;
