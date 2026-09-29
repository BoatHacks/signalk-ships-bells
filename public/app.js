(function () {
  var statusEl = document.getElementById('status');
  var lastStrikeEl = document.getElementById('last-strike');
  var audioEl = document.getElementById('bell-audio');
  var testButton = document.getElementById('test-button');
  var volumeEl = document.getElementById('volume');
  var muteButton = document.getElementById('mute-button');

  var STORAGE_KEY = 'signalk-ships-bells:audio-prefs';

  function loadPrefs() {
    try {
      var stored = JSON.parse(localStorage.getItem(STORAGE_KEY));
      return {
        volume: typeof stored?.volume === 'number' ? stored.volume : 80,
        muted: !!stored?.muted
      };
    } catch (e) {
      return { volume: 80, muted: false };
    }
  }

  function savePrefs(prefs) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
    } catch (e) {
      // localStorage unavailable (private browsing etc) - just skip persisting
    }
  }

  var prefs = loadPrefs();

  function applyPrefs() {
    audioEl.volume = prefs.volume / 100;
    audioEl.muted = prefs.muted;
    volumeEl.value = prefs.volume;
    muteButton.setAttribute('aria-pressed', String(prefs.muted));
    muteButton.textContent = prefs.muted ? 'Unmute' : 'Mute';
  }

  applyPrefs();

  volumeEl.addEventListener('input', function () {
    prefs.volume = Number(volumeEl.value);
    if (prefs.volume > 0 && prefs.muted) {
      prefs.muted = false;
    }
    applyPrefs();
    savePrefs(prefs);
  });

  muteButton.addEventListener('click', function () {
    prefs.muted = !prefs.muted;
    applyPrefs();
    savePrefs(prefs);
  });

  var scheduleSelect = document.getElementById('schedule-select');
  var scheduleStatus = document.getElementById('schedule-status');
  var API_BASE = '/plugins/signalk-ships-bells';

  // Signal K's admin UI login is token-based (a JWT stored in localStorage),
  // not cookie-based, so being logged into the admin UI in this browser does
  // NOT automatically authenticate this webapp's own fetch calls - the token
  // has to be read out of localStorage and sent explicitly. localStorage is
  // shared across pages on the same origin, so this picks up the same login
  // used by the admin UI (and any other Signal K webapp) without a separate
  // login step here.
  function authHeaders() {
    var token = localStorage.getItem('token');
    return token ? { Authorization: 'Bearer ' + token } : {};
  }

  function statusTextForResponse(res, fallback) {
    if (res.status === 401 || res.status === 403) {
      return 'Log in to the Signal K server to ' + fallback + '.';
    }
    return null;
  }

  function loadSchedule() {
    fetch(API_BASE + '/schedule', { headers: authHeaders() })
      .then(function (res) {
        if (!res.ok) {
          var err = new Error('status ' + res.status);
          err.statusText = statusTextForResponse(res, 'load the schedule');
          throw err;
        }
        return res.json();
      })
      .then(function (data) {
        scheduleSelect.innerHTML = '';
        (data.options || []).forEach(function (opt) {
          var el = document.createElement('option');
          el.value = opt.value;
          el.textContent = opt.label;
          scheduleSelect.appendChild(el);
        });
        scheduleSelect.value = data.watchScheme;
        scheduleSelect.disabled = false;
      })
      .catch(function (err) {
        scheduleStatus.textContent = err.statusText || 'Could not load schedule options.';
        console.warn('ships-bells: failed to load schedule', err);
      });
  }

  scheduleSelect.addEventListener('change', function () {
    var watchScheme = scheduleSelect.value;
    scheduleStatus.textContent = 'Saving...';
    fetch(API_BASE + '/schedule', {
      method: 'PUT',
      headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()),
      body: JSON.stringify({ watchScheme: watchScheme })
    })
      .then(function (res) {
        if (!res.ok) {
          var err = new Error('status ' + res.status);
          err.statusText = statusTextForResponse(res, 'change the schedule');
          throw err;
        }
        return res.json();
      })
      .then(function () {
        scheduleStatus.textContent = 'Saved.';
        setTimeout(function () { scheduleStatus.textContent = ''; }, 2000);
        loadBellTimes(); // the reference table's bell counts depend on the scheme
      })
      .catch(function (err) {
        scheduleStatus.textContent = err.statusText || 'Failed to save - try again.';
        console.warn('ships-bells: failed to save schedule', err);
      });
  });

  loadSchedule();

  var mopidyZonesControl = document.getElementById('mopidy-zones-control');
  var mopidyZonesList = document.getElementById('mopidy-zones-list');
  var mopidyZonesStatus = document.getElementById('mopidy-zones-status');

  function saveMopidyZones(zoneIds) {
    mopidyZonesStatus.textContent = 'Saving...';
    fetch(API_BASE + '/mopidy-zones', {
      method: 'PUT',
      headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()),
      body: JSON.stringify({ zoneIds: zoneIds })
    })
      .then(function (res) {
        if (!res.ok) {
          var err = new Error('status ' + res.status);
          err.statusText = statusTextForResponse(res, 'change zone selection');
          throw err;
        }
        return res.json();
      })
      .then(function () {
        mopidyZonesStatus.textContent = 'Saved.';
        setTimeout(function () { mopidyZonesStatus.textContent = ''; }, 2000);
      })
      .catch(function (err) {
        mopidyZonesStatus.textContent = err.statusText || 'Failed to save - try again.';
        console.warn('ships-bells: failed to save mopidy zones', err);
      });
  }

  function loadMopidyZones() {
    fetch(API_BASE + '/zones', { headers: authHeaders() })
      .then(function (res) { return res.json(); })
      .then(function (zones) {
        if (!Array.isArray(zones) || zones.length === 0) {
          return;
        }
        return fetch(API_BASE + '/mopidy-zones', { headers: authHeaders() })
          .then(function (res) { return res.json(); })
          .then(function (data) {
            var selected = (data && data.zoneIds) || [];
            mopidyZonesList.innerHTML = '';
            zones.forEach(function (zone) {
              var label = document.createElement('label');
              var checkbox = document.createElement('input');
              checkbox.type = 'checkbox';
              checkbox.value = zone.id;
              checkbox.checked = selected.indexOf(zone.id) !== -1;
              checkbox.addEventListener('change', function () {
                var checked = Array.prototype.slice
                  .call(mopidyZonesList.querySelectorAll('input:checked'))
                  .map(function (el) { return el.value; });
                saveMopidyZones(checked);
              });
              label.appendChild(checkbox);
              label.appendChild(document.createTextNode(zone.name || zone.id));
              mopidyZonesList.appendChild(label);
            });
            mopidyZonesControl.style.display = 'block';
          });
      })
      .catch(function (err) {
        console.warn('ships-bells: failed to load zones', err);
      });
  }

  loadMopidyZones();

  // ---- Bell schedule reference table (like Wikipedia's Ship's bell page) --
  var bellTimesStatus = document.getElementById('bell-times-status');
  var bellTimesBody = document.getElementById('bell-times-body');
  var bellTimesRows = []; // cached {watch, time, bells} from the last fetch
  var bellTimesUsesUtc = false;
  var bellTimesShipsOffset = null; // minutes east of UTC, when on ship's time
  var highlightTimer = null;

  function bellPattern(n) {
    // A dot per bell, grouped in pairs with a gap between pairs (a plain-
    // text approximation of the paired "ding-ding" strike pattern the
    // Wikipedia table itself uses dots for) -- a lone trailing bell (odd
    // counts) stands alone, same as it actually rings.
    var groups = [];
    var remaining = n;
    while (remaining >= 2) {
      groups.push('●●');
      remaining -= 2;
    }
    if (remaining === 1) {
      groups.push('●');
    }
    return groups.join(' ');
  }

  function currentRowTime() {
    // The table's row times are UTC clock marks when the manual offset is
    // enabled (buildBellScheduleTable's own convention, matching what
    // effectiveMinutesSinceMidnight() actually reads), local wall-clock
    // marks otherwise -- match whichever this browser's own clock should
    // be compared against so "now" highlights the right row.
    // With ship's time the rows are ship-local marks, which this browser's
    // own timezone may not match, so shift UTC by the ship's offset.
    var now = new Date();
    var h;
    var m;
    if (bellTimesShipsOffset !== null) {
      var shipMinutes = (((now.getUTCHours() * 60 + now.getUTCMinutes() + bellTimesShipsOffset) % 1440) + 1440) % 1440;
      h = Math.floor(shipMinutes / 60);
      m = shipMinutes % 60;
    } else {
      h = bellTimesUsesUtc ? now.getUTCHours() : now.getHours();
      m = bellTimesUsesUtc ? now.getUTCMinutes() : now.getMinutes();
    }
    var halfHour = m < 30 ? 0 : 30;
    return String(h).padStart(2, '0') + ':' + String(halfHour).padStart(2, '0');
  }

  function highlightCurrentRow() {
    var target = currentRowTime();
    Array.prototype.forEach.call(bellTimesBody.children, function (row) {
      row.classList.toggle('current-row', row.dataset.time === target);
    });
  }

  function renderBellTimes(data) {
    bellTimesRows = data.rows || [];
    bellTimesUsesUtc = !!data.usesUtc;
    bellTimesShipsOffset = typeof data.shipsTimeOffsetMinutes === 'number' ? data.shipsTimeOffsetMinutes : null;

    var notes = [];
    if (bellTimesUsesUtc) {
      notes.push('Manual UTC offset is enabled - times below are UTC clock times.');
    } else if (bellTimesShipsOffset !== null) {
      notes.push("Times below are ship's time (from signalk-ships-time).");
    } else if (data.timeSource === 'ships-time') {
      notes.push("Ship's time is selected but no offset has arrived from signalk-ships-time yet - times below are this server's local time.");
    }
    var hasMuted = bellTimesRows.some(function (r) { return r.muted; });
    var hasReduced = bellTimesRows.some(function (r) { return r.reducedVolume; });
    if (hasMuted || hasReduced) {
      var legend = [];
      if (hasReduced) legend.push('subdued text = reduced volume');
      if (hasMuted) legend.push('strikethrough = muted');
      notes.push(legend.join(', ') + '.');
    }
    bellTimesStatus.textContent = notes.join(' ');

    bellTimesBody.innerHTML = '';
    var lastWatch = null;
    var lastWatchCell = null;
    bellTimesRows.forEach(function (row) {
      var tr = document.createElement('tr');
      tr.dataset.time = row.time;
      if (row.muted) {
        tr.classList.add('muted-row');
      } else if (row.reducedVolume) {
        tr.classList.add('reduced-row');
      }

      if (row.watch !== lastWatch) {
        var watchCell = document.createElement('td');
        watchCell.className = 'watch-name';
        watchCell.textContent = row.watch;
        watchCell.rowSpan = 1;
        tr.appendChild(watchCell);
        lastWatch = row.watch;
        lastWatchCell = watchCell;
      } else if (lastWatchCell) {
        lastWatchCell.rowSpan += 1;
      }

      var timeCell = document.createElement('td');
      timeCell.textContent = row.time;
      tr.appendChild(timeCell);

      var bellsCell = document.createElement('td');
      bellsCell.className = 'bells';
      bellsCell.textContent = bellPattern(row.bells) + ' (' + row.bells + ')';
      tr.appendChild(bellsCell);

      bellTimesBody.appendChild(tr);
    });

    highlightCurrentRow();
  }

  function loadBellTimes() {
    fetch(API_BASE + '/bell-times', { headers: authHeaders() })
      .then(function (res) {
        if (!res.ok) {
          var err = new Error('status ' + res.status);
          err.statusText = statusTextForResponse(res, 'load the bell schedule table');
          throw err;
        }
        return res.json();
      })
      .then(renderBellTimes)
      .catch(function (err) {
        bellTimesStatus.textContent = err.statusText || 'Could not load the bell schedule table.';
        console.warn('ships-bells: failed to load bell times', err);
      });
  }

  loadBellTimes();
  // Re-check every minute which row is "now" -- purely a client-side
  // highlight, no need to re-fetch the table itself for this.
  highlightTimer = setInterval(highlightCurrentRow, 60 * 1000);

  var NOTIFICATION_PATH = 'notifications.plugins.signalkShipsBell.strike';
  var BELLS_BASE_URL = 'bells/';

  function bellFileUrl(strikes) {
    return BELLS_BASE_URL + 'bell-strikes-' + strikes + '.wav';
  }

  function playStrike(strikes, label, volumeFactor) {
    audioEl.src = bellFileUrl(strikes);
    audioEl.volume = (prefs.volume / 100) * (typeof volumeFactor === 'number' ? volumeFactor : 1);
    var playPromise = audioEl.play();
    if (playPromise && typeof playPromise.then === 'function') {
      playPromise
        .then(function () {
          statusEl.textContent = 'Connected, waiting for the next bell...';
        })
        .catch(function (err) {
          statusEl.textContent = 'Playback blocked - tap the page once, then it will play automatically.';
          console.warn('ships-bells: audio playback failed', err);
        });
    }
    lastStrikeEl.textContent = (label || (strikes + ' bell(s)')) + ' - ' + new Date().toLocaleTimeString();
  }

  testButton.addEventListener('click', function () {
    playStrike(8, 'Test: 8 bells');
    fetch(API_BASE + '/test-strike', { method: 'POST' })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (data.playedOnServerSpeaker) {
          console.log('ships-bells: test also played on server speaker');
        }
        if (data.playedOnMopidy) {
          console.log('ships-bells: test also played on Mopidy sound server');
        }
        if (data.playedOnAlerts) {
          console.log('ships-bells: test also played on Alerts stream');
        }
        if (!data.playedOnServerSpeaker && data.reason && data.reason !== 'server-speaker playback is not enabled') {
          console.warn('ships-bells: server-speaker test failed -', data.reason);
        }
      })
      .catch(function (err) {
        console.warn('ships-bells: could not reach test-strike endpoint', err);
      });
  });

  function connect() {
    var protocol = location.protocol === 'https:' ? 'wss://' : 'ws://';
    var ws = new WebSocket(protocol + location.host + '/signalk/v1/stream?subscribe=none');

    ws.onopen = function () {
      statusEl.textContent = 'Connected, waiting for the next bell...';
      ws.send(JSON.stringify({
        context: 'vessels.self',
        subscribe: [
          { path: NOTIFICATION_PATH, period: 1000 }
        ]
      }));
    };

    ws.onmessage = function (event) {
      var delta;
      try {
        delta = JSON.parse(event.data);
      } catch (e) {
        return;
      }
      if (!delta.updates) {
        return;
      }
      delta.updates.forEach(function (update) {
        (update.values || []).forEach(function (v) {
          if (v.path === NOTIFICATION_PATH && v.value && v.value.data) {
            playStrike(v.value.data.strikes, v.value.message, v.value.data.volumeFactor);
          }
        });
      });
    };

    ws.onclose = function () {
      statusEl.textContent = 'Disconnected, retrying...';
      setTimeout(connect, 3000);
    };

    ws.onerror = function () {
      ws.close();
    };
  }

  connect();
})();
