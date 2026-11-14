import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { join, dirname } from 'node:path';
import vm from 'node:vm';

// Exercise production functions without importing the DSH runtime, touching real
// connection files, rendering React, or contacting a real Surge instance.
const hostSource = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  .replace(/^import[\s\S]*?from '[^']+';\n/gm, '').replace(/^export /gm, '');
const clientSource = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
const conn = (id, host = id + '.local') => ({ id, name: id, host, port: 6171, protocol: 'http', apiKey: 'test-only', platform: 'auto' });
const dataFor = path => ({
  '/v1/traffic': { interface: { all: { inCurrentSpeed: 10, outCurrentSpeed: 3, in: 100, out: 20 } }, startTime: 1700000000, connector: {} },
  '/v1/outbound': { mode: 'rule' }, '/v1/requests/recent': { requests: [] },
  '/v1/devices': { devices: [] }, '/v1/events': { events: [] },
  '/v1/policies': { 'policy-groups': [], proxies: [] }, '/v1/modules': { enabled: [] },
  '/v1/rules': { rules: [] }, '/v1/dns': { dnsCache: [] }, '/v1/profiles/current': { name: 'Test' }
})[path];
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

function hostHarness(initial = { activeId: 'a', connections: [conn('a'), conn('b')] }) {
  const files = new Map([['/test/.dsh/surge-panel-connections.json', JSON.stringify(initial)]]);
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
    Buffer, URL, setTimeout, clearTimeout, randomBytes, join, dirname, homedir: () => '/test',
    Date: class extends Date { static now() { return clock; } },
    http: transport, https: transport,
    readdirSync: () => [], existsSync: () => true, mkdirSync() {},
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
  vm.runInContext(hostSource + '\nglobalThis.subject = { getJSON, cachedJSON, loadConnections, connectionCopy, saveConnections, normalizeConnection, connectionToEndpoint, buildResponse, buildSnapshot, readBody, wrap, mapLimited, handleConnectionSave, handleConnectionDelete, handleConnectionActivate, guard };', context);
  return {
    ...context.subject, context, files, operations,
    setResponder(fn) { responder = fn; }, advance(ms) { clock += ms; }, failStorage(stage) { storageError = stage; },
    stubGet(fn) { context.stub = fn; vm.runInContext('getJSON = stub', context); }
  };
}
function responseSink() {
  return { status: 0, body: null, writeHead(status) { this.status = status; }, end(value) { this.body = JSON.parse(value.toString()); }, setHeader() {} };
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
