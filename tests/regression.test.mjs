import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { randomBytes, X509Certificate } from 'node:crypto';
import { join, dirname } from 'node:path';
import vm from 'node:vm';

// Exercise production functions without importing the DSH runtime, touching real
// connection files, rendering React, or contacting a real Surge instance.
const hostSource = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  .replace(/^import[\s\S]*?from '[^']+';\n/gm, '').replace(/^export /gm, '');
const clientSource = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
const pkgJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const conn = (id, host = id + '.local') => ({ id, name: id, host, port: 6171, protocol: 'http', apiKey: 'test-only', platform: 'auto' });
const dataFor = path => ({
  '/v1/traffic': { interface: { all: { inCurrentSpeed: 10, outCurrentSpeed: 3, in: 100, out: 20 } }, startTime: 1700000000, connector: {} },
  '/v1/outbound': { mode: 'rule' }, '/v1/requests/recent': { requests: [] },
  '/v1/devices': { devices: [] }, '/v1/events': { events: [] },
  '/v1/policies': { 'policy-groups': [], proxies: [] }, '/v1/modules': { enabled: [] },
  '/v1/rules': { rules: [] }, '/v1/dns': { dnsCache: [] }, '/v1/profiles/current': { name: 'Test' }
})[path];
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

function hostHarness(initial = { activeId: 'a', connections: [conn('a'), conn('b')] }, opts = {}) {
  const files = new Map([['/test/.dsh/surge-panel-connections.json', JSON.stringify(initial)]]);
  if (opts.extraFiles) for (const [k, v] of Object.entries(opts.extraFiles)) files.set(k, v);
  const dirs = opts.dirs || {};
  const operations = [];
  let clock = 1700000010000;
  let storageError = '';
  let responder = (url, options, callback) => {
    const response = new EventEmitter();
    response.statusCode = 200;
    response.complete = false;
    response.destroy = () => { response.destroyed = true; response.emit('close'); };
    callback(response);
    response.emit('data', Buffer.from(JSON.stringify(dataFor(url.pathname))));
    response.complete = true;
    response.emit('end');
    response.emit('close');
  };
  const transport = { request(url, options, callback) {
    const request = new EventEmitter();
    request.destroy = () => { request.destroyed = true; };
    request.end = () => { queueMicrotask(() => responder(url, options, callback, request)); };
    return request;
  } };
  const context = vm.createContext({
    Buffer, URL, setTimeout, clearTimeout, randomBytes, X509Certificate, join, dirname, homedir: () => '/test',
    Date: class extends Date { static now() { return clock; } },
    http: transport, https: transport,
    readdirSync: (dir) => dirs[dir] || [],
    statSync: (p) => ({ mtimeMs: (opts.mtimes && opts.mtimes[p]) || 0 }),
    existsSync: (p) => files.has(p) || Object.prototype.hasOwnProperty.call(dirs, p) || p.endsWith('.dsh'),
    mkdirSync() {},
    readFileSync(path) { if (!files.has(path)) throw Object.assign(new Error('missing'), { code: 'ENOENT' }); return files.get(path); },
    writeFileSync(path, value, options) {
      operations.push(['write', options]);
      if (storageError === 'write') throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
      files.set(path, value);
    },
    chmodSync(path, mode) { operations.push(['chmod', mode]); },
    renameSync(from, to) {
      if (storageError === 'rename') throw Object.assign(new Error('denied'), { code: 'EACCES' });
      files.set(to, files.get(from)); files.delete(from);
    },
    unlinkSync(path) { files.delete(path); }
  });
  vm.runInContext(hostSource + '\nglobalThis.subject = { getJSON, cachedJSON, loadConnections, connectionCopy, saveConnections, normalizeConnection, connectionToEndpoint, buildResponse, buildSnapshot, readBody, wrap, mapLimited, handleConnectionsList, handleConnectionSave, handleConnectionDelete, handleConnectionActivate, handleConnectionTest, handleFleet, handleDiagnostics, discover, resetRuntimeState, guard };', context);
  return {
    ...context.subject, context, files, operations,
    setResponder(fn) { responder = fn; }, advance(ms) { clock += ms; }, failStorage(stage) { storageError = stage; },
    stubGet(fn) { context.stub = fn; vm.runInContext('getJSON = stub', context); }
  };
}
function responseSink() {
  return { status: 0, body: null, rawEnded: false, writeHead(status) { this.status = status; }, end(value) { this.rawEnded = true; this.body = value == null || value === '' ? null : JSON.parse(value.toString()); }, setHeader() {} };
}
function jsonRequest(data) {
  const request = new EventEmitter();
  request.method = 'POST'; request.headers = {}; request.complete = false;
  queueMicrotask(() => { request.emit('data', Buffer.from(JSON.stringify(data))); request.complete = true; request.emit('end'); });
  return request;
}

for (const stage of ['write', 'rename']) {
  test(`failed ${stage} preserves saved connection, active selection and key`, () => {
    const host = hostHarness();
    const before = JSON.stringify(host.loadConnections());
    const copy = host.connectionCopy();
    copy.activeId = 'b'; copy.connections[0].apiKey = 'new-test-key';
    host.failStorage(stage);
    assert.throws(() => host.saveConnections(copy), /连接未保存/);
    assert.equal(JSON.stringify(host.loadConnections()), before);
    assert.equal(host.files.size, 1, 'temporary file was cleaned up');
    assert.equal(host.files.get('/test/.dsh/surge-panel-connections.json'), before);
  });
}
test('atomic save uses an exclusive mode-600 temporary file and commits afterward', () => {
  const host = hostHarness();
  const copy = host.connectionCopy(); copy.activeId = 'b'; host.saveConnections(copy);
  assert.equal(host.loadConnections().activeId, 'b');
  assert.equal(host.operations[0][1].flag, 'wx');
  assert.equal(host.operations[0][1].mode, 0o600);
  assert.equal(host.operations[1][1], 0o600);
});
test('corrupt storage remains an error on repeated reads', () => {
  const host = hostHarness(); host.files.set('/test/.dsh/surge-panel-connections.json', 'null');
  assert.throws(() => host.loadConnections(), /格式错误/);
  assert.throws(() => host.loadConnections(), /格式错误/);
  assert.equal(host.files.get('/test/.dsh/surge-panel-connections.json'), 'null');
});
test('host validation rejects embedded URLs and ports, accepts IPv6, validates protocol and CA', () => {
  const host = hostHarness();
  for (const name of ['surge.local:6171', 'https://surge.local', 'user@surge.local', 'surge.local/path', 'surge.local\\path', '169.254.169.254']) assert.equal(host.normalizeConnection(conn('a', name)).ok, false, name);
  for (const name of ['surge.local', '192.168.1.4', '::1', '[2001:db8::1]']) {
    const result = host.normalizeConnection(conn('a', name)); assert.equal(result.ok, true, name);
    assert.doesNotThrow(() => new URL(host.connectionToEndpoint(result.value).base));
  }
  assert.equal(host.normalizeConnection({ ...conn('a'), protocol: 'ftp' }).ok, false);
  assert.equal(host.normalizeConnection({ ...conn('a'), caCert: 'invalid' }).ok, false);
});
test('HTTPS verifies certificate identity and supports a custom CA', async () => {
  const host = hostHarness(); let observed;
  host.setResponder((url, options, callback) => {
    observed = options;
    const response = new EventEmitter(); response.statusCode = 200; response.complete = true; response.destroy = () => {};
    callback(response); response.emit('data', Buffer.from('{"mode":"rule"}')); response.emit('end');
  });
  const result = await host.getJSON({ base: 'https://surge.local:6171', key: 'test', caCert: 'test-CA' }, '/v1/outbound');
  assert.equal(result.ok, true); assert.equal(observed.rejectUnauthorized, true); assert.equal(observed.ca, 'test-CA');
});
for (const event of ['aborted', 'close', 'error']) {
  test(`response ${event} settles and destroys the request`, async () => {
    const host = hostHarness(); let request;
    host.setResponder((url, options, callback, req) => {
      request = req;
      const response = new EventEmitter(); response.statusCode = 200; response.complete = false;
      response.destroy = () => { response.complete = false; }; callback(response);
      response.emit(event, event === 'error' ? new Error('interrupted') : undefined);
    });
    const result = await host.getJSON({ base: 'http://surge.local', key: '' }, '/v1/outbound', 100);
    assert.equal(result.ok, false); assert.equal(request.destroyed, true); assert.match(result.message, /response/);
  });
}
test('wall-clock deadline ends a request even without socket inactivity', async () => {
  const host = hostHarness(); let request;
  host.setResponder((url, options, callback, req) => { request = req; });
  const result = await host.getJSON({ base: 'http://surge.local' }, '/v1/outbound', 15);
  assert.equal(result.ok, false); assert.match(result.message, /deadline/); assert.equal(request.destroyed, true);
});
test('oversized response rejects immediately, without waiting for end', async () => {
  const host = hostHarness(); let destroyed = false;
  host.setResponder((url, options, callback) => {
    const response = new EventEmitter(); response.statusCode = 200;
    response.destroy = () => { destroyed = true; }; callback(response);
    response.emit('data', Buffer.alloc(16 * 1024 * 1024 + 1));
  });
  const result = await host.getJSON({ base: 'http://surge.local' }, '/v1/outbound', 100);
  assert.match(result.message, /too large/); assert.equal(destroyed, true);
});
test('null and array JSON bodies return validation errors', async () => {
  const host = hostHarness();
  for (const body of [null, [], 42]) assert.equal((await host.readBody(jsonRequest(body))).ok, false);
  assert.equal((await host.readBody(jsonRequest({ id: 'a' }))).ok, true);
});
test('body abort and size limit settle without retaining new chunks', async () => {
  const host = hostHarness();
  const aborted = new EventEmitter(); const pending = host.readBody(aborted); aborted.emit('aborted');
  assert.equal((await pending).ok, false);
  const large = new EventEmitter(); const pendingLarge = host.readBody(large); large.emit('data', Buffer.alloc(65537));
  assert.equal((await pendingLarge).ok, false);
});
test('same-site and cross-site browser calls are rejected', () => {
  const host = hostHarness();
  for (const site of ['same-site', 'cross-site']) {
    const response = responseSink();
    assert.equal(host.guard({ headers: { 'sec-fetch-site': site }, method: 'POST' }, response, ['POST']), false);
    assert.equal(response.status, 403);
  }
});
test('synchronous route failures are caught by the wrapper', async () => {
  const host = hostHarness(), response = responseSink();
  host.wrap(() => { throw new Error('read failure'); })({}, response);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(response.status, 500); assert.match(response.body.message, /read failure/);
});
test('mutating routes keep live state unchanged when persistence fails', async () => {
  for (const name of ['handleConnectionSave', 'handleConnectionDelete', 'handleConnectionActivate']) {
    const host = hostHarness(); const before = JSON.stringify(host.loadConnections()); host.failStorage('write');
    const request = jsonRequest(name === 'handleConnectionSave' ? { connection: { ...conn('a'), name: 'changed' } } : { id: 'b' });
    await assert.rejects(host[name](request, responseSink()), /连接未保存/);
    assert.equal(JSON.stringify(host.loadConnections()), before, name);
  }
});
test('two concurrent snapshots share ten requests, slow endpoints are reused, failures retain stale data', async () => {
  const host = hostHarness(); const counts = new Map(); let failEvents = false;
  host.stubGet(async (ep, path) => {
    counts.set(path, (counts.get(path) || 0) + 1);
    return failEvents && path === '/v1/events' ? { ok: false, status: 404 } : { ok: true, status: 200, data: dataFor(path) };
  });
  const first = responseSink(), second = responseSink(); await Promise.all([host.buildResponse(first), host.buildResponse(second)]);
  assert.equal([...counts.values()].reduce((a, b) => a + b, 0), 10);
  assert.equal(first.body.snapshot.activeConnection.id, 'a');
  const cached = responseSink(); await host.buildResponse(cached);
  assert.equal(cached.body.snapshot.sampledAt, first.body.snapshot.sampledAt);
  host.advance(5100); failEvents = true;
  const next = responseSink(); await host.buildResponse(next);
  assert.equal(counts.get('/v1/policies'), 1); assert.equal(counts.get('/v1/traffic'), 2);
  assert.equal(next.body.snapshot.endpoints.events.ok, false);
  assert.equal(next.body.snapshot.endpoints.events.stale, true);
  assert.equal(next.body.snapshot.endpoints.events.updatedAt, first.body.snapshot.endpoints.events.updatedAt);
});
test('malformed optional endpoint is unavailable, never a valid empty result', async () => {
  const host = hostHarness();
  host.stubGet(async (ep, path) => ({ ok: true, status: 200, data: path === '/v1/devices' ? {} : dataFor(path) }));
  const response = responseSink(); await host.buildResponse(response);
  assert.equal(response.body.ok, true); assert.equal(response.body.snapshot.endpoints.devices.ok, false);
  assert.equal(response.body.snapshot.endpoints.devices.stale, false);
});
test('an in-flight snapshot is rejected after switching connections', async () => {
  const host = hostHarness(), gate = deferred();
  host.stubGet(async (ep, path) => { await gate.promise; return { ok: true, status: 200, data: dataFor(path) }; });
  const response = responseSink(); const pending = host.buildResponse(response);
  const copy = host.connectionCopy(); copy.activeId = 'b'; host.saveConnections(copy); gate.resolve(); await pending;
  assert.equal(response.status, 409); assert.equal(response.body.code, 'CONNECTION_CHANGED');
});
test('fleet worker concurrency is bounded', async () => {
  const host = hostHarness(); let active = 0, peak = 0;
  const results = await host.mapLimited(Array.from({ length: 11 }, (_, i) => i), 4, async value => {
    active++; peak = Math.max(peak, active); await new Promise(resolve => setImmediate(resolve)); active--; return value;
  });
  assert.equal(peak, 4); assert.equal(results.length, 11); assert.equal(results[10], 10);
});

function clientHarness(fetchImpl, extras = {}) {
  const api = clientSource.slice(clientSource.indexOf('    async function api('), clientSource.indexOf('    function createPrefs('));
  const store = clientSource.slice(clientSource.indexOf('    function createStore('), clientSource.indexOf('    const store = createStore();'));
  const pollStart = clientSource.indexOf('    function startPolling(');
  const pollEnd = clientSource.indexOf('\n    /*', pollStart);
  const polling = clientSource.slice(pollStart, pollEnd);
  const context = vm.createContext({ fetch: fetchImpl, AbortController, setTimeout, clearTimeout, Date, fmtTime: date => date.toISOString(), ...extras });
  vm.runInContext(api + store + polling + '\nglobalThis.subject = { api, createStore, startPolling };', context);
  return context.subject;
}
const webResponse = body => ({ ok: true, status: 200, json: async () => body });
const sample = (id, sampledAt, revision = 0) => webResponse({ ok: true, snapshot: { activeConnection: { id }, connectionRevision: revision, sampledAt, down: sampledAt, up: 1 } });
test('client samples are isolated by connection and revision; duplicate cached samples are skipped', async () => {
  const queue = [sample('a', 1000), sample('a', 1000), sample('b', 2000), sample('b', 3000, 1)];
  const client = clientHarness(async () => queue.shift()), store = client.createStore();
  await store.fetch(); await store.fetch(); assert.equal(store.buffers().down.length, 1);
  await store.fetch(); assert.deepEqual(Array.from(store.buffers().down), [2000]);
  await store.fetch(); assert.deepEqual(Array.from(store.buffers().down), [3000]);
});
test('late fetches cannot overwrite state after invalidation, even if transport ignores abort', async () => {
  const old = deferred(); let calls = 0;
  const client = clientHarness(() => ++calls === 1 ? old.promise : Promise.resolve(sample('b', 2000))), store = client.createStore();
  const previous = store.fetch(); store.invalidate(); await store.fetch(); old.resolve(sample('a', 1000)); await previous;
  assert.equal(store.get().snap.activeConnection.id, 'b'); assert.deepEqual(Array.from(store.buffers().down), [2000]);
});
test('client timeout aborts transport and releases the polling flight for retry', async () => {
  let calls = 0;
  const client = clientHarness((url, options) => {
    calls++;
    if (calls > 1) return Promise.resolve(sample('a', 1000));
    return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('timeout')), { once: true }));
  }, { setTimeout: fn => setTimeout(fn, 5) });
  const store = client.createStore(); await store.fetch(); assert.equal(store.get().status, 'error');
  await store.fetch(); assert.equal(store.get().status, 'ok'); assert.equal(calls, 2);
});
test('client surfaces server JSON error messages on HTTP failures', async () => {
  const client = clientHarness(async () => ({ ok: false, status: 500, json: async () => ({ ok: false, message: 'ENOSPC' }) }));
  assert.equal((await client.api('/test')).message, 'ENOSPC');
});
test('polling stops while hidden, paused and disposed, and leaves only one timer', async () => {
  const timers = new Map(); let next = 0, fetches = 0, cancels = 0, listener;
  const client = clientHarness(() => {}, { setTimeout: fn => { timers.set(++next, fn); return next; }, clearTimeout: id => timers.delete(id) });
  const document = { hidden: false, addEventListener(event, fn) { listener = fn; }, removeEventListener() { listener = null; } };
  const store = { fetch: async () => { fetches++; }, cancel: () => { cancels++; } };
  const dispose = client.startPolling(store, { paused: false, refreshMs: 5000 }, document);
  listener(); listener(); await Promise.resolve(); assert.equal(timers.size, 1);
  document.hidden = true; listener(); assert.equal(timers.size, 0); assert.ok(cancels > 0);
  const hiddenFetches = fetches; listener(); await Promise.resolve(); assert.equal(fetches, hiddenFetches);
  document.hidden = false; listener(); await Promise.resolve(); assert.equal(fetches, hiddenFetches + 1);
  dispose(); assert.equal(timers.size, 0); assert.equal(listener, null);
  const before = fetches; const disposePaused = client.startPolling(store, { paused: true, refreshMs: 5000 }, document);
  await Promise.resolve(); assert.equal(fetches, before); disposePaused();
});

test('host validation rejects IPv6-mapped metadata hosts and malformed PEM certificates', () => {
  const host = hostHarness();
  for (const name of ['::ffff:169.254.169.254', '[::ffff:169.254.169.254]', '::ffff:a9fe:a9fe', 'metadata.google.internal']) {
    const res = host.normalizeConnection(conn('a', name));
    assert.equal(res.ok, false, name);
    assert.equal(res.code, 'HOST_BLOCKED');
  }
  const badPem = '-----BEGIN CERTIFICATE-----\nnot-valid-der\n-----END CERTIFICATE-----';
  const pemRes = host.normalizeConnection({ ...conn('a'), caCert: badPem });
  assert.equal(pemRes.ok, false);
  assert.equal(pemRes.code, 'INVALID_CA_CERT');
});

test('connection routes handle list, delete 404, save+activate, test, fleet, diagnostics and HEAD', async () => {
  const host = hostHarness();
  host.stubGet(async (ep, path) => ({ ok: true, status: 200, data: dataFor(path) }));

  // List (GET and HEAD)
  const listRes = responseSink();
  host.handleConnectionsList({ method: 'GET', headers: {} }, listRes);
  assert.equal(listRes.status, 200);
  assert.equal(listRes.body.ok, true);
  assert.equal(listRes.body.connections.length, 3);
  assert.equal(listRes.body.connections[0].id, 'local');

  const headRes = responseSink();
  host.handleConnectionsList({ method: 'HEAD', headers: {} }, headRes);
  assert.equal(headRes.status, 200);
  assert.equal(headRes.rawEnded, true);
  assert.equal(headRes.body, null);

  // Delete missing id returns 404 without writing
  const opsBefore = host.operations.length;
  const delMissing = responseSink();
  await host.handleConnectionDelete(jsonRequest({ id: 'does-not-exist' }), delMissing);
  assert.equal(delMissing.status, 404);
  assert.equal(delMissing.body.code, 'CONNECTION_NOT_FOUND');
  assert.equal(host.operations.length, opsBefore);

  // Save with activate: true creates and activates in one call
  const saveRes = responseSink();
  await host.handleConnectionSave(jsonRequest({ connection: { name: 'Gateway C', host: 'c.local', port: 6171, protocol: 'http', apiKey: 'key-c', platform: 'macos' }, activate: true }), saveRes);
  assert.equal(saveRes.status, 200);
  assert.equal(saveRes.body.ok, true);
  assert.equal(saveRes.body.activeId, saveRes.body.id);

  // Connection test returns structured TEST_OK
  const testRes = responseSink();
  await host.handleConnectionTest(jsonRequest({ id: saveRes.body.id }), testRes);
  assert.equal(testRes.status, 200);
  assert.equal(testRes.body.ok, true);
  assert.equal(testRes.body.code, 'TEST_OK');

  // Fleet aggregates saved + local
  const fleetRes = responseSink();
  await host.handleFleet({ method: 'GET', headers: {} }, fleetRes);
  assert.equal(fleetRes.status, 200);
  assert.equal(fleetRes.body.ok, true);
  assert.equal(fleetRes.body.fleet.length, 4);

  // Diagnostics inspects all endpoints
  const diagRes = responseSink();
  await host.handleDiagnostics({ method: 'GET', headers: {} }, diagRes);
  assert.equal(diagRes.status, 200);
  assert.equal(diagRes.body.ok, true);
  assert.equal(diagRes.body.checks.length, 10);
  assert.ok(diagRes.body.checks.every(c => c.ok));
});

test('discover sorts candidates by most recently modified profile first', () => {
  const dir = '/test/Library/Application Support/Surge/Profiles';
  const host = hostHarness({ activeId: 'local', connections: [] }, {
    dirs: { [dir]: ['older.conf', 'newer.conf'] },
    mtimes: { [dir + '/older.conf']: 1000, [dir + '/newer.conf']: 2000 },
    extraFiles: {
      [dir + '/older.conf']: '[General]\nhttp-api = secret1@0.0.0.0:6171\n',
      [dir + '/newer.conf']: '[General]\nhttp-api = secret2@127.0.0.1:6172\n'
    }
  });
  const found = host.discover();
  assert.equal(found.length, 2);
  assert.equal(found[0].file, 'newer.conf');
  assert.equal(found[0].port, 6172);
  assert.equal(found[1].file, 'older.conf');
  host.resetRuntimeState();
});

test('buildSnapshot sorts devices by live speed then total bytes and includes recentRequests', () => {
  const host = hostHarness();
  const snap = host.buildSnapshot({
    traffic: dataFor('/v1/traffic'),
    outbound: { mode: 'rule' },
    requests: {
      requests: [
        { id: 1, URL: 'https://ok.example/a', policyName: 'DIRECT', status: 'Completed', completed: true, failed: false, inBytes: 100, outBytes: 20 },
        { id: 2, URL: 'https://fail.example/b', policyName: 'PROXY', status: 'Failed', completed: true, failed: true, notes: ['Timeout'] }
      ]
    },
    devices: {
      devices: [
        { name: 'IdleBig', displayIPAddress: '10.0.0.2', identifier: 'id-big', currentInSpeed: 0, currentOutSpeed: 0, inBytesStat: { total: 50000 }, outBytesStat: { total: 0 } },
        { name: 'ActiveSmall', displayIPAddress: '10.0.0.3', identifier: 'id-active', currentInSpeed: 800, currentOutSpeed: 200, inBytesStat: { total: 1000 }, outBytesStat: { total: 0 } },
        { name: 'IdleSmall', displayIPAddress: '10.0.0.4', identifier: 'id-small', currentInSpeed: 0, currentOutSpeed: 0, inBytesStat: { total: 500 }, outBytesStat: { total: 0 } }
      ]
    },
    events: { events: [] }, policies: {}, modules: {}, rules: {}, dns: {}, profile: { name: 'Main' }
  }, { host: '127.0.0.1', port: 6171, tls: false, local: true }, { activeId: 'local', connections: [] });
  assert.equal(snap.devices[0].name, 'ActiveSmall');
  assert.equal(snap.devices[0].key, 'id-active');
  assert.equal(snap.devices[0].speed, 1000);
  assert.equal(snap.devices[1].name, 'IdleBig');
  assert.equal(snap.devices[2].name, 'IdleSmall');
  assert.equal(snap.recentRequests.length, 2);
  assert.equal(snap.recentRequests[0].failed, true);
  assert.equal(snap.recentRequests[0].target, 'https://fail.example/b');
});

test('version, i18n dictionaries and package.json files whitelist stay in sync', () => {
  const verMatch = clientSource.match(/const VERSION = '([^']+)'/);
  assert.ok(verMatch, 'VERSION constant exists in client.js');
  assert.equal(verMatch[1], pkgJson.version);

  const dictCtx = vm.createContext({});
  const zhStart = clientSource.indexOf('    const zh = {');
  const dictsEnd = clientSource.indexOf('    const dicts = {', zhStart);
  vm.runInContext(clientSource.slice(zhStart, dictsEnd) + '\nglobalThis.zh = zh; globalThis.en = en;', dictCtx);
  const zhKeys = Object.keys(dictCtx.zh).sort();
  const enKeys = Object.keys(dictCtx.en).sort();
  assert.deepEqual(zhKeys, enKeys, 'zh and en dictionary keys match exactly');

  // Every static t('...') key referenced in client.js exists in both dictionaries
  const staticKeys = new Set();
  for (const m of clientSource.matchAll(/\bt\('([a-zA-Z0-9._-]+)'\)/g)) staticKeys.add(m[1]);
  for (const key of staticKeys) {
    assert.ok(Object.prototype.hasOwnProperty.call(dictCtx.zh, key), `zh missing key: ${key}`);
    assert.ok(Object.prototype.hasOwnProperty.call(dictCtx.en, key), `en missing key: ${key}`);
  }

  // Package whitelist must not pack the entire docs directory or local layout captures
  assert.equal(pkgJson.files.includes('docs'), false);
  assert.equal(pkgJson.files.some(f => f.includes('layout-check')), false);
});
