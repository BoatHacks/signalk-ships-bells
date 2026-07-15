module.exports = function (app) {
  const plugin = {};

  plugin.id = 'signalk-ships-bell';
  plugin.name = "Ship's Bell";
  plugin.description = "Plays traditional ship's bell audio on the watch schedule";

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
    // TODO: serve/play audio (webapp <audio> trigger via delta, or server-side playback)
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
