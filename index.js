const path = require('path');
const net = require('net');
const { spawn } = require('child_process');

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

// ---- Manual UTC offset ----------------------------------------------------
//
// Lets a user pin the bell schedule to UTC-plus-N-minutes instead of the
// server's local clock (e.g. running the schedule on a different watch
// rotation than local wall-clock time would give). Deliberately UTC-based
// rather than local-time-based, so it isn't entangled with the server's own
// timezone/DST handling. When enabled, the watch scheme is forced to
// "simple-cycle" (labelled "Standard" in the schema) - the dog-watch reset
// in "traditional" is a fixed-clock-time convention, and an arbitrary offset
// would put it somewhere that no longer matches the real second dog watch.

function minutesSinceMidnightUTC(date) {
  return date.getUTCHours() * 60 + date.getUTCMinutes();
}

function effectiveMinutesSinceMidnight(date, options) {
  if (!options.utcOffsetEnabled) {
    return minutesSinceMidnight(date);
  }
  const offset = options.utcOffsetMinutes || 0;
  return (minutesSinceMidnightUTC(date) + offset + 1440) % 1440;
}

function effectiveWatchScheme(options) {
  return options.utcOffsetEnabled ? 'simple-cycle' : options.watchScheme;
}

// ---- Bell schedule reference table (public/ webapp) ----------------------
//
// Full 48-half-hour-mark table, same shape as Wikipedia's "Ship's bell"
// reference table (https://en.wikipedia.org/wiki/Ship%27s_bell): the
// traditional seven watches, each with its own half-hour marks and bell
// count. Reuses bellCountForMinutes/effectiveWatchScheme directly rather
// than re-deriving the schedule, so this can never drift from what
// actually rings.
//
// Each watch owns the half-hour marks strictly AFTER its own nominal start
// and up to and including its own end -- the "N bells" mark that concludes
// it -- not the marks starting at its own beginning (those belong to the
// PRECEDING watch's own final bells). Concretely: midnight (00:00) is the
// First Watch's own closing "eight bells" from the day before wrapping
// around, not the Middle Watch's opening mark -- matches the real
// convention (eight bells always signals the END of a watch) and is why
// the loop below runs marks 30..1440 (not 0..1410) and looks the watch up
// by the UNWRAPPED mark, only wrapping mod 1440 afterward for the
// displayed clock time.
const WATCHES = [
  { name: 'Middle Watch', start: 0, end: 240 },
  { name: 'Morning Watch', start: 240, end: 480 },
  { name: 'Forenoon Watch', start: 480, end: 720 },
  { name: 'Afternoon Watch', start: 720, end: 960 },
  { name: 'First Dog Watch', start: 960, end: 1080 },
  { name: 'Last Dog Watch', start: 1080, end: 1200 },
  { name: 'First Watch', start: 1200, end: 1440 }
];

function watchNameForUnwrappedMark(unwrappedMinutes) {
  const watch = WATCHES.find((w) => unwrappedMinutes > w.start && unwrappedMinutes <= w.end);
  return watch ? watch.name : WATCHES[WATCHES.length - 1].name;
}

function formatHHMM(minutesSinceMidnightValue) {
  const h = Math.floor(minutesSinceMidnightValue / 60);
  const m = minutesSinceMidnightValue % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

// usesUtc/offset mirror effectiveMinutesSinceMidnight()'s own logic exactly
// (SPEC: the manual UTC offset is UTC-based, not local-wall-clock-based) --
// when the offset is enabled, each row's displayed time is a UTC clock
// mark, and its bell count reflects that same mark shifted by the
// configured offset, i.e. exactly what a `Date` at that UTC instant would
// produce if run through effectiveMinutesSinceMidnight() right now.
function buildBellScheduleTable(options) {
  const scheme = effectiveWatchScheme(options);
  const usesUtc = !!options.utcOffsetEnabled;
  const offset = options.utcOffsetMinutes || 0;
  const rows = [];

  for (let mark = 30; mark <= 1440; mark += 30) {
    const clockMinutes = mark % 1440;
    const effectiveMinutes = usesUtc ? (clockMinutes + offset + 1440) % 1440 : clockMinutes;
    rows.push({
      watch: watchNameForUnwrappedMark(mark),
      time: formatHHMM(clockMinutes),
      bells: bellCountForMinutes(effectiveMinutes, scheme)
    });
  }

  return { rows, usesUtc, watchScheme: scheme };
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

// ---- Night-volume reduction -----------------------------------------------
//
// Like quiet hours, but instead of muting entirely it scales the webapp's
// playback volume down during a time range - e.g. still audible but quieter
// overnight. Reuses the same time-range check as quiet hours. Only applies
// to webapp playback: play-sound doesn't offer a portable way to control
// output volume across the different system audio players it can shell out
// to, so server-speaker playback always plays at full volume regardless of
// this setting.

function nightVolumeFactorForMoment(date, options) {
  if (!options.nightVolumeEnabled) {
    return 1;
  }
  if (!isWithinQuietHours(minutesSinceMidnight(date), options.nightVolumeStart, options.nightVolumeEnd)) {
    return 1;
  }
  const level = typeof options.nightVolumeLevel === 'number' ? options.nightVolumeLevel : 100;
  return Math.max(0, Math.min(100, level)) / 100;
}

// ---- New Year's midnight (extra 8 bells) ---------------------------------
//
// Traditional at sea: 16 bells at midnight on New Year's Eve - eight for the
// old year, eight for the new. Implemented simply as an extra, independent
// 8-bell strike shortly before midnight, on top of the regular half-hour
// schedule's own 8-bell strike at 00:00:00 (which already happens on every
// scheme - see "watch changes always ring 8 bells" in the tests). No
// override of the normal bell-count logic is needed.

// bell-strikes-8.wav is ~12.78s long. Firing the extra strike this many
// seconds before midnight means it finishes right around the stroke of
// midnight, just ahead of the regular 00:00:00 strike.
const NEW_YEAR_EARLY_TRIGGER_SECONDS = 13;

function nextNewYearEveTriggerTime(now) {
  const seconds = 60 - NEW_YEAR_EARLY_TRIGGER_SECONDS; // 47
  let candidate = new Date(now.getFullYear(), 11, 31, 23, 59, seconds, 0);
  if (candidate.getTime() <= now.getTime()) {
    candidate = new Date(now.getFullYear() + 1, 11, 31, 23, 59, seconds, 0);
  }
  return candidate;
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
  let newYearExtraStrikeTimer;
  let unsubscribeNavState;
  let currentNavState;
  let audioPlayer;
  let audioPlayerLoadFailed = false;
  let currentOptions = {};
  let fetchImpl = fetch;
  let snapConnectImpl = net.createConnection.bind(net);
  let alertsConnectImpl = net.createConnection.bind(net);
  let spawnImpl = spawn;

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

  // Test-only hook: lets the test suite inject a fake fetch instead of the
  // real one, so tests don't make real HTTP calls to a Mopidy instance.
  plugin._setFetchForTesting = function (fakeFetch) {
    fetchImpl = fakeFetch;
  };

  // Test-only hook: lets the test suite inject a fake net.connect instead of
  // the real one, so tests don't make real TCP connections to a Snapserver.
  plugin._setSnapConnectForTesting = function (fakeConnect) {
    snapConnectImpl = fakeConnect;
  };

  // Test-only hook: a separate connect function from snapConnectImpl above -
  // that one is for Snapserver's own control-port JSON-RPC, this one is for
  // signalk-jukebox's Alerts stream (raw audio bytes, unrelated protocol) -
  // so tests can fake each independently.
  plugin._setAlertsConnectForTesting = function (fakeConnect) {
    alertsConnectImpl = fakeConnect;
  };

  // Test-only hook: lets the test suite inject a fake child_process.spawn
  // instead of the real one, so tests don't shell out to a real ffmpeg.
  plugin._setSpawnForTesting = function (fakeSpawn) {
    spawnImpl = fakeSpawn;
  };

  // ---- Mopidy sound server playback ----------------------------------------
  //
  // Plays the bell through a Mopidy instance instead of a speaker wired
  // directly to the SignalK host - for setups (e.g. signalk-jukebox) where the
  // host's own sound card is already claimed by a Snapcast client and
  // server-speaker playback (which opens the ALSA device directly via
  // play-sound) would fight it for the device. Mopidy runs in a container in
  // the signalk-jukebox case, so it can't read this plugin's bell .wav files
  // off local disk - it fetches them over HTTP instead, from wherever this
  // plugin's own webapp already serves them
  // (/signalk-ships-bells/bells/<file>.wav).
  //
  // Two separate network paths, two separate config fields:
  // - mopidyHost/mopidyPort: this plugin (running in the SignalK process, on
  //   the host) calling Mopidy's JSON-RPC API. Defaults (localhost:6680)
  //   match a default signalk-jukebox install, whose Mopidy port is reachable
  //   from the host regardless of the jukebox container's own network mode
  //   (signalk-container's signalkAccessiblePorts binds it on the host's own
  //   loopback for exactly this).
  // - mopidyAudioBaseUrl: the reverse direction - Mopidy (inside its
  //   container) fetching the bell .wav back from this plugin. A default
  //   (non-host-networked) container can't reach the host's own loopback, so
  //   "http://localhost:<this SignalK server's port>" (the auto-built
  //   default when this field is left blank) only works if the Mopidy
  //   container uses host networking. Otherwise this must be set to this
  //   SignalK server's real LAN IP.

  function mopidyRpc(host, port, method, params) {
    return fetchImpl(`http://${host}:${port}/mopidy/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: params || {} })
    })
      .then((res) => res.json())
      .then((body) => {
        if (body.error) {
          throw new Error(body.error.message || 'Mopidy RPC error');
        }
        return body.result;
      });
  }

  function resolveMopidyAudioBaseUrl(options) {
    const mopidyAudioBaseUrl = (options.mopidySettings || {}).mopidyAudioBaseUrl;
    if (mopidyAudioBaseUrl) {
      return mopidyAudioBaseUrl.replace(/\/$/, '');
    }
    const port = (app.config && app.config.settings && app.config.settings.port) || 3000;
    return `http://localhost:${port}`;
  }

  // ---- Snapserver zone targeting -------------------------------------------
  //
  // Mopidy has one shared output ("the Jukebox stream" in signalk-jukebox
  // terms) - every Snapcast zone connected to it hears the same audio. To
  // play the bell in only some zones, this mutes every OTHER currently
  // connected zone for the strike's duration, then restores each one's own
  // prior mute state (not just unmuting blindly - a zone the admin already
  // had muted stays muted). Talks to Snapserver's own control port directly:
  // raw newline-delimited JSON-RPC over TCP, not HTTP, matching
  // signalk-jukebox's own snapserver-client.ts. Default port 1705 is
  // signalk-jukebox's SNAPCAST_CONTROL_PORT.
  //
  // Only runs at all when mopidyZoneIds is a non-empty array - an empty/unset
  // list means "every zone", the original unconditional behavior, and skips
  // this entirely.

  function snapserverCall(host, port, method, params) {
    return new Promise((resolve, reject) => {
      const socket = snapConnectImpl(port, host);
      let buffer = '';
      let settled = false;
      socket.setEncoding('utf8');
      socket.once('connect', () => {
        socket.write(`${JSON.stringify({ id: 1, jsonrpc: '2.0', method, params })}\n`);
      });
      socket.on('data', (chunk) => {
        buffer += chunk;
        const newlineAt = buffer.indexOf('\n');
        if (newlineAt === -1) {
          return;
        }
        const line = buffer.slice(0, newlineAt);
        settled = true;
        socket.end();
        let msg;
        try {
          msg = JSON.parse(line);
        } catch (err) {
          reject(err);
          return;
        }
        if (msg.error) {
          reject(new Error(msg.error.message || 'Snapserver RPC error'));
        } else {
          resolve(msg.result);
        }
      });
      socket.once('error', (err) => {
        if (!settled) {
          reject(err);
        }
      });
    });
  }

  async function listSnapclients(host, port) {
    const status = await snapserverCall(host, port, 'Server.GetStatus');
    const clients = [];
    for (const group of status.server.groups) {
      for (const client of group.clients) {
        clients.push(client);
      }
    }
    return clients;
  }

  async function muteOtherZones(host, port, selectedZoneIds) {
    const clients = await listSnapclients(host, port);
    const snapshot = [];
    for (const client of clients) {
      if (selectedZoneIds.includes(client.id)) {
        continue;
      }
      snapshot.push({
        id: client.id,
        volume: client.config.volume.percent,
        wasMuted: client.config.volume.muted
      });
      if (!client.config.volume.muted) {
        await snapserverCall(host, port, 'Client.SetVolume', {
          id: client.id,
          volume: { percent: client.config.volume.percent, muted: true }
        });
      }
    }
    return snapshot;
  }

  async function restoreZones(host, port, snapshot) {
    for (const entry of snapshot) {
      if (entry.wasMuted) {
        continue; // already muted before this strike - leave it muted
      }
      await snapserverCall(host, port, 'Client.SetVolume', {
        id: entry.id,
        volume: { percent: entry.volume, muted: false }
      });
    }
  }

  // Ducking: if Mopidy is already playing something when the bell fires, its
  // current track and exact playback position are captured, playback is
  // paused (the "duck"), the bell is inserted into the tracklist and played
  // on its own, and afterward the original track is resumed at the captured
  // position (the "un-duck") - rather than clearing/replacing the tracklist
  // outright. If nothing was playing, there's nothing to duck or resume;
  // the bell just plays and is removed from the tracklist afterward.

  async function duckForBell(host, port) {
    const state = await mopidyRpc(host, port, 'core.playback.get_state');
    if (state !== 'playing') {
      return null;
    }
    const tlTrack = await mopidyRpc(host, port, 'core.playback.get_current_tl_track');
    if (!tlTrack) {
      return null;
    }
    const positionMs = await mopidyRpc(host, port, 'core.playback.get_time_position');
    await mopidyRpc(host, port, 'core.playback.pause');
    return { tlid: tlTrack.tlid, positionMs };
  }

  async function unduckAfterBell(host, port, snapshot) {
    if (!snapshot) {
      return;
    }
    await mopidyRpc(host, port, 'core.playback.play', { tlid: snapshot.tlid });
    await mopidyRpc(host, port, 'core.playback.seek', { time_position: snapshot.positionMs });
  }

  // Night-volume reduction applies to Mopidy playback too, via Mopidy's own
  // mixer volume - scaled by the same volumeFactor (0-1) the webapp applies
  // to its own <audio> element. Only touches the mixer at all when a
  // reduction is actually in effect (volumeFactor < 1); the reduced level is
  // read back to full afterward rather than to a hardcoded value, so
  // whatever level the mixer was already at (e.g. set by signalk-jukebox's
  // own volume control) survives the strike unchanged.

  async function duckVolumeForBell(host, port, volumeFactor) {
    if (volumeFactor >= 1) {
      return null;
    }
    const originalVolume = await mopidyRpc(host, port, 'core.mixer.get_volume');
    if (typeof originalVolume !== 'number') {
      return null;
    }
    const bellVolume = Math.max(0, Math.min(100, Math.round(originalVolume * volumeFactor)));
    await mopidyRpc(host, port, 'core.mixer.set_volume', { volume: bellVolume });
    return originalVolume;
  }

  async function restoreVolumeAfterBell(host, port, originalVolume) {
    if (originalVolume === null || originalVolume === undefined) {
      return;
    }
    await mopidyRpc(host, port, 'core.mixer.set_volume', { volume: originalVolume });
  }

  function playOnMopidy(strikes, options, volumeFactor) {
    const mopidySettings = options.mopidySettings || {};
    const host = mopidySettings.mopidyHost || 'localhost';
    const port = mopidySettings.mopidyPort || 6680;
    const snapHost = options.snapcastHost || 'localhost';
    const snapPort = mopidySettings.snapcastControlPort || 1705;
    const zoneIds = Array.isArray(options.mopidyZoneIds) ? options.mopidyZoneIds : [];
    const factor = typeof volumeFactor === 'number' ? volumeFactor : 1;
    const url = `${resolveMopidyAudioBaseUrl(options)}/signalk-ships-bells/bells/${bellFile(strikes)}`;

    (async () => {
      let zoneSnapshot = [];
      if (zoneIds.length > 0) {
        try {
          zoneSnapshot = await muteOtherZones(snapHost, snapPort, zoneIds);
        } catch (err) {
          app.error(`ships-bells: could not mute other zones: ${err.message || err}`);
        }
      }

      let playbackSnapshot = null;
      let originalVolume = null;
      try {
        playbackSnapshot = await duckForBell(host, port);
        originalVolume = await duckVolumeForBell(host, port, factor);

        const added = await mopidyRpc(host, port, 'core.tracklist.add', { uris: [url] });
        const bellTlTrack = added && added[0];
        await mopidyRpc(host, port, 'core.playback.play', bellTlTrack ? { tlid: bellTlTrack.tlid } : {});

        const durationMs = (bellTlTrack && bellTlTrack.track && bellTlTrack.track.length) || 5000;
        setTimeout(() => {
          (async () => {
            if (bellTlTrack) {
              await mopidyRpc(host, port, 'core.tracklist.remove', { criteria: { tlid: [bellTlTrack.tlid] } });
            }
            await unduckAfterBell(host, port, playbackSnapshot);
            await restoreVolumeAfterBell(host, port, originalVolume);
          })().catch((err) => {
            app.error(`ships-bells: could not resume mopidy playback after bell: ${err.message || err}`);
          }).finally(() => {
            if (zoneSnapshot.length > 0) {
              restoreZones(snapHost, snapPort, zoneSnapshot).catch((err) => {
                app.error(`ships-bells: could not restore zone mute state: ${err.message || err}`);
              });
            }
          });
        }, durationMs + 500);
      } catch (err) {
        app.error(`ships-bells: mopidy playback failed: ${err.message || err}`);
        unduckAfterBell(host, port, playbackSnapshot).catch(() => {});
        restoreVolumeAfterBell(host, port, originalVolume).catch(() => {});
        if (zoneSnapshot.length > 0) {
          restoreZones(snapHost, snapPort, zoneSnapshot).catch(() => {});
        }
      }
    })();

    return true;
  }

  // ---- Alerts stream playback (signalk-jukebox's Snapcast intake) ---------
  //
  // Streams the bell straight into signalk-jukebox's "Alerts" Snapcast
  // stream (a standing TCP intake, ALERTS_STREAM_ID in signalk-jukebox's own
  // container.ts) instead of going through Mopidy at all. Whichever zones
  // are currently switched to "Alerts" (signalk-jukebox's own webapp "Play
  // here" toggle) hear it - zones still on "jukebox" don't, since a
  // Snapcast group can only be assigned to one stream at a time. Unlike
  // playOnMopidy, there's nothing to duck/resume here: the Alerts stream is
  // entirely separate from whatever's playing on the jukebox stream, so
  // this never interrupts anything.
  //
  // The bundled bell .wav files are 44100:16:2 (Benboncan/Freesound's own
  // format); signalk-jukebox's Alerts stream is fixed at 48000:16:2 (its
  // own snapserver.conf.template) - Snapcast's tcp-server source doesn't
  // resample, it expects the connecting sender to already send audio
  // matching that format. Resampled on the fly via ffmpeg (confirmed by
  // build-testing against a real signalk-jukebox instance: a real bell
  // strike streamed through this exact ffmpeg invocation played for its
  // full, correct 12.78s), piped directly into the socket - no temp file.
  // Requires ffmpeg installed on this machine, same kind of external-binary
  // requirement as the server-speaker method's play-sound/mpg123/aplay.
  //
  // snapcastHost is shared with playOnMopidy's own zone-muting (both talk
  // to the same Snapserver instance) rather than reusing mopidyHost -
  // Mopidy and Snapserver are the same host in a default signalk-jukebox
  // install (this field's default), but aren't necessarily the same host
  // in general. alertsStreamName has no effect on the connection itself
  // (Snapcast identifies the stream by which port you connect to, not a
  // name sent over the wire) - it's for the admin's own reference, so a
  // renamed or custom-built Alerts-equivalent stream is still visible in
  // logs.

  function playOnAlerts(strikes, options, volumeFactor) {
    const alertsSettings = options.alertsSettings || {};
    const host = options.snapcastHost || 'localhost';
    const port = alertsSettings.alertsPort || 4953;
    const streamName = alertsSettings.alertsStreamName || 'Alerts';
    const factor = typeof volumeFactor === 'number' ? volumeFactor : 1;

    app.debug(`ships-bells: streaming into Snapcast stream "${streamName}" at ${host}:${port}`);
    const socket = alertsConnectImpl(port, host);
    // Applies the same night-volume reduction webapp/Mopidy playback get,
    // via ffmpeg's own volume filter (a plain linear multiplier, same
    // 0-1 factor nightVolumeFactorForMoment() already produces elsewhere)
    // -- skipped entirely outside the reduced-volume window (factor >= 1)
    // to avoid the filter's re-encode overhead when it wouldn't change
    // anything, same as playOnMopidy's own early-out for the same case.
    const ffmpeg = spawnImpl('ffmpeg', [
      '-i', bellFilePath(strikes),
      ...(factor < 1 ? ['-af', `volume=${factor}`] : []),
      '-ar', '48000',
      '-ac', '2',
      '-sample_fmt', 's16',
      '-f', 'wav',
      '-'
    ]);

    ffmpeg.on('error', (err) => {
      app.error(
        `ships-bells: could not start ffmpeg for alerts playback (${err.message}) - ` +
        "the 'Play via Alerts stream' method needs ffmpeg installed on this machine."
      );
      socket.destroy();
    });
    socket.on('error', (err) => {
      app.error(`ships-bells: alerts stream connection failed: ${err.message || err}`);
      ffmpeg.kill();
    });

    ffmpeg.stdout.pipe(socket);

    return true;
  }

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

    const playbackOutputs = options.playbackOutputs || {};
    const webapp = playbackOutputs.playbackWebapp !== undefined ? !!playbackOutputs.playbackWebapp : true;
    const serverSpeaker = !!playbackOutputs.playbackServerSpeaker;
    const mopidy = !!playbackOutputs.playbackMopidy;
    const alerts = !!playbackOutputs.playbackAlerts;
    app.debug(
      `ships-bells: striking ${strikes} bell(s), file ${bellFile(strikes)}, ` +
      `webapp=${webapp}, serverSpeaker=${serverSpeaker}, mopidy=${mopidy}, alerts=${alerts}`
    );

    const volumeFactor = nightVolumeFactorForMoment(new Date(), options);

    if (webapp) {
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
                  method: [],
                  message: `${strikes} bell(s)`,
                  data: { strikes, file: bellFile(strikes), volumeFactor }
                }
              }
            ]
          }
        ]
      });
    }

    if (serverSpeaker) {
      playOnServerSpeaker(strikes);
    }

    if (mopidy) {
      playOnMopidy(strikes, options, volumeFactor);
    }

    if (alerts) {
      playOnAlerts(strikes, options, volumeFactor);
    }
  }

  function msUntilNextHalfHourBoundary(now, options) {
    if (options && options.utcOffsetEnabled) {
      const shifted = new Date(now.getTime() + (options.utcOffsetMinutes || 0) * 60 * 1000);
      const msPastHalfHour =
        ((shifted.getUTCMinutes() % 30) * 60 + shifted.getUTCSeconds()) * 1000 + shifted.getUTCMilliseconds();
      return 30 * 60 * 1000 - msPastHalfHour;
    }
    const msPastHalfHour = ((now.getMinutes() % 30) * 60 + now.getSeconds()) * 1000 + now.getMilliseconds();
    return 30 * 60 * 1000 - msPastHalfHour;
  }

  // setTimeout has a hard ~24.8 day limit (2^31-1 ms, a 32-bit signed int
  // internally) - delays longer than that overflow and fire almost
  // immediately instead of waiting. The New Year's extra strike needs to
  // wait up to ~365 days between occurrences, so long delays are chunked
  // into safe hops rather than a single setTimeout.
  const MAX_SAFE_TIMEOUT_MS = 20 * 24 * 60 * 60 * 1000; // 20 days

  function scheduleLongTimeout(delayMs, callback, storeTimerId) {
    if (delayMs > MAX_SAFE_TIMEOUT_MS) {
      storeTimerId(setTimeout(() => {
        scheduleLongTimeout(delayMs - MAX_SAFE_TIMEOUT_MS, callback, storeTimerId);
      }, MAX_SAFE_TIMEOUT_MS));
      return;
    }
    storeTimerId(setTimeout(callback, Math.max(0, delayMs)));
  }

  function scheduleNextStrike(options) {
    const now = new Date();
    const delay = msUntilNextHalfHourBoundary(now, options);

    strikeTimer = setTimeout(() => {
      const t = new Date();
      strikeBell(bellCountForMinutes(effectiveMinutesSinceMidnight(t, options), effectiveWatchScheme(options)), options);
      scheduleNextStrike(options);
    }, delay);
  }

  function scheduleNextNewYearExtraStrike(options) {
    const now = new Date();
    const delay = nextNewYearEveTriggerTime(now).getTime() - now.getTime();

    scheduleLongTimeout(
      delay,
      () => {
        strikeBell(8, options);
        scheduleNextNewYearExtraStrike(options);
      },
      (timerId) => { newYearExtraStrikeTimer = timerId; }
    );
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
      utcOffsetEnabled: {
        type: 'boolean',
        title: 'Enable manual UTC time offset',
        description:
          "Runs the bell schedule against UTC-plus-the-offset-below instead of this " +
          "server's local clock, for crews who want the watch bells to sound at " +
          "different times than local wall-clock time would give. When enabled, the " +
          "Watch bell schedule above is forced to Standard - the British Navy dog-watch " +
          "reset is tied to real second-dog-watch clock time, which an arbitrary offset " +
          "would no longer line up with.",
        default: false
      },
      utcOffsetMinutes: {
        type: 'integer',
        title: 'UTC time offset (minutes)',
        description: 'Only used when "Enable manual UTC time offset" is on, above.',
        minimum: 0,
        maximum: 240,
        default: 0
      },
      playbackOutputs: {
        type: 'object',
        title: 'Playback outputs',
        description:
          "Choose where bell strikes play - any combination can be enabled at once. " +
          "Detail settings for each are further down, in the matching section below.",
        properties: {
          playbackWebapp: {
            type: 'boolean',
            title: 'Play in web player',
            description:
              "Plays through the browser wherever this plugin's webapp is open (e.g. " +
              "a helm tablet).",
            default: true
          },
          playbackServerSpeaker: {
            type: 'boolean',
            title: 'Play on server (local speaker)',
            description:
              "Plays directly on the machine running Signal K, via a speaker wired " +
              "to it - no browser needed, but requires the 'play-sound' npm package " +
              "plus a system audio player (e.g. mpg123 or aplay) installed on that " +
              "machine, and that speaker can't also be in use by something else " +
              "(e.g. a Snapcast client for signalk-jukebox) at the same time - use " +
              "Mopidy playback instead in that case.",
            default: false
          },
          playbackMopidy: {
            type: 'boolean',
            title: 'Play via Mopidy sound server',
            description:
              "Sends the bell through a Mopidy instance instead (e.g. " +
              "signalk-jukebox's own container) - see 'Mopidy sound server " +
              "settings' below. If Mopidy is already playing something, it's " +
              "paused (ducked) for the strike and resumed at the same position " +
              "afterward.",
            default: false
          },
          playbackAlerts: {
            type: 'boolean',
            title: 'Play via Alerts stream (signalk-jukebox)',
            description:
              "Streams the bell directly into signalk-jukebox's \"Alerts\" " +
              "Snapcast stream, bypassing Mopidy entirely - see 'Alerts stream " +
              "settings' below. Only zones currently switched to \"Alerts\" in " +
              "signalk-jukebox's own webapp hear it - zones still on \"jukebox\" " +
              "don't, since a Snapcast zone can only be on one stream at a time. " +
              "Unlike Mopidy playback, this never interrupts anything: the Alerts " +
              "stream is entirely separate from whatever's playing on the jukebox " +
              "stream. Requires ffmpeg installed on this machine, to resample the " +
              "bundled bell files (44100:16:2) to the Alerts stream's fixed format " +
              "(48000:16:2) - Snapcast's own intake doesn't resample.",
            default: false
          }
        }
      },
      webPlayerSettings: {
        type: 'object',
        title: 'Web player settings',
        description:
          "No additional settings - only used when 'Play in web player' above is " +
          "checked.",
        properties: {}
      },
      serverSpeakerSettings: {
        type: 'object',
        title: 'Server speaker settings',
        description:
          "No additional settings - only used when 'Play on server (local " +
          "speaker)' above is checked. Requires the 'play-sound' npm package plus " +
          "a system audio player (e.g. mpg123 or aplay) installed on this machine.",
        properties: {}
      },
      mopidySettings: {
        type: 'object',
        title: 'Mopidy sound server settings',
        description: "Only used when 'Play via Mopidy sound server' above is checked.",
        properties: {
          mopidyHost: {
            type: 'string',
            title: 'Mopidy host',
            description:
              "Where this plugin reaches Mopidy's own JSON-RPC API to send the " +
              "play command. Default matches a default signalk-jukebox install on " +
              "this same machine.",
            default: 'localhost'
          },
          mopidyPort: {
            type: 'integer',
            title: 'Mopidy port',
            default: 6680
          },
          mopidyAudioBaseUrl: {
            type: 'string',
            title: 'Mopidy audio base URL (optional)',
            description:
              "Mopidy fetches the bell .wav files over HTTP from this plugin's own " +
              "webapp (they aren't on Mopidy's local disk) - this is the base URL " +
              "it uses to do that, e.g. http://192.168.1.50:3000. This is the " +
              "opposite network direction from Mopidy host/port above, and matters " +
              "when Mopidy runs in a container (e.g. signalk-jukebox): such a " +
              "container usually can't reach this host's own loopback address. " +
              "Leave blank to default to http://localhost:<this Signal K server's " +
              "own port>, which only works if Mopidy's container uses host " +
              "networking; otherwise set this to this Signal K server's real LAN " +
              "IP.",
            default: ''
          },
          snapcastControlPort: {
            type: 'integer',
            title: 'Snapcast control port',
            description:
              "Only used when one or more zones are selected in this plugin's own " +
              "webapp (\"play bells in <zone>\" checkboxes) - reached at the " +
              "Snapcast host set below. Default (1705) matches signalk-jukebox's " +
              "SNAPCAST_CONTROL_PORT. Used to mute every zone except the selected " +
              "ones for the strike, then restore each one's own prior mute state " +
              "afterward.",
            default: 1705
          }
        }
      },
      snapcastHost: {
        type: 'string',
        title: 'Snapcast host',
        description:
          "Where this plugin reaches Snapserver directly (not through Mopidy) - " +
          "shared by Mopidy sound server settings' own zone muting above and by " +
          "Alerts stream settings' own stream connection below, since both usually " +
          "talk to the same Snapserver instance. Default matches a default " +
          "signalk-jukebox install, where Mopidy and Snapserver run in the same " +
          "container; set this separately if Snapserver runs elsewhere.",
        default: 'localhost'
      },
      alertsSettings: {
        type: 'object',
        title: 'Alerts stream settings',
        description: "Only used when 'Play via Alerts stream' above is checked.",
        properties: {
          alertsPort: {
            type: 'integer',
            title: 'Alerts stream port',
            description:
              "Reached at the Snapcast host set above. Default (4953) matches " +
              "signalk-jukebox's ALERTS_PORT.",
            default: 4953
          },
          alertsStreamName: {
            type: 'string',
            title: 'Alerts stream name',
            description:
              "Doesn't affect the connection itself (Snapcast identifies the " +
              "stream by which port you connect to, not a name sent over the " +
              "wire) - shown in this plugin's own log messages, so change it to " +
              "match signalk-jukebox if its Alerts-equivalent stream was ever " +
              "renamed or custom-built.",
            default: 'Alerts'
          }
        }
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
      },
      nightVolumeEnabled: {
        type: 'boolean',
        title: 'Reduce volume during a time range',
        description:
          "For when you don't want to mute the bell entirely, just have it quieter " +
          "overnight. Affects webapp playback (browser volume), Mopidy playback " +
          "(Mopidy's own mixer volume, restored afterward), and Alerts stream " +
          "playback (scaled into the ffmpeg resample via its volume filter) - " +
          "play-sound doesn't offer a portable way to control server-speaker " +
          "output volume, so that always plays at full volume regardless of this " +
          "setting.",
        default: false
      },
      nightVolumeStart: {
        type: 'string',
        title: 'Reduced volume start (HH:MM, 24-hour, ship-local time)',
        default: '22:00'
      },
      nightVolumeEnd: {
        type: 'string',
        title: 'Reduced volume end (HH:MM, 24-hour, ship-local time)',
        description: 'Can be earlier than the start time to span midnight, e.g. 22:00-06:00.',
        default: '06:00'
      },
      nightVolumeLevel: {
        type: 'integer',
        title: 'Reduced volume level (%)',
        description: 'Applied on top of whatever volume the webapp itself is set to.',
        minimum: 0,
        maximum: 100,
        default: 30
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

    // Backs the webapp's reference table (like Wikipedia's Ship's bell
    // page), reflecting the current effective schedule -- including the
    // manual UTC offset, if enabled (SPEC: forces simple-cycle and shifts
    // every row's bell count by the configured offset, same as a live
    // strike would get).
    router.get('/bell-times', (req, res) => {
      res.json(buildBellScheduleTable(currentOptions));
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

    // Lets the webapp show a live "play bells in <zone>" checkbox per
    // signalk-jukebox zone (see playOnMopidy/mopidyZoneIds above) - a plain
    // JSON-schema admin config field can't render a checkbox list populated
    // from a live API call, so this lives in the webapp instead. Proxies
    // signalk-jukebox's own /api/zones (same signalk-server process, reached
    // over its own loopback HTTP port - not the Mopidy/Snapserver ports
    // above, which are a different service). Returns an empty array (not an
    // error) if signalk-jukebox isn't installed or its container isn't up
    // yet, so the webapp can just show "no zones found" rather than break.
    router.get('/zones', (req, res) => {
      const port = (app.config && app.config.settings && app.config.settings.port) || 3000;
      fetchImpl(`http://localhost:${port}/plugins/signalk-jukebox/api/zones`)
        .then((r) => r.json())
        .then((zones) => {
          res.json(Array.isArray(zones) ? zones.map((z) => ({ id: z.id, name: z.name })) : []);
        })
        .catch((err) => {
          app.debug(`ships-bells: could not fetch signalk-jukebox zones: ${err.message || err}`);
          res.json([]);
        });
    });

    router.get('/mopidy-zones', (req, res) => {
      res.json({ zoneIds: Array.isArray(currentOptions.mopidyZoneIds) ? currentOptions.mopidyZoneIds : [] });
    });

    router.put('/mopidy-zones', (req, res) => {
      const zoneIds = req.body && req.body.zoneIds;
      if (!Array.isArray(zoneIds) || !zoneIds.every((id) => typeof id === 'string')) {
        res.status(400).json({ error: 'zoneIds must be an array of strings' });
        return;
      }

      currentOptions.mopidyZoneIds = zoneIds;
      app.savePluginOptions(currentOptions, (err) => {
        if (err) {
          app.error(`ships-bells: failed to save mopidyZoneIds: ${err.message || err}`);
          res.status(500).json({ error: 'Failed to save option' });
          return;
        }
        res.json({ zoneIds: currentOptions.mopidyZoneIds });
      });
    });

    // Read/write the manual UTC offset. Deliberately a separate endpoint from
    // /schedule (rather than folded into it) - the webapp doesn't use this one,
    // it's for external tooling/automation that wants to set the offset without
    // going through the admin config UI. Supports partial updates: PUT only the
    // field(s) you're changing.
    router.get('/offset', (req, res) => {
      res.json({
        utcOffsetEnabled: !!currentOptions.utcOffsetEnabled,
        utcOffsetMinutes: currentOptions.utcOffsetMinutes || 0
      });
    });

    router.put('/offset', (req, res) => {
      const body = req.body || {};
      const { minimum, maximum } = plugin.schema.properties.utcOffsetMinutes;
      const hasEnabled = Object.prototype.hasOwnProperty.call(body, 'utcOffsetEnabled');
      const hasMinutes = Object.prototype.hasOwnProperty.call(body, 'utcOffsetMinutes');

      if (!hasEnabled && !hasMinutes) {
        res.status(400).json({ error: 'Body must include utcOffsetEnabled and/or utcOffsetMinutes' });
        return;
      }
      if (hasEnabled && typeof body.utcOffsetEnabled !== 'boolean') {
        res.status(400).json({ error: 'utcOffsetEnabled must be a boolean' });
        return;
      }
      if (
        hasMinutes &&
        (!Number.isInteger(body.utcOffsetMinutes) || body.utcOffsetMinutes < minimum || body.utcOffsetMinutes > maximum)
      ) {
        res.status(400).json({ error: `utcOffsetMinutes must be an integer between ${minimum} and ${maximum}` });
        return;
      }

      if (hasEnabled) {
        currentOptions.utcOffsetEnabled = body.utcOffsetEnabled;
      }
      if (hasMinutes) {
        currentOptions.utcOffsetMinutes = body.utcOffsetMinutes;
      }

      app.savePluginOptions(currentOptions, (err) => {
        if (err) {
          app.error(`ships-bells: failed to save offset option: ${err.message || err}`);
          res.status(500).json({ error: 'Failed to save option' });
          return;
        }
        res.json({
          utcOffsetEnabled: !!currentOptions.utcOffsetEnabled,
          utcOffsetMinutes: currentOptions.utcOffsetMinutes || 0
        });
      });
    });

    // Lets the "play test bell" button in the webapp also exercise server-speaker
    // and mopidy output when one of those is part of the configured playback
    // method - a plain client-side <audio> play() can't reach either, so this is
    // the only way the test button can cover those paths. Intentionally ignores
    // the anchored/moored mute setting, since a test triggered by hand is
    // deliberate.
    router.post('/test-strike', (req, res) => {
      const strikes = 8;
      const playbackOutputs = currentOptions.playbackOutputs || {};
      const serverSpeaker = !!playbackOutputs.playbackServerSpeaker;
      const mopidy = !!playbackOutputs.playbackMopidy;
      const alerts = !!playbackOutputs.playbackAlerts;

      if (mopidy) {
        playOnMopidy(strikes, currentOptions);
      }
      if (alerts) {
        playOnAlerts(strikes, currentOptions);
      }

      if (!serverSpeaker) {
        res.json({
          playedOnServerSpeaker: false,
          playedOnMopidy: mopidy,
          playedOnAlerts: alerts,
          reason: 'server-speaker playback is not enabled'
        });
        return;
      }

      const played = playOnServerSpeaker(strikes);
      res.json({
        playedOnServerSpeaker: played,
        playedOnMopidy: mopidy,
        playedOnAlerts: alerts,
        reason: played ? undefined : 'play-sound unavailable - check server logs'
      });
    });
  };

  // ---- Lifecycle ------------------------------------------------------------

  // Migrates the old single-select `playbackMethod` ('webapp'/'server-speaker'/
  // 'both'/'mopidy') to the three independent checkboxes it was replaced by, so
  // installs configured before that change keep working without the admin
  // having to re-check anything. Only runs once - a no-op as soon as any of the
  // new keys is present (including a deliberate `false`), and a no-op if there
  // was never a playbackMethod to migrate from (a fresh install).
  function migratePlaybackMethod(options) {
    const hasNewFlags = ['playbackWebapp', 'playbackServerSpeaker', 'playbackMopidy'].some((key) =>
      Object.prototype.hasOwnProperty.call(options, key)
    );
    if (hasNewFlags || !options.playbackMethod) {
      return false;
    }
    const method = options.playbackMethod;
    options.playbackWebapp = method === 'webapp' || method === 'both';
    options.playbackServerSpeaker = method === 'server-speaker' || method === 'both';
    options.playbackMopidy = method === 'mopidy';
    delete options.playbackMethod;
    return true;
  }

  // Migrates the four playback checkboxes and their per-method detail
  // fields (mopidyHost/mopidyPort/mopidyAudioBaseUrl/snapcastControlPort,
  // alertsPort/alertsStreamName) from top-level schema keys into three
  // grouped objects (playbackOutputs/mopidySettings/alertsSettings) - the
  // admin config UI renders a nested schema object as its own fieldset,
  // which is how the four playback checkboxes and each one's own settings
  // get their own visual subsection instead of one long flat list. Same
  // no-op-once pattern as migratePlaybackMethod above (runs right after
  // it, so an install still on the even older playbackMethod shape
  // migrates through both steps in one plugin.start call): a no-op as
  // soon as options.playbackOutputs is already present, and a no-op for a
  // genuinely fresh install with none of the old flat keys either.
  // snapcastHost is deliberately NOT moved - it's shared by mopidySettings'
  // own zone-muting and alertsSettings' own stream connection, so it stays
  // a single top-level field rather than being duplicated into both.
  function migratePlaybackSettingsGrouping(options) {
    if (options.playbackOutputs && typeof options.playbackOutputs === 'object') {
      return false;
    }
    const legacyKeys = [
      'playbackWebapp', 'playbackServerSpeaker', 'playbackMopidy', 'playbackAlerts',
      'mopidyHost', 'mopidyPort', 'mopidyAudioBaseUrl', 'snapcastControlPort',
      'alertsPort', 'alertsStreamName'
    ];
    const hasLegacy = legacyKeys.some((key) => Object.prototype.hasOwnProperty.call(options, key));
    if (!hasLegacy) {
      return false;
    }

    options.playbackOutputs = {
      playbackWebapp: options.playbackWebapp !== undefined ? !!options.playbackWebapp : true,
      playbackServerSpeaker: !!options.playbackServerSpeaker,
      playbackMopidy: !!options.playbackMopidy,
      playbackAlerts: !!options.playbackAlerts
    };
    options.mopidySettings = {
      mopidyHost: options.mopidyHost || 'localhost',
      mopidyPort: options.mopidyPort || 6680,
      mopidyAudioBaseUrl: options.mopidyAudioBaseUrl || '',
      snapcastControlPort: options.snapcastControlPort || 1705
    };
    options.alertsSettings = {
      alertsPort: options.alertsPort || 4953,
      alertsStreamName: options.alertsStreamName || 'Alerts'
    };

    delete options.playbackWebapp;
    delete options.playbackServerSpeaker;
    delete options.playbackMopidy;
    delete options.playbackAlerts;
    delete options.mopidyHost;
    delete options.mopidyPort;
    delete options.mopidyAudioBaseUrl;
    delete options.snapcastControlPort;
    delete options.alertsPort;
    delete options.alertsStreamName;
    return true;
  }

  plugin.start = function (options) {
    app.debug('starting ships-bell plugin', options);

    const migratedMethod = migratePlaybackMethod(options);
    const migratedGrouping = migratePlaybackSettingsGrouping(options);
    if (migratedMethod || migratedGrouping) {
      app.savePluginOptions(options, (err) => {
        if (err) {
          app.error(`ships-bells: failed to save migrated playback options: ${err.message || err}`);
        }
      });
    }

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
    scheduleNextNewYearExtraStrike(currentOptions);
  };

  plugin.stop = function () {
    app.debug('stopping ships-bell plugin');
    if (strikeTimer) {
      clearTimeout(strikeTimer);
      strikeTimer = undefined;
    }
    if (newYearExtraStrikeTimer) {
      clearTimeout(newYearExtraStrikeTimer);
      newYearExtraStrikeTimer = undefined;
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
module.exports.nextNewYearEveTriggerTime = nextNewYearEveTriggerTime;
module.exports.nightVolumeFactorForMoment = nightVolumeFactorForMoment;
module.exports.minutesSinceMidnightUTC = minutesSinceMidnightUTC;
module.exports.effectiveMinutesSinceMidnight = effectiveMinutesSinceMidnight;
module.exports.effectiveWatchScheme = effectiveWatchScheme;
module.exports.buildBellScheduleTable = buildBellScheduleTable;
