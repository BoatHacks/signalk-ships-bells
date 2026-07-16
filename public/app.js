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

  function loadSchedule() {
    fetch(API_BASE + '/schedule')
      .then(function (res) {
        if (!res.ok) {
          throw new Error('status ' + res.status);
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
        scheduleStatus.textContent = 'Could not load schedule options.';
        console.warn('ships-bells: failed to load schedule', err);
      });
  }

  scheduleSelect.addEventListener('change', function () {
    var watchScheme = scheduleSelect.value;
    scheduleStatus.textContent = 'Saving...';
    fetch(API_BASE + '/schedule', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ watchScheme: watchScheme })
    })
      .then(function (res) {
        if (!res.ok) {
          throw new Error('status ' + res.status);
        }
        return res.json();
      })
      .then(function () {
        scheduleStatus.textContent = 'Saved.';
        setTimeout(function () { scheduleStatus.textContent = ''; }, 2000);
      })
      .catch(function (err) {
        scheduleStatus.textContent = 'Failed to save - try again.';
        console.warn('ships-bells: failed to save schedule', err);
      });
  });

  loadSchedule();

  var NOTIFICATION_PATH = 'notifications.plugins.signalkShipsBell.strike';
  var BELLS_BASE_URL = 'bells/';

  function bellFileUrl(strikes) {
    return BELLS_BASE_URL + 'bell-strikes-' + strikes + '.wav';
  }

  function playStrike(strikes, label) {
    audioEl.src = bellFileUrl(strikes);
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
        } else if (data.reason && data.reason !== 'playbackMethod is webapp-only') {
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
            playStrike(v.value.data.strikes, v.value.message);
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
