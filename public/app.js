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

  var NOTIFICATION_PATH = 'notifications.plugins.signalkShipsBell.strike';
  var BELLS_BASE_URL = 'bells/';

  function bellFileUrl(strikes) {
    return BELLS_BASE_URL + 'bell-strikes-' + strikes + '.wav';
  }

  function playStrike(strikes, label) {
    audioEl.src = bellFileUrl(strikes);
    audioEl.play().catch(function (err) {
      statusEl.textContent = 'Playback blocked - tap the page once, then it will play automatically.';
      console.warn('ships-bell: audio playback failed', err);
    });
    lastStrikeEl.textContent = (label || (strikes + ' bell(s)')) + ' - ' + new Date().toLocaleTimeString();
  }

  testButton.addEventListener('click', function () {
    playStrike(8, 'Test: 8 bells');
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
