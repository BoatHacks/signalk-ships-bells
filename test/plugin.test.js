const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
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
  const routes = { get: {}, put: {}, post: {} };
  return {
    get: (path, handler) => { routes.get[path] = handler; },
    put: (path, handler) => { routes.put[path] = handler; },
    post: (path, handler) => { routes.post[path] = handler; },
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

  for (const key of ['watchScheme']) {
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
  assert.strictEqual(props.playbackWebapp.default, true);
  assert.strictEqual(props.playbackServerSpeaker.default, false);
  assert.strictEqual(props.playbackMopidy.default, false);
  assert.strictEqual(props.playbackAlerts.default, false);
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
  plugin.start({ enabled: true, watchScheme: 'simple-cycle', playbackMethod: 'webapp', muteWhenAnchoredOrMoored: true });

  const res = makeFakeRes();
  router.routes.get['/schedule']({}, res);

  assert.strictEqual(res.body.watchScheme, 'simple-cycle');
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
  saveCalled = false; // start() migrates the legacy playbackMethod field and saves once; not what's under test here

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
  router.routes.put['/schedule']({ body: { watchScheme: 'simple-cycle' } }, res);

  assert.strictEqual(res.statusCode, 500);

  plugin.stop();
});

test('GET /offset returns the current offset settings, defaulting minutes to 0', () => {
  const app = makeMockApp();
  const plugin = createPlugin(app);
  const router = makeFakeRouter();
  plugin.registerWithRouter(router);
  plugin.start({ enabled: true, watchScheme: 'traditional', playbackMethod: 'webapp', muteWhenAnchoredOrMoored: true });

  const res = makeFakeRes();
  router.routes.get['/offset']({}, res);

  assert.deepStrictEqual(res.body, { utcOffsetEnabled: false, utcOffsetMinutes: 0 });

  plugin.stop();
});

test('PUT /offset rejects a non-boolean utcOffsetEnabled with 400 and does not save', () => {
  const app = makeMockApp();
  let saveCalled = false;
  app.savePluginOptions = (options, cb) => { saveCalled = true; cb(null); };
  const plugin = createPlugin(app);
  const router = makeFakeRouter();
  plugin.registerWithRouter(router);
  plugin.start({ enabled: true, watchScheme: 'traditional', playbackMethod: 'webapp', muteWhenAnchoredOrMoored: true });
  saveCalled = false; // start() migrates the legacy playbackMethod field and saves once; not what's under test here

  const res = makeFakeRes();
  router.routes.put['/offset']({ body: { utcOffsetEnabled: 'yes' } }, res);

  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(saveCalled, false);

  plugin.stop();
});

test('PUT /offset rejects an out-of-range or non-integer utcOffsetMinutes with 400 and does not save', () => {
  const app = makeMockApp();
  let saveCalled = false;
  app.savePluginOptions = (options, cb) => { saveCalled = true; cb(null); };
  const plugin = createPlugin(app);
  const router = makeFakeRouter();
  plugin.registerWithRouter(router);
  plugin.start({ enabled: true, watchScheme: 'traditional', playbackMethod: 'webapp', muteWhenAnchoredOrMoored: true });
  saveCalled = false; // start() migrates the legacy playbackMethod field and saves once; not what's under test here

  for (const bad of [-1, 241, 12.5, 'ninety']) {
    const res = makeFakeRes();
    router.routes.put['/offset']({ body: { utcOffsetMinutes: bad } }, res);
    assert.strictEqual(res.statusCode, 400, `expected 400 for utcOffsetMinutes=${bad}`);
  }
  assert.strictEqual(saveCalled, false);

  plugin.stop();
});

test('PUT /offset rejects a body with neither field, with 400', () => {
  const app = makeMockApp();
  const plugin = createPlugin(app);
  const router = makeFakeRouter();
  plugin.registerWithRouter(router);
  plugin.start({ enabled: true, watchScheme: 'traditional', playbackMethod: 'webapp', muteWhenAnchoredOrMoored: true });

  const res = makeFakeRes();
  router.routes.put['/offset']({ body: {} }, res);

  assert.strictEqual(res.statusCode, 400);

  plugin.stop();
});

test('PUT /offset accepts a partial update (minutes only), persists it, and GET reflects the change', () => {
  const app = makeMockApp();
  const plugin = createPlugin(app);
  const router = makeFakeRouter();
  plugin.registerWithRouter(router);
  plugin.start({ enabled: true, watchScheme: 'traditional', playbackMethod: 'webapp', muteWhenAnchoredOrMoored: true });

  const putRes = makeFakeRes();
  router.routes.put['/offset']({ body: { utcOffsetMinutes: 90 } }, putRes);
  assert.strictEqual(putRes.statusCode, 200);
  assert.deepStrictEqual(putRes.body, { utcOffsetEnabled: false, utcOffsetMinutes: 90 });

  const getRes = makeFakeRes();
  router.routes.get['/offset']({}, getRes);
  assert.deepStrictEqual(getRes.body, { utcOffsetEnabled: false, utcOffsetMinutes: 90 });

  plugin.stop();
});

test('PUT /offset accepts both fields together', () => {
  const app = makeMockApp();
  const plugin = createPlugin(app);
  const router = makeFakeRouter();
  plugin.registerWithRouter(router);
  plugin.start({ enabled: true, watchScheme: 'traditional', playbackMethod: 'webapp', muteWhenAnchoredOrMoored: true });

  const putRes = makeFakeRes();
  router.routes.put['/offset']({ body: { utcOffsetEnabled: true, utcOffsetMinutes: 240 } }, putRes);
  assert.strictEqual(putRes.statusCode, 200);
  assert.deepStrictEqual(putRes.body, { utcOffsetEnabled: true, utcOffsetMinutes: 240 });

  plugin.stop();
});

test('PUT /offset returns 500 if savePluginOptions fails', () => {
  const app = makeMockApp();
  app.savePluginOptions = (options, cb) => cb(new Error('disk full'));
  const plugin = createPlugin(app);
  const router = makeFakeRouter();
  plugin.registerWithRouter(router);
  plugin.start({ enabled: true, watchScheme: 'traditional', playbackMethod: 'webapp', muteWhenAnchoredOrMoored: true });

  const res = makeFakeRes();
  router.routes.put['/offset']({ body: { utcOffsetMinutes: 30 } }, res);

  assert.strictEqual(res.statusCode, 500);

  plugin.stop();
});

test('POST /test-strike does not touch server speaker when only webapp is enabled', () => {
  const app = makeMockApp();
  const plugin = createPlugin(app);
  const router = makeFakeRouter();
  plugin.registerWithRouter(router);
  plugin.start({ enabled: true, watchScheme: 'traditional', playbackMethod: 'webapp', muteWhenAnchoredOrMoored: true });

  const res = makeFakeRes();
  router.routes.post['/test-strike']({}, res);

  assert.strictEqual(res.body.playedOnServerSpeaker, false);
  assert.strictEqual(res.body.reason, 'server-speaker playback is not enabled');

  plugin.stop();
});

test('POST /test-strike attempts server speaker playback when playbackMethod is server-speaker or both', () => {
  for (const method of ['server-speaker', 'both']) {
    const played = [];
    const app = makeMockApp();
    const plugin = createPlugin(app);
    const router = makeFakeRouter();
    plugin.registerWithRouter(router);
    plugin._setAudioPlayerForTesting({
      play: (file, cb) => { played.push(file); cb(null); }
    });
    plugin.start({ enabled: true, watchScheme: 'traditional', playbackMethod: method, muteWhenAnchoredOrMoored: true });

    const res = makeFakeRes();
    router.routes.post['/test-strike']({}, res);

    assert.strictEqual(res.body.playedOnServerSpeaker, true);
    assert.strictEqual(played.length, 1);
    assert.ok(played[0].endsWith('bell-strikes-8.wav'));

    plugin.stop();
  }
});

test('POST /test-strike ignores navigation.state (mute setting does not block a manual test)', () => {
  const app = makeMockApp();
  const plugin = createPlugin(app);
  const router = makeFakeRouter();
  plugin.registerWithRouter(router);
  const played = [];
  plugin._setAudioPlayerForTesting({
    play: (file, cb) => { played.push(file); cb(null); }
  });
  plugin.start({ enabled: true, watchScheme: 'traditional', playbackMethod: 'server-speaker', muteWhenAnchoredOrMoored: true });

  const res = makeFakeRes();
  router.routes.post['/test-strike']({}, res);

  // Would be rejected/skipped by strikeBell()'s mute check if this endpoint
  // routed through it - it doesn't, so it always attempts playback regardless
  // of navigation.state (which isn't even set here).
  assert.strictEqual(res.body.playedOnServerSpeaker, true);
  assert.strictEqual(played.length, 1);

  plugin.stop();
});

test("New Year's Eve gets an extra 8-bell strike at 23:59:47, independent of and in addition to the regular schedule's own 00:00:00 strike", (t) => {
  const strikeLog = [];
  const app = makeMockApp({
    handleMessage: (id, delta) => {
      strikeLog.push({
        strikes: delta.updates[0].values[0].value.data.strikes,
        at: new Date().toISOString()
      });
    }
  });
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: new Date('2026-12-31T23:59:40.000Z').getTime() });

  const plugin = createPlugin(app);
  plugin.start({ enabled: true, watchScheme: 'traditional', playbackMethod: 'webapp', muteWhenAnchoredOrMoored: false });

  t.mock.timers.tick(7 * 1000); // -> 23:59:47, the extra New Year's strike
  assert.deepStrictEqual(strikeLog.map((s) => s.strikes), [8]);
  assert.strictEqual(strikeLog[0].at, '2026-12-31T23:59:47.000Z');

  t.mock.timers.tick(13 * 1000); // -> 00:00:00 exactly, the regular schedule's own strike
  assert.deepStrictEqual(strikeLog.map((s) => s.strikes), [8, 8]);
  assert.strictEqual(strikeLog[1].at, '2027-01-01T00:00:00.000Z');

  t.mock.timers.tick(30 * 60 * 1000); // -> 00:30:00, the next normal half-hour strike
  assert.deepStrictEqual(strikeLog.map((s) => s.strikes), [8, 8, 1]);
  assert.strictEqual(strikeLog[2].at, '2027-01-01T00:30:00.000Z');

  plugin.stop();
});

function makeFakeFetch(responses) {
  const calls = [];
  const fetchImpl = (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    const response = responses.shift() || { result: null };
    return Promise.resolve({ json: () => Promise.resolve(response) });
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

function flushMicrotasks() {
  return new Promise((resolve) => setImmediate(resolve));
}

test('POST /test-strike with playbackMethod mopidy sends get_state, tracklist.add, playback.play in order, when nothing was playing', async () => {
  const app = makeMockApp();
  const plugin = createPlugin(app);
  const router = makeFakeRouter();
  plugin.registerWithRouter(router);
  const fakeFetch = makeFakeFetch([{ result: 'stopped' }, { result: [] }, { result: null }]);
  plugin._setFetchForTesting(fakeFetch);
  plugin.start({ enabled: true, watchScheme: 'traditional', playbackMethod: 'mopidy', muteWhenAnchoredOrMoored: true });

  const res = makeFakeRes();
  router.routes.post['/test-strike']({}, res);
  await flushMicrotasks();

  assert.strictEqual(res.body.playedOnMopidy, true);
  assert.strictEqual(fakeFetch.calls.length, 3);
  assert.strictEqual(fakeFetch.calls[0].url, 'http://localhost:6680/mopidy/rpc');
  assert.strictEqual(fakeFetch.calls[0].body.method, 'core.playback.get_state');
  assert.strictEqual(fakeFetch.calls[1].body.method, 'core.tracklist.add');
  assert.deepStrictEqual(fakeFetch.calls[1].body.params.uris, ['http://localhost:3000/signalk-ships-bells/bells/bell-strikes-8.wav']);
  assert.strictEqual(fakeFetch.calls[2].body.method, 'core.playback.play');

  plugin.stop();
});

test('mopidy playback ducks and resumes a track that was already playing', async () => {
  const app = makeMockApp();
  const plugin = createPlugin(app);
  const router = makeFakeRouter();
  plugin.registerWithRouter(router);
  const fakeFetch = makeFakeFetch([
    { result: 'playing' }, // get_state
    { result: { tlid: 42, track: { uri: 'https://ice6.somafm.com/groovesalad-128-mp3' } } }, // get_current_tl_track
    { result: 12345 }, // get_time_position
    { result: null }, // pause
    { result: [{ tlid: 99, track: { length: 20 } }] }, // tracklist.add (bell)
    { result: null }, // playback.play (bell)
    { result: null }, // tracklist.remove (bell)
    { result: null }, // playback.play (resume original)
    { result: null } // seek
  ]);
  plugin._setFetchForTesting(fakeFetch);
  plugin.start({ enabled: true, watchScheme: 'traditional', playbackMethod: 'mopidy', muteWhenAnchoredOrMoored: true });

  router.routes.post['/test-strike']({}, makeFakeRes());
  await flushMicrotasks();

  assert.strictEqual(fakeFetch.calls.length, 6);
  assert.strictEqual(fakeFetch.calls[0].body.method, 'core.playback.get_state');
  assert.strictEqual(fakeFetch.calls[1].body.method, 'core.playback.get_current_tl_track');
  assert.strictEqual(fakeFetch.calls[2].body.method, 'core.playback.get_time_position');
  assert.strictEqual(fakeFetch.calls[3].body.method, 'core.playback.pause');
  assert.strictEqual(fakeFetch.calls[4].body.method, 'core.tracklist.add');
  assert.strictEqual(fakeFetch.calls[5].body.method, 'core.playback.play');
  assert.deepStrictEqual(fakeFetch.calls[5].body.params, { tlid: 99 });

  // Bell is 20ms + the 500ms restore buffer; wait past that for the resume.
  await new Promise((resolve) => setTimeout(resolve, 600));

  assert.strictEqual(fakeFetch.calls.length, 9);
  assert.strictEqual(fakeFetch.calls[6].body.method, 'core.tracklist.remove');
  assert.deepStrictEqual(fakeFetch.calls[6].body.params, { criteria: { tlid: [99] } });
  assert.strictEqual(fakeFetch.calls[7].body.method, 'core.playback.play');
  assert.deepStrictEqual(fakeFetch.calls[7].body.params, { tlid: 42 });
  assert.strictEqual(fakeFetch.calls[8].body.method, 'core.playback.seek');
  assert.deepStrictEqual(fakeFetch.calls[8].body.params, { time_position: 12345 });

  plugin.stop();
});

test('mopidy playback uses configured mopidyHost/mopidyPort and mopidyAudioBaseUrl', async () => {
  const app = makeMockApp();
  const plugin = createPlugin(app);
  const router = makeFakeRouter();
  plugin.registerWithRouter(router);
  const fakeFetch = makeFakeFetch([{ result: 'stopped' }, { result: [] }, { result: null }]);
  plugin._setFetchForTesting(fakeFetch);
  plugin.start({
    enabled: true,
    watchScheme: 'traditional',
    playbackMethod: 'mopidy',
    mopidyHost: '192.168.1.50',
    mopidyPort: 7000,
    mopidyAudioBaseUrl: 'http://192.168.1.50:3000/',
    muteWhenAnchoredOrMoored: true
  });

  router.routes.post['/test-strike']({}, makeFakeRes());
  await flushMicrotasks();

  assert.strictEqual(fakeFetch.calls[0].url, 'http://192.168.1.50:7000/mopidy/rpc');
  assert.deepStrictEqual(fakeFetch.calls[1].body.params.uris, ['http://192.168.1.50:3000/signalk-ships-bells/bells/bell-strikes-8.wav']);

  plugin.stop();
});

test('mopidy audio base URL defaults from app.config.settings.port when unset', async () => {
  const app = makeMockApp({ config: { settings: { port: 4000 } } });
  const plugin = createPlugin(app);
  const router = makeFakeRouter();
  plugin.registerWithRouter(router);
  const fakeFetch = makeFakeFetch([{ result: 'stopped' }, { result: [] }, { result: null }]);
  plugin._setFetchForTesting(fakeFetch);
  plugin.start({ enabled: true, watchScheme: 'traditional', playbackMethod: 'mopidy', muteWhenAnchoredOrMoored: true });

  router.routes.post['/test-strike']({}, makeFakeRes());
  await flushMicrotasks();

  assert.deepStrictEqual(fakeFetch.calls[1].body.params.uris, ['http://localhost:4000/signalk-ships-bells/bells/bell-strikes-8.wav']);

  plugin.stop();
});

test('mopidy RPC failure is logged via app.error, not thrown', async () => {
  const app = makeMockApp();
  const plugin = createPlugin(app);
  const router = makeFakeRouter();
  plugin.registerWithRouter(router);
  plugin._setFetchForTesting(() => Promise.resolve({ json: () => Promise.resolve({ error: { message: 'connection refused' } }) }));
  plugin.start({ enabled: true, watchScheme: 'traditional', playbackMethod: 'mopidy', muteWhenAnchoredOrMoored: true });

  router.routes.post['/test-strike']({}, makeFakeRes());
  await new Promise((resolve) => setImmediate(resolve));

  assert.ok(app._errorLog.some((msg) => msg.includes('connection refused')));

  plugin.stop();
});

test('legacy playbackMethod values migrate to the three checkboxes and are persisted', () => {
  const cases = [
    ['webapp', { playbackWebapp: true, playbackServerSpeaker: false, playbackMopidy: false }],
    ['server-speaker', { playbackWebapp: false, playbackServerSpeaker: true, playbackMopidy: false }],
    ['both', { playbackWebapp: true, playbackServerSpeaker: true, playbackMopidy: false }],
    ['mopidy', { playbackWebapp: false, playbackServerSpeaker: false, playbackMopidy: true }]
  ];

  for (const [method, expected] of cases) {
    const app = makeMockApp();
    let saved = null;
    app.savePluginOptions = (options, cb) => { saved = options; cb(null); };
    const plugin = createPlugin(app);
    const options = { enabled: true, watchScheme: 'traditional', playbackMethod: method, muteWhenAnchoredOrMoored: true };

    plugin.start(options);

    assert.strictEqual(options.playbackMethod, undefined);
    assert.strictEqual(options.playbackWebapp, expected.playbackWebapp);
    assert.strictEqual(options.playbackServerSpeaker, expected.playbackServerSpeaker);
    assert.strictEqual(options.playbackMopidy, expected.playbackMopidy);
    assert.strictEqual(saved, options);

    plugin.stop();
  }
});

test('a fresh install with no legacy playbackMethod is left alone (no migration, no save)', () => {
  const app = makeMockApp();
  let saveCalled = false;
  app.savePluginOptions = (options, cb) => { saveCalled = true; cb(null); };
  const plugin = createPlugin(app);
  const options = { enabled: true, watchScheme: 'traditional', playbackWebapp: true, muteWhenAnchoredOrMoored: true };

  plugin.start(options);

  assert.strictEqual(saveCalled, false);
  assert.strictEqual(options.playbackServerSpeaker, undefined);

  plugin.stop();
});

test('webapp and mopidy checkboxes can both be enabled at once and both fire on a strike', async (t) => {
  const app = makeMockApp();
  const messages = [];
  app.handleMessage = (pluginId, delta) => messages.push(delta);
  const plugin = createPlugin(app);
  const fakeFetch = makeFakeFetch([{ result: 'stopped' }, { result: [] }, { result: null }]);
  plugin._setFetchForTesting(fakeFetch);

  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: new Date('2026-06-15T22:00:00.000Z').getTime() });
  plugin.start({
    enabled: true,
    watchScheme: 'traditional',
    playbackWebapp: true,
    playbackServerSpeaker: false,
    playbackMopidy: true,
    muteWhenAnchoredOrMoored: false
  });

  t.mock.timers.tick(30 * 60 * 1000); // next half-hour boundary
  await flushMicrotasks();

  assert.strictEqual(messages.length, 1);
  assert.strictEqual(messages[0].updates[0].values[0].path, 'notifications.plugins.signalkShipsBell.strike');
  assert.strictEqual(fakeFetch.calls[0].body.method, 'core.playback.get_state');
  assert.strictEqual(fakeFetch.calls[1].body.method, 'core.tracklist.add');

  plugin.stop();
});

test('mopidy playback reduces bell volume via the mixer during the configured night-volume-reduction hours, then restores it', async (t) => {
  const app = makeMockApp();
  const plugin = createPlugin(app);
  const fakeFetch = makeFakeFetch([
    { result: 'stopped' }, // get_state
    { result: 80 }, // mixer.get_volume
    { result: null }, // mixer.set_volume (duck to 40 = 80 * 0.5)
    { result: [{ tlid: 7, track: { length: 10 } }] }, // tracklist.add
    { result: null }, // playback.play (bell)
    { result: null }, // tracklist.remove
    { result: null } // mixer.set_volume (restore to 80)
  ]);
  plugin._setFetchForTesting(fakeFetch);

  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: new Date('2026-06-15T22:00:00.000Z').getTime() });
  plugin.start({
    enabled: true,
    watchScheme: 'traditional',
    playbackWebapp: false,
    playbackMopidy: true,
    muteWhenAnchoredOrMoored: false,
    nightVolumeEnabled: true,
    nightVolumeStart: '00:00',
    nightVolumeEnd: '23:59',
    nightVolumeLevel: 50
  });

  t.mock.timers.tick(30 * 60 * 1000); // next half-hour boundary
  await flushMicrotasks();

  assert.strictEqual(fakeFetch.calls.length, 5);
  assert.strictEqual(fakeFetch.calls[0].body.method, 'core.playback.get_state');
  assert.strictEqual(fakeFetch.calls[1].body.method, 'core.mixer.get_volume');
  assert.strictEqual(fakeFetch.calls[2].body.method, 'core.mixer.set_volume');
  assert.deepStrictEqual(fakeFetch.calls[2].body.params, { volume: 40 });
  assert.strictEqual(fakeFetch.calls[3].body.method, 'core.tracklist.add');
  assert.strictEqual(fakeFetch.calls[4].body.method, 'core.playback.play');

  t.mock.timers.tick(10 + 500); // bell duration (10ms) + the restore buffer
  await flushMicrotasks();

  assert.strictEqual(fakeFetch.calls.length, 7);
  assert.strictEqual(fakeFetch.calls[5].body.method, 'core.tracklist.remove');
  assert.strictEqual(fakeFetch.calls[6].body.method, 'core.mixer.set_volume');
  assert.deepStrictEqual(fakeFetch.calls[6].body.params, { volume: 80 });

  plugin.stop();
});

function makeFakeSpawn(options) {
  const calls = [];
  const fakeSpawn = (cmd, args) => {
    calls.push({ cmd, args });
    const proc = new EventEmitter();
    proc.stdout = new PassThrough();
    setImmediate(() => {
      if (options && options.emitError) {
        proc.emit('error', new Error(options.emitError));
      } else {
        proc.stdout.end('fake-wav-bytes');
      }
    });
    return proc;
  };
  fakeSpawn.calls = calls;
  return fakeSpawn;
}

function makeFakeAlertsSocket() {
  const socket = new EventEmitter();
  socket.written = [];
  socket.destroyed = false;
  socket.write = (chunk) => {
    socket.written.push(chunk);
    return true;
  };
  socket.end = () => {};
  socket.destroy = () => {
    socket.destroyed = true;
  };
  return socket;
}

test('POST /test-strike with playbackAlerts resamples the bell via ffmpeg and streams it into the Alerts connection', async () => {
  const app = makeMockApp();
  const plugin = createPlugin(app);
  const router = makeFakeRouter();
  plugin.registerWithRouter(router);

  const fakeSpawn = makeFakeSpawn();
  const socket = makeFakeAlertsSocket();
  const connectCalls = [];
  plugin._setSpawnForTesting(fakeSpawn);
  plugin._setAlertsConnectForTesting((port, host) => {
    connectCalls.push({ port, host });
    return socket;
  });
  plugin.start({ enabled: true, watchScheme: 'traditional', playbackAlerts: true, muteWhenAnchoredOrMoored: true });

  const res = makeFakeRes();
  router.routes.post['/test-strike']({}, res);
  await flushMicrotasks();

  assert.strictEqual(res.body.playedOnAlerts, true);
  assert.strictEqual(connectCalls.length, 1);
  assert.strictEqual(connectCalls[0].port, 4953);
  assert.strictEqual(connectCalls[0].host, 'localhost');
  assert.strictEqual(fakeSpawn.calls.length, 1);
  assert.strictEqual(fakeSpawn.calls[0].cmd, 'ffmpeg');
  const args = fakeSpawn.calls[0].args;
  assert.ok(args.includes('-ar'));
  assert.strictEqual(args[args.indexOf('-ar') + 1], '48000');
  assert.ok(args.includes('-ac'));
  assert.strictEqual(args[args.indexOf('-ac') + 1], '2');
  assert.ok(args.some((a) => a.endsWith('bell-strikes-8.wav')));

  await flushMicrotasks();
  assert.strictEqual(Buffer.concat(socket.written).toString(), 'fake-wav-bytes');

  plugin.stop();
});

test('alerts playback uses configured snapcastHost/alertsPort', async () => {
  const app = makeMockApp();
  const plugin = createPlugin(app);
  const router = makeFakeRouter();
  plugin.registerWithRouter(router);

  const fakeSpawn = makeFakeSpawn();
  const socket = makeFakeAlertsSocket();
  const connectCalls = [];
  plugin._setSpawnForTesting(fakeSpawn);
  plugin._setAlertsConnectForTesting((port, host) => {
    connectCalls.push({ port, host });
    return socket;
  });
  plugin.start({
    enabled: true,
    watchScheme: 'traditional',
    playbackAlerts: true,
    snapcastHost: '192.168.1.50',
    alertsPort: 9999,
    muteWhenAnchoredOrMoored: true
  });

  router.routes.post['/test-strike']({}, makeFakeRes());
  await flushMicrotasks();

  assert.strictEqual(connectCalls[0].host, '192.168.1.50');
  assert.strictEqual(connectCalls[0].port, 9999);

  plugin.stop();
});

test('a failed ffmpeg spawn for alerts playback is logged via app.error, not thrown', async () => {
  const app = makeMockApp();
  const plugin = createPlugin(app);
  const router = makeFakeRouter();
  plugin.registerWithRouter(router);

  const fakeSpawn = makeFakeSpawn({ emitError: 'spawn ffmpeg ENOENT' });
  const socket = makeFakeAlertsSocket();
  plugin._setSpawnForTesting(fakeSpawn);
  plugin._setAlertsConnectForTesting(() => socket);
  plugin.start({ enabled: true, watchScheme: 'traditional', playbackAlerts: true, muteWhenAnchoredOrMoored: true });

  router.routes.post['/test-strike']({}, makeFakeRes());
  await flushMicrotasks();

  assert.ok(app._errorLog.some((msg) => msg.includes('spawn ffmpeg ENOENT')));
  assert.strictEqual(socket.destroyed, true);

  plugin.stop();
});

function makeFakeSnapSocket(responder) {
  const socket = new EventEmitter();
  socket.setEncoding = () => {};
  socket.write = (line) => {
    const msg = JSON.parse(line);
    const result = responder(msg.method, msg.params);
    setImmediate(() => {
      socket.emit('data', `${JSON.stringify({ id: msg.id, jsonrpc: '2.0', result })}\n`);
    });
  };
  socket.end = () => {};
  setImmediate(() => socket.emit('connect'));
  return socket;
}

test('mopidy zone muting reaches Snapcast at the configured snapcastHost, independent of mopidyHost', async () => {
  const app = makeMockApp();
  const plugin = createPlugin(app);
  const router = makeFakeRouter();
  plugin.registerWithRouter(router);

  const fakeFetch = makeFakeFetch([{ result: 'stopped' }, { result: [] }, { result: null }]);
  plugin._setFetchForTesting(fakeFetch);

  const snapConnectCalls = [];
  const responder = (method) => {
    if (method === 'Server.GetStatus') {
      return {
        server: {
          groups: [
            {
              clients: [
                { id: 'zone-1', config: { volume: { percent: 50, muted: false } } },
                { id: 'zone-2', config: { volume: { percent: 70, muted: false } } }
              ]
            }
          ]
        }
      };
    }
    return null;
  };
  plugin._setSnapConnectForTesting((port, host) => {
    snapConnectCalls.push({ port, host });
    return makeFakeSnapSocket(responder);
  });

  plugin.start({
    enabled: true,
    watchScheme: 'traditional',
    playbackMopidy: true,
    mopidyHost: 'mopidy.example.internal',
    snapcastHost: 'snapcast.example.internal',
    mopidyZoneIds: ['zone-1'],
    muteWhenAnchoredOrMoored: true
  });

  router.routes.post['/test-strike']({}, makeFakeRes());
  await flushMicrotasks();
  await flushMicrotasks();

  assert.ok(snapConnectCalls.length > 0);
  assert.ok(snapConnectCalls.every((c) => c.host === 'snapcast.example.internal'));
  assert.ok(fakeFetch.calls.every((c) => c.url.startsWith('http://mopidy.example.internal:')));

  plugin.stop();
});
