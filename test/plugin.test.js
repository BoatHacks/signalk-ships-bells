const { test } = require('node:test');
const assert = require('node:assert/strict');
const createPlugin = require('../index.js');

function makeMockApp(overrides) {
  const noop = () => {};
  const debugLog = [];
  const errorLog = [];
  return Object.assign(
    {
      debug: (msg) => debugLog.push(msg),
      error: (msg) => errorLog.push(msg),
      handleMessage: noop,
      streambundle: { getSelfStream: () => ({ onValue: () => noop }) },
      savePluginOptions: (options, cb) => cb(null),
      _debugLog: debugLog,
      _errorLog: errorLog
    },
    overrides
  );
}

function makeFakeRouter() {
  const routes = { get: {}, put: {} };
  return {
    get: (path, handler) => { routes.get[path] = handler; },
    put: (path, handler) => { routes.put[path] = handler; },
    routes
  };
}

function makeFakeRes() {
  const res = {
    statusCode: 200,
    body: undefined,
    status(code) { res.statusCode = code; return res; },
    json(body) { res.body = body; return res; }
  };
  return res;
}

test('plugin has the required identity fields', () => {
  const app = makeMockApp();
  const plugin = createPlugin(app);
  assert.strictEqual(plugin.id, 'signalk-ships-bells');
  assert.strictEqual(typeof plugin.name, 'string');
  assert.ok(plugin.name.length > 0);
  assert.strictEqual(typeof plugin.description, 'string');
  assert.ok(plugin.description.length > 0);
});

test('schema enum/enumNames stay in sync and defaults are valid members', () => {
  const app = makeMockApp();
  const plugin = createPlugin(app);
  const props = plugin.schema.properties;

  for (const key of ['watchScheme', 'playbackMethod']) {
    assert.ok(Array.isArray(props[key].enum), `${key}.enum should be an array`);
    assert.ok(Array.isArray(props[key].enumNames), `${key}.enumNames should be an array`);
    assert.strictEqual(
      props[key].enum.length,
      props[key].enumNames.length,
      `${key}.enum and enumNames must be the same length`
    );
    assert.ok(
      props[key].enum.includes(props[key].default),
      `${key}.default must be one of its own enum values`
    );
  }

  assert.strictEqual(typeof props.enabled.default, 'boolean');
  assert.strictEqual(typeof props.muteWhenAnchoredOrMoored.default, 'boolean');
});

test('start()/stop() do not throw when enabled, and stop() clears its timers', () => {
  const app = makeMockApp();
  const plugin = createPlugin(app);
  assert.doesNotThrow(() => {
    plugin.start({
      enabled: true,
      watchScheme: 'traditional',
      playbackMethod: 'webapp',
      muteWhenAnchoredOrMoored: true
    });
  });
  assert.doesNotThrow(() => plugin.stop());
});

test('start() with enabled:false does not schedule anything, and stop() is still safe', () => {
  const app = makeMockApp();
  const plugin = createPlugin(app);
  assert.doesNotThrow(() => plugin.start({ enabled: false }));
  assert.doesNotThrow(() => plugin.stop());
});

test('supports restart (stop then start again) without throwing', () => {
  const app = makeMockApp();
  const plugin = createPlugin(app);
  const options = {
    enabled: true,
    watchScheme: 'simple-cycle',
    playbackMethod: 'both',
    muteWhenAnchoredOrMoored: false
  };
  plugin.start(options);
  plugin.stop();
  assert.doesNotThrow(() => plugin.start(options));
  plugin.stop();
});

test('GET /schedule returns the current watch scheme and the full option list', () => {
  const app = makeMockApp();
  const plugin = createPlugin(app);
  const router = makeFakeRouter();
  plugin.registerWithRouter(router);
  plugin.start({ enabled: true, watchScheme: 'pre-1797', playbackMethod: 'webapp', muteWhenAnchoredOrMoored: true });

  const res = makeFakeRes();
  router.routes.get['/schedule']({}, res);

  assert.strictEqual(res.body.watchScheme, 'pre-1797');
  assert.ok(Array.isArray(res.body.options));
  assert.strictEqual(res.body.options.length, plugin.schema.properties.watchScheme.enum.length);
  assert.ok(res.body.options.every((o) => typeof o.value === 'string' && typeof o.label === 'string'));

  plugin.stop();
});

test('PUT /schedule rejects an invalid scheme with 400 and does not call savePluginOptions', () => {
  const app = makeMockApp();
  let saveCalled = false;
  app.savePluginOptions = (options, cb) => { saveCalled = true; cb(null); };
  const plugin = createPlugin(app);
  const router = makeFakeRouter();
  plugin.registerWithRouter(router);
  plugin.start({ enabled: true, watchScheme: 'traditional', playbackMethod: 'webapp', muteWhenAnchoredOrMoored: true });

  const res = makeFakeRes();
  router.routes.put['/schedule']({ body: { watchScheme: 'not-a-real-scheme' } }, res);

  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(saveCalled, false);

  plugin.stop();
});

test('PUT /schedule accepts a valid scheme, persists it, and GET reflects the change', () => {
  const app = makeMockApp();
  const plugin = createPlugin(app);
  const router = makeFakeRouter();
  plugin.registerWithRouter(router);
  plugin.start({ enabled: true, watchScheme: 'traditional', playbackMethod: 'webapp', muteWhenAnchoredOrMoored: true });

  const putRes = makeFakeRes();
  router.routes.put['/schedule']({ body: { watchScheme: 'simple-cycle' } }, putRes);
  assert.strictEqual(putRes.statusCode, 200);
  assert.strictEqual(putRes.body.watchScheme, 'simple-cycle');

  const getRes = makeFakeRes();
  router.routes.get['/schedule']({}, getRes);
  assert.strictEqual(getRes.body.watchScheme, 'simple-cycle');

  plugin.stop();
});

test('PUT /schedule returns 500 if savePluginOptions fails', () => {
  const app = makeMockApp();
  app.savePluginOptions = (options, cb) => cb(new Error('disk full'));
  const plugin = createPlugin(app);
  const router = makeFakeRouter();
  plugin.registerWithRouter(router);
  plugin.start({ enabled: true, watchScheme: 'traditional', playbackMethod: 'webapp', muteWhenAnchoredOrMoored: true });

  const res = makeFakeRes();
  router.routes.put['/schedule']({ body: { watchScheme: 'pre-1797' } }, res);

  assert.strictEqual(res.statusCode, 500);

  plugin.stop();
});
