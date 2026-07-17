const path = require('path');

// ---- Bell-count calculation --------------------------------------------
//
// Both schemes share the same underlying idea: bells cycle 1-8 every 240
// minutes (a 4-hour watch), struck on the half hour. The only place they
// differ is the second dog watch (18:00-20:00):
//
//  - "traditional" (post-1797 Royal Navy convention): the second dog watch
//    resets the count to 1 instead of continuing 5-6-7, so that "five
//    bells in the second dog watch" - the Nore mutiny signal - is never
//    struck again. Sequence: 18:30=1, 19:00=2, 19:30=3, 20:00=8.
//  - "simple-cycle": ignores the dog-watch split as a concept entirely and
//    just cycles 1-8 every 240 minutes all day, including through the
//    second dog watch (18:30=5, 19:00=6, 19:30=7, 20:00=8).
//
// (There used to be a third "pre-1797" option here, but it produced exactly
// the same strikes as "simple-cycle" - splitting a 4-hour watch into two
// 2-hour ones doesn't change the half-hourly count unless something resets
// it - so it was removed as a redundant, confusing duplicate rather than a
// genuinely different schedule.)
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

  // "simple-cycle" (and "traditional" outside the second dog watch) follow
  // the plain 240-minute cycle.
  const cyclePosition = minutesSinceMidnight % 240;
  const idx = cyclePosition / 30;
  return idx === 0 ? 8 : idx;
}

function minutesSinceMidnight(date) {
  return date.getHours() * 60 + date.getMinutes();
}

// ---- Quiet-hours calculation --------------------------------------------
//
// Also pulled out to module scope so the test suite can exercise it directly.

function parseTimeToMinutes(hhmm) {
  if (typeof hhmm !== 'string') {
    return NaN;
  }
  const match = hhmm.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) {
    return NaN;
  }
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) {
    return NaN;
  }
  return hours * 60 + minutes;
}

function isWithinQuietHours(currentMinutes, startStr, endStr) {
  const start = parseTimeToMinutes(startStr);
  const end = parseTimeToMinutes(endStr);
  if (Number.isNaN(start) || Number.isNaN(end) || start === end) {
    // Equal start/end (including both unset) is treated as "no range" rather
    // than "muted all day" - a likely misconfiguration shouldn't silence the
    // bell entirely.
    return false;
  }
  if (start < end) {
    return currentMinutes >= start && currentMinutes < end;
  }
  // Range wraps past midnight, e.g. 22:00-06:00
  return currentMinutes >= start || currentMinutes < end;
}

// ---- New Year's midnight (16 bells) --------------------------------------
//
// Traditional at sea: 16 bells at midnight on New Year's Eve - eight for the
// old year, eight for the new - rather than the usual 8. This overrides the
// normal per-scheme calculation for that one moment only (local ship time).

function isNewYearMidnight(date) {
  return date.getMonth() === 0 && date.getDate() === 1 && date.getHours() === 0 && date.getMinutes() === 0;
}

// bell-strikes-8.wav is ~12.78s long. The New Year's 16-bell audio is that
// file played twice, so starting it this many seconds before midnight lands
// the boundary between the two halves right on the stroke of midnight.
const NEW_YEAR_EARLY_TRIGGER_SECONDS = 13;

function strikesForMoment(date, scheme) {
  if (isNewYearMidnight(date)) {
    return 16;
  }
  return bellCountForMinutes(minutesSinceMidnight(date), scheme);
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

  let strikeTimer;
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

  function playOnServerSpeaker(strikes) {
    // Plays directly on the machine running SignalK, via a speaker wired to it -
    // no browser/webapp needed. Same idea as signalk-audio-notifications, using
    // play-sound to shell out to a system player (mpg123, aplay, etc).
    const player = getAudioPlayer();
    if (!player) {
      return false;
    }
    player.play(bellFilePath(strikes), (err) => {
      if (err) {
        app.error(`ships-bells: server-speaker playback failed: ${err.message || err}`);
      }
    });
    return true;
  }

  // Test-only hook: lets the test suite inject a fake player (rather than the
  // real play-sound, which would shell out to whatever audio binary happens to
  // be on the machine running the tests - including CI runners - and can hang
  // rather than fail fast when there's no audio device to play through).
  plugin._setAudioPlayerForTesting = function (fakePlayer) {
    audioPlayer = fakePlayer;
    audioPlayerLoadFailed = false;
  };

  function isMuted(options) {
    if (options.muteWhenAnchoredOrMoored && MUTED_STATES.includes(currentNavState)) {
      return true;
    }
    if (options.quietHoursEnabled) {
      const now = minutesSinceMidnight(new Date());
      if (isWithinQuietHours(now, options.quietHoursStart, options.quietHoursEnd)) {
        return true;
      }
    }
    return false;
  }

  function strikeBell(strikes, options) {
    if (isMuted(options)) {
      app.debug(
        `ships-bells: ${strikes} bell(s) due, but muted ` +
        `(navigation.state=${currentNavState}, quietHours=${options.quietHoursEnabled})`
      );
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
      playOnServerSpeaker(strikes);
    }
  }

  function msUntilNextHalfHourBoundary(now) {
    const msPastHalfHour = ((now.getMinutes() % 30) * 60 + now.getSeconds()) * 1000 + now.getMilliseconds();
    return 30 * 60 * 1000 - msPastHalfHour;
  }

  function scheduleNextStrike(options, afterBoundary) {
    const now = new Date();
    let boundary = new Date(now.getTime() + msUntilNextHalfHourBoundary(now));

    // The New Year's early trigger fires *before* its boundary (see below), so
    // at that point real time hasn't reached the boundary yet and the above
    // would recompute the very same boundary again, causing an immediate
    // repeat fire. Force progression to the next one instead.
    if (afterBoundary && boundary.getTime() <= afterBoundary.getTime()) {
      boundary = new Date(afterBoundary.getTime() + 30 * 60 * 1000);
    }

    const strikes = strikesForMoment(boundary, options.watchScheme);

    // bell-strikes-8.wav is ~12.78s long. For the New Year's 16-bell file
    // (that file played twice back to back), start it NEW_YEAR_EARLY_TRIGGER_SECONDS
    // before midnight so the first set of 8 strikes finishes right on the
    // stroke of midnight, rather than starting there and running 12-13s late.
    const fireAt = isNewYearMidnight(boundary)
      ? new Date(boundary.getTime() - NEW_YEAR_EARLY_TRIGGER_SECONDS * 1000)
      : boundary;
    const delay = Math.max(0, fireAt.getTime() - now.getTime());

    strikeTimer = setTimeout(() => {
      strikeBell(strikes, options);
      scheduleNextStrike(options, boundary);
    }, delay);
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
        enum: ['traditional', 'simple-cycle'],
        enumNames: [
          'British Navy (resets to 1 bell at the second dog watch, avoiding the old "five bells" mutiny signal)',
          'Standard (ignores the dog-watch split, just cycles 1-8 all day)'
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
      },
      quietHoursEnabled: {
        type: 'boolean',
        title: 'Mute during a time range',
        description: 'E.g. quiet hours overnight while at anchor or in a marina.',
        default: false
      },
      quietHoursStart: {
        type: 'string',
        title: 'Quiet hours start (HH:MM, 24-hour, ship-local time)',
        default: '22:00'
      },
      quietHoursEnd: {
        type: 'string',
        title: 'Quiet hours end (HH:MM, 24-hour, ship-local time)',
        description: 'Can be earlier than the start time to span midnight, e.g. 22:00-06:00.',
        default: '06:00'
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

    // Lets the "play test bell" button in the webapp also exercise server-speaker
    // output when that's part of the configured playback method - a plain client-side
    // <audio> play() can't reach the SignalK host's own speaker, so this is the only
    // way the test button can cover that path. Intentionally ignores the
    // anchored/moored mute setting, since a test triggered by hand is deliberate.
    router.post('/test-strike', (req, res) => {
      const method = currentOptions.playbackMethod || 'webapp';
      const strikes = 8;

      if (method !== 'server-speaker' && method !== 'both') {
        res.json({ playedOnServerSpeaker: false, reason: 'playbackMethod is webapp-only' });
        return;
      }

      const played = playOnServerSpeaker(strikes);
      res.json({
        playedOnServerSpeaker: played,
        reason: played ? undefined : 'play-sound unavailable - check server logs'
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
    if (strikeTimer) {
      clearTimeout(strikeTimer);
      strikeTimer = undefined;
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
module.exports.parseTimeToMinutes = parseTimeToMinutes;
module.exports.isWithinQuietHours = isWithinQuietHours;
module.exports.isNewYearMidnight = isNewYearMidnight;
module.exports.strikesForMoment = strikesForMoment;
