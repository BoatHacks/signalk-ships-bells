const path = require('path');

module.exports = function (app) {
  const plugin = {};

  plugin.id = 'signalk-ships-bell';
  plugin.name = "Ship's Bell";
  plugin.description = "Plays traditional ship's bell audio on the watch schedule";

  // One audio file per strike count (1-8), e.g. bell-strikes-3.wav for three bells
  const bellsDir = path.join(__dirname, 'assets', 'bells');
  const bellFile = (strikes) => `bell-strikes-${strikes}.wav`;

  let timer;

  plugin.schema = {
    type: 'object',
    properties: {
      enabled: {
        type: 'boolean',
        title: 'Enable bell strikes',
        default: true
      }
    }
  };

  plugin.start = function (options) {
    app.debug('starting ships-bell plugin', options);
    // TODO: schedule bell strikes based on ship's local time / watch schedule
    // TODO: on each half-hour, determine strike count (1-8) and trigger playback of
    //       bellFile(strikes) from bellsDir - e.g. via a signalk-server-configured
    //       webapp path (/plugins/signalk-ships-bell/assets/bells/...) so the browser
    //       can <audio> play it, or server-side playback if running headless.
  };

  plugin.stop = function () {
    app.debug('stopping ships-bell plugin');
    if (timer) {
      clearInterval(timer);
      timer = undefined;
    }
  };

  return plugin;
};
