/*
 * Surge System Monitor — DSH-native Client half.
 *
 * A single React panel registered into the `main` keyed slot plus a matching
 * `sidebar.panellist` icon entry. Everything is rendered with the host React
 * runtime and styled with --dsw-alias-* theme tokens.
 *
 * This is a faithful DSH-native adaptation of surge-lan-console. The original
 * React product has a full navigable app: 仪表盘 / 设备总览(Fleet) / 连接(多实例
 * CRUD) / 设置(外观、刷新、诊断) / API Diagnostics. An earlier DSH port shipped
 * only the dashboard, dropping Settings and multi-instance management. This
 * half restores both through a tab bar (概览 / 设备管理 / 设置):
 *
 *   - 概览: the original dashboard, plus the two requested display fixes
 *     (evenly-sampled chart x-axis; de-duplicated, single-line recent events).
 *   - 设备管理: connection CRUD + set-active + test + a Fleet summary that
 *     aggregates EVERY saved Surge instance (the original FleetPage concept,
 *     which is different from the LAN-client "设备总览" card on the dashboard).
 *   - 设置: appearance (system/light/dark), refresh interval / pause, trend
 *     sample points, device & event caps, active-connection info, API
 *     diagnostics and an honest About note.
 *
 * Data is REAL. The Host half reads the local Surge profile, injects the private
 * X-Key, stores keys for saved instances in a Host-private file, and proxies
 * the HTTP API over same-origin routes. Stored keys are never returned;
 * nothing is fabricated; errors are surfaced.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-surge-panel',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const useState = React.useState;
    const useEffect = React.useEffect;
    const useRef = React.useRef;

    const NS = 'surgePanel';
    const PANEL_ID = 'surge-monitor';
    const VERSION = '1.1.1';

    /* ------------------------------------------------------------------ *
     * Dictionaries. zh + en are the baselines; every other UI locale falls
     * back to English so a missing locale never leaks a raw key into the UI.
     * ------------------------------------------------------------------ */
    const zh = {
      'panel.title': 'Surge 系统监控',
      'header.subtitle': 'Surge 网关实时数据 · 参照 surge-lan-console 适配',
      'badge.live': '实时数据',
      'badge.connecting': '连接中',
      'badge.offline': '未连接',
      'status.online': '已连接 Surge 网关',
      'status.via': '当前连接',
      'status.updated': '更新于',
      'status.loading': '正在连接 Surge 网关…',
      'status.error': '无法读取 Surge 数据',
      'status.unavailable': '数据不可用',
      'status.stale': '上次成功数据',
      'status.paused': '自动刷新已暂停',
      'status.partial': '仅汇总已成功读取的实例',
      'dm.field.ca': 'HTTPS 自定义 CA 证书（可选，PEM）',
      'dm.field.caHint': 'HTTPS 始终校验证书；自签证书请填写其受信任 CA。主机字段仅填写域名或 IP。',
      'action.refresh': '刷新',
      'action.retry': '重试',
      'tab.overview': '概览',
      'tab.devices': '设备管理',
      'tab.settings': '设置',
      'uptime.days': '天',
      'uptime.hours': '时',
      'uptime.mins': '分',
      'metrics.download': '下载速度',
      'metrics.upload': '上传速度',
      'metrics.session': '会话流量',
      'metrics.uptime': '运行时长',
      'metrics.conns': '活动连接',
      'metrics.failed': '失败请求',
      'chart.title': '流量趋势',
      'chart.down': '下载',
      'chart.up': '上传',
      'chart.empty': '点击上方图例以显示曲线',
      'chart.sampling': '正在采样…打开面板后开始记录真实速率，请稍候。',
      'chart.sampled': '自打开面板起采样',
      'chart.peak': '峰值',
      'devices.title': '设备总览',
      'devices.online': '台设备',
      'devices.throughput': '当前吞吐',
      'devices.empty': '暂无设备数据',
      'network.title': '网络环境',
      'network.mode': '出站模式',
      'network.profile': '当前配置',
      'network.port': 'API 端口',
      'network.rules': '规则 / 策略组',
      'network.res': '模块 / DNS 缓存',
      'quality.title': '节点流量',
      'quality.latency': '按会话流量',
      'quality.empty': '暂无节点数据',
      'events.title': '最近事件',
      'events.empty': '暂无事件',
      'note': '数据来自 Surge HTTP API：本机密钥由 Host 读取；手动填写的密钥仅用于测试或保存，保存后不会返回浏览器。曲线记录当前连接的真实采样，切换连接后重新开始。',
      /* ---- 设备管理 ---- */
      'dm.title': '设备管理',
      'dm.subtitle': '管理多个 Surge 实例，切换当前连接，并汇总所有实例的在线状态与吞吐',
      'dm.add': '添加连接',
      'dm.edit': '编辑',
      'dm.delete': '删除',
      'dm.activate': '设为当前',
      'dm.active': '当前',
      'dm.test': '测试连接',
      'dm.save': '保存',
      'dm.cancel': '取消',
      'dm.confirmDelete': '确认删除该连接？此操作不可撤销。',
      'dm.field.name': '名称',
      'dm.field.protocol': '协议',
      'dm.field.host': '主机',
      'dm.field.port': '端口',
      'dm.field.platform': '平台',
      'dm.field.key': 'API 密钥 (X-Key)',
      'dm.field.keyHint': '留空表示不修改已保存的密钥',
      'dm.field.keyStored': '已保存',
      'dm.field.keyMissing': '未设置',
      'dm.local': '本机',
      'dm.localHint': '自动读取本机 Surge 配置，密钥不进入浏览器；可切换、测试，但不可编辑或删除。',
      'dm.form.add': '添加 Surge 实例',
      'dm.form.edit': '编辑 Surge 实例',
      'dm.saved': '已保存连接',
      'dm.online': '在线设备',
      'dm.totalDown': '总下载',
      'dm.totalUp': '总上传',
      'dm.activeReqs': '活动请求',
      'dm.fleet.title': '设备总览（多实例汇总）',
      'dm.fleet.refresh': '刷新全部',
      'dm.status.online': '在线',
      'dm.status.offline': '离线',
      'dm.status.noKey': '缺少密钥',
      'dm.rtt': 'API 延迟',
      'dm.hostPort': '访问地址',
      'dm.platform.auto': '自动',
      'dm.platform.ios': 'iOS',
      'dm.platform.tvos': 'tvOS',
      'dm.platform.macos': 'macOS',
      'dm.emptyHint': '尚未添加其他 Surge 实例。点击「添加连接」，把局域网内或远程的其他网关纳入监控。',
      'dm.test.ok': '连接成功',
      'dm.test.fail': '连接失败',
      'dm.activated': '已切换当前连接',
      'dm.savedOk': '连接已保存',
      'dm.deleted': '连接已删除',
      'dm.error': '操作失败',
      'dm.keyBadge': '密钥',
      'dm.rttUnit': 'ms',
      'dm.refresh': '刷新',
      'dm.saveErr': '请填写名称、主机与端口',
      /* ---- 设置 ---- */
      'st.title': '设置',
      'st.subtitle': '面板偏好保存在本浏览器；连接与密钥保存在 Host，已保存的密钥不会回传',
      'st.appearance': '外观与体验',
      'st.appearance.desc': '选择面板配色；跟随系统会继承 DSH 当前主题，浅色 / 深色仅作用于本面板。',
      'st.appearance.system': '跟随系统',
      'st.appearance.light': '浅色',
      'st.appearance.dark': '深色',
      'st.data': '数据刷新',
      'st.refresh': '刷新间隔',
      'st.refresh.desc': '轮询 Host 快照的间隔；越短曲线越平滑，但请求更频繁。',
      'st.pause': '暂停自动刷新',
      'st.pause.desc': '暂停后仅在手动点击「刷新」时采样一次。',
      'st.samples': '趋势采样点数',
      'st.samples.desc': '流量曲线保留的最近采样数量。',
      'st.display': '显示',
      'st.maxDevices': '设备显示上限',
      'st.maxDevices.desc': '概览「设备总览」中最多显示的 LAN 客户端数量。',
      'st.maxEvents': '事件显示上限',
      'st.maxEvents.desc': '概览「最近事件」合并去重后最多显示条数。',
      'st.seconds': '秒',
      'st.connection': '当前连接',
      'st.connection.desc': '概览数据来自此实例；可在「设备管理」中切换。',
      'st.diagnostics': 'API 诊断',
      'st.diagnostics.desc': '逐端点检查 Surge HTTP API 的状态、延迟与响应结构，用于排查连接问题。',
      'st.diag.run': '运行诊断',
      'st.diag.running': '正在诊断…',
      'st.diag.endpoint': '端点',
      'st.diag.status': '状态',
      'st.diag.rtt': '延迟',
      'st.diag.shape': '响应结构',
      'st.diag.ok': '正常',
      'st.diag.fail': '失败',
      'st.diag.gateway': '网关',
      'st.diag.retry': '请先在「设备管理」中确认当前连接可用，再运行诊断。',
      'st.about': '关于',
      'st.about.version': '版本',
      'st.about.type': '类型',
      'st.about.source': '数据来源',
      'st.reset': '恢复默认',
      'st.note': '说明：原项目的「锁定控制台 / 通知中心 / 后台自动化 / 演示模式」与 Surge 功能写开关，依赖独立的 Node Core、SQLite 和任务调度层；本插件是 DSH 原生的只读监控面板，不内嵌这些写操作或伪造数据，改以面板级外观、刷新与多实例管理提供等价能力。',
      'st.loading': '加载中…',
      'st.typeValue': 'DSH 原生插件（Host + Client）',
      'st.sourceValue': 'Surge HTTP API · 真实数据'
    };
    const en = {
      'panel.title': 'Surge system monitor',
      'header.subtitle': 'Live data from your Surge gateways · adapted from surge-lan-console',
      'badge.live': 'Live data',
      'badge.connecting': 'Connecting',
      'badge.offline': 'Disconnected',
      'status.online': 'Connected to Surge gateway',
      'status.via': 'Active',
      'status.updated': 'Updated',
      'status.loading': 'Connecting to the Surge gateway…',
      'status.error': 'Could not read Surge data',
      'status.unavailable': 'Data unavailable',
      'status.stale': 'Last successful data',
      'status.paused': 'Auto-refresh paused',
      'status.partial': 'Totals include successfully read instances only',
      'dm.field.ca': 'Custom HTTPS CA certificate (optional, PEM)',
      'dm.field.caHint': 'HTTPS always verifies certificates. Add a trusted CA for self-signed certificates. Enter only a domain or IP in Host.',
      'action.refresh': 'Refresh',
      'action.retry': 'Retry',
      'tab.overview': 'Overview',
      'tab.devices': 'Devices',
      'tab.settings': 'Settings',
      'uptime.days': 'd ',
      'uptime.hours': 'h',
      'uptime.mins': 'm',
      'metrics.download': 'Download',
      'metrics.upload': 'Upload',
      'metrics.session': 'Session traffic',
      'metrics.uptime': 'Uptime',
      'metrics.conns': 'Active connections',
      'metrics.failed': 'Failed requests',
      'chart.title': 'Traffic',
      'chart.down': 'Download',
      'chart.up': 'Upload',
      'chart.empty': 'Toggle the legend above to show a series',
      'chart.sampling': 'Sampling… real rates are recorded from the moment the panel opens. Please wait.',
      'chart.sampled': 'Sampled since this panel opened',
      'chart.peak': 'Peak',
      'devices.title': 'Devices',
      'devices.online': 'devices',
      'devices.throughput': 'Throughput',
      'devices.empty': 'No device data',
      'network.title': 'Network environment',
      'network.mode': 'Outbound mode',
      'network.profile': 'Active profile',
      'network.port': 'API port',
      'network.rules': 'Rules / groups',
      'network.res': 'Modules / DNS cache',
      'quality.title': 'Node traffic',
      'quality.latency': 'By session traffic',
      'quality.empty': 'No node data',
      'events.title': 'Recent events',
      'events.empty': 'No events',
      'note': 'Data comes from the Surge HTTP API. The Host reads local keys; manually entered keys are submitted for testing or saving and are never returned once stored. The curve records real samples for the current connection and restarts when it changes.',
      /* ---- Devices ---- */
      'dm.title': 'Device management',
      'dm.subtitle': 'Manage multiple Surge instances, switch the active one and review fleet-wide status',
      'dm.add': 'Add connection',
      'dm.edit': 'Edit',
      'dm.delete': 'Delete',
      'dm.activate': 'Set active',
      'dm.active': 'Active',
      'dm.test': 'Test',
      'dm.save': 'Save',
      'dm.cancel': 'Cancel',
      'dm.confirmDelete': 'Delete this connection? This cannot be undone.',
      'dm.field.name': 'Name',
      'dm.field.protocol': 'Protocol',
      'dm.field.host': 'Host',
      'dm.field.port': 'Port',
      'dm.field.platform': 'Platform',
      'dm.field.key': 'API key (X-Key)',
      'dm.field.keyHint': 'Leave blank to keep the saved key',
      'dm.field.keyStored': 'Stored',
      'dm.field.keyMissing': 'Not set',
      'dm.local': 'Local',
      'dm.localHint': 'Auto-read from the local Surge profile; the key never reaches the browser. Can be activated/tested, not edited or deleted.',
      'dm.form.add': 'Add a Surge instance',
      'dm.form.edit': 'Edit a Surge instance',
      'dm.saved': 'Saved',
      'dm.online': 'Online',
      'dm.totalDown': 'Total down',
      'dm.totalUp': 'Total up',
      'dm.activeReqs': 'Active reqs',
      'dm.fleet.title': 'Fleet overview (all instances)',
      'dm.fleet.refresh': 'Refresh all',
      'dm.status.online': 'Online',
      'dm.status.offline': 'Offline',
      'dm.status.noKey': 'No key',
      'dm.rtt': 'API RTT',
      'dm.hostPort': 'Address',
      'dm.platform.auto': 'Auto',
      'dm.platform.ios': 'iOS',
      'dm.platform.tvos': 'tvOS',
      'dm.platform.macos': 'macOS',
      'dm.emptyHint': 'No other Surge instances yet. Click "Add connection" to include another LAN or remote gateway.',
      'dm.test.ok': 'Connection OK',
      'dm.test.fail': 'Connection failed',
      'dm.activated': 'Active connection switched',
      'dm.savedOk': 'Connection saved',
      'dm.deleted': 'Connection deleted',
      'dm.error': 'Operation failed',
      'dm.keyBadge': 'Key',
      'dm.rttUnit': 'ms',
      'dm.refresh': 'Refresh',
      'dm.saveErr': 'Name, host and port are required',
      /* ---- Settings ---- */
      'st.title': 'Settings',
      'st.subtitle': 'Preferences are stored in this browser; connections and keys stay on the Host',
      'st.appearance': 'Appearance',
      'st.appearance.desc': 'Choose the panel palette; System inherits the current DSH theme, Light/Dark apply to this panel only.',
      'st.appearance.system': 'System',
      'st.appearance.light': 'Light',
      'st.appearance.dark': 'Dark',
      'st.data': 'Data refresh',
      'st.refresh': 'Refresh interval',
      'st.refresh.desc': 'How often the Host snapshot is polled. Shorter = smoother curve, more requests.',
      'st.pause': 'Pause auto-refresh',
      'st.pause.desc': 'When paused, a sample is taken only on a manual Refresh.',
      'st.samples': 'Trend sample points',
      'st.samples.desc': 'Number of recent samples kept in the traffic curve.',
      'st.display': 'Display',
      'st.maxDevices': 'Max devices shown',
      'st.maxDevices.desc': 'Cap on LAN clients shown in the Overview device card.',
      'st.maxEvents': 'Max events shown',
      'st.maxEvents.desc': 'Cap on merged recent events shown in Overview.',
      'st.seconds': 's',
      'st.connection': 'Active connection',
      'st.connection.desc': 'Overview data comes from this instance; switch it in Devices.',
      'st.diagnostics': 'API diagnostics',
      'st.diagnostics.desc': 'Check each Surge HTTP API endpoint for status, latency and response shape.',
      'st.diag.run': 'Run diagnostics',
      'st.diag.running': 'Running…',
      'st.diag.endpoint': 'Endpoint',
      'st.diag.status': 'Status',
      'st.diag.rtt': 'RTT',
      'st.diag.shape': 'Shape',
      'st.diag.ok': 'OK',
      'st.diag.fail': 'Failed',
      'st.diag.gateway': 'Gateway',
      'st.diag.retry': 'Confirm the active connection in Devices first, then run diagnostics.',
      'st.about': 'About',
      'st.about.version': 'Version',
      'st.about.type': 'Type',
      'st.about.source': 'Data source',
      'st.reset': 'Reset to defaults',
      'st.note': 'Note: the original product\'s console lock / notification centre / background automation / demo mode and the Surge feature write-switches depend on a separate Node Core, SQLite and scheduler. This plugin is a DSH-native read-only monitor: it does not embed those writes or fabricate data, and instead offers panel-level appearance, refresh and multi-instance management as equivalents.',
      'st.loading': 'Loading…',
      'st.typeValue': 'DSH-native plugin (Host + Client)',
      'st.sourceValue': 'Surge HTTP API · real data'
    };
    const dicts = {
      zh: zh, 'zh-CN': zh, 'zh-TW': zh, en: en,
      ja: en, es: en, fr: en, de: en, ru: en, pt: en, ko: en, it: en,
      nl: en, pl: en, tr: en, ar: en, th: en, vi: en, id: en, hi: en
    };

    /* ------------------------------------------------------------------ *
     * Lucide-like stroke paths (24x24). Pure artwork, no text, no scripts.
     * ------------------------------------------------------------------ */
    const PATHS = {
      activity: 'M22 12h-4l-3 9L9 3l-3 9H2',
      download: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3',
      upload: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12',
      clock: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 6v6l4 2',
      link: 'M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71',
      refresh: 'M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6',
      wifi: 'M5 12.55a11 11 0 0 1 14.08 0M1.42 9a16 16 0 0 1 21.16 0M8.53 16.11a6 6 0 0 1 6.95 0M12 20h.01',
      globe: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z',
      shield: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z',
      server: 'M4 4h16v6H4zM4 14h16v6H4zM8 7h.01M8 17h.01',
      info: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 16v-4M12 8h.01',
      laptop: 'M4 5h16v11H4zM2 20h20M9 20l-.5 1.5M15 20l.5 1.5',
      phone: 'M7 2h10v20H7zM10 5h4M11 18.5h2',
      tv: 'M3 5h18v12H3zM8 21h8M12 17v4',
      speaker: 'M6 3h4v18H6zM14 8a5 5 0 0 1 0 8M17 5a9 9 0 0 1 0 14',
      trendUp: 'M3 17l6-6 4 4 8-8M15 7h6v6',
      trendDown: 'M3 7l6 6 4-4 8 8M15 17h6v-6',
      radio: 'M12 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2zM8.5 8.5a5 5 0 0 0 0 7M15.5 8.5a5 5 0 0 1 0 7M5.5 5.5a9 9 0 0 0 0 13M18.5 5.5a9 9 0 0 1 0 13',
      mapPin: 'M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0zM12 12a2 2 0 1 0 0-4 2 2 0 0 0 0 4z',
      arrowUpRight: 'M7 17 17 7M8 7h9v9',
      settings: 'M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09A1.65 1.65 0 0 0 15 4.6a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9c.14.34.4.62.74.8.3.16.64.25.99.26H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z',
      plus: 'M12 5v14M5 12h14',
      check: 'M20 6 9 17l-5-5',
      trash: 'M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6',
      sliders: 'M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6'
    };

    /* ------------------------------------------------------------------ *
     * Real-data helpers.
     * ------------------------------------------------------------------ */
    function fmtBytes(bytes, perSec) {
      const b = Math.max(0, Number(bytes) || 0);
      const units = ['B', 'KB', 'MB', 'GB', 'TB'];
      let i = 0, v = b;
      while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
      const digits = v >= 100 ? 0 : v >= 10 ? 1 : 2;
      return { value: v.toFixed(digits), unit: units[i] + (perSec ? '/s' : '') };
    }
    function fmtUptime(sec, t) {
      const s = Math.max(0, Math.floor(Number(sec) || 0));
      const d = Math.floor(s / 86400), hh = Math.floor((s % 86400) / 3600), mm = Math.floor((s % 3600) / 60);
      if (d > 0) return d + t('uptime.days') + hh + t('uptime.hours');
      if (hh > 0) return hh + t('uptime.hours') + mm + t('uptime.mins');
      return mm + t('uptime.mins');
    }
    function pad(n) { return String(n).padStart(2, '0'); }
    function fmtTime(d) { return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()); }
    function toneOf(tone) { return 'sg-tone-' + (tone || 'idle'); }
    function clampInt(v, min, max, fallback) {
      const n = Number(v);
      if (!isFinite(n)) return fallback;
      return Math.min(max, Math.max(min, Math.round(n)));
    }

    /* FIX 1 (traffic x-axis): instead of one label per sample (48 cramped
     * "13:37" spans that overflowed the container), pick AT MOST `count`
     * evenly-spaced ticks from the real label buffer. Labels carry seconds so
     * adjacent ticks stay distinguishable. */
    function tickLabels(labels, count) {
      const n = labels.length;
      if (!n) return [];
      const k = Math.min(count, n);
      const out = [];
      for (let i = 0; i < k; i++) {
        const idx = k === 1 ? 0 : Math.round(i * (n - 1) / (k - 1));
        out.push({ label: labels[idx], odd: (i % 2) === 1 });
      }
      return out;
    }

    /* FIX 2 (recent events): merge identical (tone+text) entries into one
     * row with a ×N badge, so a flood of "Connection refuse (POSIX:61)" lines
     * no longer renders as a wall of fragmented two-line items. */
    function mergeEvents(list) {
      const order = [];
      const map = {};
      for (const e of list) {
        const key = (e.tone || 'idle') + '\u0000' + String(e.text || '');
        if (!map[key]) {
          map[key] = { time: e.time || '', text: e.text || '', tone: e.tone || 'idle', count: 0, key: key };
          order.push(key);
        }
        map[key].count += 1;
      }
      return order.map(function (k) { return map[k]; });
    }

    async function api(path, opts = {}) {
      const controller = new AbortController();
      const abort = function () { controller.abort(); };
      const { timeoutMs = 15000, signal, ...request } = opts;
      if (signal) {
        if (signal.aborted) abort();
        else signal.addEventListener('abort', abort, { once: true });
      }
      const timer = setTimeout(abort, timeoutMs);
      try {
        const response = await fetch(path, { headers: { Accept: 'application/json' }, cache: 'no-store', ...request, signal: controller.signal });
        let body;
        try { body = await response.json(); }
        catch { throw new Error('Invalid JSON response (HTTP ' + response.status + ')'); }
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Invalid API response');
        return response.ok ? body : { ...body, ok: false, message: body.message || 'HTTP ' + response.status };
      } finally {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', abort);
      }
    }
    function post(path, body, opts) {
      return api(path, {
        ...opts,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body || {})
      });
    }

    /* ------------------------------------------------------------------ *
     * Preferences — stored in the browser (matching the original product's
     * zustand-persist preferences store). Validated on read so a stale or
     * hand-edited localStorage value can never break the panel.
     * ------------------------------------------------------------------ */
    const PREF_KEY = 'dsh-surge-panel.preferences';
    const DEFAULTS = {
      appearance: 'system', refreshMs: 5000, samplePoints: 48,
      maxDevices: 8, maxEvents: 6, paused: false
    };
    function createPrefs() {
      let state = Object.assign({}, DEFAULTS);
      try {
        const raw = localStorage.getItem(PREF_KEY);
        if (raw) {
          const p = JSON.parse(raw) || {};
          state = {
            appearance: ['system', 'light', 'dark'].indexOf(p.appearance) >= 0 ? p.appearance : 'system',
            refreshMs: [2000, 5000, 10000, 30000, 60000].indexOf(Number(p.refreshMs)) >= 0 ? Number(p.refreshMs) : 5000,
            samplePoints: [24, 48, 96, 144].indexOf(Number(p.samplePoints)) >= 0 ? Number(p.samplePoints) : 48,
            maxDevices: clampInt(p.maxDevices, 2, 16, 8),
            maxEvents: clampInt(p.maxEvents, 2, 12, 6),
            paused: !!p.paused
          };
        }
      } catch (e) { /* fall back to defaults */ }
      const subs = new Set();
      const notify = function () { subs.forEach(function (f) { try { f(); } catch (e) { /* noop */ } }); };
      return {
        get: function () { return state; },
        set: function (patch) {
          state = Object.assign({}, state, patch);
          try { localStorage.setItem(PREF_KEY, JSON.stringify(state)); } catch (e) { /* noop */ }
          notify();
        },
        reset: function () {
          state = Object.assign({}, DEFAULTS);
          try { localStorage.setItem(PREF_KEY, JSON.stringify(state)); } catch (e) { /* noop */ }
          notify();
        },
        subscribe: function (f) { subs.add(f); return function () { subs.delete(f); }; }
      };
    }
    const prefs = createPrefs();

    /* Shared live-data store: latest Host snapshot + a rolling REAL sample
     * buffer. Labels carry seconds (HH:MM:SS) for readable x-axis ticks. */
    function createStore() {
      let state = { status: 'loading', snap: null, error: '', updated: null };
      const down = [], up = [], labels = [];
      const subs = new Set();
      let epoch = 0, flight = null, seriesKey = '', lastSample = null;
      const clearSamples = function () { down.length = 0; up.length = 0; labels.length = 0; lastSample = null; };
      const emit = function (next) { state = next; subs.forEach(function (fn) { try { fn(); } catch { /* Isolate subscriber failures. */ } }); };
      const cancel = function () {
        epoch++;
        if (flight) flight.controller.abort();
        flight = null;
      };
      const fetchOnce = function () {
        if (flight) return flight.promise;
        if (typeof fetch !== 'function') return Promise.resolve();
        const currentEpoch = epoch;
        const current = { controller: new AbortController(), promise: null };
        flight = current;
        current.promise = api('/surge-api/snapshot', { signal: current.controller.signal })
          .then(function (body) {
            if (currentEpoch !== epoch) return;
            if (body.ok && body.snapshot) {
              const snapshot = body.snapshot;
              const key = snapshot.activeConnection.id + ':' + snapshot.connectionRevision;
              if (seriesKey !== key) { clearSamples(); seriesKey = key; }
              const sampledAt = snapshot.sampledAt || Date.now();
              const when = new Date(sampledAt);
              if (sampledAt !== lastSample) {
                down.push(Math.max(0, Number(snapshot.down) || 0));
                up.push(Math.max(0, Number(snapshot.up) || 0));
                labels.push(fmtTime(when));
                if (down.length > 144) { down.shift(); up.shift(); labels.shift(); }
                lastSample = sampledAt;
              }
              emit({ status: 'ok', snap: snapshot, error: '', updated: when });
            } else {
              if (body.code === 'CONNECTION_CHANGED') { clearSamples(); seriesKey = ''; }
              emit({ status: 'error', snap: body.code === 'CONNECTION_CHANGED' ? null : state.snap, error: body.message || body.code || 'Unknown error', updated: state.updated });
            }
          })
          .catch(function (error) {
            if (currentEpoch !== epoch) return;
            emit({ status: 'error', snap: state.snap, error: String(error.message || error), updated: state.updated });
          })
          .finally(function () { if (flight === current) flight = null; });
        return current.promise;
      };
      return {
        get: function () { return state; },
        subscribe: function (fn) { subs.add(fn); return function () { subs.delete(fn); }; },
        fetch: fetchOnce,
        cancel,
        invalidate: function () {
          cancel(); clearSamples(); seriesKey = '';
          emit({ status: 'loading', snap: null, error: '', updated: null });
        },
        buffers: function () { return { down, up, labels }; }
      };
    }
    const store = createStore();

    function startPolling(store, preferences, doc = document) {
      let stopped = false, timer = null, generation = 0;
      const tick = function () {
        clearTimeout(timer);
        const current = ++generation;
        if (stopped || preferences.paused || doc.hidden) { store.cancel(); return; }
        void store.fetch().finally(function () {
          if (!stopped && current === generation && !doc.hidden && !preferences.paused) timer = setTimeout(tick, preferences.refreshMs);
        });
      };
      doc.addEventListener('visibilitychange', tick);
      tick();
      return function () {
        stopped = true; generation++;
        clearTimeout(timer);
        doc.removeEventListener('visibilitychange', tick);
        store.cancel();
      };
    }


    /* ------------------------------------------------------------------ *
     * Scoped stylesheet. Colours come from --dsw-alias-* tokens. The two
     * `sg-force-*` blocks re-declare those tokens locally so the user's
     * explicit Light/Dark choice applies to THIS panel only (System inherits
     * the host theme untouched). Injected once via ctx.effect; removed on
     * unload.
     * ------------------------------------------------------------------ */
    const CSS = `
.sg-root{box-sizing:border-box;height:100%;min-height:0;overflow-y:auto;padding:28px 32px 40px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;font-size:14px;line-height:1.5}
.sg-root *{box-sizing:border-box}
.sg-root button,.sg-root input,.sg-root select{font-family:inherit}
.sg-root::-webkit-scrollbar{width:9px}
.sg-root::-webkit-scrollbar-thumb{background:var(--dsw-alias-border-l2);border-radius:9px;border:2px solid var(--dsw-alias-bg-base)}
.sg-mono{font-family:SFMono-Regular,Menlo,Monaco,Consolas,monospace;font-variant-numeric:tabular-nums}
.sg-num{font-variant-numeric:tabular-nums;letter-spacing:-.01em}
.sg-sub{font-size:12px;color:var(--dsw-alias-label-secondary)}
.sg-ic{display:block;flex:none}
.sg-root.sg-force-light{--dsw-alias-bg-base:#f5f5f7;--dsw-alias-bg-layer-1:#ffffff;--dsw-alias-bg-layer-2:#ececf0;--dsw-alias-bg-overlay:#ffffff;--dsw-alias-border-l1:#e2e2e7;--dsw-alias-border-l2:#c9c9d0;--dsw-alias-brand-primary:#d4623b;--dsw-alias-label-primary:#1c1c1e;--dsw-alias-label-secondary:#6b6b72;--dsw-alias-state-error-primary:#d63a3f;--dsw-alias-state-idle-primary:#8e8e95;--dsw-alias-state-success-primary:#1f9d63;--dsw-alias-state-warn-primary:#c07d0a}
.sg-root.sg-force-dark{--dsw-alias-bg-base:#1a1a1c;--dsw-alias-bg-layer-1:#232326;--dsw-alias-bg-layer-2:#2c2c30;--dsw-alias-bg-overlay:#232326;--dsw-alias-border-l1:#343438;--dsw-alias-border-l2:#48484e;--dsw-alias-brand-primary:#e0684a;--dsw-alias-label-primary:#f2f2f4;--dsw-alias-label-secondary:#9a9aa2;--dsw-alias-state-error-primary:#ef5f63;--dsw-alias-state-idle-primary:#8e8e95;--dsw-alias-state-success-primary:#4ac97e;--dsw-alias-state-warn-primary:#e6a23c}

.sg-header{display:flex;align-items:center;gap:14px;flex-wrap:wrap}
.sg-brand{width:44px;height:44px;border-radius:13px;display:flex;align-items:center;justify-content:center;color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1)}
.sg-head-txt{flex:1;min-width:180px}
.sg-title{margin:0;font-size:24px;line-height:1.2;font-weight:650;letter-spacing:-.02em}
.sg-subtitle{margin:3px 0 0;font-size:13px;color:var(--dsw-alias-label-secondary)}
.sg-head-right{display:flex;align-items:center;gap:10px;margin-left:auto}
.sg-badge{display:inline-flex;align-items:center;gap:7px;padding:6px 11px;border-radius:999px;font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1)}
.sg-badge.is-live{color:var(--dsw-alias-state-success-primary)}
.sg-badge-dot{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-label-secondary)}
.sg-badge.is-live .sg-badge-dot{background:var(--dsw-alias-state-success-primary)}
.sg-error{display:flex;align-items:center;gap:10px;padding:12px 14px;border-radius:11px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary);font-size:12px}
.sg-error-txt{flex:1;min-width:0;overflow-wrap:anywhere}
.sg-retry{flex:none;padding:6px 12px;border-radius:8px;border:1px solid var(--dsw-alias-state-error-primary);background:transparent;color:var(--dsw-alias-state-error-primary);font-size:12px;font-weight:600;cursor:pointer}
.sg-retry:hover{background:var(--dsw-alias-bg-layer-2)}
.sg-root :focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.sg-icon-btn{width:34px;height:34px;display:inline-flex;align-items:center;justify-content:center;border-radius:9px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);cursor:pointer;transition:color .15s,border-color .15s,transform .15s}
.sg-icon-btn:hover{color:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-border-l2)}
.sg-icon-btn:active{transform:scale(.93)}
@keyframes sgSpin{from{transform:rotate(0)}to{transform:rotate(360deg)}}
.sg-spin{animation:sgSpin .6s ease}

/* Tab bar */
.sg-tabbar{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin:18px 0 20px}
.sg-tabs{display:flex;gap:4px;padding:4px;border-radius:11px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1)}
.sg-tab{display:inline-flex;align-items:center;gap:7px;padding:7px 15px;border-radius:8px;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font-size:13px;font-weight:600;cursor:pointer;white-space:nowrap}
.sg-tab:hover{color:var(--dsw-alias-label-primary)}
.sg-tab.is-active{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.sg-tabbar-sp{flex:1}
.sg-active-chip{display:inline-flex;align-items:center;gap:7px;padding:6px 11px;border-radius:999px;font-size:12px;font-weight:600;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary)}
.sg-active-chip .sg-ic{color:var(--dsw-alias-brand-primary)}

.sg-livebar{display:flex;align-items:center;gap:9px;padding:10px 14px;border-radius:11px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);font-size:12px;flex-wrap:wrap}
.sg-dot-live{width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-state-warn-primary)}
.sg-dot-live.is-live{background:var(--dsw-alias-state-success-primary)}
.sg-live-txt{font-weight:600;color:var(--dsw-alias-label-primary)}
.sg-live-sp{flex:1}

.sg-card{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:16px;padding:18px 20px;transition:border-color .15s,box-shadow .15s}
.sg-card:hover{border-color:var(--dsw-alias-border-l2)}
.sg-card-h{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:16px;flex-wrap:wrap}
.sg-card-h:last-child{margin-bottom:0}
.sg-card-h.is-tall{align-items:flex-start}
.sg-card-t{margin:0;font-size:14px;font-weight:650;display:flex;align-items:center;gap:8px}
.sg-card-t .sg-ic{color:var(--dsw-alias-label-secondary)}
.sg-h-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}

.sg-metrics{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:14px}
.sg-metric{padding:16px 16px 10px;display:flex;flex-direction:column;gap:10px;overflow:hidden}
.sg-metric-head{display:flex;align-items:center;gap:9px}
.sg-ico-tile{width:28px;height:28px;border-radius:8px;display:inline-flex;align-items:center;justify-content:center;background:var(--dsw-alias-bg-layer-2)}
.sg-metric-label{font-size:12px;color:var(--dsw-alias-label-secondary);font-weight:500}
.sg-metric-row{display:flex;align-items:baseline;justify-content:space-between;gap:8px}
.sg-metric-num{font-size:26px;font-weight:650;line-height:1;white-space:nowrap}
.sg-unit{font-size:12px;color:var(--dsw-alias-label-secondary);margin-left:5px;font-weight:500}
.sg-spark{width:100%;height:28px;display:block;margin-top:2px}
.sg-spark-ph{height:28px}
.sg-spark-line{fill:none;stroke:currentColor;stroke-width:1.6;vector-effect:non-scaling-stroke;stroke-linejoin:round;stroke-linecap:round}
.sg-spark-area{fill:currentColor;opacity:.12}

.sg-tone-brand{color:var(--dsw-alias-brand-primary)}
.sg-tone-success{color:var(--dsw-alias-state-success-primary)}
.sg-tone-warn{color:var(--dsw-alias-state-warn-primary)}
.sg-tone-idle{color:var(--dsw-alias-state-idle-primary)}
.sg-tone-error{color:var(--dsw-alias-state-error-primary)}

.sg-main-grid{display:grid;grid-template-columns:minmax(0,1.65fr) minmax(0,1fr);gap:14px}
.sg-bottom-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px}

.sg-legend{display:inline-flex;gap:6px}
.sg-legend-btn{display:inline-flex;align-items:center;gap:6px;border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;padding:4px 8px;border-radius:7px;cursor:pointer;transition:opacity .15s,border-color .15s}
.sg-legend-btn:hover{border-color:var(--dsw-alias-border-l1)}
.sg-legend-btn.is-off{opacity:.38;text-decoration:line-through}
.sg-legend-dot{width:8px;height:8px;border-radius:50%;background:currentColor}

.sg-chart{width:100%;overflow:hidden}
.sg-chart-svg{width:100%;height:200px;display:block;overflow:hidden}
.sg-grid{stroke:var(--dsw-alias-border-l1);stroke-width:1;vector-effect:non-scaling-stroke}
.sg-area-down{fill:var(--dsw-alias-brand-primary);opacity:.14}
.sg-area-up{fill:var(--dsw-alias-state-success-primary);opacity:.12}
.sg-line{fill:none;stroke-width:2;vector-effect:non-scaling-stroke;stroke-linejoin:round;stroke-linecap:round}
.sg-line-down{stroke:var(--dsw-alias-brand-primary)}
.sg-line-up{stroke:var(--dsw-alias-state-success-primary)}
/* FIX 1: a handful of evenly-spaced ticks, clipped to the container. No more
   one-span-per-sample pile-up; odd ticks hide on narrow screens. */
.sg-xaxis{display:flex;justify-content:space-between;gap:6px;margin-top:8px;font-size:11px;color:var(--dsw-alias-label-secondary);overflow:hidden;width:100%}
.sg-xaxis .sg-tick{white-space:nowrap;flex:none}
.sg-chart-foot{display:flex;justify-content:space-between;gap:12px;margin-top:10px;font-size:11px;color:var(--dsw-alias-label-secondary)}
.sg-empty{height:200px;display:flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-secondary);font-size:13px;text-align:center;padding:0 12px}

.sg-dev-list{display:flex;flex-direction:column;gap:4px}
.sg-dev{display:flex;align-items:center;gap:10px;width:100%;text-align:left;padding:9px 10px;border-radius:10px;border:1px solid transparent;background:transparent;color:inherit;cursor:pointer;transition:background .15s,border-color .15s}
.sg-dev:hover{background:var(--dsw-alias-bg-layer-2)}
.sg-dev.is-sel{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l1)}
.sg-dev-dot{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-state-success-primary);flex:none}
.sg-dev-ico{color:var(--dsw-alias-label-secondary);flex:none}
.sg-dev-main{display:flex;flex-direction:column;min-width:0;flex:1}
.sg-dev-name{font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sg-dev-sub{font-size:11px;color:var(--dsw-alias-label-secondary)}
.sg-dev-bar{width:54px;height:5px;border-radius:4px;background:var(--dsw-alias-bg-layer-2);overflow:hidden;flex:none}
.sg-dev-bar-fill{display:block;height:100%;border-radius:4px;background:var(--dsw-alias-brand-primary)}
.sg-dev-foot{margin-top:12px;padding-top:11px;border-top:1px solid var(--dsw-alias-border-l1);display:flex;justify-content:space-between;gap:10px;font-size:12px}
.sg-dev-foot b{font-weight:650}

.sg-kv{display:flex;flex-direction:column;gap:2px}
.sg-kv-row{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 0;border-bottom:1px solid var(--dsw-alias-border-l1);font-size:13px}
.sg-kv-row:last-child{border-bottom:0}
.sg-kv-key{display:flex;align-items:center;gap:9px;color:var(--dsw-alias-label-secondary)}
.sg-kv-key .sg-ic{color:var(--dsw-alias-state-idle-primary)}
.sg-kv-val{font-weight:550;text-align:right;word-break:break-all}

.sg-node{margin-bottom:13px}
.sg-node:last-child{margin-bottom:0}
.sg-node-top{display:flex;justify-content:space-between;gap:8px;margin-bottom:6px;font-size:12px}
.sg-node-name{font-weight:600}
.sg-node-ms{color:var(--dsw-alias-label-secondary)}
.sg-track{height:6px;border-radius:4px;background:var(--dsw-alias-bg-layer-2);overflow:hidden}
.sg-track-fill{display:block;height:100%;border-radius:4px;background:currentColor}

/* FIX 2: clean, single-line, de-duplicated event rows. No fragmented
   two-line wraps, no per-row connector line; full text on hover via title. */
.sg-timeline{display:flex;flex-direction:column}
.sg-event{display:flex;align-items:center;gap:10px;padding:10px 2px;font-size:12.5px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.sg-event:last-child{border-bottom:0}
.sg-event-dot{width:8px;height:8px;border-radius:50%;background:currentColor;flex:none}
.sg-event-txt{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--dsw-alias-label-primary)}
.sg-event-count{flex:none;font-size:11px;font-weight:700;padding:1px 7px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary)}
.sg-event-time{flex:none;color:var(--dsw-alias-label-secondary);font-size:11px}

.sg-note{display:flex;align-items:flex-start;gap:9px;padding:12px 14px;border-radius:11px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);font-size:12px;color:var(--dsw-alias-label-secondary);line-height:1.55}
.sg-note .sg-ic{color:var(--dsw-alias-state-idle-primary);margin-top:1px}
.sg-callout{display:flex;align-items:flex-start;gap:9px;padding:12px 14px;border-radius:11px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);font-size:12px;color:var(--dsw-alias-label-secondary);line-height:1.6}
.sg-callout .sg-ic{color:var(--dsw-alias-state-idle-primary);margin-top:1px;flex:none}
.sg-notice{margin-bottom:14px;padding:10px 13px;border-radius:10px;font-size:12px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-primary)}
.sg-stack>.sg-notice{margin-bottom:0}

/* Shared controls */
.sg-btn{display:inline-flex;align-items:center;gap:7px;padding:8px 14px;border-radius:9px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:13px;font-weight:600;cursor:pointer;white-space:nowrap}
.sg-btn:hover{border-color:var(--dsw-alias-brand-primary)}
.sg-btn.primary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base)}
.sg-btn.danger{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.sg-btn.sm{padding:5px 10px;font-size:12px}
.sg-btn:disabled{opacity:.5;cursor:not-allowed}
.sg-input,.sg-select{width:100%;padding:8px 10px;border-radius:9px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:13px;outline:none}
.sg-input:focus,.sg-select:focus{border-color:var(--dsw-alias-brand-primary)}
.sg-select-sm{width:auto;min-width:112px}
.sg-field{display:flex;flex-direction:column;gap:5px;min-width:0}
.sg-field label{font-size:12px;color:var(--dsw-alias-label-secondary);font-weight:600}
.sg-form-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
.sg-form-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:14px}
.sg-seg{display:inline-flex;gap:3px;padding:3px;border-radius:10px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);flex-wrap:wrap}
.sg-seg button{padding:6px 14px;border-radius:7px;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font-size:13px;font-weight:600;cursor:pointer}
.sg-seg button.is-active{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}
.sg-switch{width:38px;height:22px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);position:relative;cursor:pointer;flex:none;padding:0}
.sg-switch.is-on{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}
.sg-switch i{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-bg-layer-1);transition:left .15s}
.sg-switch.is-on i{left:18px}
.sg-set-row{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:12px 0;border-bottom:1px solid var(--dsw-alias-border-l1);flex-wrap:wrap}
.sg-set-row:last-child{border-bottom:0}
.sg-set-label{font-size:13px;font-weight:600}
.sg-set-desc{font-size:11.5px;color:var(--dsw-alias-label-secondary);margin-top:2px;font-weight:400;max-width:460px}
.sg-section{font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--dsw-alias-label-secondary);margin:0 0 6px}
.sg-stack{display:flex;flex-direction:column;gap:18px}

/* Devices */
.sg-strip{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:12px}
.sg-strip-item{padding:14px 16px}
.sg-strip-label{font-size:11px;color:var(--dsw-alias-label-secondary)}
.sg-strip-value{font-size:21px;font-weight:650;margin-top:5px;white-space:nowrap}
.sg-conn-list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
.sg-conn-top{display:flex;align-items:center;gap:9px}
.sg-conn-name{font-size:14px;font-weight:650;flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sg-badge-sm{display:inline-flex;align-items:center;gap:5px;flex:none;padding:3px 9px;border-radius:999px;font-size:11px;font-weight:650;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary)}
.sg-badge-sm.is-active{color:var(--dsw-alias-state-success-primary)}
.sg-badge-sm.is-online{color:var(--dsw-alias-state-success-primary)}
.sg-badge-sm.is-offline{color:var(--dsw-alias-state-error-primary)}
.sg-badge-sm.is-warn{color:var(--dsw-alias-state-warn-primary)}
.sg-conn-meta{display:flex;flex-wrap:wrap;gap:6px 18px;margin-top:12px;font-size:12px}
.sg-conn-meta-item{display:flex;align-items:center;gap:6px;color:var(--dsw-alias-label-secondary)}
.sg-conn-meta-item b{color:var(--dsw-alias-label-primary);font-weight:600}
.sg-conn-actions{display:flex;gap:6px;flex-wrap:wrap;margin-top:14px}
.sg-diag-tbl{width:100%;border-collapse:collapse;font-size:12px}
.sg-diag-tbl th{text-align:left;font-weight:600;color:var(--dsw-alias-label-secondary);padding:7px 8px;border-bottom:1px solid var(--dsw-alias-border-l1);white-space:nowrap}
.sg-diag-tbl td{padding:7px 8px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.sg-diag-tbl tr:last-child td{border-bottom:0}
.sg-pill-ok{color:var(--dsw-alias-state-success-primary);font-weight:650}
.sg-pill-fail{color:var(--dsw-alias-state-error-primary);font-weight:650}

@media(max-width:1120px){.sg-metrics{grid-template-columns:repeat(3,minmax(0,1fr))}.sg-main-grid{grid-template-columns:1fr}.sg-bottom-grid{grid-template-columns:1fr}.sg-strip{grid-template-columns:repeat(3,minmax(0,1fr))}}
@media(max-width:720px){.sg-root{padding:20px 16px 32px}.sg-metrics{grid-template-columns:repeat(2,minmax(0,1fr))}.sg-title{font-size:20px}.sg-xaxis .sg-tick.sg-tick-odd{display:none}.sg-conn-list{grid-template-columns:1fr}.sg-strip{grid-template-columns:repeat(2,minmax(0,1fr))}.sg-form-grid{grid-template-columns:1fr}}
@media(prefers-reduced-motion:reduce){.sg-root *{animation:none!important;transition:none!important}}
`;

    return {
      inject: ['slots', 'locale'],
      apply: function (ctx) {
        const t = ctx.locale.bind(NS);

        ctx.effect(function () { return ctx.locale.register(NS, dicts); }, 'surge-panel: dictionaries');

        ctx.effect(function () {
          if (typeof document === 'undefined') return undefined;
          const style = document.createElement('style');
          style.setAttribute('data-dsh-surge-panel', '');
          style.textContent = CSS;
          document.head.appendChild(style);
          return function () { try { if (style.parentNode) style.parentNode.removeChild(style); } catch (e) { /* noop */ } };
        }, 'surge-panel: stylesheet');

        /* Live polling. The interval follows the Settings preference and is
         * rebuilt whenever it changes (including pause/resume). ctx.effect owns
         * the whole lifecycle so the timer is always cleared on unload. */
        ctx.effect(function () {
          return function () { store.cancel(); };
        }, 'surge-panel: cancel requests on unload');

        /* ---- render helpers (capture t / ctx via closure) ---- */
        function I(name, size, cls, key) {
          return h('svg', {
            key: key, className: 'sg-ic' + (cls ? ' ' + cls : ''),
            width: size || 18, height: size || 18, viewBox: '0 0 24 24',
            fill: 'none', stroke: 'currentColor', strokeWidth: 1.8,
            strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true
          }, h('path', { d: PATHS[name] || PATHS.activity }));
        }
        function Sparkline(arr, tone) {
          const W = 100, H = 28;
          const MAX = Math.max.apply(null, arr) * 1.12 || 1;
          const X = function (i) { return (i / (arr.length - 1)) * W; };
          const Y = function (v) { return H - 2 - (v / MAX) * (H - 6); };
          const d = arr.map(function (v, i) { return (i ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(v).toFixed(1); }).join(' ');
          return h('svg', { viewBox: '0 0 100 28', preserveAspectRatio: 'none', className: 'sg-spark ' + tone, 'aria-hidden': true },
            h('path', { d: d + ' L 100 28 L 0 28 Z', className: 'sg-spark-area' }),
            h('path', { d: d, className: 'sg-spark-line' }));
        }
        function AreaChart(chart, showDown, showUp) {
          const W = 760, H = 220, TOP = 14, BOT = 10;
          const n = chart.down.length;
          const MAX = Math.max(1, chart.max || 1) * 1.15;
          const X = function (i) { return n < 2 ? W / 2 : (i / (n - 1)) * W; };
          const Y = function (v) { return H - BOT - (Math.max(0, Math.min(MAX, v)) / MAX) * (H - TOP - BOT); };
          const line = function (arr) {
            return arr.map(function (v, i) { return (i ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(v).toFixed(1); }).join(' ');
          };
          const area = function (arr) { return line(arr) + ' L ' + W + ' ' + (H - BOT) + ' L 0 ' + (H - BOT) + ' Z'; };
          const grids = [0, 0.25, 0.5, 0.75, 1].map(function (f, i) {
            const y = H - BOT - f * (H - TOP - BOT);
            return h('line', { key: 'g' + i, x1: 0, y1: y, x2: W, y2: y, className: 'sg-grid' });
          });
          const half = function (v) { return v >= 1e6 ? (v / 1e6).toFixed(1) + ' MB/s' : v >= 1e3 ? (v / 1e3).toFixed(0) + ' KB/s' : Math.round(v) + ' B/s'; };
          return h('div', { className: 'sg-chart' },
            h('svg', { viewBox: '0 0 ' + W + ' ' + H, preserveAspectRatio: 'none', className: 'sg-chart-svg', 'aria-hidden': true },
              grids,
              showDown ? h('path', { key: 'ad', d: area(chart.down), className: 'sg-area-down' }) : null,
              showUp ? h('path', { key: 'au', d: area(chart.up), className: 'sg-area-up' }) : null,
              showDown ? h('path', { key: 'ld', d: line(chart.down), className: 'sg-line sg-line-down' }) : null,
              showUp ? h('path', { key: 'lu', d: line(chart.up), className: 'sg-line sg-line-up' }) : null),
            h('div', { className: 'sg-xaxis' }, tickLabels(chart.labels, 6).map(function (tk, i) {
              return h('span', { key: i, className: 'sg-mono sg-tick' + (tk.odd ? ' sg-tick-odd' : '') }, tk.label);
            })),
            h('div', { className: 'sg-chart-foot' },
              h('span', { className: 'sg-sub' }, t('chart.sampled')),
              h('span', { className: 'sg-mono sg-sub' }, t('chart.peak') + ' ' + half(chart.max || 0))));
        }
        function MetricCard(o) {
          return h('div', { className: 'sg-card sg-metric' },
            h('div', { className: 'sg-metric-head' },
              h('span', { className: 'sg-ico-tile ' + o.tone }, I(o.icon, 15)),
              h('span', { className: 'sg-metric-label' }, t(o.label))),
            h('div', { className: 'sg-metric-row' },
              h('div', null,
                h('span', { className: 'sg-num sg-metric-num' }, o.value),
                o.unit ? h('span', { className: 'sg-unit' }, o.unit) : null),
              o.sub ? h('span', { className: 'sg-sub' }, o.sub) : null),
            o.spark && o.spark.length > 1 ? Sparkline(o.spark, o.tone) : h('div', { className: 'sg-spark-ph' }));
        }
        function Legend(items) {
          return h('div', { className: 'sg-legend' }, items.map(function (it) {
            return h('button', {
              key: it.key, type: 'button',
              className: 'sg-legend-btn ' + it.tone + (it.on ? '' : ' is-off'),
              onClick: it.toggle, 'aria-pressed': it.on ? 'true' : 'false'
            }, h('span', { className: 'sg-legend-dot' }), t(it.label));
          }));
        }
        function kv(icon, label, value, mono) {
          return h('div', { className: 'sg-kv-row' },
            h('span', { className: 'sg-kv-key' }, I(icon, 14), t(label)),
            h('span', { className: 'sg-kv-val' + (mono ? ' sg-mono' : '') }, value));
        }
        function Stat(label, value, sub) {
          return h('div', { className: 'sg-card sg-strip-item' },
            h('div', { className: 'sg-strip-label' }, label),
            h('div', { className: 'sg-strip-value sg-num' }, value),
            sub ? h('div', { className: 'sg-sub' }, sub) : null);
        }
        function Btn(o) {
          return h('button', {
            type: 'button',
            className: 'sg-btn' + (o.primary ? ' primary' : '') + (o.danger ? ' danger' : '') + (o.sm ? ' sm' : ''),
            disabled: !!o.disabled, onClick: o.onClick, title: o.title || undefined
          }, o.icon ? I(o.icon, 14) : null, o.label);
        }
        function Seg(value, opts, onChange) {
          return h('div', { className: 'sg-seg' }, opts.map(function (o) {
            return h('button', { key: o.v, type: 'button', className: value === o.v ? 'is-active' : '', onClick: function () { onChange(o.v); } }, t(o.l));
          }));
        }
        function Switch(on, onChange) {
          return h('button', {
            type: 'button', role: 'switch', 'aria-checked': on ? 'true' : 'false',
            className: 'sg-switch' + (on ? ' is-on' : ''), onClick: function () { onChange(!on); }
          }, h('i', null));
        }
        function Select(value, opts, onChange) {
          return h('select', {
            className: 'sg-select sg-select-sm', value: String(value),
            onChange: function (e) { onChange(e.target.value); }
          }, opts.map(function (o) { return h('option', { key: String(o.v), value: String(o.v) }, o.l); }));
        }
        function SetRow(labelKey, descKey, control) {
          return h('div', { className: 'sg-set-row' },
            h('div', null,
              h('div', { className: 'sg-set-label' }, t(labelKey)),
              descKey ? h('div', { className: 'sg-set-desc' }, t(descKey)) : null),
            control);
        }
        function SectionCard(title, right, children) {
          return h('div', { className: 'sg-card' },
            h('div', { className: 'sg-card-h' }, h('h2', { className: 'sg-card-t' }, title), right || null),
            children);
        }

        /* ---- Sidebar icon: owner props are { size, active } ---- */
        function PanelIcon(props) {
          const size = (props && props.size) || 20;
          const active = !!(props && props.active);
          return h('svg', {
            width: size, height: size, viewBox: '0 0 24 24',
            fill: 'none', stroke: 'currentColor', strokeWidth: 1.9,
            strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
            style: { display: 'block', color: active ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-label-secondary)' }
          },
            h('rect', { x: 3, y: 4, width: 18, height: 13, rx: 2 }),
            h('path', { d: 'M8 21h8M12 17v4' }),
            h('path', { d: 'M6 11h2.2l1.5-3.2 2.1 6 1.5-2.8H18' }));
        }

        /* ================================================================ *
         * OVERVIEW — the original dashboard, with both display fixes.
         * ================================================================ */
        function Overview(props) {
          const ui = props.ui;
          const state = store.get();
          const p = prefs.get();
          const s = state.snap;
          const available = function (name) {
            const endpoint = s && s.endpoints && s.endpoints[name];
            return !!endpoint && (endpoint.ok || endpoint.stale);
          };
          const count = function (name, value) { return available(name) ? String(value) : '—'; };
          const endpointHint = function (names) {
            const failed = names.filter(function (name) { return s && s.endpoints && s.endpoints[name] && !s.endpoints[name].ok; });
            if (!failed.length) return null;
            return h('div', { className: 'sg-sub', role: 'status', style: { padding: '8px 14px' } }, failed.map(function (name) {
              const endpoint = s.endpoints[name];
              return name + ' · ' + (endpoint.stale ? t('status.stale') + ' ' + fmtTime(new Date(endpoint.updatedAt)) : t('status.unavailable'));
            }).join('；'));
          };
          const buf = store.buffers();
          const N = p.samplePoints;
          const downArr = buf.down.slice(-N);
          const upArr = buf.up.slice(-N);
          const labArr = buf.labels.slice(-N);
          const maxV = Math.max.apply(null, [1].concat(downArr, upArr));

          const d = s ? fmtBytes(s.down, true) : { value: '—', unit: '' };
          const u = s ? fmtBytes(s.up, true) : { value: '—', unit: '' };
          const sess = s ? fmtBytes(s.session, false) : { value: '—', unit: '' };
          const metrics = [
            { label: 'metrics.download', value: d.value, unit: d.unit, icon: 'download', tone: 'sg-tone-brand', spark: downArr },
            { label: 'metrics.upload', value: u.value, unit: u.unit, icon: 'upload', tone: 'sg-tone-success', spark: upArr },
            { label: 'metrics.session', value: sess.value, unit: sess.unit, icon: 'activity', tone: 'sg-tone-idle', spark: [] },
            { label: 'metrics.uptime', value: s && s.uptime != null ? fmtUptime(s.uptime, t) : '—', unit: '', icon: 'clock', tone: 'sg-tone-warn', spark: [] },
            { label: 'metrics.conns', value: count('requests', s && s.conns), unit: '', icon: 'link', tone: 'sg-tone-brand', sub: available('requests') ? (s.connsFailed + ' ' + t('metrics.failed')) : '', spark: [] }
          ];

          const devices = ((s && s.devices) || []).slice(0, p.maxDevices);
          const nodes = (s && s.nodes) || [];
          const merged = mergeEvents((s && s.events) || []).slice(0, p.maxEvents);
          const sel = devices.length ? Math.min(ui.selected, devices.length - 1) : -1;
          const counts = (s && s.counts) || {};
          const onRefresh = function () { store.fetch(); };
          const active = s && s.activeConnection;

          return h('div', { className: 'sg-stack' },
            state.status === 'error'
              ? h('div', { className: 'sg-error' },
                  I('info', 16),
                  h('span', { className: 'sg-error-txt' }, t('status.error') + ' · ' + state.error + (state.updated ? ' · ' + t('status.stale') + ' ' + fmtTime(state.updated) : '')),
                  h('button', { type: 'button', className: 'sg-retry', onClick: onRefresh }, t('action.retry')))
              : h('div', { className: 'sg-livebar' },
                  h('span', { className: 'sg-dot-live' + (state.status === 'ok' && !p.paused ? ' is-live' : '') }),
                  h('span', { className: 'sg-live-txt' }, p.paused ? t('status.paused') : state.status === 'loading' ? t('status.loading') : t('status.online')),
                  active ? h('span', { className: 'sg-sub' }, t('status.via') + ' · ' + active.name) : null,
                  h('span', { className: 'sg-live-sp' }),
                  state.updated ? h('span', { className: 'sg-sub sg-mono' }, t('status.updated') + ' ' + fmtTime(state.updated)) : null),

            h('div', { className: 'sg-metrics' }, metrics.map(function (m, i) {
              return h(MetricCard, Object.assign({ key: i }, m));
            })),

            endpointHint(['requests']),

            h('div', { className: 'sg-main-grid' },
              h('div', { className: 'sg-card' },
                h('div', { className: 'sg-card-h' },
                  h('h2', { className: 'sg-card-t' }, I('activity', 16), t('chart.title')),
                  Legend([
                    { key: 'd', label: 'chart.down', tone: 'sg-tone-brand', on: ui.showDown, toggle: function () { ui.setShowDown(function (v) { return !v; }); } },
                    { key: 'u', label: 'chart.up', tone: 'sg-tone-success', on: ui.showUp, toggle: function () { ui.setShowUp(function (v) { return !v; }); } }
                  ])),
                downArr.length < 2
                  ? h('div', { className: 'sg-empty' }, t('chart.sampling'))
                  : (ui.showDown || ui.showUp)
                    ? AreaChart({ down: downArr, up: upArr, labels: labArr, max: maxV }, ui.showDown, ui.showUp)
                    : h('div', { className: 'sg-empty' }, t('chart.empty'))),

              h('div', { className: 'sg-card' },
                h('div', { className: 'sg-card-h' },
                  h('h2', { className: 'sg-card-t' }, I('wifi', 16), t('devices.title')),
                  h('span', { className: 'sg-sub' }, count('devices', s && s.devicesCount) + ' ' + t('devices.online'))),
                devices.length
                  ? h('div', { className: 'sg-dev-list' }, devices.map(function (dv, i) {
                      return h('button', {
                        key: i, type: 'button',
                        className: 'sg-dev' + (i === sel ? ' is-sel' : ''),
                        'aria-pressed': i === sel ? 'true' : 'false',
                        onClick: function () { ui.setSelected(i); }
                      },
                        h('span', { className: 'sg-dev-dot' }),
                        h('span', { className: 'sg-dev-ico' }, I(dv.icon, 16)),
                        h('span', { className: 'sg-dev-main' },
                          h('span', { className: 'sg-dev-name' }, dv.name),
                          h('span', { className: 'sg-dev-sub sg-mono' }, dv.ip)),
                        h('span', { className: 'sg-dev-bar' },
                          h('span', { className: 'sg-dev-bar-fill', style: { width: Math.max(4, dv.load * 100) + '%' } })));
                    }))
                  : h('div', { className: 'sg-empty' }, available('devices') ? t('devices.empty') : t('status.unavailable')),
                endpointHint(['devices']),
                sel >= 0
                  ? h('div', { className: 'sg-dev-foot' },
                      h('span', { className: 'sg-sub' }, t('devices.throughput') + ' · ' + devices[sel].name),
                      h('b', { className: 'sg-mono' }, fmtBytes(devices[sel].speed, true).value + ' ' + fmtBytes(devices[sel].speed, true).unit))
                  : null)),

            h('div', { className: 'sg-bottom-grid' },
              h('div', { className: 'sg-card' },
                h('div', { className: 'sg-card-h' }, h('h2', { className: 'sg-card-t' }, I('globe', 16), t('network.title'))),
                h('div', { className: 'sg-kv' },
                  kv('server', 'network.mode', available('outbound') ? (s.mode || '—') : '—', false),
                  kv('shield', 'network.profile', available('profile') ? s.profile : '—', false),
                  kv('globe', 'network.port', s ? String(s.apiPort) : '—', true),
                  kv('link', 'network.rules', count('rules', counts.rules) + ' / ' + count('policies', counts.groups), true),
                  kv('server', 'network.res', count('modules', counts.modules) + ' / ' + count('dns', counts.dns), true)),
                endpointHint(['outbound', 'profile', 'rules', 'policies', 'modules', 'dns'])),

              h('div', { className: 'sg-card' },
                h('div', { className: 'sg-card-h' },
                  h('h2', { className: 'sg-card-t' }, I('radio', 16), t('quality.title')),
                  h('span', { className: 'sg-sub' }, t('quality.latency'))),
                nodes.length
                  ? nodes.map(function (node, i) {
                      const bf = fmtBytes(node.bytes, false);
                      return h('div', { key: i, className: 'sg-node' },
                        h('div', { className: 'sg-node-top' },
                          h('span', { className: 'sg-node-name' }, node.name),
                          h('span', { className: 'sg-node-ms sg-mono' }, bf.value + ' ' + bf.unit)),
                        h('div', { className: 'sg-track' },
                          h('span', { className: 'sg-track-fill sg-tone-brand', style: { width: Math.max(3, node.share) + '%' } })));
                    })
                  : h('div', { className: 'sg-empty' }, s ? t('quality.empty') : t('status.unavailable'))),

              h('div', { className: 'sg-card' },
                h('div', { className: 'sg-card-h' }, h('h2', { className: 'sg-card-t' }, I('clock', 16), t('events.title'))),
                merged.length
                  ? h('div', { className: 'sg-timeline' }, merged.map(function (ev) {
                      return h('div', { key: ev.key, className: 'sg-event', title: ev.text },
                        h('span', { className: 'sg-event-dot ' + toneOf(ev.tone) }),
                        h('span', { className: 'sg-event-txt' }, ev.text),
                        ev.count > 1 ? h('span', { className: 'sg-event-count sg-mono' }, '×' + ev.count) : null,
                        h('span', { className: 'sg-event-time sg-mono' }, ev.time));
                    }))
                  : h('div', { className: 'sg-empty' }, available('events') ? t('events.empty') : t('status.unavailable')),
                endpointHint(['events']))),

            h('div', { className: 'sg-note' }, I('info', 16), h('span', null, t('note')))
          );
        }

        /* ================================================================ *
         * DEVICES — restored multi-instance management + Fleet summary.
         * ================================================================ */
        function DevicesPanel() {
          const [data, setData] = useState({ connections: [], activeId: 'local', loading: true, error: '' });
          const [fleet, setFleet] = useState({ fleet: [], totals: { online: 0, total: 0, down: 0, up: 0, conns: 0 }, loading: true, error: '', updated: null });
          const [form, setForm] = useState(null);
          const [busy, setBusy] = useState('');
          const [notice, setNotice] = useState('');
          const [confirmId, setConfirmId] = useState('');
          const [testResult, setTestResult] = useState(null);

          const requests = useRef({ controller: new AbortController(), connSeq: 0, fleetSeq: 0, busy: false });
          const loadConns = function () {
            const signal = requests.current.controller.signal;
            const seq = ++requests.current.connSeq;
            return api('/surge-api/connections', { signal }).then(function (result) {
              if (signal.aborted || seq !== requests.current.connSeq) return;
              if (!result.ok) throw new Error(result.message || 'error');
              setData({ connections: result.connections || [], activeId: result.activeId || 'local', loading: false, error: '' });
            }).catch(function (error) {
              if (!signal.aborted && seq === requests.current.connSeq) setData(function (prev) { return { ...prev, loading: false, error: String(error.message || error) }; });
            });
          };
          const loadFleet = function () {
            const signal = requests.current.controller.signal;
            const seq = ++requests.current.fleetSeq;
            setFleet(function (prev) { return { ...prev, loading: true }; });
            return api('/surge-api/fleet', { signal, timeoutMs: 90000 }).then(function (result) {
              if (signal.aborted || seq !== requests.current.fleetSeq) return;
              if (!result.ok) throw new Error(result.message || 'error');
              setFleet({ fleet: result.fleet || [], totals: result.totals, loading: false, error: '', updated: new Date() });
            }).catch(function (error) {
              if (!signal.aborted && seq === requests.current.fleetSeq) setFleet(function (prev) { return { ...prev, loading: false, error: String(error.message || error) }; });
            });
          };
          useEffect(function () {
            requests.current.controller = new AbortController();
            loadConns(); loadFleet();
            return function () { requests.current.controller.abort(); };
          }, []);

          const call = function (path, body) {
            if (requests.current.busy) return Promise.resolve({ ok: false, cancelled: true });
            requests.current.busy = true;
            const signal = requests.current.controller.signal;
            setBusy(path); setNotice('');
            return post(path, body, { signal }).then(function (result) {
              if (signal.aborted) return { ok: false, cancelled: true };
              if (!result.ok) setNotice(t('dm.error') + (result.message ? ' · ' + result.message : ''));
              else if (path !== '/surge-api/connection/test') {
                requests.current.connSeq++; requests.current.fleetSeq++;
                setData({ connections: result.connections || [], activeId: result.activeId || 'local', loading: false, error: '' });
                store.invalidate();
              }
              return result;
            }).catch(function (error) {
              if (signal.aborted) return { ok: false, cancelled: true };
              setNotice(t('dm.error') + ' · ' + String(error.message || error));
              return { ok: false };
            }).finally(function () {
              requests.current.busy = false;
              if (!signal.aborted) setBusy('');
            });
          };
          const reloadAll = function () { loadConns(); loadFleet(); void store.fetch(); };

          const onActivate = function (id) {
            call('/surge-api/connection/activate', { id: id }).then(function (r) {
              if (r.ok) { setNotice(t('dm.activated')); reloadAll(); }
            });
          };
          const onDelete = function (id) {
            setConfirmId('');
            call('/surge-api/connection/delete', { id: id }).then(function (r) {
              if (r.ok) { setNotice(t('dm.deleted')); reloadAll(); }
            });
          };
          const onTest = function (c) {
            setTestResult(null);
            call('/surge-api/connection/test', { id: c.id }).then(function (r) {
              if (r.cancelled) return;
              setTestResult({ id: c.id, ok: !!r.ok, message: r.message || (r.ok ? t('dm.test.ok') : t('dm.test.fail')), rtt: r.rtt, mode: r.mode });
            });
          };
          const onTestForm = function (f) {
            setTestResult(null);
            call('/surge-api/connection/test', { connection: f }).then(function (r) {
              if (r.cancelled) return;
              setTestResult({ id: 'form', ok: !!r.ok, message: r.message || (r.ok ? t('dm.test.ok') : t('dm.test.fail')), rtt: r.rtt, mode: r.mode });
            });
          };
          const onSave = function (f) {
            if (!f.name || !f.host || !f.port) { setNotice(t('dm.saveErr')); return; }
            const body = {
              id: f.id || '', name: f.name, protocol: f.protocol, host: f.host,
              port: Number(f.port), platform: f.platform, apiKey: f.apiKey || '', caCert: f.caCert || ''
            };
            call('/surge-api/connection/save', { connection: body }).then(function (r) {
              if (r.ok) { setForm(null); setNotice(t('dm.savedOk')); reloadAll(); }
            });
          };
          const openAdd = function () {
            setForm({ id: '', name: '', protocol: 'http', host: '', port: '6171', platform: 'auto', apiKey: '', caCert: '' });
            setTestResult(null); setNotice('');
          };
          const openEdit = function (c) {
            setForm({ id: c.id, name: c.name, protocol: c.protocol, host: c.host, port: String(c.port), platform: c.platform || 'auto', apiKey: '', caCert: c.caCert || '' });
            setTestResult(null); setNotice('');
          };

          function fld(labelKey, name, f, setF, type, ph, choices) {
            const onChange = function (e) { const next = Object.assign({}, f); next[name] = e.target.value; setF(next); };
            const control = choices
              ? h('select', { className: 'sg-select', id: 'sg-field-' + name, value: f[name], onChange: onChange, disabled: !!busy }, choices.map(function (c) { return h('option', { key: c.v, value: c.v }, c.l); }))
              : h('input', { className: 'sg-input', id: 'sg-field-' + name, disabled: !!busy, type: type || 'text', value: f[name], placeholder: ph || '', onChange: onChange });
            return h('div', { className: 'sg-field', key: name }, h('label', { htmlFor: 'sg-field-' + name }, t(labelKey)), control);
          }

          const platformOpts = [
            { v: 'auto', l: t('dm.platform.auto') }, { v: 'ios', l: t('dm.platform.ios') },
            { v: 'tvos', l: t('dm.platform.tvos') }, { v: 'macos', l: t('dm.platform.macos') }
          ];
          const protocolOpts = [{ v: 'http', l: 'HTTP' }, { v: 'https', l: 'HTTPS' }];
          const fleetById = {};
          for (const f of fleet.fleet) fleetById[f.id] = f;
          const totals = fleet.totals;
          /* Host returns the built-in local connection as the first element
           * (isLocal:true); it is rendered as a dedicated card below, so keep
           * only the user-saved ones here to avoid a duplicate + miscount. */
          const saved = data.connections.filter(function (c) { return !c.isLocal; });
          const extra = saved.length;

          return h('div', { className: 'sg-stack' },
            h('div', { className: 'sg-card' },
              h('div', { className: 'sg-card-h is-tall' },
                h('div', null,
                  h('h2', { className: 'sg-card-t' }, I('server', 16), t('dm.title')),
                  h('p', { className: 'sg-subtitle' }, t('dm.subtitle'))),
                h('div', { className: 'sg-h-actions' },
                  Btn({ label: t('dm.refresh'), icon: 'refresh', sm: true, onClick: reloadAll, disabled: !!busy }),
                  Btn({ label: t('dm.add'), icon: 'plus', primary: true, sm: true, onClick: openAdd, disabled: !!busy })))),

            h('div', { className: 'sg-strip' },
              Stat(t('dm.saved'), data.loading || data.error ? '—' : String(extra + 1), t('dm.local')),
              Stat(t('dm.online'), fleet.updated ? totals.online + ' / ' + totals.total : '—', t('dm.fleet.title')),
              Stat(t('dm.activeReqs'), fleet.updated && totals.connsComplete ? String(totals.conns) : '—', fleet.updated && !totals.connsComplete ? t('status.partial') : ''),
              Stat(t('dm.totalDown'), fleet.updated ? fmtBytes(totals.down, true).value : '—', fleet.updated ? fmtBytes(totals.down, true).unit + ' · ' + t('status.partial') : ''),
              Stat(t('dm.totalUp'), fleet.updated ? fmtBytes(totals.up, true).value : '—', fleet.updated ? fmtBytes(totals.up, true).unit + ' · ' + t('status.partial') : '')),

            data.error ? h('div', { className: 'sg-error', role: 'alert' }, data.error) : null,
            fleet.error ? h('div', { className: 'sg-error', role: 'alert' }, fleet.error + (fleet.updated ? ' · ' + t('status.stale') + ' ' + fmtTime(fleet.updated) : '')) : null,
            notice ? h('div', { className: 'sg-notice', role: 'status' }, notice) : null,

            /* Add / edit form */
            form ? h('div', { className: 'sg-card' },
              h('div', { className: 'sg-card-h' },
                h('h2', { className: 'sg-card-t' }, I(form.id ? 'settings' : 'plus', 16), t(form.id ? 'dm.form.edit' : 'dm.form.add'))),
              h('div', { className: 'sg-form-grid' },
                fld('dm.field.name', 'name', form, setForm, 'text', 'Surge Mac mini'),
                fld('dm.field.protocol', 'protocol', form, setForm, null, null, protocolOpts),
                fld('dm.field.host', 'host', form, setForm, 'text', '192.168.5.10'),
                fld('dm.field.port', 'port', form, setForm, 'number', '6171'),
                fld('dm.field.platform', 'platform', form, setForm, null, null, platformOpts),
                fld('dm.field.key', 'apiKey', form, setForm, 'password', t('dm.field.keyHint'))),
              form.protocol === 'https' ? h('div', { className: 'sg-field', style: { margin: '0 14px 14px' } },
                h('label', { htmlFor: 'sg-field-ca' }, t('dm.field.ca')),
                h('textarea', { className: 'sg-input', id: 'sg-field-ca', disabled: !!busy, rows: 4, value: form.caCert, maxLength: 16384, onChange: function (event) { setForm({ ...form, caCert: event.target.value }); } }),
                h('div', { className: 'sg-sub' }, t('dm.field.caHint'))) : null,
              h('div', { className: 'sg-form-actions' },
                Btn({ label: t('dm.save'), icon: 'check', primary: true, onClick: function () { onSave(form); }, disabled: !!busy }),
                Btn({ label: t('dm.test'), icon: 'activity', onClick: function () { onTestForm(form); }, disabled: !!busy }),
                Btn({ label: t('dm.cancel'), disabled: !!busy, onClick: function () { setForm(null); setTestResult(null); } })))
              : null,

            testResult ? h('div', { className: 'sg-notice' },
              (testResult.ok ? t('dm.test.ok') : t('dm.test.fail')) + ' · ' + testResult.message +
              (typeof testResult.rtt === 'number' ? ' · ' + testResult.rtt + ' ' + t('dm.rttUnit') : '') +
              (testResult.mode ? ' · ' + testResult.mode : ''))
              : null,

            /* Connection cards */
            extra === 0 && !data.loading && !data.error
              ? h('div', { className: 'sg-callout' }, I('info', 16), h('span', null, t('dm.emptyHint')))
              : null,

            h('div', { className: 'sg-conn-list' },
              /* Local entry */
              h('div', { className: 'sg-card', key: 'local' },
                h('div', { className: 'sg-conn-top' },
                  h('span', { className: 'sg-ico-tile sg-tone-brand' }, I('laptop', 16)),
                  h('span', { className: 'sg-conn-name' }, t('dm.local')),
                  h('span', { className: 'sg-badge-sm' + (data.activeId === 'local' ? ' is-active' : '') }, data.activeId === 'local' ? t('dm.active') : t('dm.local'))),
                h('div', { className: 'sg-conn-meta' },
                  h('span', { className: 'sg-conn-meta-item' }, I('info', 13), h('span', null, t('dm.localHint')))),
                h('div', { className: 'sg-conn-actions' },
                  Btn({ label: t('dm.activate'), icon: 'check', sm: true, disabled: data.activeId === 'local' || !!busy, onClick: function () { onActivate('local'); } }),
                  Btn({ label: t('dm.test'), icon: 'activity', sm: true, disabled: !!busy, onClick: function () { onTest({ id: 'local' }); } }))),

              saved.map(function (c) {
                const ff = fleetById[c.id] || {};
                const statusCls = ff.online ? ' is-online' : (c.hasKey ? ' is-offline' : ' is-warn');
                const statusLabel = fleet.loading ? t('st.loading') : fleet.error || !ff.id ? t('status.unavailable') : ff.online ? t('dm.status.online') : t('dm.status.offline');
                return h('div', { className: 'sg-card', key: c.id },
                  h('div', { className: 'sg-conn-top' },
                    h('span', { className: 'sg-ico-tile sg-tone-idle' }, I('server', 16)),
                    h('span', { className: 'sg-conn-name' }, c.name),
                    c.active ? h('span', { className: 'sg-badge-sm is-active' }, t('dm.active')) : null,
                    h('span', { className: 'sg-badge-sm' + statusCls }, statusLabel)),
                  h('div', { className: 'sg-conn-meta' },
                    h('span', { className: 'sg-conn-meta-item' }, I('globe', 13), t('dm.hostPort') + ' ', h('b', { className: 'sg-mono' }, c.protocol + '://' + (c.host.includes(':') ? '[' + c.host + ']' : c.host) + ':' + c.port)),
                    h('span', { className: 'sg-conn-meta-item' }, I('shield', 13), t('dm.keyBadge') + ' ', h('b', null, c.hasKey ? t('dm.field.keyStored') : t('dm.field.keyMissing'))),
                    h('span', { className: 'sg-conn-meta-item' }, I('server', 13), t('dm.field.platform') + ' ', h('b', null, t('dm.platform.' + (c.platform || 'auto')) || c.platform)),
                    ff.online ? h('span', { className: 'sg-conn-meta-item' }, I('activity', 13), t('dm.rtt') + ' ', h('b', { className: 'sg-mono' }, (ff.rtt || 0) + ' ' + t('dm.rttUnit'))) : null,
                    ff.online ? h('span', { className: 'sg-conn-meta-item' }, I('download', 13), t('dm.totalDown') + ' ', h('b', { className: 'sg-mono' }, fmtBytes(ff.down, true).value + ' ' + fmtBytes(ff.down, true).unit)) : null,
                    ff.online ? h('span', { className: 'sg-conn-meta-item' }, I('upload', 13), t('dm.totalUp') + ' ', h('b', { className: 'sg-mono' }, fmtBytes(ff.up, true).value + ' ' + fmtBytes(ff.up, true).unit)) : null),
                  ff.message ? h('div', { className: 'sg-notice' }, ff.message) : null,
                  confirmId === c.id
                    ? h('div', { className: 'sg-notice' }, t('dm.confirmDelete'))
                    : null,
                  h('div', { className: 'sg-conn-actions' },
                    Btn({ label: t('dm.activate'), icon: 'check', sm: true, disabled: c.active || !!busy, onClick: function () { onActivate(c.id); } }),
                    Btn({ label: t('dm.test'), icon: 'activity', sm: true, disabled: !!busy, onClick: function () { onTest(c); } }),
                    Btn({ label: t('dm.edit'), icon: 'settings', sm: true, disabled: !!busy, onClick: function () { openEdit(c); } }),
                    confirmId === c.id
                      ? Btn({ label: t('dm.save'), icon: 'check', danger: true, sm: true, disabled: !!busy, onClick: function () { onDelete(c.id); } })
                      : Btn({ label: t('dm.delete'), icon: 'trash', danger: true, sm: true, disabled: !!busy, onClick: function () { setConfirmId(c.id); } }),
                    confirmId === c.id ? Btn({ label: t('dm.cancel'), sm: true, onClick: function () { setConfirmId(''); } }) : null));
              })),

            fleet.loading ? h('div', { className: 'sg-sub' }, t('st.loading')) : null
          );
        }

        /* ================================================================ *
         * SETTINGS — restored appearance, refresh, display, diagnostics,
         * active-connection info and an honest About note.
         * ================================================================ */
        function SettingsPanel() {
          const [diag, setDiag] = useState({ running: false, data: null, error: '' });
          const diagRequest = useRef(new AbortController());
          const p = prefs.get();
          const set = function (patch) { prefs.set(patch); };
          const s = store.get().snap;
          const active = s && s.activeConnection;

          useEffect(function () {
            const controller = new AbortController();
            diagRequest.current = controller;
            setDiag({ running: false, data: null, error: '' });
            return function () { controller.abort(); };
          }, [s && s.connectionRevision, active && active.id]);

          const refreshOpts = [2000, 5000, 10000, 30000, 60000].map(function (v) {
            return { v: v, l: (v / 1000) + ' ' + t('st.seconds') };
          });
          const sampleOpts = [24, 48, 96, 144].map(function (v) { return { v: v, l: String(v) }; });
          const devOpts = [4, 6, 8, 12, 16].map(function (v) { return { v: v, l: String(v) }; });
          const evOpts = [4, 6, 8, 12].map(function (v) { return { v: v, l: String(v) }; });

          const runDiag = function () {
            setDiag({ running: true, data: null, error: '' });
            const signal = diagRequest.current.signal;
            api('/surge-api/diagnostics', { signal }).then(function (r) {
              if (signal.aborted) return;
              if (r.ok) setDiag({ running: false, data: r, error: '' });
              else setDiag({ running: false, data: null, error: r.message || r.code || t('st.diag.retry') });
            }).catch(function (e) {
              if (!signal.aborted) setDiag({ running: false, data: null, error: String((e && e.message) || e) });
            });
          };

          const diagBody = diag.data
            ? h('div', null,
                h('div', { className: 'sg-sub', style: { marginBottom: '10px' } }, t('st.diag.gateway') + ' · ' + (diag.data.endpoint ? diag.data.endpoint.base + ' (:' + diag.data.endpoint.port + ')' : '—')),
                h('table', { className: 'sg-diag-tbl' },
                  h('thead', null, h('tr', null,
                    h('th', null, t('st.diag.endpoint')), h('th', null, t('st.diag.status')),
                    h('th', null, t('st.diag.rtt')), h('th', null, t('st.diag.shape')))),
                  h('tbody', null, (diag.data.checks || []).map(function (c) {
                    return h('tr', { key: c.name },
                      h('td', { className: 'sg-mono' }, c.path),
                      h('td', null, h('span', { title: c.message || '', className: c.ok ? 'sg-pill-ok' : 'sg-pill-fail' }, c.ok ? t('st.diag.ok') : t('st.diag.fail') + ' (' + c.status + ')')),
                      h('td', { className: 'sg-mono' }, c.rtt + ' ' + t('dm.rttUnit')),
                      h('td', { className: 'sg-mono' }, c.shape));
                  }))))
            : diag.error
              ? h('div', { className: 'sg-notice' }, diag.error)
              : h('div', { className: 'sg-sub' }, t('st.diagnostics.desc'));

          return h('div', { className: 'sg-stack' },
            h('div', { className: 'sg-card' },
              h('div', { className: 'sg-card-h is-tall' },
                h('div', null,
                  h('h2', { className: 'sg-card-t' }, I('settings', 16), t('st.title')),
                  h('p', { className: 'sg-subtitle' }, t('st.subtitle'))),
                Btn({ label: t('st.reset'), icon: 'refresh', sm: true, onClick: function () { prefs.reset(); } }))),

            /* Appearance */
            h('div', { className: 'sg-card' },
              h('div', { className: 'sg-card-h is-tall' },
                h('div', null,
                  h('h2', { className: 'sg-card-t' }, I('laptop', 16), t('st.appearance')),
                  h('p', { className: 'sg-subtitle' }, t('st.appearance.desc'))),
                Seg(p.appearance, [
                  { v: 'system', l: 'st.appearance.system' },
                  { v: 'light', l: 'st.appearance.light' },
                  { v: 'dark', l: 'st.appearance.dark' }
                ], function (v) { set({ appearance: v }); }))),

            /* Data refresh */
            h('div', { className: 'sg-card' },
              h('div', { className: 'sg-card-h' },
                h('h2', { className: 'sg-card-t' }, I('refresh', 16), t('st.data'))),
              SetRow('st.refresh', 'st.refresh.desc',
                Select(p.refreshMs, refreshOpts, function (v) { set({ refreshMs: Number(v) }); })),
              SetRow('st.samples', 'st.samples.desc',
                Select(p.samplePoints, sampleOpts, function (v) { set({ samplePoints: Number(v) }); })),
              SetRow('st.pause', 'st.pause.desc',
                Switch(p.paused, function (v) { set({ paused: v }); }))),

            /* Display */
            h('div', { className: 'sg-card' },
              h('div', { className: 'sg-card-h' },
                h('h2', { className: 'sg-card-t' }, I('globe', 16), t('st.display'))),
              SetRow('st.maxDevices', 'st.maxDevices.desc',
                Select(p.maxDevices, devOpts, function (v) { set({ maxDevices: Number(v) }); })),
              SetRow('st.maxEvents', 'st.maxEvents.desc',
                Select(p.maxEvents, evOpts, function (v) { set({ maxEvents: Number(v) }); }))),

            /* Active connection */
            h('div', { className: 'sg-card' },
              h('div', { className: 'sg-card-h is-tall' },
                h('div', null,
                  h('h2', { className: 'sg-card-t' }, I('link', 16), t('st.connection')),
                  h('p', { className: 'sg-subtitle' }, t('st.connection.desc'))),
                h('span', { className: 'sg-kv-val sg-mono' }, active
                  ? active.name + ' · ' + active.host + ':' + active.port + (active.local ? ' (' + t('dm.local') + ')' : '')
                  : '—'))),

            /* API diagnostics */
            h('div', { className: 'sg-card' },
              h('div', { className: 'sg-card-h' },
                h('h2', { className: 'sg-card-t' }, I('activity', 16), t('st.diagnostics')),
                Btn({ label: diag.running ? t('st.diag.running') : t('st.diag.run'), icon: 'activity', sm: true, disabled: diag.running, onClick: runDiag })),
              diagBody),

            /* About */
            h('div', { className: 'sg-card' },
              h('div', { className: 'sg-card-h' },
                h('h2', { className: 'sg-card-t' }, I('info', 16), t('st.about'))),
              h('div', { className: 'sg-kv' },
                h('div', { className: 'sg-kv-row' }, h('span', { className: 'sg-kv-key' }, t('st.about.version')), h('span', { className: 'sg-kv-val sg-mono' }, VERSION)),
                h('div', { className: 'sg-kv-row' }, h('span', { className: 'sg-kv-key' }, t('st.about.type')), h('span', { className: 'sg-kv-val' }, t('st.typeValue'))),
                h('div', { className: 'sg-kv-row' }, h('span', { className: 'sg-kv-key' }, t('st.about.source')), h('span', { className: 'sg-kv-val' }, t('st.sourceValue'))))),

            h('div', { className: 'sg-callout' }, I('info', 16), h('span', null, t('st.note')))
          );
        }

        /* ================================================================ *
         * APP — tab shell. Preferences/appearance and polling are owned at
         * apply level so switching tabs never interrupts live sampling.
         * ================================================================ */
        function App() {
          const [, force] = useState(0);
          const [tab, setTab] = useState('overview');
          const [showDown, setShowDown] = useState(true);
          const [showUp, setShowUp] = useState(true);
          const [selected, setSelected] = useState(0);

          useEffect(function () {
            const bump = function () { force(function (v) { return v + 1; }); };
            const a = ctx.locale.subscribe(bump);
            const b = store.subscribe(bump);
            const c = prefs.subscribe(bump);
            return function () {
              if (typeof a === 'function') a();
              if (typeof b === 'function') b();
              if (typeof c === 'function') c();
            };
          }, []);

          const state = store.get();
          const p = prefs.get();
          useEffect(function () { return startPolling(store, p); }, [p.paused, p.refreshMs]);
          const rootCls = 'sg-root' + (p.appearance === 'light' ? ' sg-force-light' : p.appearance === 'dark' ? ' sg-force-dark' : '');
          const onRefresh = function () { store.fetch(); };
          const ui = {
            showDown: showDown, setShowDown: setShowDown,
            showUp: showUp, setShowUp: setShowUp,
            selected: selected, setSelected: setSelected
          };
          const active = state.snap && state.snap.activeConnection;

          const tabs = [
            { k: 'overview', l: 'tab.overview', i: 'activity' },
            { k: 'devices', l: 'tab.devices', i: 'server' },
            { k: 'settings', l: 'tab.settings', i: 'settings' }
          ];

          return h('div', { className: rootCls },
            h('div', { className: 'sg-header' },
              h('div', { className: 'sg-brand' }, I('activity', 22)),
              h('div', { className: 'sg-head-txt' },
                h('h1', { className: 'sg-title' }, t('panel.title')),
                h('p', { className: 'sg-subtitle' }, t('header.subtitle'))),
              h('div', { className: 'sg-head-right' },
                h('span', { className: 'sg-badge' + (state.status === 'ok' && !p.paused ? ' is-live' : '') },
                  h('span', { className: 'sg-badge-dot' }),
                  t(p.paused ? 'status.paused' : state.status === 'ok' ? 'badge.live' : state.status === 'loading' ? 'badge.connecting' : 'badge.offline')),
                h('button', {
                  type: 'button', className: 'sg-icon-btn', title: t('action.refresh'),
                  'aria-label': t('action.refresh'), onClick: onRefresh
                }, I('refresh', 16)))),

            h('div', { className: 'sg-tabbar' },
              h('div', { className: 'sg-tabs' }, tabs.map(function (tb) {
                return h('button', {
                  key: tb.k, type: 'button',
                  className: 'sg-tab' + (tab === tb.k ? ' is-active' : ''),
                  'aria-selected': tab === tb.k ? 'true' : 'false',
                  onClick: function () { setTab(tb.k); }
                }, I(tb.i, 15), t(tb.l));
              })),
              h('span', { className: 'sg-tabbar-sp' }),
              active ? h('span', { className: 'sg-active-chip' }, I('link', 13), active.name) : null),

            tab === 'overview'
              ? h(Overview, { ui: ui })
              : tab === 'devices'
                ? h(DevicesPanel, { key: 'devices' })
                : h(SettingsPanel, { key: 'settings' })
          );
        }

        /* ---- Register the panel and its sidebar icon together ---- */
        ctx.effect(function () {
          const offMain = ctx.slots.inject('main', function () {
            return ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS }, App);
          });
          const offSide = ctx.slots.inject('sidebar.panellist', function () {
            return ctx.slots.register({
              name: 'sidebar.panellist', id: PANEL_ID, order: 31,
              label: function () { return t('panel.title'); }, locale: NS
            }, PanelIcon);
          });
          return function () { offMain(); offSide(); };
        }, 'surge-panel: slots');
      }
    };
  }
});
