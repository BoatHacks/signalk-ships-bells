(function () {
  var statusEl = document.getElementById('status');
  var lastStrikeEl = document.getElementById('last-strike');
  var audioEl = document.getElementById('bell-audio');
  var testButton = document.getElementById('test-button');

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
