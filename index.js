/**
 * Host half — local / LAN Surge HTTP API bridge.
 *
 * The reference product (surge-lan-console) runs a Node Core that reads a
 * Surge profile, injects the private X-Key and proxies the LAN dashboard,
 * while a SQLite-backed connection store manages MANY Surge instances and an
 * encrypted Vault holds their API keys. This bundle does the same thing inside
 * DSH:
 *
 *   - The key for the LOCAL gateway is read from the user's own Surge profile.
 *   - Keys for SAVED LAN/remote gateways live in a Host-private JSON file
 *     (~/.dsh/surge-panel-connections.json, mode 600). No API key is ever
 *     returned to the browser: the Client only sees `hasKey: boolean`.
 *   - The Client half only ever talks to same-origin routes registered here.
 *
 * Everything Surge-facing is read-only. Cross-site browser requests are
 * rejected, POST bodies are size-capped, and saved hosts are validated so a
 * mis-typed address cannot turn the Host into an open proxy.
 */
import http from 'node:http';
import https from 'node:https';
import {
  readdirSync, readFileSync, writeFileSync, mkdirSync, renameSync, existsSync, unlinkSync, chmodSync
} from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';

const ROUTE = '/surge-api/snapshot';
const PROFILE_DIR = join(homedir(), 'Library', 'Application Support', 'Surge', 'Profiles');
const CONN_FILE = join(homedir(), '.dsh', 'surge-panel-connections.json');

const ENDPOINTS = {
  traffic: '/v1/traffic',
  outbound: '/v1/outbound',
  requests: '/v1/requests/recent',
  devices: '/v1/devices',
  events: '/v1/events',
  policies: '/v1/policies',
  modules: '/v1/modules',
  rules: '/v1/rules',
  dns: '/v1/dns',
  profile: '/v1/profiles/current'
};

let cachedEndpoint = null;
let cachedSelection = null;
let connCache = null;
let connectionRevision = 0;
let endpointDiscoveredAt = 0;
const responseCache = new Map();
const snapshotJobs = new Map();
const SLOW_ENDPOINTS = new Set(['policies', 'modules', 'rules', 'profile']);

function invalidateConnections() {
  connectionRevision++;
  cachedEndpoint = null;
  cachedSelection = null;
  responseCache.clear();
}

function connectionCopy() {
  const data = loadConnections();
  return { activeId: data.activeId, connections: data.connections.map(function (c) { return { ...c }; }) };
}

/* -------------------------------------------------------------------------- *
 * Discovery. Several .conf files (and .bak copies) may live in Profiles/; we
 * collect every distinct `http-api = <key>@<bind>:<port>` and probe them so a
 * profile switch is picked up without a restart. The bind address (0.0.0.0)
 * is replaced with loopback for the outgoing connection.
 * -------------------------------------------------------------------------- */
function discover() {
  let files = [];
  try {
    files = readdirSync(PROFILE_DIR).filter(function (f) { return /\.conf$/i.test(f); });
  } catch (e) {
    return [];
  }
  const out = [];
  for (const file of files) {
    let text = '';
    try { text = readFileSync(join(PROFILE_DIR, file), 'utf8'); } catch (e) { continue; }
    const m = /(?:^|\n)\s*http-api\s*=\s*([^@\s]+)@([^:\s]+):(\d+)/.exec(text);
    if (!m) continue;
    const tls = /\n\s*http-api-tls\s*=\s*true/i.test('\n' + text);
    const port = Number(m[3]);
    const base = (tls ? 'https' : 'http') + '://127.0.0.1:' + port;
    const key = m[1];
    if (!out.some(function (o) { return o.base === base && o.key === key; })) {
      out.push({ base: base, key: key, port: port, tls: tls, file: file });
    }
  }
  return out;
}

function localEndpoint() {
  const found = discover();
  return found.length ? found[0] : null;
}

/* -------------------------------------------------------------------------- *
 * Connection store — the DSH-native equivalent of the original's SQLite
 * connection store. Keys are stored as plain JSON protected by mode 600;
 * the browser only ever receives a redacted view of each connection.
 * -------------------------------------------------------------------------- */
function defaultConnections() {
  return { connections: [], activeId: 'local' };
}

function loadConnections() {
  if (connCache) return connCache;
  try {
    connCache = JSON.parse(readFileSync(CONN_FILE, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') throw new Error('无法读取连接存储：' + (e.code || 'JSON 格式错误'));
    connCache = defaultConnections();
  }
  if (!connCache || !Array.isArray(connCache.connections)) {
    connCache = null;
    throw new Error('连接存储格式错误，原文件未修改');
  }
  const ids = new Set();
  for (const connection of connCache.connections) {
    const normalized = normalizeConnection(connection);
    if (!connection || !connection.id || !normalized.ok || ids.has(connection.id)) {
      connCache = null;
      throw new Error('连接存储包含无效或重复的连接，原文件未修改');
    }
    ids.add(connection.id);
  }
  if (!connCache.activeId) connCache.activeId = 'local';
  if (connCache.activeId !== 'local' && !ids.has(connCache.activeId)) {
    connCache = null;
    throw new Error('当前连接不存在，请修复连接存储');
  }
  return connCache;
}

function saveConnections(data) {
  const dir = dirname(CONN_FILE);
  const tmp = CONN_FILE + '.' + randomBytes(8).toString('hex') + '.tmp';
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600, flag: 'wx' });
    chmodSync(tmp, 0o600);
    renameSync(tmp, CONN_FILE);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* The temp file may not have been created. */ }
    throw new Error('连接未保存：' + (e.code || '存储写入失败'));
  }
  connCache = data;
  invalidateConnections();
}

function newId() {
  return 'c_' + Date.now().toString(36) + '_' + randomBytes(3).toString('hex');
}

function normalizeConnection(input) {
  const src = input && typeof input === 'object' ? input : {};
  let id = String(src.id || '').trim();
  if (!id) id = newId();
  if (id === 'local') return { ok: false, message: '连接 ID "local" 为保留值' };
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return { ok: false, message: '连接 ID 只能包含字母、数字、-、_' };

  const name = String(src.name || '').trim().slice(0, 64) || 'Surge';
  const protocol = src.protocol || 'http';
  if (!['http', 'https'].includes(protocol)) return { ok: false, message: '协议仅支持 HTTP 或 HTTPS' };

  let host = String(src.host || '').trim().toLowerCase();
  // Host and port are separate fields. Never silently strip URL credentials or paths.
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (!host || /[\s\\/@?#%]/.test(host)) return { ok: false, message: '主机仅填写域名或 IP，协议和端口请使用独立字段' };
  try {
    const parsed = new URL('http://' + (host.includes(':') ? '[' + host + ']' : host) + ':6171');
    if (parsed.hostname.replace(/^\[|\]$/g, '') !== host && host.includes(':')) host = parsed.hostname.slice(1, -1);
    else host = parsed.hostname;
    host = host.replace(/^\[|\]$/g, '');
    if (!/^[a-z0-9.:-]+$/.test(host)) throw new Error('invalid host');
  } catch {
    return { ok: false, message: '主机地址不合法；请勿在主机字段附加端口' };
  }
  if (host === '169.254.169.254' || /(^|\.)metadata\.google\.internal\.?$/.test(host)) {
    return { ok: false, message: '该主机地址不允许' };
  }

  const port = Number(src.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { ok: false, message: '端口须为 1–65535 的整数' };
  }
  const platform = ['auto', 'ios', 'tvos', 'macos'].indexOf(src.platform) >= 0 ? src.platform : 'auto';
  const apiKey = String(src.apiKey || '');
  if (apiKey.length > 512 || /[\r\n]/.test(apiKey)) return { ok: false, message: 'API 密钥格式不合法' };
  const caCert = String(src.caCert || '').trim();
  if (caCert.length > 16384 || (caCert && !/^-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----$/.test(caCert))) {
    return { ok: false, message: 'CA 证书须为 PEM 格式，且不超过 16 KB' };
  }
  return { ok: true, value: { id, name, protocol, host, port, apiKey, platform, caCert } };
}

function connectionToEndpoint(c) {
  const proto = c.protocol === 'https' ? 'https' : 'http';
  const host = c.host.indexOf(':') >= 0 && c.host.charAt(0) !== '[' ? '[' + c.host + ']' : c.host;
  return {
    base: proto + '://' + host + ':' + c.port,
    key: c.apiKey || '', port: c.port, tls: proto === 'https', caCert: c.caCert || '', file: ''
  };
}

async function endpointForView(view) {
  if (view.isLocal) return resolveEndpoint({ activeId: 'local', connections: [] });
  const c = loadConnections().connections.find(function (x) { return x.id === view.id; });
  return c ? connectionToEndpoint(c) : null;
}

function redacted(c, activeId, isLocal) {
  return {
    id: c.id, name: c.name, protocol: c.protocol, host: c.host, port: c.port,
    platform: c.platform || 'auto', hasKey: !!c.apiKey, caCert: c.caCert || '', isLocal: !!isLocal,
    active: activeId === c.id
  };
}

function connectionViews(data) {
  const activeId = data.activeId || 'local';
  const local = cachedEndpoint || localEndpoint();
  const views = [redacted({
    id: 'local', name: '本机 Surge', protocol: local && local.tls ? 'https' : 'http',
    host: '127.0.0.1', port: local ? local.port : 6171, platform: 'macos', apiKey: local ? local.key : ''
  }, activeId, true)];
  for (const c of data.connections) views.push(redacted(c, activeId, false));
  return views;
}

/* A tiny GET+JSON client over node:http(s). Avoids depending on a possibly
 * instrumented global fetch and keeps the timeout explicit. */
function getJSON(ep, path, ms = 2500) {
  return new Promise(function (resolve) {
    let req, response, timer;
    let settled = false;
    function done(value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    }
    function fail(message) {
      done({ ok: false, status: response ? response.statusCode : 0, message });
      if (response) response.destroy();
      if (req) req.destroy();
    }
    timer = setTimeout(function () { fail('Surge API deadline exceeded'); }, ms);
    try {
      const url = new URL(ep.base + path);
      const mod = url.protocol === 'https:' ? https : http;
      req = mod.request(url, {
        method: 'GET',
        headers: { 'X-Key': ep.key || '', Accept: 'application/json' },
        rejectUnauthorized: true,
        ...(ep.caCert ? { ca: ep.caCert } : {})
      }, function (res) {
        response = res;
        if (settled) { res.destroy(); return; }
        const chunks = [];
        let size = 0;
        res.on('error', function () { fail('Surge API response error'); });
        res.on('aborted', function () { fail('Surge API response aborted'); });
        res.on('close', function () { if (!res.complete) fail('Surge API response closed early'); });
        res.on('data', function (chunk) {
          size += chunk.length;
          if (size > 16 * 1024 * 1024) { fail('Surge API response too large'); return; }
          if (!settled) chunks.push(chunk);
        });
        res.on('end', function () {
          if (res.statusCode !== 200) { done({ ok: false, status: res.statusCode }); return; }
          try {
            const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('invalid shape');
            done({ ok: true, status: 200, data });
          } catch { done({ ok: false, status: 200, message: 'invalid JSON object from Surge' }); }
        });
      });
      req.on('error', function (e) { done({ ok: false, status: 0, message: e.code || 'Surge API connection error' }); });
      req.end();
    } catch { fail('Invalid Surge connection configuration'); }
  });
}

function endpointCacheKey(ep, path) {
  return JSON.stringify([connectionRevision, ep.base, ep.key, ep.caCert || '', path]);
}

function cachedJSON(ep, path, ttl = 1000) {
  const key = endpointCacheKey(ep, path);
  const prev = responseCache.get(key);
  if (prev && prev.promise) return prev.promise;
  if (prev && Date.now() - prev.checkedAt < (prev.result.ok ? ttl : 1000)) return Promise.resolve(prev.result);
  const entry = { result: prev && prev.result, checkedAt: 0, promise: null };
  entry.promise = getJSON(ep, path, 3000).then(function (result) {
    const endpointName = Object.keys(ENDPOINTS).find(function (name) { return ENDPOINTS[name] === path; });
    if (result.ok && endpointName && !validEndpointData(endpointName, result.data)) {
      result = { ok: false, status: 200, message: 'Unexpected Surge API response shape' };
    }
    const updatedAt = result.ok ? Date.now() : (prev && prev.result.updatedAt) || null;
    entry.result = { ...result, updatedAt, data: result.ok ? result.data : (prev && prev.result.data) || null };
    entry.checkedAt = Date.now();
    entry.promise = null;
    return entry.result;
  });
  responseCache.set(key, entry);
  return entry.promise;
}

async function resolveEndpoint(data = connectionCopy(), revision = connectionRevision) {
  const selection = data.activeId || 'local';
  const active = data.connections.find(function (c) { return c.id === selection && c.id !== 'local'; });
  if (active) return connectionToEndpoint(active);
  if (selection !== 'local') return null;
  if (cachedEndpoint && cachedSelection === selection && Date.now() - endpointDiscoveredAt < 30000) return cachedEndpoint;
  for (const candidate of discover()) {
    const probe = await cachedJSON(candidate, '/v1/outbound');
    if (probe.ok) {
      if (revision === connectionRevision) {
        cachedEndpoint = candidate;
        cachedSelection = selection;
        endpointDiscoveredAt = Date.now();
      }
      return candidate;
    }
  }
  return null;
}

function num(v) { return typeof v === 'number' && isFinite(v) ? v : 0; }

function buildSnapshot(raw, ep, data) {
  const traffic = raw.traffic || {};
  const outbound = raw.outbound || {};
  const requests = raw.requests || {};
  const devices = raw.devices || {};
  const events = raw.events || {};
  const policies = raw.policies || {};
  const modules = raw.modules || {};
  const rules = raw.rules || {};
  const dns = raw.dns || {};
  const profile = raw.profile || {};

  let down = 0, up = 0, session = 0;
  const intf = traffic.interface || {};
  for (const k in intf) {
    const x = intf[k] || {};
    down += num(x.inCurrentSpeed);
    up += num(x.outCurrentSpeed);
    session += num(x.in) + num(x.out);
  }
  const startTime = num(traffic.startTime);
  const uptime = startTime > 0 ? Math.max(0, Date.now() / 1000 - startTime) : null;

  const reqs = (requests.requests || []).filter(Boolean);
  let conns = 0, connsFailed = 0;
  for (const r of reqs) {
    if (r.failed) connsFailed++;
    else if (!r.completed) conns++;
  }

  const dl = (devices.devices || []).filter(Boolean);
  const devBytes = function (d) {
    return num(d.inBytesStat && d.inBytesStat.total) + num(d.outBytesStat && d.outBytesStat.total);
  };
  const maxDev = dl.reduce(function (max, device) { return Math.max(max, devBytes(device)); }, 1);
  const dev = dl.slice(0, 16).map(function (d) {
    const ico = String(d.dhcpIcon || '');
    let icon = 'laptop';
    if (/iPhone|Mobile|Android|phone/i.test(ico)) icon = 'phone';
    else if (/Apple ?TV|\bTV\b/i.test(ico)) icon = 'tv';
    else if (/NAS|Server|Mac mini|MacBook|Mac Studio/i.test(ico)) icon = 'server';
    else if (/HomePod|Speaker/i.test(ico)) icon = 'speaker';
    const parts = ico.split('::');
    const friendly = parts.length ? parts[parts.length - 1] : '';
    const ip = String(d.displayIPAddress || d.name || '');
    const name = (friendly && !/^B\d+$/.test(friendly)) ? friendly + ' · ' + ip : (d.name || ip || 'device');
    return {
      icon: icon, name: name, ip: ip,
      load: Math.min(1, devBytes(d) / maxDev),
      speed: num(d.currentInSpeed) + num(d.currentOutSpeed)
    };
  });

  const conn = traffic.connector || {};
  const nodeList = Object.keys(conn).map(function (k) {
    return { name: k, bytes: num(conn[k] && conn[k].in) + num(conn[k] && conn[k].out) };
  }).sort(function (a, b) { return b.bytes - a.bytes; }).slice(0, 4);
  const maxNode = Math.max.apply(null, [1].concat(nodeList.map(function (n) { return n.bytes; })));
  const nodes = nodeList.map(function (n) {
    return { name: n.name, bytes: n.bytes, share: Math.round(n.bytes / maxNode * 100) };
  });

  const ev = (events.events || []).filter(Boolean).slice(0, 12).map(function (e) {
    const content = String(e.content || e.identifier || '').slice(0, 300);
    const ty = num(e.type);
    let tone = 'idle';
    if (ty >= 3 || /error|fatal|refused|fail|超时|错误/i.test(content)) tone = 'error';
    else if (ty === 2 || /warn/i.test(content)) tone = 'warn';
    else if (ty === 1) tone = 'brand';
    let time = '';
    const m = /T(\d{2}):(\d{2})/.exec(String(e.date || ''));
    if (m) time = m[1] + ':' + m[2];
    return { time: time, text: content, tone: tone };
  });

  const sel = data.activeId || 'local';
  const active = data.connections.find(function (c) { return c.id === sel && c.id !== 'local'; });
  const activeConnection = active
    ? { id: active.id, name: active.name, host: active.host, port: active.port, local: false }
    : { id: 'local', name: '本机 Surge', host: '127.0.0.1', port: ep.port, local: true };

  return {
    down: down,
    up: up,
    session: session,
    uptime: uptime,
    conns: conns,
    connsFailed: connsFailed,
    mode: String(outbound.mode || ''),
    apiPort: ep.port,
    profile: String(profile.name || 'Surge'),
    activeConnection: activeConnection,
    devices: dev,
    devicesCount: dl.length,
    nodes: nodes,
    events: ev,
    counts: {
      groups: (policies['policy-groups'] || []).length,
      proxies: (policies.proxies || []).length,
      rules: (rules.rules || []).length,
      modules: (modules.enabled || []).length,
      dns: (dns.dnsCache || []).length
    }
  };
}

/* -------------------------------------------------------------------------- *
 * HTTP plumbing.
 * -------------------------------------------------------------------------- */
function json(res, status, body) {
  if (res.writableEnded || res.destroyed) return;
  let data;
  try { data = Buffer.from(JSON.stringify(body)); }
  catch (e) { data = Buffer.from('{"ok":false,"message":"serialize failed"}'); }
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': data.length,
    'cache-control': 'no-store'
  });
  res.end(data);
}

function guard(req, res, methods) {
  const fsHeader = req.headers && req.headers['sec-fetch-site'];
  const site = Array.isArray(fsHeader) ? fsHeader[0] : fsHeader;
  if (typeof site === 'string' && !['same-origin', 'none'].includes(site.toLowerCase())) {
    json(res, 403, { ok: false, message: 'cross-site request rejected' });
    return false;
  }
  if (methods.indexOf(req.method) < 0) {
    res.setHeader('allow', methods.join(', '));
    json(res, 405, { ok: false, message: methods.join('/') + ' required' });
    return false;
  }
  return true;
}

function readBody(req) {
  return new Promise(function (resolve) {
    let done = false;
    const chunks = [];
    const finish = function (value) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      chunks.length = 0;
      resolve(value);
    };
    const timer = setTimeout(function () { finish({ ok: false, message: 'request body timeout' }); }, 10000);
    let size = 0;
    req.on('data', function (chunk) {
      if (done) return;
      size += chunk.length;
      if (size > 65536) { finish({ ok: false, message: 'request body too large' }); return; }
      chunks.push(chunk);
    });
    req.on('end', function () {
      if (done) return;
      try {
        const data = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('object required');
        finish({ ok: true, data });
      } catch { finish({ ok: false, message: 'JSON body must be an object' }); }
    });
    req.on('error', function () { finish({ ok: false, message: 'body read error' }); });
    req.on('aborted', function () { finish({ ok: false, message: 'body read aborted' }); });
    req.on('close', function () { if (!req.complete) finish({ ok: false, message: 'body read closed early' }); });
  });
}

function describeShape(v) {
  if (v === null || v === undefined) return 'no response';
  if (Array.isArray(v)) return 'array(' + v.length + ')';
  if (typeof v === 'object') {
    const k = Object.keys(v);
    return '{' + k.slice(0, 6).join(', ') + (k.length > 6 ? ', …' : '') + '} (' + k.length + ' keys)';
  }
  return typeof v;
}

function validEndpointData(key, data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  const arrayFields = { requests: ['requests'], devices: ['devices'], events: ['events'], policies: ['policy-groups', 'proxies'], modules: ['enabled'], rules: ['rules'], dns: ['dnsCache'] };
  if (arrayFields[key]) return arrayFields[key].every(function (field) { return Array.isArray(data[field]); });
  if (key === 'traffic') return !!data.interface && typeof data.interface === 'object' && !Array.isArray(data.interface);
  if (key === 'outbound') return typeof data.mode === 'string';
  if (key === 'profile') return typeof data.name === 'string';
  return true;
}

async function collectSnapshot(data, revision) {
  const ep = await resolveEndpoint(data, revision);
  if (!ep) return { ok: false, code: 'NO_GATEWAY', message: '未找到可用的 Surge HTTP API，请检查当前连接；HTTPS 自签证书需在连接中配置受信任 CA。' };
  const keys = Object.keys(ENDPOINTS);
  const results = await Promise.all(keys.map(async function (key) {
    return [key, await cachedJSON(ep, ENDPOINTS[key], SLOW_ENDPOINTS.has(key) ? 60000 : 1000)];
  }));
  const raw = {}, endpoints = {};
  for (const [key, result] of results) {
    raw[key] = result.data || null;
    endpoints[key] = { ok: result.ok, status: result.status || 0, updatedAt: result.updatedAt, stale: !result.ok && !!result.data, message: result.message || (result.ok ? '' : 'HTTP ' + result.status) };
  }
  if (!endpoints.traffic.ok) {
    cachedEndpoint = null;
    return { ok: false, code: 'API_ERROR', message: 'Surge 流量 API 不可用，请检查连接或运行 API 诊断。' };
  }
  const snapshot = buildSnapshot(raw, ep, data);
  snapshot.endpoints = endpoints;
  snapshot.connectionRevision = revision;
  snapshot.sampledAt = endpoints.traffic.updatedAt;
  return { ok: true, snapshot };
}

async function buildResponse(res) {
  const revision = connectionRevision;
  let job = snapshotJobs.get(revision);
  if (!job) {
    job = collectSnapshot(connectionCopy(), revision);
    snapshotJobs.set(revision, job);
    void job.finally(function () { if (snapshotJobs.get(revision) === job) snapshotJobs.delete(revision); }).catch(function () {});
  }
  const body = await job;
  if (revision !== connectionRevision) {
    json(res, 409, { ok: false, code: 'CONNECTION_CHANGED', message: '连接已切换，请重新刷新。' });
    return;
  }
  json(res, 200, body);
}

/* ---- Route handlers ---- */
function handleSnapshot(req, res) {
  if (!guard(req, res, ['GET', 'HEAD'])) return;
  void buildResponse(res).catch(function (e) {
    json(res, 500, { ok: false, message: String((e && e.message) || e).slice(0, 200) });
  });
}

function handleConnectionsList(req, res) {
  if (!guard(req, res, ['GET', 'HEAD'])) return;
  const data = loadConnections();
  json(res, 200, { ok: true, connections: connectionViews(data), activeId: data.activeId || 'local' });
}

async function handleConnectionSave(req, res) {
  if (!guard(req, res, ['POST'])) return;
  const body = await readBody(req);
  if (!body.ok) { json(res, 400, { ok: false, message: body.message }); return; }
  const norm = normalizeConnection(body.data.connection || body.data);
  if (!norm.ok) { json(res, 400, { ok: false, message: norm.message }); return; }
  const data = connectionCopy();
  const idx = data.connections.findIndex(function (c) { return c.id === norm.value.id; });
  if (idx >= 0) {
    /* An empty key on edit means "keep the stored key" (the browser can never
     * read it back), matching the reference product's Vault behaviour. */
    if (!norm.value.apiKey) norm.value.apiKey = data.connections[idx].apiKey;
    data.connections[idx] = norm.value;
  } else {
    if (data.connections.length >= 100) { json(res, 400, { ok: false, message: '最多保存 100 个连接' }); return; }
    data.connections.push(norm.value);
  }
  saveConnections(data);
  json(res, 200, { ok: true, connections: connectionViews(data), activeId: data.activeId || 'local' });
}

async function handleConnectionDelete(req, res) {
  if (!guard(req, res, ['POST'])) return;
  const body = await readBody(req);
  if (!body.ok) { json(res, 400, { ok: false, message: body.message }); return; }
  const id = String(body.data.id || '');
  if (!id || id === 'local') { json(res, 400, { ok: false, message: '本机连接不可删除' }); return; }
  const data = connectionCopy();
  data.connections = data.connections.filter(function (c) { return c.id !== id; });
  if (data.activeId === id) data.activeId = 'local';
  saveConnections(data);
  json(res, 200, { ok: true, connections: connectionViews(data), activeId: data.activeId });
}

async function handleConnectionActivate(req, res) {
  if (!guard(req, res, ['POST'])) return;
  const body = await readBody(req);
  if (!body.ok) { json(res, 400, { ok: false, message: body.message }); return; }
  const id = String(body.data.id || 'local');
  const data = connectionCopy();
  if (id !== 'local' && !data.connections.some(function (c) { return c.id === id; })) {
    json(res, 400, { ok: false, message: '连接不存在' }); return;
  }
  data.activeId = id;
  saveConnections(data);
  json(res, 200, { ok: true, connections: connectionViews(data), activeId: id });
}

async function handleConnectionTest(req, res) {
  if (!guard(req, res, ['POST'])) return;
  const body = await readBody(req);
  if (!body.ok) { json(res, 400, { ok: false, message: body.message }); return; }
  const data = loadConnections();
  let ep = null;
  const byId = String(body.data.id || '');
  if (byId && byId !== 'local') {
    const stored = data.connections.find(function (c) { return c.id === byId; });
    if (stored) ep = connectionToEndpoint(stored);
  }
  if (!ep && byId === 'local') ep = await resolveEndpoint({ activeId: 'local', connections: [] });
  if (!ep && body.data.connection) {
    const norm = normalizeConnection(Object.assign({}, body.data.connection, {
      apiKey: body.data.connection.apiKey || (function () {
        const s = data.connections.find(function (c) { return c.id === body.data.connection.id; });
        return s ? s.apiKey : '';
      })()
    }));
    if (!norm.ok) { json(res, 400, { ok: false, message: norm.message }); return; }
    ep = connectionToEndpoint(norm.value);
  }
  if (!ep) { json(res, 200, { ok: false, message: '缺少连接信息或 API 密钥' }); return; }
  const t0 = Date.now();
  const probe = await getJSON(ep, '/v1/outbound', 2500);
  const rtt = Date.now() - t0;
  json(res, 200, {
    ok: probe.ok, rtt: rtt,
    mode: probe.ok ? String((probe.data && probe.data.mode) || '') : '',
    message: probe.ok ? '连接成功' : ('连接失败：' + (probe.message || ('HTTP ' + probe.status)))
  });
}

function speedOf(tr) {
  let down = 0, up = 0;
  const intf = (tr && tr.data && tr.data.interface) || {};
  for (const k in intf) {
    const x = intf[k] || {};
    down += num(x.inCurrentSpeed);
    up += num(x.outCurrentSpeed);
  }
  return { down: down, up: up };
}

async function probeFleetOne(view) {
  const ep = await endpointForView(view);
  if (!ep) {
    return {
      id: view.id, name: view.name, host: view.host, port: view.port,
      active: view.active, isLocal: view.isLocal, online: false, rtt: 0,
      down: 0, up: 0, conns: 0, mode: '',
      message: view.isLocal ? '未发现本机 Surge HTTP API' : '缺少连接信息或 API 密钥'
    };
  }
  const t0 = Date.now();
  const [tr, ob, rq] = await Promise.all([
    cachedJSON(ep, '/v1/traffic'),
    cachedJSON(ep, '/v1/outbound'),
    cachedJSON(ep, '/v1/requests/recent')
  ]);
  const rtt = Date.now() - t0;
  const base = { id: view.id, name: view.name, host: view.host, port: view.port, active: view.active, isLocal: view.isLocal, rtt: rtt };
  if (!tr.ok) {
    return Object.assign(base, { online: false, down: 0, up: 0, conns: 0, mode: '', message: 'API 无响应：' + (tr.message || ('HTTP ' + tr.status)) });
  }
  const sp = speedOf(tr);
  let conns = 0;
  const reqs = (rq.ok && rq.data && rq.data.requests) || [];
  for (const r of reqs) if (r && !r.failed && !r.completed) conns++;
  return Object.assign(base, {
    online: true, down: sp.down, up: sp.up, conns: conns,
    mode: ob.ok ? String((ob.data && ob.data.mode) || '') : '',
    connsAvailable: rq.ok, modeAvailable: ob.ok,
    message: [!rq.ok ? '活动请求不可用' : '', !ob.ok ? '出站模式不可用' : ''].filter(Boolean).join('；')
  });
}

async function mapLimited(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async function () {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  }));
  return results;
}

async function handleFleet(req, res) {
  if (!guard(req, res, ['GET', 'HEAD'])) return;
  const revision = connectionRevision;
  const views = connectionViews(loadConnections());
  const fleet = await mapLimited(views, 4, probeFleetOne);
  if (revision !== connectionRevision) { json(res, 409, { ok: false, code: 'CONNECTION_CHANGED', message: '连接已变更，请刷新设备列表' }); return; }
  const totals = { online: 0, total: fleet.length, down: 0, up: 0, conns: 0, connsComplete: true };
  for (const f of fleet) {
    if (f.online) totals.online++;
    if (!f.online || !f.connsAvailable) totals.connsComplete = false;
    totals.down += f.down; totals.up += f.up; totals.conns += f.conns;
  }
  json(res, 200, { ok: true, fleet: fleet, totals: totals });
}

async function handleDiagnostics(req, res) {
  if (!guard(req, res, ['GET', 'HEAD'])) return;
  const revision = connectionRevision;
  const ep = await resolveEndpoint();
  if (!ep) {
    json(res, 200, { ok: false, code: 'NO_GATEWAY', message: '未找到可用的 Surge 网关，无法运行诊断。' });
    return;
  }
  const keys = Object.keys(ENDPOINTS);
  const checks = await Promise.all(keys.map(async function (k) {
    const t0 = Date.now();
    const r = await getJSON(ep, ENDPOINTS[k], 3000);
    return {
      name: k, path: ENDPOINTS[k], ok: r.ok && validEndpointData(k, r.data),
      message: r.message || (r.ok && !validEndpointData(k, r.data) ? 'Unexpected Surge API response shape' : ''),
      status: r.status || 0, rtt: Date.now() - t0,
      shape: r.ok ? describeShape(r.data) : (r.message || 'HTTP ' + r.status)
    };
  }));
  if (revision !== connectionRevision) { json(res, 409, { ok: false, code: 'CONNECTION_CHANGED', message: '连接已切换，请重新运行诊断' }); return; }
  json(res, 200, {
    ok: true,
    endpoint: { base: ep.base.replace(/^https?:\/\//, ''), port: ep.port, tls: !!ep.tls },
    checks: checks
  });
}

/* -------------------------------------------------------------------------- *
 * Registration. All routes are exact; a single disposer removes every one on
 * unload. Every promise is contained so an escaped rejection cannot hit the
 * Host's process-level unhandledRejection guard.
 * -------------------------------------------------------------------------- */
const ROUTES = [
  [ROUTE, handleSnapshot],
  ['/surge-api/connections', handleConnectionsList],
  ['/surge-api/connection/save', handleConnectionSave],
  ['/surge-api/connection/delete', handleConnectionDelete],
  ['/surge-api/connection/activate', handleConnectionActivate],
  ['/surge-api/connection/test', handleConnectionTest],
  ['/surge-api/fleet', handleFleet],
  ['/surge-api/diagnostics', handleDiagnostics]
];

function wrap(handler) {
  return function (req, res) {
    void Promise.resolve().then(function () { return handler(req, res); }).catch(function (e) {
      json(res, 500, { ok: false, message: String((e && e.message) || e).slice(0, 200) });
    });
  };
}

export function apply(ctx) {
  ctx.inject(['webServer'], function (webCtx) {
    const webServer = webCtx.get('webServer');
    if (webServer === undefined) return;
    webCtx.effect(function () {
      const offs = ROUTES.map(function (pair) {
        return webServer.register({ kind: 'exact', path: pair[0], handler: wrap(pair[1]) });
      });
      return function () { offs.forEach(function (off) { try { if (typeof off === 'function') off(); } catch (e) { /* noop */ } }); };
    }, 'surge-panel: api routes');
  });
}
