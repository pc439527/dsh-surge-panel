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
    const VERSION = '1.2.0';

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
      'sep': '；',
      'action.refresh': '刷新',
      'action.retry': '重试',
      'action.pause': '暂停自动刷新',
      'action.resume': '恢复自动刷新',
      'action.switchConn': '切换当前连接',
      'action.manageConns': '管理连接…',
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
      'requests.title': '最近请求',
      'requests.show': '查看明细',
      'requests.hide': '收起明细',
      'requests.target': '目标',
      'requests.policy': '策略',
      'requests.status': '状态',
      'requests.traffic': '流量',
      'requests.failed': '失败',
      'requests.active': '活动中',
      'requests.done': '已完成',
      'requests.empty': '暂无最近请求',
      'chart.title': '流量趋势',
      'chart.down': '下载',
      'chart.up': '上传',
      'chart.empty': '点击上方图例以显示曲线',
      'chart.sampling': '正在采样…打开面板后开始记录真实速率，请稍候。',
      'chart.sampled': '自打开面板起采样',
      'chart.peak': '峰值',
      'devices.title': '设备总览',
      'devices.online': '台设备',
      'devices.throughput': '实时吞吐',
      'devices.sessionTotal': '会话累计',
      'devices.barTitle': '条形比例表示该设备占最高会话流量的占比',
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
      'events.toggleHint': '点击展开或收起完整事件内容',
      'note': '数据来自 Surge HTTP API：本机密钥由 Host 读取；手动填写的密钥仅用于测试或保存，保存后不会返回浏览器。曲线记录当前连接的真实采样，切换连接后重新开始。',
      /* ---- 错误与状态码 ---- */
      'err.NO_GATEWAY': '未找到可用的 Surge HTTP API，请检查当前连接；HTTPS 自签证书需在连接中配置受信任 CA。',
      'err.API_ERROR': 'Surge 流量 API 不可用，请检查连接或运行 API 诊断。',
      'err.CONNECTION_CHANGED': '连接已切换，请刷新重试。',
      'err.ID_RESERVED': '连接 ID "local" 为保留值。',
      'err.ID_INVALID': '连接 ID 只能包含字母、数字、-、_。',
      'err.INVALID_PROTOCOL': '协议仅支持 HTTP 或 HTTPS。',
      'err.INVALID_HOST': '主机仅填写域名或 IP，请勿附加协议、端口或路径。',
      'err.HOST_BLOCKED': '该主机地址不允许访问。',
      'err.INVALID_PORT': '端口须为 1–65535 的整数。',
      'err.INVALID_API_KEY': 'API 密钥格式不合法。',
      'err.INVALID_CA_CERT': 'CA 证书须为有效的 X.509 PEM 格式，且不超过 16 KB。',
      'err.BAD_BODY': '请求参数格式不合法。',
      'err.MAX_CONNECTIONS': '最多保存 100 个连接。',
      'err.LOCAL_NOT_DELETABLE': '本机连接不可删除。',
      'err.CONNECTION_NOT_FOUND': '该连接不存在或已被删除。',
      'err.LOCAL_NOT_FOUND': '未发现本机 Surge HTTP API。',
      'err.MISSING_CONNECTION': '缺少连接信息或 API 密钥。',
      'err.API_UNREACHABLE': 'API 无响应',
      'err.PARTIAL_DATA': '部分端点不可用',
      'err.VALIDATION_ERROR': '连接配置校验失败。',
      'ep.requests': '活动请求',
      'ep.outbound': '出站模式',
      'ep.devices': '设备列表',
      'ep.events': '最近事件',
      'ep.profile': '当前配置',
      'ep.rules': '规则',
      'ep.policies': '策略组',
      'ep.modules': '模块',
      'ep.dns': 'DNS 缓存',
      'ep.traffic': '流量统计',
      /* ---- 设备管理 ---- */
      'dm.title': '设备管理',
      'dm.subtitle': '管理多个 Surge 实例，切换当前连接，并汇总所有实例的在线状态与吞吐',
      'dm.add': '添加连接',
      'dm.edit': '编辑',
      'dm.delete': '删除',
      'dm.confirmDeleteBtn': '确认删除',
      'dm.activate': '设为当前',
      'dm.active': '当前',
      'dm.test': '测试连接',
      'dm.save': '保存',
      'dm.saveActivate': '保存并设为当前',
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
      'dm.field.ca': 'HTTPS 自定义 CA 证书（可选，PEM）',
      'dm.field.caHint': 'HTTPS 始终校验证书；自签证书请填写其受信任 CA。主机字段仅填写域名或 IP。',
      'dm.local': '本机',
      'dm.localName': '本机 Surge',
      'dm.localHint': '自动读取本机 Surge 配置，密钥不进入浏览器；可切换、测试，但不可编辑或删除。',
      'dm.form.add': '添加 Surge 实例',
      'dm.form.edit': '编辑 Surge 实例',
      'dm.saved': '已保存连接',
      'dm.online': '在线设备',
      'dm.totalDown': '总下载',
      'dm.totalUp': '总上传',
      'dm.activeReqs': '活动请求',
      'dm.fleet.title': '设备总览（多实例汇总）',
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
      'dm.refresh': '刷新全部',
      'dm.saveErr': '请填写名称、主机与端口',
      'dm.testErr': '请填写有效的主机与端口后再测试',
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
      'chart.keyboard': '使用方向键浏览采样点，Home 和 End 跳到首尾，Esc 关闭提示。',
      'st.diag.httpStatus': 'HTTP 状态',
      'st.diag.noResponse': '未收到 HTTP 响应',
      'st.diag.message': '诊断消息',
      'st.diag.noMessage': '无诊断消息',
      'st.diag.noChecks': '没有端点诊断结果。',
      'st.diag.details': '诊断详情',
      'st.diag.copy': '复制诊断结果',
      'st.diag.copied': '已复制诊断结果。',
      'st.diag.copyFailed': '无法写入剪贴板，请手动复制下方内容。',
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
      'st.resetDone': '已恢复默认设置',
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
      'sep': '; ',
      'action.refresh': 'Refresh',
      'action.retry': 'Retry',
      'action.pause': 'Pause auto-refresh',
      'action.resume': 'Resume auto-refresh',
      'action.switchConn': 'Switch active connection',
      'action.manageConns': 'Manage connections…',
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
      'requests.title': 'Recent requests',
      'requests.show': 'Details',
      'requests.hide': 'Hide',
      'requests.target': 'Target',
      'requests.policy': 'Policy',
      'requests.status': 'Status',
      'requests.traffic': 'Traffic',
      'requests.failed': 'Failed',
      'requests.active': 'Active',
      'requests.done': 'Done',
      'requests.empty': 'No recent requests',
      'chart.title': 'Traffic',
      'chart.down': 'Download',
      'chart.up': 'Upload',
      'chart.empty': 'Toggle the legend above to show a series',
      'chart.sampling': 'Sampling… real rates are recorded from the moment the panel opens. Please wait.',
      'chart.sampled': 'Sampled since this panel opened',
      'chart.peak': 'Peak',
      'devices.title': 'Devices',
      'devices.online': 'devices',
      'devices.throughput': 'Live throughput',
      'devices.sessionTotal': 'Session total',
      'devices.barTitle': 'Bar width shows session traffic relative to the top device',
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
      'events.toggleHint': 'Click to expand or collapse full event text',
      'note': 'Data comes from the Surge HTTP API. The Host reads local keys; manually entered keys are submitted for testing or saving and are never returned once stored. The curve records real samples for the current connection and restarts when it changes.',
      /* ---- Errors & status codes ---- */
      'err.NO_GATEWAY': 'No reachable Surge HTTP API found. Check the active connection; for self-signed HTTPS certificates, configure a trusted CA.',
      'err.API_ERROR': 'Surge traffic API is unavailable. Check the connection or run API diagnostics.',
      'err.CONNECTION_CHANGED': 'Active connection changed. Please refresh.',
      'err.ID_RESERVED': 'Connection ID "local" is reserved.',
      'err.ID_INVALID': 'Connection ID may only contain letters, digits, - and _.',
      'err.INVALID_PROTOCOL': 'Protocol must be HTTP or HTTPS.',
      'err.INVALID_HOST': 'Enter only a hostname or IP address without scheme, port or path.',
      'err.HOST_BLOCKED': 'This host address is not allowed.',
      'err.INVALID_PORT': 'Port must be an integer between 1 and 65535.',
      'err.INVALID_API_KEY': 'API key format is invalid.',
      'err.INVALID_CA_CERT': 'CA certificate must be valid X.509 PEM and at most 16 KB.',
      'err.BAD_BODY': 'Invalid request payload.',
      'err.MAX_CONNECTIONS': 'At most 100 connections can be saved.',
      'err.LOCAL_NOT_DELETABLE': 'The local connection cannot be deleted.',
      'err.CONNECTION_NOT_FOUND': 'Connection not found or already deleted.',
      'err.LOCAL_NOT_FOUND': 'Local Surge HTTP API was not detected.',
      'err.MISSING_CONNECTION': 'Missing connection details or API key.',
      'err.API_UNREACHABLE': 'API unreachable',
      'err.PARTIAL_DATA': 'Some endpoints are unavailable',
      'err.VALIDATION_ERROR': 'Connection configuration is invalid.',
      'ep.requests': 'Active requests',
      'ep.outbound': 'Outbound mode',
      'ep.devices': 'Devices',
      'ep.events': 'Events',
      'ep.profile': 'Profile',
      'ep.rules': 'Rules',
      'ep.policies': 'Policies',
      'ep.modules': 'Modules',
      'ep.dns': 'DNS cache',
      'ep.traffic': 'Traffic',
      /* ---- Devices ---- */
      'dm.title': 'Device management',
      'dm.subtitle': 'Manage multiple Surge instances, switch the active one and review fleet-wide status',
      'dm.add': 'Add connection',
      'dm.edit': 'Edit',
      'dm.delete': 'Delete',
      'dm.confirmDeleteBtn': 'Confirm delete',
      'dm.activate': 'Set active',
      'dm.active': 'Active',
      'dm.test': 'Test',
      'dm.save': 'Save',
      'dm.saveActivate': 'Save & activate',
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
      'dm.field.ca': 'Custom HTTPS CA certificate (optional, PEM)',
      'dm.field.caHint': 'HTTPS always verifies certificates. Add a trusted CA for self-signed certificates. Enter only a domain or IP in Host.',
      'dm.local': 'Local',
      'dm.localName': 'Local Surge',
      'dm.localHint': 'Auto-read from the local Surge profile; the key never reaches the browser. Can be activated/tested, not edited or deleted.',
      'dm.form.add': 'Add a Surge instance',
      'dm.form.edit': 'Edit a Surge instance',
      'dm.saved': 'Saved',
      'dm.online': 'Online',
      'dm.totalDown': 'Total down',
      'dm.totalUp': 'Total up',
      'dm.activeReqs': 'Active reqs',
      'dm.fleet.title': 'Fleet overview (all instances)',
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
      'dm.refresh': 'Refresh all',
      'dm.saveErr': 'Name, host and port are required',
      'dm.testErr': 'Enter a valid host and port before testing',
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
      'chart.keyboard': 'Use the arrow keys to browse samples, Home and End to jump to either end, and Escape to close the tooltip.',
      'st.diag.httpStatus': 'HTTP status',
      'st.diag.noResponse': 'No HTTP response',
      'st.diag.message': 'Diagnostic message',
      'st.diag.noMessage': 'No diagnostic message',
      'st.diag.noChecks': 'No endpoint results were returned.',
      'st.diag.details': 'Diagnostic details',
      'st.diag.copy': 'Copy diagnostics',
      'st.diag.copied': 'Diagnostics copied.',
      'st.diag.copyFailed': 'Clipboard access failed. Copy the report below manually.',
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
      'st.resetDone': 'Preferences reset to defaults',
      'st.note': 'Note: the original product\'s console lock / notification centre / background automation / demo mode and the Surge feature write-switches depend on a separate Node Core, SQLite and scheduler. This plugin is a DSH-native read-only monitor: it does not embed those writes or fabricate data, and instead offers panel-level appearance, refresh and multi-instance management as equivalents.',
      'st.loading': 'Loading…',
      'st.typeValue': 'DSH-native plugin (Host + Client)',
      'st.sourceValue': 'Surge HTTP API · real data'
    };
    const detailLabels = {
      zh: {
        open: '查看详情', all: '全部', close: '关闭', search: '搜索', filter: '筛选', previous: '上一页', next: '下一页',
        copy: '复制', copied: '已复制', copyError: '无法访问剪贴板，请手动复制', empty: '暂无条目',
        type: '类型', value: '值', policy: '策略', selected: '当前选择', policyCount: '成员数', enabled: '启用', disabled: '停用',
        domain: '域名', address: '地址', ttl: 'TTL（秒）', target: '目标', status: '状态', failed: '失败', active: '活动中',
        completed: '已完成', group: '策略组', proxy: '代理', rule: '规则', error: '错误', warn: '警告', brand: '信息', idle: '普通',
        timestamp: '时间', startDate: '开始时间', ip: 'IP 地址', inBytes: '下载累计', outBytes: '上传累计',
        inSpeed: '下载速率', outSpeed: '上传速率', name: '名称', yes: '是', no: '否', online: '在线实例', offline: '离线实例',
        mode: '出站模式', rtt: 'API 延迟', conns: '活动请求', event: '事件详情', checkedAt: '探测时间', activate: '设为当前并查看概览',
        switchError: '切换连接失败', loadError: '连接列表加载失败', interfaces: '网卡流量', detailsFor: '查看详情', truncated: '内容已截断'
      },
      en: {
        open: 'View details', all: 'All', close: 'Close', search: 'Search', filter: 'Filter', previous: 'Previous', next: 'Next',
        copy: 'Copy', copied: 'Copied', copyError: 'Clipboard unavailable. Copy the text manually.', empty: 'No entries',
        type: 'Type', value: 'Value', policy: 'Policy', selected: 'Selected', policyCount: 'Members', enabled: 'Enabled', disabled: 'Disabled',
        domain: 'Domain', address: 'Address', ttl: 'TTL (seconds)', target: 'Target', status: 'Status', failed: 'Failed', active: 'Active',
        completed: 'Completed', group: 'Group', proxy: 'Proxy', rule: 'Rule', error: 'Error', warn: 'Warning', brand: 'Info', idle: 'General',
        timestamp: 'Time', startDate: 'Started', ip: 'IP address', inBytes: 'Downloaded', outBytes: 'Uploaded',
        inSpeed: 'Download rate', outSpeed: 'Upload rate', name: 'Name', yes: 'Yes', no: 'No', online: 'Online instances', offline: 'Offline instances',
        mode: 'Outbound mode', rtt: 'API latency', conns: 'Active requests', event: 'Event details', checkedAt: 'Checked at', activate: 'Set active and open overview',
        switchError: 'Could not switch connections', loadError: 'Could not load connections', interfaces: 'Interface traffic', detailsFor: 'View details', truncated: 'Text was truncated'
      }
    };
    for (const [dictionary, labels] of [[zh, detailLabels.zh], [en, detailLabels.en]]) {
      for (const [key, value] of Object.entries(labels)) dictionary['detail.' + key] = value;
    }
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
      radio: 'M12 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2zM8.5 8.5a5 5 0 0 0 0 7M15.5 8.5a5 5 0 0 1 0 7M5.5 5.5a9 9 0 0 0 0 13M18.5 5.5a9 9 0 0 1 0 13',
      settings: 'M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09A1.65 1.65 0 0 0 15 4.6a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9c.14.34.4.62.74.8.3.16.64.25.99.26H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z',
      plus: 'M12 5v14M5 12h14',
      check: 'M20 6 9 17l-5-5',
      trash: 'M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6',
      pause: 'M9 5h2v14H9zM13 5h2v14h-2z',
      play: 'M7 5l12 7-12 7z',
      chevronDown: 'M6 9l6 6 6-6'
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
    function fmtBytesStr(bytes, perSec) {
      const f = fmtBytes(bytes, perSec);
      return f.value + ' ' + f.unit;
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
    function fmtEventTime(ev) {
      if (ev && typeof ev.timestamp === 'number' && isFinite(ev.timestamp)) {
        const dt = new Date(ev.timestamp);
        return pad(dt.getHours()) + ':' + pad(dt.getMinutes());
      }
      return (ev && ev.time) || '';
    }
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
          map[key] = { time: fmtEventTime(e), text: e.text || '', tone: e.tone || 'idle', count: 0, key: key };
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
      let target = path;
      if (typeof target === 'string' && target.startsWith('/')) {
        let prefix = '';
        if (typeof window !== 'undefined' && window.__FNOS_GATEWAY_CONFIG__ && typeof window.__FNOS_GATEWAY_CONFIG__.prefix === 'string') {
          prefix = window.__FNOS_GATEWAY_CONFIG__.prefix.replace(/\/+$/, '');
        } else if (typeof document !== 'undefined' && document.querySelector) {
          const baseEl = document.querySelector('base[href]');
          const href = baseEl && baseEl.getAttribute('href');
          if (href && href.startsWith('/') && !href.startsWith('//')) prefix = href.replace(/\/+$/, '');
        }
        if (prefix && target !== prefix && !target.startsWith(prefix + '/')) target = prefix + target;
      }
      if (signal) {
        if (signal.aborted) abort();
        else signal.addEventListener('abort', abort, { once: true });
      }
      const timer = setTimeout(abort, timeoutMs);
      try {
        const response = await fetch(target, { headers: { Accept: 'application/json' }, cache: 'no-store', ...request, signal: controller.signal });
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
      let state = { status: 'loading', snap: null, activeConnection: null, error: '', errorCode: '', errorDetail: '', updated: null, fetching: false };
      const down = [], up = [], labels = [];
      const subs = new Set();
      let epoch = 0, flight = null, seriesKey = '', lastSample = null;
      const clearSamples = function () { down.length = 0; up.length = 0; labels.length = 0; lastSample = null; };
      const emit = function (next) { state = next; subs.forEach(function (fn) { try { fn(); } catch { /* Isolate subscriber failures. */ } }); };
      const cancel = function () {
        epoch++;
        if (flight) flight.controller.abort();
        flight = null;
        if (state.fetching) emit({ ...state, fetching: false });
      };
      const fetchOnce = function () {
        if (flight) return flight.promise;
        if (typeof fetch !== 'function') return Promise.resolve();
        const currentEpoch = epoch;
        const current = { controller: new AbortController(), promise: null };
        flight = current;
        emit({ ...state, fetching: true });
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
              emit({ status: 'ok', snap: snapshot, activeConnection: snapshot.activeConnection || state.activeConnection, error: '', errorCode: '', errorDetail: '', updated: when, fetching: false });
            } else {
              if (body.code === 'CONNECTION_CHANGED') { clearSamples(); seriesKey = ''; }
              const nextActive = body.activeConnection || (body.code === 'CONNECTION_CHANGED' ? null : state.activeConnection);
              emit({
                status: 'error',
                snap: body.code === 'CONNECTION_CHANGED' ? null : state.snap,
                activeConnection: nextActive,
                error: body.message || body.code || 'Unknown error',
                errorCode: body.code || '',
                errorDetail: body.detail || '',
                updated: state.updated,
                fetching: false
              });
            }
          })
          .catch(function (error) {
            if (currentEpoch !== epoch) return;
            emit({ status: 'error', snap: state.snap, activeConnection: state.activeConnection, error: String(error.message || error), errorCode: '', errorDetail: '', updated: state.updated, fetching: false });
          })
          .finally(function () {
            if (flight === current) {
              flight = null;
              if (state.fetching) emit({ ...state, fetching: false });
            }
          });
        return current.promise;
      };
      return {
        get: function () { return state; },
        subscribe: function (fn) { subs.add(fn); return function () { subs.delete(fn); }; },
        fetch: fetchOnce,
        cancel,
        invalidate: function () {
          cancel(); clearSamples(); seriesKey = '';
          emit({ status: 'loading', snap: null, activeConnection: null, error: '', errorCode: '', errorDetail: '', updated: null, fetching: false });
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
.sg-root,.sg-root.sg-force-light{
  --sg-fallback-base:#f5f5f7;--sg-fallback-surface:#fff;--sg-fallback-raised:#ececf0;
  --sg-fallback-border:#dddde3;--sg-fallback-border-strong:#a2a2ac;
  --sg-fallback-text:#1c1c1e;--sg-fallback-muted:#595960;--sg-fallback-idle:#64646d;
  --sg-fallback-accent:#a84020;--sg-fallback-error:#ac282e;--sg-fallback-success:#176b43;--sg-fallback-warning:#845305;
  --sg-fallback-on-accent:#fff;
}
@media(prefers-color-scheme:dark){
  .sg-root:not(.sg-force-light){
    --sg-fallback-base:#1a1a1c;--sg-fallback-surface:#232326;--sg-fallback-raised:#2c2c30;
    --sg-fallback-border:#3b3b43;--sg-fallback-border-strong:#696973;
    --sg-fallback-text:#f2f2f4;--sg-fallback-muted:#b4b4bc;--sg-fallback-idle:#a3a3ad;
    --sg-fallback-accent:#ff9478;--sg-fallback-error:#ff868a;--sg-fallback-success:#70dba0;--sg-fallback-warning:#f4b85b;
    --sg-fallback-on-accent:#1a1a1c;
  }
}
.sg-root.sg-force-dark{
  --sg-fallback-base:#1a1a1c;--sg-fallback-surface:#232326;--sg-fallback-raised:#2c2c30;
  --sg-fallback-border:#3b3b43;--sg-fallback-border-strong:#696973;
  --sg-fallback-text:#f2f2f4;--sg-fallback-muted:#b4b4bc;--sg-fallback-idle:#a3a3ad;
  --sg-fallback-accent:#ff9478;--sg-fallback-error:#ff868a;--sg-fallback-success:#70dba0;--sg-fallback-warning:#f4b85b;
  --sg-fallback-on-accent:#1a1a1c;
}
/* Resolve host aliases before exposing their fallbacks to the page content. */
.sg-root{
  --sg-base:var(--dsw-alias-bg-base,var(--sg-fallback-base));
  --sg-surface:var(--dsw-alias-bg-layer-1,var(--sg-fallback-surface));
  --sg-raised:var(--dsw-alias-bg-layer-2,var(--sg-fallback-raised));
  --sg-overlay:var(--dsw-alias-bg-overlay,var(--sg-surface));
  --sg-border:var(--dsw-alias-border-l1,var(--sg-fallback-border));
  --sg-border-strong:var(--dsw-alias-border-l2,var(--sg-fallback-border-strong));
  --sg-text:var(--dsw-alias-label-primary,var(--sg-fallback-text));
  --sg-muted:var(--dsw-alias-label-secondary,var(--sg-fallback-muted));
  --sg-idle:var(--dsw-alias-state-idle-primary,var(--sg-fallback-idle));
  --sg-accent:var(--dsw-alias-brand-primary,var(--sg-fallback-accent));
  --sg-error:var(--dsw-alias-state-error-primary,var(--sg-fallback-error));
  --sg-success:var(--dsw-alias-state-success-primary,var(--sg-fallback-success));
  --sg-warning:var(--dsw-alias-state-warn-primary,var(--sg-fallback-warning));
  --sg-primary-fg:var(--dsw-alias-bg-base,var(--sg-fallback-on-accent));
  box-sizing:border-box;block-size:100%;min-block-size:0;min-inline-size:0;
  overflow:auto;background:var(--sg-base);color:var(--sg-text);
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;font-size:.875rem;line-height:1.5;
  container:sg-panel / inline-size;
}
.sg-root.sg-force-light,.sg-root.sg-force-dark{
  --sg-base:var(--sg-fallback-base);--sg-surface:var(--sg-fallback-surface);--sg-raised:var(--sg-fallback-raised);--sg-overlay:var(--sg-fallback-surface);
  --sg-border:var(--sg-fallback-border);--sg-border-strong:var(--sg-fallback-border-strong);
  --sg-text:var(--sg-fallback-text);--sg-muted:var(--sg-fallback-muted);--sg-idle:var(--sg-fallback-idle);
  --sg-accent:var(--sg-fallback-accent);--sg-error:var(--sg-fallback-error);--sg-success:var(--sg-fallback-success);--sg-warning:var(--sg-fallback-warning);
  --sg-primary-fg:var(--sg-fallback-on-accent);
}
.sg-root.sg-force-light{color-scheme:light}
.sg-root.sg-force-dark{color-scheme:dark}
.sg-inner{
  --dsw-alias-bg-base:var(--sg-base);--dsw-alias-bg-layer-1:var(--sg-surface);--dsw-alias-bg-layer-2:var(--sg-raised);--dsw-alias-bg-overlay:var(--sg-overlay);
  --dsw-alias-border-l1:var(--sg-border);--dsw-alias-border-l2:var(--sg-border-strong);
  --dsw-alias-label-primary:var(--sg-text);--dsw-alias-label-secondary:var(--sg-muted);--dsw-alias-state-idle-primary:var(--sg-idle);
  --dsw-alias-brand-primary:var(--sg-accent);--dsw-alias-state-error-primary:var(--sg-error);--dsw-alias-state-success-primary:var(--sg-success);--dsw-alias-state-warn-primary:var(--sg-warning);
  --sg-edge:16px;--sg-gap:14px;--sg-target:36px;--sg-axis-width:56px;
  max-inline-size:1440px;min-inline-size:0;margin-inline:auto;padding:24px var(--sg-edge) 36px;
  padding-inline:max(var(--sg-edge),env(safe-area-inset-left)) max(var(--sg-edge),env(safe-area-inset-right));
  padding-block-end:max(36px,env(safe-area-inset-bottom));
  overflow-wrap:anywhere;
}
.sg-root *{box-sizing:border-box}
.sg-root button,.sg-root input,.sg-root select,.sg-root textarea{font-family:inherit;line-height:inherit}
.sg-root::-webkit-scrollbar{width:9px;height:9px}
.sg-root::-webkit-scrollbar-thumb{background:var(--sg-border-strong);border-radius:9px;border:2px solid var(--sg-base)}
.sg-root .sg-mono{font-family:SFMono-Regular,Menlo,Monaco,Consolas,monospace;font-variant-numeric:tabular-nums}
.sg-num{font-variant-numeric:tabular-nums;letter-spacing:-.01em}
.sg-sub{font-size:.75rem;color:var(--dsw-alias-label-secondary)}
.sg-ic{display:block;flex:none}

.sg-header{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.sg-brand{width:44px;height:44px;flex:none;border-radius:13px;display:flex;align-items:center;justify-content:center;color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1)}
.sg-head-txt{flex:1 1 12rem;min-inline-size:0}
.sg-title{margin:0;font-size:1.375rem;font-size:clamp(1.25rem,1rem + 1cqi,1.75rem);line-height:1.15;font-weight:700;letter-spacing:-.025em}
.sg-subtitle{margin:4px 0 0;font-size:.8125rem;color:var(--dsw-alias-label-secondary)}
.sg-head-right{display:flex;align-items:center;gap:8px;flex-wrap:wrap;max-inline-size:100%;margin-inline-start:auto}
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
.sg-icon-btn.is-active{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary)}
.sg-icon-btn:active{transform:scale(.93)}
@keyframes sgSpin{from{transform:rotate(0)}to{transform:rotate(360deg)}}
.sg-spin{animation:sgSpin .85s linear infinite}

/* Tab bar & active-connection switcher */
.sg-tabbar{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin:18px 0 20px}
.sg-tabs{display:flex;flex-wrap:wrap;max-inline-size:100%;gap:4px;padding:4px;border-radius:12px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1)}
.sg-tab{display:inline-flex;align-items:center;justify-content:center;gap:7px;min-inline-size:0;padding:6px 14px;border-radius:8px;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font-size:.8125rem;font-weight:600;cursor:pointer}
.sg-tab:hover{color:var(--dsw-alias-label-primary)}
.sg-tab.is-active{background:var(--dsw-alias-bg-layer-2);box-shadow:inset 0 -2px var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary)}
.sg-tabbar-sp{flex:1}
.sg-switcher{position:relative;min-inline-size:0;max-inline-size:100%;margin-inline-start:auto}
.sg-active-chip{display:inline-flex;align-items:center;gap:7px;max-inline-size:100%;text-align:start;padding:6px 11px;border-radius:999px;font-size:.75rem;font-weight:600;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);cursor:pointer;transition:border-color .15s,color .15s}
.sg-active-chip:hover{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary)}
.sg-active-chip .sg-ic{color:var(--dsw-alias-brand-primary)}
.sg-active-chip .sg-chev{color:var(--dsw-alias-label-secondary);margin-inline-start:auto}
.sg-popover{
  position:absolute;inset-inline-end:0;inset-block-start:calc(100% + 6px);
  inline-size:20rem;max-inline-size:calc(100vw - 2 * var(--sg-edge));max-inline-size:calc(100cqi - 2 * var(--sg-edge));
  max-block-size:min(20rem,45vh);max-block-size:min(20rem,45dvh);
  overflow:auto;overscroll-behavior:contain;padding:6px;border-radius:12px;
  background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l2);
  box-shadow:0 8px 24px rgba(0,0,0,.18);z-index:30;display:flex;flex-direction:column;gap:2px;
}
.sg-pop-item{display:flex;align-items:center;gap:6px 8px;flex:none;flex-wrap:wrap;width:100%;text-align:start;padding:7px 9px;border-radius:8px;border:0;background:transparent;color:var(--dsw-alias-label-primary);font-size:.8125rem;font-weight:550;cursor:pointer}
.sg-pop-item:hover,.sg-pop-item.is-active{background:var(--dsw-alias-bg-layer-2)}
.sg-pop-item.is-active{color:var(--dsw-alias-brand-primary);font-weight:650}
.sg-pop-name{flex:1;min-inline-size:0}
.sg-pop-host{font-size:.6875rem;color:var(--dsw-alias-label-secondary);max-inline-size:100%}
.sg-pop-div{flex:none;block-size:1px;background:var(--dsw-alias-border-l1);margin:4px 2px}
.sg-pop-foot{color:var(--dsw-alias-label-secondary);font-size:.75rem}

.sg-livebar{display:flex;align-items:center;gap:9px;padding:10px 14px;border-radius:11px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);font-size:12px;flex-wrap:wrap}
.sg-dot-live{width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-state-warn-primary)}
.sg-dot-live.is-live{background:var(--dsw-alias-state-success-primary)}
.sg-live-txt{font-weight:600;color:var(--dsw-alias-label-primary)}
.sg-live-sp{flex:1}

.sg-card{min-inline-size:0;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:16px;padding:var(--sg-card-pad,16px);transition:border-color .15s}
.sg-card:hover{border-color:var(--dsw-alias-border-l2)}
.sg-card-h{display:flex;align-items:center;justify-content:space-between;gap:8px 12px;margin-bottom:14px;flex-wrap:wrap}
.sg-card-h:last-child{margin-bottom:0}
.sg-card-h.is-tall{align-items:flex-start}
.sg-card-t{margin:0;font-size:.9375rem;font-weight:700;line-height:1.3;display:flex;align-items:center;gap:8px}
.sg-card-t .sg-ic{color:var(--dsw-alias-brand-primary)}
.sg-h-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-inline-size:0}

.sg-metrics,.sg-strip{display:grid;grid-template-columns:repeat(var(--sg-stat-columns,5),minmax(0,1fr));gap:var(--sg-gap)}
.sg-metrics>*,.sg-strip>*{grid-column:span var(--sg-stat-span,1)}
.sg-metric{padding:14px var(--sg-card-pad,16px) 12px;display:flex;flex-direction:column;gap:8px}
.sg-metric-head{display:flex;align-items:center;gap:8px}
.sg-ico-tile{width:28px;height:28px;flex:none;border-radius:8px;display:inline-flex;align-items:center;justify-content:center;background:var(--dsw-alias-bg-layer-2)}
.sg-metric-label{font-size:.75rem;color:var(--dsw-alias-label-secondary);font-weight:600}
.sg-metric-row{display:flex;align-items:baseline;justify-content:space-between;gap:4px 8px;flex-wrap:wrap}
.sg-metric-num{font-size:1.375rem;font-size:clamp(1.25rem,1rem + 1cqi,1.75rem);font-weight:700;line-height:1.15;min-inline-size:0}
.sg-unit{font-size:.75rem;color:var(--dsw-alias-label-secondary);margin-inline-start:5px;font-weight:500}
.sg-spark{width:100%;height:28px;display:block;margin-top:auto}
.sg-spark-ph{min-block-size:28px;display:flex;align-items:flex-end;margin-top:auto}
.sg-metric-link{border:0;background:transparent;padding:0;color:var(--dsw-alias-brand-primary);font-size:.75rem;font-weight:600;text-align:start;cursor:pointer;display:inline-flex;align-items:center;gap:4px}
.sg-metric-link:hover{text-decoration:underline}
.sg-spark-line{fill:none;stroke:currentColor;stroke-width:1.6;vector-effect:non-scaling-stroke;stroke-linejoin:round;stroke-linecap:round}
.sg-spark-area{fill:currentColor;opacity:.12}

.sg-tone-brand{color:var(--dsw-alias-brand-primary)}
.sg-tone-success{color:var(--dsw-alias-state-success-primary)}
.sg-tone-warn{color:var(--dsw-alias-state-warn-primary)}
.sg-tone-idle{color:var(--dsw-alias-state-idle-primary)}
.sg-tone-error{color:var(--dsw-alias-state-error-primary)}

.sg-main-grid,.sg-bottom-grid{display:grid;gap:var(--sg-gap)}
.sg-main-grid{grid-template-columns:var(--sg-main-cols,minmax(0,1.6fr) minmax(0,1fr))}
.sg-bottom-grid{grid-template-columns:repeat(var(--sg-bottom-cols,3),minmax(0,1fr))}
.sg-bottom-grid>:nth-child(3){grid-column:var(--sg-bottom-last,auto)}

.sg-legend{display:inline-flex;flex-wrap:wrap;gap:4px}
.sg-legend-btn{display:inline-flex;align-items:center;gap:6px;border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary);font-size:.75rem;padding:4px 8px;border-radius:7px;cursor:pointer;transition:border-color .15s}
.sg-legend-btn:hover{border-color:var(--dsw-alias-border-l2)}
.sg-legend-btn.is-off{text-decoration:line-through}
.sg-legend-btn.is-off .sg-legend-dot{background:transparent;border:1px solid currentColor}
.sg-legend-dot{width:8px;height:8px;border-radius:50%;background:currentColor;flex:none}

.sg-chart{display:grid;grid-template-columns:minmax(0,1fr);width:100%;container:sg-chart / inline-size}
.sg-chart-wrap{display:flex;align-items:stretch;gap:8px;width:100%}
.sg-yaxis{display:flex;flex-direction:column;justify-content:space-between;padding:8px 0 6px;font-size:.6875rem;color:var(--dsw-alias-label-secondary);text-align:end;white-space:nowrap;flex:none;inline-size:max(var(--sg-axis-width),6ch)}
.sg-plot{--sg-tip-width:150px;position:relative;flex:1;min-width:0;cursor:crosshair;touch-action:pan-y pinch-zoom}
.sg-chart-svg{width:100%;height:200px;display:block;overflow:hidden}
.sg-grid{stroke:var(--dsw-alias-border-l1);stroke-width:1;vector-effect:non-scaling-stroke}
.sg-area-down{fill:var(--dsw-alias-brand-primary);opacity:.14}
.sg-area-up{fill:var(--dsw-alias-state-success-primary);opacity:.12}
.sg-line{fill:none;stroke-width:2;vector-effect:non-scaling-stroke;stroke-linejoin:round;stroke-linecap:round}
.sg-line-down{stroke:var(--dsw-alias-brand-primary)}
.sg-line-up{stroke:var(--dsw-alias-state-success-primary)}
.sg-crosshair{position:absolute;top:12px;bottom:8px;width:1px;background:var(--dsw-alias-border-l2);pointer-events:none}
.sg-hover-dot{position:absolute;width:8px;height:8px;border-radius:50%;border:2px solid var(--dsw-alias-bg-layer-1);transform:translate(-50%,-50%);pointer-events:none}
.sg-hover-dot.is-down{background:var(--dsw-alias-brand-primary)}
.sg-hover-dot.is-up{background:var(--dsw-alias-state-success-primary)}
.sg-tooltip{position:absolute;top:8px;width:var(--sg-tip-width);max-inline-size:100%;min-inline-size:0;padding:6px 8px;border-radius:9px;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l2);box-shadow:0 4px 14px rgba(0,0,0,.16);font-size:.6875rem;pointer-events:none;z-index:10;display:flex;flex-direction:column;gap:3px;white-space:normal;overflow-wrap:anywhere}
.sg-tip-row{display:flex;align-items:baseline;justify-content:space-between;flex-wrap:wrap;gap:2px 6px}
.sg-tip-lbl{display:inline-flex;align-items:center;gap:5px;color:var(--dsw-alias-label-secondary)}
.sg-xaxis{display:flex;justify-content:space-between;gap:4px;margin-top:8px;padding-inline-start:calc(max(var(--sg-axis-width),6ch) + 8px);font-size:.6875rem;color:var(--dsw-alias-label-secondary);width:100%}
.sg-xaxis .sg-tick{min-inline-size:0;text-align:center}
.sg-xaxis .sg-tick:first-child{text-align:start}
.sg-xaxis .sg-tick:last-child{text-align:end}
.sg-chart-foot{display:flex;flex-wrap:wrap;justify-content:space-between;gap:4px 12px;margin-top:10px;font-size:.6875rem;color:var(--dsw-alias-label-secondary)}
@container sg-chart (max-width:30rem){.sg-xaxis .sg-tick-odd:not(.sg-tick-edge){display:none}}
@container sg-chart (max-width:16rem){.sg-xaxis .sg-tick:not(.sg-tick-edge):not(:first-child):not(:last-child){display:none}}
.sg-empty{height:200px;display:flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-secondary);font-size:13px;text-align:center;padding:0 12px}

.sg-dev-list{display:flex;flex-direction:column;gap:4px}
.sg-dev{display:flex;align-items:center;gap:10px;width:100%;text-align:left;padding:9px 10px;border-radius:10px;border:1px solid transparent;background:transparent;color:inherit;cursor:pointer;transition:background .15s,border-color .15s}
.sg-dev:hover{background:var(--dsw-alias-bg-layer-2)}
.sg-dev.is-sel{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l1)}
.sg-dev-dot{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-state-idle-primary);flex:none}
.sg-dev-dot.is-hot{background:var(--dsw-alias-state-success-primary)}
.sg-dev-ico{color:var(--dsw-alias-label-secondary);flex:none}
.sg-dev-main{display:flex;flex-direction:column;min-width:0;flex:1}
.sg-dev-name{font-size:.8125rem;font-weight:650;overflow-wrap:anywhere}
.sg-dev-sub{font-size:.6875rem;color:var(--dsw-alias-label-secondary)}
.sg-dev-right{display:flex;flex-direction:column;align-items:flex-end;gap:4px;flex:none;max-inline-size:40%}
.sg-dev-speed{font-size:.6875rem;color:var(--dsw-alias-label-secondary);text-align:end}
.sg-dev-speed.is-hot{color:var(--dsw-alias-label-primary);font-weight:600}
.sg-dev-bar{width:54px;height:5px;border-radius:4px;background:var(--dsw-alias-bg-layer-2);overflow:hidden;flex:none}
.sg-dev-bar-fill{display:block;height:100%;border-radius:4px;background:var(--dsw-alias-brand-primary)}
.sg-dev-foot{margin-top:12px;padding-top:11px;border-top:1px solid var(--dsw-alias-border-l1);display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:6px 12px;font-size:12px}
.sg-dev-foot b{font-weight:650}

.sg-kv{display:flex;flex-direction:column;gap:2px}
.sg-kv-row{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 0;border-bottom:1px solid var(--dsw-alias-border-l1);font-size:13px}
.sg-kv-row:last-child{border-bottom:0}
.sg-kv-key{display:flex;align-items:center;gap:9px;color:var(--dsw-alias-label-secondary)}
.sg-kv-key .sg-ic{color:var(--dsw-alias-state-idle-primary)}
.sg-kv-val{min-inline-size:0;font-weight:550;text-align:end;overflow-wrap:anywhere}

.sg-node{margin-bottom:13px}
.sg-node:last-child{margin-bottom:0}
.sg-node-top{display:flex;justify-content:space-between;gap:8px;margin-bottom:6px;font-size:12px}
.sg-node-name{font-weight:600}
.sg-node-ms{color:var(--dsw-alias-label-secondary)}
.sg-track{height:6px;border-radius:4px;background:var(--dsw-alias-bg-layer-2);overflow:hidden}
.sg-track-fill{display:block;height:100%;border-radius:4px;background:currentColor}

/* De-duplicated event rows; click to expand full message */
.sg-timeline{display:flex;flex-direction:column}
.sg-event{display:flex;align-items:center;gap:10px;width:100%;text-align:left;padding:10px 4px;font-size:12.5px;border:0;border-bottom:1px solid var(--dsw-alias-border-l1);background:transparent;color:inherit;cursor:pointer;border-radius:6px;transition:background .12s}
.sg-event:hover{background:var(--dsw-alias-bg-layer-2)}
.sg-event:last-child{border-bottom:0}
.sg-event.is-expanded{align-items:flex-start}
.sg-event.is-expanded .sg-event-dot{margin-top:5px}
.sg-event-dot{width:8px;height:8px;border-radius:50%;background:currentColor;flex:none}
.sg-event-txt{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--dsw-alias-label-primary)}
.sg-event.is-expanded .sg-event-txt{white-space:normal;overflow:visible;word-break:break-word}
.sg-event-count{flex:none;font-size:11px;font-weight:700;padding:1px 7px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary)}
.sg-event-time{flex:none;color:var(--dsw-alias-label-secondary);font-size:11px}

.sg-note{display:flex;align-items:flex-start;gap:9px;padding:12px 14px;border-radius:11px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);font-size:12px;color:var(--dsw-alias-label-secondary);line-height:1.55}
.sg-note .sg-ic{color:var(--dsw-alias-state-idle-primary);margin-top:1px}
.sg-callout{display:flex;align-items:flex-start;gap:9px;padding:12px 14px;border-radius:11px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);font-size:12px;color:var(--dsw-alias-label-secondary);line-height:1.6}
.sg-callout .sg-ic{color:var(--dsw-alias-state-idle-primary);margin-top:1px;flex:none}
.sg-notice{margin-top:12px;padding:10px 13px;border-radius:10px;font-size:12px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}
.sg-notice.is-ok{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary)}
.sg-notice.is-danger{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.sg-notice.is-warn{border-color:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-primary)}
.sg-stack>.sg-notice{margin-top:0}

/* Shared controls */
.sg-btn{display:inline-flex;align-items:center;justify-content:center;gap:7px;max-inline-size:100%;padding:7px 13px;border-radius:9px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:.8125rem;font-weight:600;text-align:center;cursor:pointer}
.sg-btn:is(:hover,:focus-visible){border-color:var(--dsw-alias-brand-primary)}
.sg-btn.primary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:var(--sg-primary-fg)}
.sg-btn.danger{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.sg-btn.sm{padding:5px 10px;font-size:.75rem}
.sg-btn:disabled,.sg-icon-btn:disabled,.sg-active-chip:disabled{opacity:.6;cursor:not-allowed}
.sg-input,.sg-select{width:100%;max-inline-size:100%;padding:8px 10px;border-radius:9px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:.875rem}
.sg-input:focus,.sg-select:focus{border-color:var(--dsw-alias-brand-primary)}
.sg-select-sm{width:auto;min-inline-size:min(7rem,100%)}
.sg-field{display:flex;flex-direction:column;gap:5px;min-width:0}
.sg-field label{font-size:.75rem;color:var(--dsw-alias-label-secondary);font-weight:600}
.sg-form-grid{display:grid;grid-template-columns:repeat(var(--sg-form-cols,2),minmax(0,1fr));gap:12px}
.sg-form-ca{margin-top:12px}
.sg-form-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:14px}
.sg-seg{display:inline-flex;gap:3px;padding:3px;border-radius:10px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);flex-wrap:wrap;max-inline-size:100%}
.sg-seg button{padding:6px 12px;border-radius:7px;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font-size:.8125rem;font-weight:600;cursor:pointer}
.sg-seg button.is-active{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);box-shadow:inset 0 -2px var(--dsw-alias-brand-primary)}
.sg-switch{inline-size:44px;block-size:44px;border-radius:9px;border:0;background:none;position:relative;cursor:pointer;flex:none;padding:0}
.sg-switch::before{content:"";position:absolute;inset:11px 3px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2)}
.sg-switch.is-on::before{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}
.sg-switch i{position:absolute;inset-block-start:14px;inset-inline-start:6px;width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-label-secondary);transition:inset-inline-start .15s}
.sg-switch.is-on i{inset-inline-start:22px;background:var(--sg-primary-fg)}
.sg-set-row{display:flex;align-items:center;justify-content:space-between;gap:8px 16px;padding:9px 0;border-bottom:1px solid var(--dsw-alias-border-l1);flex-wrap:wrap}
.sg-set-row:last-child{border-bottom:0}
.sg-set-label{font-size:.8125rem;font-weight:650}
.sg-set-desc{font-size:.75rem;color:var(--dsw-alias-label-secondary);margin-top:2px;font-weight:400;max-inline-size:38rem}
.sg-stack{display:flex;flex-direction:column;gap:var(--sg-gap)}
.sg-settings{inline-size:100%;max-inline-size:60rem;margin-inline:auto}
.sg-settings-connection{display:flex;align-items:center;justify-content:flex-end;flex-wrap:wrap;gap:8px 12px;min-inline-size:0;max-inline-size:100%}
.sg-settings-connection .sg-kv-val{min-inline-size:0;text-align:inherit;word-break:normal;overflow-wrap:anywhere}
.sg-btn,.sg-icon-btn,.sg-tab,.sg-active-chip,.sg-pop-item,.sg-dev,.sg-event,.sg-retry,.sg-seg button,.sg-input,.sg-select,.sg-diag-toggle{min-block-size:var(--sg-target)}
.sg-icon-btn{min-inline-size:var(--sg-target);flex:none}
.sg-tab,.sg-retry,.sg-seg button,.sg-diag-toggle{min-inline-size:var(--sg-target)}
.sg-retry{max-inline-size:100%;white-space:normal}
.sg-error{flex-wrap:wrap}
.sg-legend-btn,.sg-metric-link{min-block-size:var(--sg-inline-target,28px)}
.sg-root :focus-visible{outline-color:var(--sg-accent)}
.sg-pop-item:focus-visible,.sg-plot:focus-visible{outline-offset:-2px}
@media(any-pointer:coarse){.sg-inner{--sg-target:44px;--sg-inline-target:44px}.sg-input,.sg-select{font-size:1rem}}

/* Devices */
.sg-strip-item{padding:var(--sg-card-pad,16px);display:flex;flex-direction:column;gap:4px}
.sg-strip-label{font-size:.75rem;font-weight:600;color:var(--dsw-alias-label-secondary)}
.sg-strip-value{font-size:1.3125rem;font-weight:700;line-height:1.2}
.sg-metrics>:nth-child(4),.sg-strip>:nth-child(4){grid-column:span var(--sg-fourth-stat-span,var(--sg-stat-span,1))}
.sg-metrics>:nth-child(5),.sg-strip>:nth-child(5){grid-column:span var(--sg-fifth-stat-span,var(--sg-stat-span,1))}
.sg-conn-list{display:grid;grid-template-columns:repeat(var(--sg-conn-cols,2),minmax(0,1fr));gap:var(--sg-gap)}
.sg-conn-list>.sg-card{display:flex;flex-direction:column}
.sg-conn-top{display:flex;align-items:center;flex-wrap:wrap;gap:6px 9px}
.sg-conn-name{font-size:.875rem;font-weight:700;flex:1 1 6rem;min-width:0}
.sg-badge-sm{display:inline-flex;align-items:center;gap:5px;flex:none;padding:3px 9px;border-radius:999px;font-size:11px;font-weight:650;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary)}
.sg-badge-sm.is-active{color:var(--dsw-alias-state-success-primary)}
.sg-badge-sm.is-online{color:var(--dsw-alias-state-success-primary)}
.sg-badge-sm.is-offline{color:var(--dsw-alias-state-error-primary)}
.sg-badge-sm.is-warn{color:var(--dsw-alias-state-warn-primary)}
.sg-conn-meta{display:flex;flex-wrap:wrap;gap:6px 18px;margin-top:12px;font-size:.75rem}
.sg-conn-meta-item{display:flex;align-items:baseline;flex-wrap:wrap;gap:2px 6px;min-inline-size:0;color:var(--dsw-alias-label-secondary)}
.sg-conn-meta-item .sg-ic{align-self:center}
.sg-conn-meta-item b{color:var(--dsw-alias-label-primary);font-weight:600}
.sg-conn-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-block-start:auto;padding-block-start:14px}

/* Diagnostic rows stay native at wide widths and show labels on narrow cards. */
.sg-table-wrap{width:100%;min-inline-size:0;max-block-size:min(32rem,62vh);max-block-size:min(32rem,62dvh);overflow:auto;container:sg-table / inline-size}
table.sg-diag-tbl{width:100%;border-collapse:separate;border-spacing:0;font-size:.8125rem;min-inline-size:30rem}
.sg-diag-tbl thead{position:sticky;inset-block-start:0;z-index:1;background:var(--dsw-alias-bg-layer-2)}
.sg-diag-tbl th,.sg-diag-tbl td{padding:8px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);text-align:start}
.sg-diag-tbl th{color:var(--dsw-alias-label-secondary);font-weight:650}
.sg-diag-tbl td{vertical-align:middle;overflow-wrap:anywhere}
.sg-diag-tbl td[role=rowheader]{position:sticky;inset-inline-start:0;background:var(--dsw-alias-bg-layer-1)}
.sg-diag-tbl tbody tr:last-child>*{border-bottom:0}
.sg-req-target{max-inline-size:24rem;overflow-wrap:anywhere}
.sg-pill-ok{color:var(--dsw-alias-state-success-primary);font-weight:650}
.sg-pill-fail{color:var(--dsw-alias-state-error-primary);font-weight:650}
.sg-pill-warn{color:var(--dsw-alias-state-warn-primary);font-weight:650}
.sg-diag-summary{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px 12px;margin-block-end:10px}
.sg-diag-copy-status:not(:empty){margin-block:6px 10px}
.sg-diag-report{resize:vertical;margin-block-end:10px}
.sg-diag-toggle{display:inline-flex;align-items:center;gap:6px;max-inline-size:100%;padding:4px 6px;border:1px solid transparent;border-radius:7px;background:transparent;color:var(--dsw-alias-brand-primary);font-size:inherit;font-weight:650;text-align:start;cursor:pointer}
.sg-diag-toggle:hover,.sg-diag-toggle[aria-expanded=true]{background:var(--dsw-alias-bg-layer-2)}
.sg-diag-toggle[aria-expanded=true] .sg-ic{rotate:180deg}
.sg-diag-detail-body{display:grid;gap:4px;padding:10px 12px;border-radius:9px;background:var(--dsw-alias-bg-layer-2)}
.sg-diag-message{overflow-wrap:anywhere}
@container sg-table (max-width:34rem){
  table.sg-diag-tbl[role=table],.sg-diag-tbl[role=table] :is(tbody,tr,td){display:block}
  table.sg-diag-tbl[role=table]{min-inline-size:0}
  .sg-diag-tbl[role=table] thead{display:none}
  .sg-diag-tbl[role=table] tbody tr{margin-block-end:8px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px}
  .sg-diag-tbl[role=table] tbody tr:last-child{margin-block-end:0}
  .sg-diag-tbl[role=table] tbody tr>*:last-child{border-bottom:0}
  .sg-diag-tbl[role=table] tbody tr>td[data-label]{display:grid;grid-template-columns:minmax(0,2fr) minmax(0,3fr);gap:8px;align-items:center;max-inline-size:none}
  .sg-diag-tbl[role=table] td[data-label]::before{content:attr(data-label);font-family:system-ui,sans-serif;font-weight:600;color:var(--dsw-alias-label-secondary)}
  .sg-diag-tbl[role=table] td[role=rowheader]{position:static;background:var(--dsw-alias-bg-layer-2);border-radius:9px 9px 0 0}
  .sg-diag-tbl .sg-diag-detail>td{padding:4px}
}
@supports not (container-type:inline-size){
  @media(max-width:42rem){
    table.sg-diag-tbl[role=table],.sg-diag-tbl[role=table] :is(tbody,tr,td){display:block}
    table.sg-diag-tbl[role=table]{min-inline-size:0}
    .sg-diag-tbl[role=table] thead{display:none}
    .sg-diag-tbl[role=table] tbody tr{margin-block-end:8px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px}
    .sg-diag-tbl[role=table] tbody tr:last-child{margin-block-end:0}
    .sg-diag-tbl[role=table] tbody tr>*:last-child{border-bottom:0}
    .sg-diag-tbl[role=table] tbody tr>td[data-label]{display:grid;grid-template-columns:minmax(0,2fr) minmax(0,3fr);gap:8px;align-items:center;max-inline-size:none}
    .sg-diag-tbl[role=table] td[data-label]::before{content:attr(data-label);font-family:system-ui,sans-serif;font-weight:600;color:var(--dsw-alias-label-secondary)}
    .sg-diag-tbl[role=table] td[role=rowheader]{position:static;background:var(--dsw-alias-bg-layer-2);border-radius:9px 9px 0 0}
    .sg-diag-tbl .sg-diag-detail>td{padding:4px}
  }
}

/* The native dialog occupies the top layer and keeps its own scroll region. */
.sg-detail-drawer{
  position:fixed;inset:0 0 0 auto;margin:0;padding:0;
  inline-size:min(100%,36rem);max-inline-size:none;block-size:100%;max-block-size:none;
  border:0;border-inline-start:1px solid var(--dsw-alias-border-l2);
  background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);
  box-shadow:0 0 32px rgba(0,0,0,.22);overflow:auto;overscroll-behavior:contain;
  --sg-drawer-pad:20px;--sg-target:44px;
}
.sg-detail-drawer[open]{display:flex;flex-direction:column}
.sg-detail-drawer::backdrop{background:rgba(0,0,0,.48);overflow:hidden;overscroll-behavior:contain}
.sg-detail-head,.sg-detail-tools,.sg-detail-body,.sg-detail-pages{padding-inline:var(--sg-drawer-pad);min-inline-size:0}
.sg-detail-head{display:flex;justify-content:space-between;align-items:flex-start;gap:10px;padding-block:16px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.sg-detail-head h2{font-size:1.25rem;line-height:1.3;margin:0;font-weight:700}
.sg-detail-head p{margin:4px 0 0}
.sg-detail-head .sg-icon-btn{font-size:1.25rem;line-height:1}
.sg-detail-tools{display:flex;align-items:center;flex-wrap:wrap;gap:8px;padding-block:10px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.sg-detail-tools .sg-input{flex:1 1 12rem;min-inline-size:0}
.sg-detail-tools .sg-select{flex:0 1 auto}
.sg-detail-body{flex:1;min-block-size:6rem;overflow:auto;overscroll-behavior:contain;padding-block:12px 16px;display:flex;flex-direction:column;gap:10px}
.sg-detail-body>.sg-notice,.sg-detail-body>p{margin:0}
.sg-detail-item{border:1px solid var(--dsw-alias-border-l1);border-radius:12px;padding:12px;background:var(--dsw-alias-bg-base)}
.sg-detail-item h3{margin:0;font-size:.9375rem;line-height:1.35;font-weight:700}
.sg-detail-item>.sg-btn{margin-block-start:10px}
.sg-detail-fields{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,2fr);gap:6px 10px;margin:8px 0 0;font-size:.8125rem}
.sg-detail-fields dt{color:var(--dsw-alias-label-secondary)}
.sg-detail-fields dd{margin:0;min-inline-size:0;overflow-wrap:anywhere;white-space:pre-wrap}
.sg-detail-pages{display:flex;align-items:center;justify-content:flex-end;gap:8px 12px;flex-wrap:wrap;padding-block:10px;border-top:1px solid var(--dsw-alias-border-l1)}
.sg-detail-pages:empty{display:none}
.sg-detail-pages [role=status]{margin-inline-end:auto}
@media(max-width:42rem){
  .sg-detail-drawer{
    inset:auto 0 0;inline-size:100%;block-size:min(88vh,44rem);block-size:min(88dvh,44rem);
    border:0;border-block-start:1px solid var(--dsw-alias-border-l2);border-radius:16px 16px 0 0;
    padding-block-end:env(safe-area-inset-bottom);--sg-drawer-pad:14px;
  }
  .sg-detail-tools .sg-input,.sg-detail-tools .sg-select{font-size:1rem}
}

/* Panel breakpoints follow available space in the host. */
@container sg-panel (min-width:65.001rem){
  .sg-inner{--sg-edge:28px;--sg-gap:16px;--sg-card-pad:20px;padding-block-start:28px}
}
@container sg-panel (max-width:65rem){
  .sg-inner{--sg-stat-columns:6;--sg-stat-span:2;--sg-fourth-stat-span:3;--sg-fifth-stat-span:3;--sg-bottom-cols:2;--sg-bottom-last:1 / -1}
}
@container sg-panel (max-width:54rem){.sg-inner{--sg-main-cols:minmax(0,1fr)}}
@container sg-panel (max-width:42rem){
  .sg-inner{--sg-stat-columns:2;--sg-stat-span:1;--sg-fourth-stat-span:1;--sg-fifth-stat-span:2;--sg-bottom-cols:1;--sg-conn-cols:1;--sg-form-cols:1;--sg-edge:12px;--sg-gap:12px;--sg-card-pad:13px;--sg-target:44px;--sg-inline-target:44px;--sg-axis-width:46px;padding-block-start:16px}
  .sg-tabbar{gap:8px;margin-block:14px 16px}
  .sg-tabs,.sg-switcher{inline-size:100%}
  .sg-tab{flex:1;min-inline-size:0;padding-inline:7px}
  .sg-tabbar-sp{display:none}
  .sg-active-chip{inline-size:100%;border-radius:10px}
  .sg-popover{max-inline-size:100%}
  .sg-input,.sg-select{font-size:1rem}
  .sg-settings-connection{justify-content:flex-start;text-align:start}
}
@container sg-panel (max-width:19rem){
  .sg-inner{--sg-stat-columns:1;--sg-fifth-stat-span:1}
  .sg-tab{flex-basis:100%}
}
@supports not (container-type:inline-size){
  @media(min-width:65.001rem){.sg-inner{--sg-edge:28px;--sg-gap:16px;--sg-card-pad:20px;padding-block-start:28px}}
  @media(max-width:65rem){.sg-inner{--sg-stat-columns:6;--sg-stat-span:2;--sg-fourth-stat-span:3;--sg-fifth-stat-span:3;--sg-bottom-cols:2;--sg-bottom-last:1 / -1}}
  @media(max-width:54rem){.sg-inner{--sg-main-cols:minmax(0,1fr)}}
  @media(max-width:42rem){
    .sg-inner{--sg-stat-columns:2;--sg-stat-span:1;--sg-fourth-stat-span:1;--sg-fifth-stat-span:2;--sg-bottom-cols:1;--sg-conn-cols:1;--sg-form-cols:1;--sg-edge:12px;--sg-gap:12px;--sg-card-pad:13px;--sg-target:44px;--sg-inline-target:44px;--sg-axis-width:46px;padding-block-start:16px}
    .sg-tabbar{gap:8px;margin-block:14px 16px}
    .sg-tabs,.sg-switcher{inline-size:100%}
    .sg-tab{flex:1;min-inline-size:0;padding-inline:7px}
    .sg-tabbar-sp{display:none}
    .sg-active-chip{inline-size:100%;border-radius:10px}
    .sg-popover{max-inline-size:100%}
    .sg-input,.sg-select{font-size:1rem}
    .sg-settings-connection{justify-content:flex-start;text-align:start}
    .sg-xaxis .sg-tick-odd:not(.sg-tick-edge){display:none}
  }
  @media(max-width:19rem){
    .sg-inner{--sg-stat-columns:1;--sg-fifth-stat-span:1}
    .sg-tab{flex-basis:100%}
    .sg-xaxis .sg-tick:not(.sg-tick-edge):not(:first-child):not(:last-child){display:none}
  }
}
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
        function connName(c) {
          if (!c) return '';
          return (c.local || c.isLocal || c.id === 'local') ? t('dm.localName') : c.name;
        }
        function tEndpoint(name) {
          const k = 'ep.' + name;
          const v = t(k);
          return v === k ? name : v;
        }
        function tCode(obj, fallbackKey) {
          if (!obj) return fallbackKey ? t(fallbackKey) : '';
          const code = obj.code;
          if (code === 'PARTIAL_DATA' && Array.isArray(obj.missing) && obj.missing.length) {
            return obj.missing.map(function (ep) { return tEndpoint(ep) + ' · ' + t('status.unavailable'); }).join(t('sep'));
          }
          if (code === 'TEST_OK') return t('dm.test.ok');
          if (code === 'TEST_FAILED') return obj.detail ? t('dm.test.fail') + ' · ' + obj.detail : t('dm.test.fail');
          if (code) {
            const k = 'err.' + code;
            const localized = t(k);
            if (localized && localized !== k) {
              return obj.detail ? localized + ' · ' + obj.detail : localized;
            }
          }
          return obj.message || (fallbackKey ? t(fallbackKey) : '');
        }
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
        function AreaChart(props) {
          const chart = props.chart, showDown = props.showDown, showUp = props.showUp;
          const [hoverIdx, setHoverIdx] = useState(-1);
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
          const pickPointerSample = function (e) {
            if (!n || !e.isPrimary) return;
            const rect = e.currentTarget.getBoundingClientRect();
            if (!rect.width) return;
            const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
            setHoverIdx(Math.round(ratio * (n - 1)));
          };
          const hi = n && hoverIdx >= 0 ? Math.min(hoverIdx, n - 1) : -1;
          const onKey = function (e) {
            let next;
            switch (e.key) {
              case 'ArrowLeft':
              case 'ArrowDown': next = Math.max(0, hi - 1); break;
              case 'ArrowRight':
              case 'ArrowUp': next = Math.min(n - 1, hi + 1); break;
              case 'Home': next = 0; break;
              case 'End': next = n - 1; break;
              case 'Escape':
                if (hi < 0) return;
                e.stopPropagation();
                next = -1;
                break;
              default: return;
            }
            e.preventDefault();
            setHoverIdx(next);
          };
          const sampleIdx = Math.max(0, hi);
          const sampleText = n ? [
            chart.labels[sampleIdx],
            showDown ? t('chart.down') + ' ' + fmtBytesStr(chart.down[sampleIdx], true) : '',
            showUp ? t('chart.up') + ' ' + fmtBytesStr(chart.up[sampleIdx], true) : ''
          ].filter(Boolean).join(', ') : undefined;
          const hiPct = X(sampleIdx) / W * 100;
          const preferredLeft = hiPct > 50
            ? 'calc(' + hiPct + '% - var(--sg-tip-width) - 10px)'
            : 'calc(' + hiPct + '% + 10px)';
          const tipStyle = {
            '--sg-tip-width': 'min(158px, calc(100% - 16px))',
            left: 'clamp(8px, ' + preferredLeft + ', calc(100% - var(--sg-tip-width) - 8px))'
          };
          const ticks = tickLabels(chart.labels, 6);
          return h('div', { className: 'sg-chart' },
            h('div', { className: 'sg-chart-wrap' },
              h('div', { className: 'sg-yaxis sg-mono', 'aria-hidden': true },
                h('span', null, fmtBytesStr(MAX, true)),
                h('span', null, fmtBytesStr(MAX / 2, true)),
                h('span', null, '0 B/s')),
              h('div', {
                className: 'sg-plot',
                role: n ? 'slider' : undefined,
                tabIndex: n ? 0 : undefined,
                'aria-label': n ? t('chart.title') : undefined,
                'aria-description': n ? t('chart.keyboard') : undefined,
                'aria-valuemin': n ? 1 : undefined,
                'aria-valuemax': n || undefined,
                'aria-valuenow': n ? sampleIdx + 1 : undefined,
                'aria-valuetext': sampleText,
                onFocus: n ? function () { setHoverIdx(function (i) { return Math.max(0, i); }); } : undefined,
                onBlur: function () { setHoverIdx(-1); },
                onKeyDown: n ? onKey : undefined,
                onPointerDown: function (e) {
                  if (n && e.isPrimary && e.pointerType !== 'mouse') e.currentTarget.focus({ preventScroll: true });
                  pickPointerSample(e);
                },
                onPointerMove: function (e) {
                  if (e.pointerType === 'mouse' || e.buttons > 0) pickPointerSample(e);
                },
                onPointerLeave: function (e) {
                  if (e.pointerType === 'mouse' && !e.currentTarget.matches(':focus-visible')) setHoverIdx(-1);
                },
                onPointerCancel: function (e) { if (e.isPrimary) setHoverIdx(-1); }
              },
                h('svg', { viewBox: '0 0 ' + W + ' ' + H, preserveAspectRatio: 'none', className: 'sg-chart-svg', 'aria-hidden': true },
                  grids,
                  showDown ? h('path', { key: 'ad', d: area(chart.down), className: 'sg-area-down' }) : null,
                  showUp ? h('path', { key: 'au', d: area(chart.up), className: 'sg-area-up' }) : null,
                  showDown ? h('path', { key: 'ld', d: line(chart.down), className: 'sg-line sg-line-down' }) : null,
                  showUp ? h('path', { key: 'lu', d: line(chart.up), className: 'sg-line sg-line-up' }) : null),
                hi >= 0 ? h('div', { className: 'sg-crosshair', style: { left: hiPct + '%' } }) : null,
                hi >= 0 && showDown ? h('div', { className: 'sg-hover-dot is-down', style: { left: hiPct + '%', top: (Y(chart.down[hi]) / H * 100) + '%' } }) : null,
                hi >= 0 && showUp ? h('div', { className: 'sg-hover-dot is-up', style: { left: hiPct + '%', top: (Y(chart.up[hi]) / H * 100) + '%' } }) : null,
                hi >= 0 ? h('div', { className: 'sg-tooltip sg-mono', style: tipStyle, 'aria-hidden': true },
                  h('div', { className: 'sg-sub' }, chart.labels[hi] || ''),
                  showDown ? h('div', { className: 'sg-tip-row' },
                    h('span', { className: 'sg-tip-lbl sg-tone-brand' }, h('span', { className: 'sg-legend-dot' }), t('chart.down')),
                    h('b', null, fmtBytesStr(chart.down[hi], true))) : null,
                  showUp ? h('div', { className: 'sg-tip-row' },
                    h('span', { className: 'sg-tip-lbl sg-tone-success' }, h('span', { className: 'sg-legend-dot' }), t('chart.up')),
                    h('b', null, fmtBytesStr(chart.up[hi], true))) : null) : null)),
            h('div', { className: 'sg-xaxis' }, ticks.map(function (tick, i) {
              const edge = i === 0 || i === ticks.length - 1;
              return h('span', { key: i, className: 'sg-mono sg-tick' + (edge ? ' sg-tick-edge' : tick.odd ? ' sg-tick-odd' : '') }, tick.label);
            })),
            h('div', { className: 'sg-chart-foot' },
              h('span', { className: 'sg-sub' }, t('chart.sampled')),
              h('span', { className: 'sg-mono sg-sub' }, t('chart.peak') + ' ' + fmtBytesStr(chart.max || 0, true))));
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
            o.spark && o.spark.length > 1 ? Sparkline(o.spark, o.tone) : null,
            o.foot ? h('div', { className: 'sg-spark-ph' }, o.foot) : null);
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
            type: o.submit ? 'submit' : 'button',
            className: 'sg-btn' + (o.primary ? ' primary' : '') + (o.danger ? ' danger' : '') + (o.sm ? ' sm' : ''),
            disabled: !!o.disabled, onClick: o.onClick, title: o.title || undefined
          }, o.icon ? I(o.icon, 14) : null, o.label);
        }
        function Seg(value, opts, onChange, ariaLabel) {
          return h('div', { className: 'sg-seg', role: 'group', 'aria-label': ariaLabel || undefined }, opts.map(function (o) {
            const active = value === o.v;
            return h('button', {
              key: o.v, type: 'button',
              className: active ? 'is-active' : '',
              'aria-pressed': active ? 'true' : 'false',
              onClick: function () { onChange(o.v); }
            }, t(o.l));
          }));
        }
        function Switch(on, onChange, labelledBy) {
          return h('button', {
            type: 'button', role: 'switch',
            'aria-checked': on ? 'true' : 'false',
            'aria-labelledby': labelledBy || undefined,
            className: 'sg-switch' + (on ? ' is-on' : ''), onClick: function () { onChange(!on); }
          }, h('i', null));
        }
        function Select(value, opts, onChange, labelledBy) {
          return h('select', {
            className: 'sg-select sg-select-sm', value: String(value),
            'aria-labelledby': labelledBy || undefined,
            onChange: function (e) { onChange(e.target.value); }
          }, opts.map(function (o) { return h('option', { key: String(o.v), value: String(o.v) }, o.l); }));
        }
        function SetRow(labelKey, descKey, renderControl) {
          const labelId = 'sg-set-' + labelKey.replace(/[^a-zA-Z0-9_-]/g, '-');
          return h('div', { className: 'sg-set-row' },
            h('div', null,
              h('div', { className: 'sg-set-label', id: labelId }, t(labelKey)),
              descKey ? h('div', { className: 'sg-set-desc' }, t(descKey)) : null),
            typeof renderControl === 'function' ? renderControl(labelId) : renderControl);
        }

        const detailTitles = {
          rules: 'ep.rules', policies: 'ep.policies', modules: 'ep.modules', dns: 'ep.dns', requests: 'requests.title',
          devices: 'devices.title', nodes: 'quality.title', events: 'events.title', interfaces: 'detail.interfaces', profile: 'ep.profile'
        };
        const detailFilters = {
          policies: ['group', 'proxy'], modules: ['enabled', 'disabled'], requests: ['failed', 'active', 'completed'],
          events: ['error', 'warn', 'brand', 'idle']
        };

        function detailValue(key, value) {
          if (typeof value === 'boolean') return t('detail.' + (value ? 'yes' : 'no'));
          if (typeof value !== 'number') return value || '—';
          if (key === 'inBytes' || key === 'outBytes') return fmtBytesStr(value, false);
          if (key === 'inSpeed' || key === 'outSpeed') return fmtBytesStr(value, true);
          if (key === 'rtt') return value + ' ms';
          if (key === 'timestamp' || key === 'startDate' || key === 'checkedAt') {
            const date = new Date(value < 1e12 ? value * 1000 : value);
            return isNaN(date.getTime()) ? '—' : date.toLocaleString();
          }
          return String(value);
        }

        function DetailDrawer({ detail, onClose }) {
          const dialogRef = useRef(null);
          const [query, setQuery] = useState('');
          const [filter, setFilter] = useState(detail.filter || 'all');
          const [offset, setOffset] = useState(0);
          const [previousOffsets, setPreviousOffsets] = useState([]);
          const [reload, setReload] = useState(0);
          const [result, setResult] = useState(null);
          const [copyStatus, setCopyStatus] = useState('');
          const title = detail.title || t(detailTitles[detail.kind]);
          const localItems = detail.items;
          const limit = 25;
          const requestKey = JSON.stringify([query, filter, offset, reload]);
          const current = result && result.key === requestKey ? result : null;
          const body = current && current.body;
          const rows = localItems || (body && body.items) || [];

          useEffect(function () {
            const dialog = dialogRef.current;
            const scroller = dialog ? dialog.closest('.sg-root') : null;
            const originalOverflow = scroller ? scroller.style.overflowY : '';
            if (dialog) dialog.showModal();
            if (scroller) scroller.style.overflowY = 'hidden';
            return function () {
              if (scroller) scroller.style.overflowY = originalOverflow;
              if (dialog && dialog.open) dialog.close();
              if (detail.trigger && detail.trigger.isConnected) detail.trigger.focus({ preventScroll: true });
            };
          }, []);

          useEffect(function () {
            if (localItems) return;
            const controller = new AbortController();
            const params = new URLSearchParams({ kind: detail.kind, offset, limit });
            if (query.trim()) params.set('q', query.trim());
            if (filter !== 'all') params.set('filter', filter);
            if (detail.id != null) params.set('id', detail.id);
            if (detail.connectionId) params.set('connectionId', detail.connectionId);
            if (detail.revision != null) params.set('revision', detail.revision);
            const timer = setTimeout(function () {
              api('/surge-api/detail?' + params, { signal: controller.signal }).then(function (response) {
                if (!controller.signal.aborted) setResult({ key: requestKey, body: response });
              }).catch(function (error) {
                if (!controller.signal.aborted) setResult({ key: requestKey, body: { ok: false, message: error.message } });
              });
            }, query ? 180 : 0);
            return function () { clearTimeout(timer); controller.abort(); };
          }, [requestKey]);

          const changeOffset = function (next) {
            setOffset(next);
            dialogRef.current.querySelector('.sg-detail-body').scrollTop = 0;
          };
          const renderItem = function (row, index) {
            const fields = Object.entries(row.fields || {});
            const copyText = row.copyText || [row.title].concat(fields.map(function ([key, value]) {
              return t('detail.' + key) + ' · ' + detailValue(key, value);
            })).join('\n');
            return h('article', { className: 'sg-detail-item', key: String(row.id) + ':' + index },
              h('h3', null, row.title),
              fields.length ? h('dl', { className: 'sg-detail-fields' }, fields.map(function ([key, value]) {
                const label = t('detail.' + key);
                return h(React.Fragment, { key }, h('dt', null, label === 'detail.' + key ? key : label), h('dd', null, detailValue(key, value)));
              })) : null,
              row.action || null,
              detail.id != null || localItems || detail.kind === 'requests' ? Btn({ label: t('detail.copy'), sm: true, onClick: async function () {
                try { await navigator.clipboard.writeText(copyText); setCopyStatus('copied'); }
                catch { setCopyStatus('copyError'); }
              } }) : null);
          };

          const options = detail.id == null && detailFilters[detail.kind];
          return h('dialog', {
            ref: dialogRef, className: 'sg-detail-drawer', 'aria-labelledby': 'sg-detail-title',
            onCancel: function (e) { e.preventDefault(); onClose(); },
            onClick: function (e) {
              if (e.target !== e.currentTarget) return;
              const rect = e.currentTarget.getBoundingClientRect();
              if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) onClose();
            }
          },
            h('header', { className: 'sg-detail-head' },
              h('div', null, h('h2', { id: 'sg-detail-title' }, title), detail.subtitle ? h('p', { className: 'sg-sub' }, detail.subtitle) : null),
              h('button', { type: 'button', className: 'sg-icon-btn', 'aria-label': t('detail.close'), onClick: onClose }, '×')),
            !localItems && detail.id == null && detail.kind !== 'profile' ? h('div', { className: 'sg-detail-tools' },
              h('input', { type: 'search', className: 'sg-input', placeholder: t('detail.search'), 'aria-label': t('detail.search'), value: query, maxLength: 120,
                onChange: function (e) { setQuery(e.target.value); setPreviousOffsets([]); changeOffset(0); } }),
              options ? h('select', { className: 'sg-select sg-select-sm', 'aria-label': t('detail.filter'), value: filter, onChange: function (e) { setFilter(e.target.value); setPreviousOffsets([]); changeOffset(0); } },
                ['all'].concat(options).map(function (value) { return h('option', { key: value, value }, t('detail.' + value)); })) : null) : null,
            h('div', { className: 'sg-detail-body', 'aria-busy': !localItems && !current },
              !localItems && !current ? h('p', { role: 'status' }, t('st.loading')) : null,
              body && !body.ok ? h('div', { className: 'sg-notice is-danger', role: 'alert' }, tCode(body, 'status.unavailable'), ' ',
                Btn({ label: t('action.retry'), sm: true, onClick: function () { setReload(reload + 1); } })) : null,
              body && body.stale ? h('div', { className: 'sg-notice is-warn', role: 'status' }, t('status.stale'), body.updatedAt ? ' · ' + fmtTime(new Date(body.updatedAt)) : '') : null,
              (localItems || (body && body.ok)) && !rows.length ? h('p', null, t('detail.empty')) : null,
              rows.map(renderItem)),
            h('div', { className: 'sg-detail-pages' },
              copyStatus ? h('span', { role: 'status', className: 'sg-sub' }, t('detail.' + copyStatus)) : null,
              body && body.ok && (offset > 0 || body.total > rows.length) ? h(React.Fragment, null,
                Btn({ label: t('detail.previous'), sm: true, disabled: previousOffsets.length === 0, onClick: function () {
                  changeOffset(previousOffsets[previousOffsets.length - 1]);
                  setPreviousOffsets(previousOffsets.slice(0, -1));
                } }),
                h('span', { className: 'sg-sub' }, (rows.length ? offset + 1 : 0) + '–' + (rows.length ? offset + rows.length : 0) + ' / ' + body.total),
                Btn({ label: t('detail.next'), sm: true, disabled: !rows.length || offset + rows.length >= body.total, onClick: function () {
                  setPreviousOffsets(previousOffsets.concat(offset));
                  changeOffset(offset + rows.length);
                } })) : null));
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
         * OVERVIEW — live dashboard with interactive chart, sorted devices,
         * expandable events and collapsible recent/failed request details.
         * ================================================================ */
        function Overview(props) {
          const ui = props.ui;
          const detailButton = function (kind, label, options) {
            const text = label || t('detail.open');
            return h('button', { type: 'button', className: 'sg-metric-link', 'aria-haspopup': 'dialog',
              'aria-label': t(detailTitles[kind]) + ' · ' + text,
              onClick: function (e) { props.openDetail(kind, e.currentTarget, options); } }, text, I('chevronDown', 12));
          };
          const [expandedEvents, setExpandedEvents] = useState({});
          const [showRequests, setShowRequests] = useState(false);
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
              return tEndpoint(name) + ' · ' + (endpoint.stale ? t('status.stale') + ' ' + fmtTime(new Date(endpoint.updatedAt)) : t('status.unavailable'));
            }).join(t('sep')));
          };
          const buf = store.buffers();
          const N = p.samplePoints;
          const downArr = buf.down.slice(-N);
          const upArr = buf.up.slice(-N);
          const labArr = buf.labels.slice(-N);
          const visibleVals = [1];
          if (ui.showDown) visibleVals.push.apply(visibleVals, downArr);
          if (ui.showUp) visibleVals.push.apply(visibleVals, upArr);
          const maxV = Math.max.apply(null, visibleVals);

          const recentReqs = (s && s.recentRequests) || [];
          const d = s ? fmtBytes(s.down, true) : { value: '—', unit: '' };
          const u = s ? fmtBytes(s.up, true) : { value: '—', unit: '' };
          const sess = s ? fmtBytes(s.session, false) : { value: '—', unit: '' };
          const reqFoot = s
            ? h('button', {
                type: 'button', className: 'sg-metric-link',
                'aria-expanded': showRequests ? 'true' : 'false',
                onClick: function () { setShowRequests(function (v) { return !v; }); }
              }, t(showRequests ? 'requests.hide' : 'requests.show'))
            : null;
          const metrics = [
            { label: 'metrics.download', value: d.value, unit: d.unit, icon: 'download', tone: 'sg-tone-brand', spark: downArr, foot: detailButton('interfaces', t('detail.interfaces')) },
            { label: 'metrics.upload', value: u.value, unit: u.unit, icon: 'upload', tone: 'sg-tone-success', spark: upArr, foot: detailButton('interfaces', t('detail.interfaces')) },
            { label: 'metrics.session', value: sess.value, unit: sess.unit, icon: 'activity', tone: 'sg-tone-idle', spark: [], foot: detailButton('interfaces', t('detail.interfaces')) },
            { label: 'metrics.uptime', value: s && s.uptime != null ? fmtUptime(s.uptime, t) : '—', unit: '', icon: 'clock', tone: 'sg-tone-warn', spark: [] },
            { label: 'metrics.conns', value: count('requests', s && s.conns), unit: '', icon: 'link', tone: 'sg-tone-brand', sub: available('requests') ? (s.connsFailed + ' ' + t('metrics.failed')) : '', spark: [], foot: reqFoot }
          ];

          const devices = ((s && s.devices) || []).slice(0, p.maxDevices);
          const nodes = (s && s.nodes) || [];
          const merged = mergeEvents((s && s.events) || []).slice(0, p.maxEvents);
          const selDevice = devices.length
            ? (devices.find(function (dv) { return dv.key === ui.selectedKey; }) || devices[0])
            : null;
          const counts = (s && s.counts) || {};
          const onRefresh = function () { store.fetch(); };
          const active = state.activeConnection || (s && s.activeConnection);
          const errMsg = tCode({ code: state.errorCode, detail: state.errorDetail, message: state.error });

          const toggleEvent = function (key) {
            setExpandedEvents(function (prev) {
              const next = Object.assign({}, prev);
              next[key] = !next[key];
              return next;
            });
          };

          return h('div', { className: 'sg-stack' },
            state.status === 'error'
              ? h('div', { className: 'sg-error', role: 'alert' },
                  I('info', 16),
                  h('span', { className: 'sg-error-txt' }, t('status.error') + ' · ' + errMsg + (state.updated ? ' · ' + t('status.stale') + ' ' + fmtTime(state.updated) : '')),
                  h('button', { type: 'button', className: 'sg-retry', onClick: onRefresh }, t('action.retry')))
              : h('div', { className: 'sg-livebar' },
                  h('span', { className: 'sg-dot-live' + (state.status === 'ok' && !p.paused ? ' is-live' : '') }),
                  h('span', { className: 'sg-live-txt' }, p.paused ? t('status.paused') : state.status === 'loading' ? t('status.loading') : t('status.online')),
                  active ? h('span', { className: 'sg-sub' }, t('status.via') + ' · ' + connName(active)) : null,
                  h('span', { className: 'sg-live-sp' }),
                  state.updated ? h('span', { className: 'sg-sub sg-mono' }, t('status.updated') + ' ' + fmtTime(state.updated)) : null),

            h('div', { className: 'sg-metrics' }, metrics.map(function (m, i) {
              return h(MetricCard, Object.assign({ key: i }, m));
            })),

            showRequests
              ? h('div', { className: 'sg-card' },
                  h('div', { className: 'sg-card-h' },
                    h('h2', { className: 'sg-card-t' }, I('link', 16), t('requests.title')),
                    h('div', { className: 'sg-h-actions' }, detailButton('requests', t('detail.all')),
                       Btn({ label: t('requests.hide'), sm: true, onClick: function () { setShowRequests(false); } }))),
                  recentReqs.length
                    ? h('div', { className: 'sg-table-wrap', role: 'region', tabIndex: 0, 'aria-label': t('requests.title') },
                        h('table', { className: 'sg-diag-tbl', role: 'table' },
                          h('thead', { role: 'rowgroup' }, h('tr', { role: 'row' },
                            h('th', { role: 'columnheader', scope: 'col' }, t('requests.target')),
                            h('th', { role: 'columnheader', scope: 'col' }, t('requests.policy')),
                            h('th', { role: 'columnheader', scope: 'col' }, t('requests.status')),
                            h('th', { role: 'columnheader', scope: 'col' }, t('requests.traffic')))),
                          h('tbody', { role: 'rowgroup' }, recentReqs.map(function (rq) {
                            const cls = rq.failed ? 'sg-pill-fail' : (!rq.completed ? 'sg-pill-warn' : 'sg-pill-ok');
                            const stText = rq.failed ? t('requests.failed') : (!rq.completed ? t('requests.active') : t('requests.done'));
                            return h('tr', { key: rq.id, role: 'row' },
                              h('td', { role: 'cell', className: 'sg-mono', 'data-label': t('requests.target') }, detailButton('requests', rq.target, { id: rq.id })),
                              h('td', { role: 'cell', 'data-label': t('requests.policy') }, rq.policy || '—'),
                              h('td', { role: 'cell', 'data-label': t('requests.status') }, h('span', { className: cls }, stText + (rq.status ? ' · ' + rq.status : ''))),
                              h('td', { role: 'cell', className: 'sg-mono', 'data-label': t('requests.traffic') }, fmtBytesStr((rq.inBytes || 0) + (rq.outBytes || 0), false)));
                          }))))
                    : h('div', { className: 'sg-sub' }, t(available('requests') ? 'requests.empty' : 'status.unavailable')))
              : null,

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
                    ? h(AreaChart, { chart: { down: downArr, up: upArr, labels: labArr, max: maxV }, showDown: ui.showDown, showUp: ui.showUp })
                    : h('div', { className: 'sg-empty' }, t('chart.empty'))),

              h('div', { className: 'sg-card' },
                h('div', { className: 'sg-card-h' },
                  h('h2', { className: 'sg-card-t' }, I('wifi', 16), t('devices.title')),
                  detailButton('devices', t('detail.all') + ' · ' + count('devices', s && s.devicesCount) + ' ' + t('devices.online'))),
                devices.length
                  ? h('div', { className: 'sg-dev-list' }, devices.map(function (dv) {
                      const isSel = selDevice && selDevice.key === dv.key;
                      const isHot = (dv.speed || 0) > 0;
                      return h('button', {
                        key: dv.key, type: 'button',
                        className: 'sg-dev' + (isSel ? ' is-sel' : ''),
                        'aria-pressed': isSel ? 'true' : 'false',
                        onClick: function () { ui.setSelectedKey(dv.key); }
                      },
                        h('span', { className: 'sg-dev-dot' + (isHot ? ' is-hot' : '') }),
                        h('span', { className: 'sg-dev-ico' }, I(dv.icon, 16)),
                        h('span', { className: 'sg-dev-main' },
                          h('span', { className: 'sg-dev-name' }, dv.name),
                          h('span', { className: 'sg-dev-sub sg-mono' }, dv.ip)),
                        h('span', { className: 'sg-dev-right' },
                          h('span', { className: 'sg-dev-speed sg-mono' + (isHot ? ' is-hot' : '') },
                            isHot ? fmtBytesStr(dv.speed, true) : fmtBytesStr(dv.bytes || 0, false)),
                          h('span', { className: 'sg-dev-bar', title: t('devices.barTitle') },
                            h('span', { className: 'sg-dev-bar-fill', style: { width: Math.max(4, dv.load * 100) + '%' } }))));
                    }))
                  : h('div', { className: 'sg-empty' }, available('devices') ? t('devices.empty') : t('status.unavailable')),
                endpointHint(['devices']),
                selDevice
                  ? h('div', { className: 'sg-dev-foot' },
                      h('span', { className: 'sg-sub' }, selDevice.name),
                      h('span', { className: 'sg-sub' },
                        t('devices.throughput') + ' ',
                        h('b', { className: 'sg-mono' }, fmtBytesStr(selDevice.speed, true)),
                        ' · ',
                        t('devices.sessionTotal') + ' ',
                        h('b', { className: 'sg-mono' }, fmtBytesStr(selDevice.bytes || 0, false))),
                       detailButton('devices', t('detail.open'), { id: selDevice.key }))
                  : null)),

            h('div', { className: 'sg-bottom-grid' },
              h('div', { className: 'sg-card' },
                h('div', { className: 'sg-card-h' }, h('h2', { className: 'sg-card-t' }, I('globe', 16), t('network.title'))),
                h('div', { className: 'sg-kv' },
                  kv('server', 'network.mode', available('outbound') ? (s.mode || '—') : '—', false),
                  detailButton('profile', t('network.profile') + ' · ' + (available('profile') ? s.profile : '—')),
                  kv('globe', 'network.port', s ? String(s.apiPort) : '—', true),
                  detailButton('rules', t('ep.rules') + ' · ' + count('rules', counts.rules)),
                   detailButton('policies', t('ep.policies') + ' · ' + count('policies', counts.groups)),
                  detailButton('modules', t('ep.modules') + ' · ' + count('modules', counts.modules)),
                   detailButton('dns', t('ep.dns') + ' · ' + count('dns', counts.dns))),
                endpointHint(['outbound', 'profile', 'rules', 'policies', 'modules', 'dns'])),

              h('div', { className: 'sg-card' },
                h('div', { className: 'sg-card-h' },
                  h('h2', { className: 'sg-card-t' }, I('radio', 16), t('quality.title')),
                  detailButton('nodes', t('detail.all'))),
                nodes.length
                  ? nodes.map(function (node, i) {
                      return h('div', { key: node.name || i, className: 'sg-node' },
                        h('div', { className: 'sg-node-top' },
                          h('span', { className: 'sg-node-name' }, detailButton('nodes', node.name, { id: node.name })),
                          h('span', { className: 'sg-node-ms sg-mono' }, fmtBytesStr(node.bytes, false), ' · ', fmtBytesStr(node.speed, true))),
                        h('div', { className: 'sg-track' },
                          h('span', { className: 'sg-track-fill ' + (node.name === 'DIRECT' ? 'sg-tone-idle' : 'sg-tone-brand'), style: { width: Math.max(3, node.share) + '%' } })));
                    })
                  : h('div', { className: 'sg-empty' }, s ? t('quality.empty') : t('status.unavailable'))),

              h('div', { className: 'sg-card' },
                h('div', { className: 'sg-card-h' }, h('h2', { className: 'sg-card-t' }, I('clock', 16), t('events.title')), detailButton('events', t('detail.all'))),
                merged.length
                  ? h('div', { className: 'sg-timeline' }, merged.map(function (ev) {
                      const open = !!expandedEvents[ev.key];
                      return h('button', {
                        key: ev.key, type: 'button',
                        className: 'sg-event' + (open ? ' is-expanded' : ''),
                        title: t('events.toggleHint'),
                        'aria-expanded': open ? 'true' : 'false',
                        onClick: function () { toggleEvent(ev.key); }
                      },
                        h('span', { className: 'sg-event-dot ' + toneOf(ev.tone) }),
                        h('span', { className: 'sg-event-txt' }, ev.text),
                        ev.count > 1 ? h('span', { className: 'sg-event-count sg-mono' }, '×' + ev.count) : null,
                        h('span', { className: 'sg-event-time sg-mono' }, ev.time), I('chevronDown', 12));
                    }))
                  : h('div', { className: 'sg-empty' }, available('events') ? t('events.empty') : t('status.unavailable')),
                endpointHint(['events']))),

            h('div', { className: 'sg-note' }, I('info', 16), h('span', null, t('note')))
          );
        }

        /* ================================================================ *
         * DEVICES — multi-instance management + Fleet summary.
         * ================================================================ */
        function DevicesPanel(props) {
          const onConnectionsChanged = props && props.onConnectionsChanged;
          const [data, setData] = useState({ connections: [], activeId: 'local', loading: true, error: '' });
          const [fleet, setFleet] = useState({ fleet: [], totals: { online: 0, total: 0, down: 0, up: 0, conns: 0 }, loading: true, error: '', updated: null });
          const [fleetFilter, setFleetFilter] = useState('all');
          const [form, setForm] = useState(null);
          const [formError, setFormError] = useState('');
          const [busy, setBusy] = useState('');
          const [notice, setNotice] = useState(null);
          const [confirmId, setConfirmId] = useState('');
          const [testResult, setTestResult] = useState(null);

          const requests = useRef({ controller: new AbortController(), connSeq: 0, fleetSeq: 0, busy: false });
          const loadConns = function () {
            const signal = requests.current.controller.signal;
            const seq = ++requests.current.connSeq;
            return api('/surge-api/connections', { signal }).then(function (result) {
              if (signal.aborted || seq !== requests.current.connSeq) return;
              if (!result.ok) throw new Error(tCode(result) || 'error');
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
              if (!result.ok) throw new Error(tCode(result) || 'error');
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
            setBusy(path); setNotice(null);
            return post(path, body, { signal }).then(function (result) {
              if (signal.aborted) return { ok: false, cancelled: true };
              if (!result.ok && path !== '/surge-api/connection/test') {
                const msg = tCode(result);
                setNotice({ text: t('dm.error') + (msg ? ' · ' + msg : ''), tone: 'is-danger' });
              } else if (result.ok && path !== '/surge-api/connection/test') {
                requests.current.connSeq++; requests.current.fleetSeq++;
                setData({ connections: result.connections || [], activeId: result.activeId || 'local', loading: false, error: '' });
                store.invalidate();
                if (typeof onConnectionsChanged === 'function') onConnectionsChanged();
              }
              return result;
            }).catch(function (error) {
              if (signal.aborted) return { ok: false, cancelled: true };
              setNotice({ text: t('dm.error') + ' · ' + String(error.message || error), tone: 'is-danger' });
              return { ok: false };
            }).finally(function () {
              requests.current.busy = false;
              if (!signal.aborted) setBusy('');
            });
          };
          const reloadAll = function () { loadConns(); loadFleet(); void store.fetch(); };

          const onActivate = function (id, onSuccess) {
            return call('/surge-api/connection/activate', { id }).then(function (result) {
              if (result.ok) {
                setNotice({ text: t('dm.activated'), tone: 'is-ok' });
                if (onSuccess) {
                  void store.fetch();
                  onSuccess();
                } else {
                  reloadAll();
                }
              }
              return result;
            });
          };
          const onDelete = function (id) {
            setConfirmId('');
            call('/surge-api/connection/delete', { id: id }).then(function (r) {
              if (r.ok) {
                if (form && form.id === id) { setForm(null); setFormError(''); }
                if (testResult && testResult.id === id) setTestResult(null);
                setNotice({ text: t('dm.deleted'), tone: 'is-ok' });
                reloadAll();
              }
            });
          };
          const onTest = function (c) {
            setTestResult(null);
            call('/surge-api/connection/test', { id: c.id }).then(function (r) {
              if (r.cancelled) return;
              const detail = tCode(r) || (r.ok ? t('dm.test.ok') : t('dm.test.fail'));
              setTestResult({ id: c.id, ok: !!r.ok, message: detail, rtt: r.rtt, mode: r.mode });
            });
          };
          const onTestForm = function (f) {
            const host = String(f.host || '').trim();
            const port = Number(f.port);
            if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
              setFormError(t('dm.testErr'));
              return;
            }
            if (!f.hasKey && !String(f.apiKey || '').trim()) {
              setFormError(t('err.MISSING_CONNECTION'));
              return;
            }
            setFormError('');
            setTestResult(null);
            call('/surge-api/connection/test', { connection: f }).then(function (r) {
              if (r.cancelled) return;
              const detail = tCode(r) || (r.ok ? t('dm.test.ok') : t('dm.test.fail'));
              setTestResult({ id: 'form', ok: !!r.ok, message: detail, rtt: r.rtt, mode: r.mode });
            });
          };
          const onSave = function (f, activate) {
            const name = String(f.name || '').trim();
            const host = String(f.host || '').trim();
            const port = Number(f.port);
            if (!name || !host || !Number.isInteger(port) || port < 1 || port > 65535) {
              setFormError(t('dm.saveErr'));
              return;
            }
            setFormError('');
            const body = {
              id: f.id || '', name: name, protocol: f.protocol, host: host,
              port: port, platform: f.platform, apiKey: f.apiKey || '', caCert: f.caCert || ''
            };
            call('/surge-api/connection/save', { connection: body, activate: !!activate }).then(function (r) {
              if (r.ok) {
                setForm(null);
                setFormError('');
                setTestResult(null);
                setNotice({ text: activate ? t('dm.activated') : t('dm.savedOk'), tone: 'is-ok' });
                reloadAll();
              } else if (!r.cancelled) {
                setFormError(tCode(r) || t('dm.error'));
              }
            });
          };
          const openAdd = function () {
            setForm({ id: '', name: '', protocol: 'http', host: '', port: '6171', platform: 'auto', apiKey: '', caCert: '', hasKey: false });
            setFormError(''); setTestResult(null); setNotice(null);
          };
          const openEdit = function (c) {
            setForm({ id: c.id, name: c.name, protocol: c.protocol, host: c.host, port: String(c.port), platform: c.platform || 'auto', apiKey: '', caCert: c.caCert || '', hasKey: !!c.hasKey });
            setFormError(''); setTestResult(null); setNotice(null);
          };
          const closeForm = function () {
            setForm(null); setFormError('');
            if (testResult && testResult.id === 'form') setTestResult(null);
          };

          function fld(labelKey, name, f, setF, type, ph, choices) {
            const onChange = function (e) { const next = Object.assign({}, f); next[name] = e.target.value; setF(next); };
            const control = choices
              ? h('select', { className: 'sg-select', id: 'sg-field-' + name, value: f[name], onChange: onChange, disabled: !!busy }, choices.map(function (c) { return h('option', { key: c.v, value: c.v }, c.l); }))
              : h('input', { className: 'sg-input', id: 'sg-field-' + name, disabled: !!busy, type: type || 'text', value: f[name], placeholder: ph || '', onChange: onChange });
            return h('div', { className: 'sg-field', key: name }, h('label', { htmlFor: 'sg-field-' + name }, t(labelKey)), control);
          }

          function renderTestBanner(id) {
            if (!testResult || testResult.id !== id) return null;
            return h('div', { className: 'sg-notice ' + (testResult.ok ? 'is-ok' : 'is-danger'), role: 'status' },
              (testResult.ok ? t('dm.test.ok') : t('dm.test.fail')) +
              (testResult.message && testResult.message !== (testResult.ok ? t('dm.test.ok') : t('dm.test.fail')) ? ' · ' + testResult.message : '') +
              (typeof testResult.rtt === 'number' ? ' · ' + testResult.rtt + ' ' + t('dm.rttUnit') : '') +
              (testResult.mode ? ' · ' + testResult.mode : ''));
          }

          const platformOpts = [
            { v: 'auto', l: t('dm.platform.auto') }, { v: 'ios', l: t('dm.platform.ios') },
            { v: 'tvos', l: t('dm.platform.tvos') }, { v: 'macos', l: t('dm.platform.macos') }
          ];
          const protocolOpts = [{ v: 'http', l: 'HTTP' }, { v: 'https', l: 'HTTPS' }];
          const fleetById = new Map(fleet.fleet.map(function (probe) { return [probe.id, probe]; }));
          const totals = fleet.totals;
          const localConn = data.connections.find(function (c) { return c.isLocal; }) || { id: 'local', protocol: 'http', host: '127.0.0.1', port: 0, isLocal: true };
          const saved = data.connections.filter(function (c) { return !c.isLocal; });
          const connections = [localConn].concat(saved).filter(function (c) {
            if (fleetFilter === 'all') return true;
            const probe = fleetById.get(c.id);
            return probe && probe.online === (fleetFilter === 'online');
          });
          const partialRates = fleet.updated && totals.online < totals.total ? t('status.partial') : '';

          function DetailAction({ id, active }) {
            const [pending, setPending] = useState(false);
            const [failed, setFailed] = useState(false);
            return h('div', { className: 'sg-conn-actions' },
              Btn({ label: t(active ? 'tab.overview' : 'detail.activate'), icon: active ? 'activity' : 'check', sm: true, disabled: pending,
                onClick: async function () {
                  if (active) { props.onOverview(); return; }
                  setPending(true);
                  setFailed(false);
                  const result = await onActivate(id, props.onOverview);
                  if (!result.ok) {
                    setPending(false);
                    if (!result.cancelled) setFailed(true);
                  }
                } }),
              failed ? h('div', { className: 'sg-notice is-danger', role: 'alert' }, t('detail.switchError')) : null);
          }

          function renderConnection(c) {
            const probe = fleetById.get(c.id);
            const online = probe && probe.online === true;
            const active = data.activeId === c.id;
            const noKey = !c.isLocal && !c.hasKey && !online;
            const statusKey = online ? 'dm.status.online' : noKey ? 'dm.status.noKey' : probe ? 'dm.status.offline' : fleet.loading ? 'st.loading' : 'status.unavailable';
            const statusClass = online ? ' is-online' : noKey ? ' is-warn' : probe ? ' is-offline' : '';
            const host = c.host.includes(':') && !c.host.startsWith('[') ? '[' + c.host + ']' : c.host;
            const name = c.isLocal ? t('dm.localName') : c.name;
            const message = probe && (probe.code ? tCode(probe) : probe.message);
            const fields = {
              status: t(statusKey),
              address: c.port ? c.protocol + '://' + host + ':' + c.port : null,
              mode: online && probe.modeAvailable !== false ? probe.mode : null,
              rtt: online && Number.isFinite(probe.rtt) ? probe.rtt : null,
              conns: online && probe.connsAvailable !== false && Number.isFinite(probe.conns) ? probe.conns : null,
              inSpeed: online && Number.isFinite(probe.down) ? probe.down : null,
              outSpeed: online && Number.isFinite(probe.up) ? probe.up : null,
              checkedAt: probe ? probe.checkedAt ?? fleet.updated?.getTime() : null
            };
            const meta = function (icon, key) {
              return fields[key] == null ? null : h('span', { className: 'sg-conn-meta-item' },
                I(icon, 13), t('detail.' + key) + ' ', h('b', { className: 'sg-mono' }, detailValue(key, fields[key])));
            };
            const confirming = confirmId === c.id;
            return h('div', { className: 'sg-card', key: c.id },
              h('div', { className: 'sg-conn-top' },
                h('span', { className: 'sg-ico-tile ' + (c.isLocal ? 'sg-tone-brand' : 'sg-tone-idle') }, I(c.isLocal ? 'laptop' : 'server', 16)),
                h('span', { className: 'sg-conn-name' }, name),
                active ? h('span', { className: 'sg-badge-sm is-active' }, t('dm.active')) : null,
                h('span', { className: 'sg-badge-sm' + statusClass }, fields.status)),
              h('div', { className: 'sg-conn-meta' },
                meta('globe', 'address'),
                !c.isLocal ? h('span', { className: 'sg-conn-meta-item' }, I('shield', 13), t('dm.keyBadge') + ' ', h('b', null, c.hasKey ? t('dm.field.keyStored') : t('dm.field.keyMissing'))) : null,
                !c.isLocal ? h('span', { className: 'sg-conn-meta-item' }, I('server', 13), t('dm.field.platform') + ' ', h('b', null, t('dm.platform.' + (c.platform || 'auto')) || c.platform)) : null,
                meta('activity', 'rtt'), meta('download', 'inSpeed'), meta('upload', 'outSpeed'),
                c.isLocal ? h('span', { className: 'sg-conn-meta-item' }, I('info', 13), h('span', null, t('dm.localHint'))) : null),
              message ? h('div', { className: 'sg-notice ' + (online ? 'is-warn' : 'is-danger') }, message) : null,
              renderTestBanner(c.id),
              confirming ? h('div', { className: 'sg-notice is-danger', role: 'alert' }, t('dm.confirmDelete')) : null,
              h('div', { className: 'sg-conn-actions' },
                h('button', { type: 'button', className: 'sg-btn sm', disabled: !!busy, 'aria-haspopup': 'dialog', 'aria-label': t('detail.open') + ' · ' + name,
                  onClick: function (event) {
                    props.openDetail(null, event.currentTarget, { title: t('detail.open'), items: [
                      { id: c.id, title: name, fields, action: h(DetailAction, { id: c.id, active }) }
                    ] });
                  } }, I('chevronDown', 14), t('detail.open')),
                Btn({ label: t('dm.activate'), icon: 'check', sm: true, disabled: active || !!busy, onClick: function () { onActivate(c.id); } }),
                Btn({ label: t('dm.test'), icon: 'activity', sm: true, disabled: !!busy, onClick: function () { onTest(c); } }),
                !c.isLocal ? Btn({ label: t('dm.edit'), icon: 'settings', sm: true, disabled: !!busy, onClick: function () { openEdit(c); } }) : null,
                !c.isLocal ? Btn({ label: t(confirming ? 'dm.confirmDeleteBtn' : 'dm.delete'), icon: 'trash', danger: true, sm: true, disabled: !!busy,
                  onClick: function () { if (confirming) onDelete(c.id); else setConfirmId(c.id); } }) : null,
                confirming ? Btn({ label: t('dm.cancel'), sm: true, onClick: function () { setConfirmId(''); } }) : null));
          }

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
              Stat(t('dm.saved'), data.loading || data.error ? '—' : String(saved.length + 1), t('dm.local')),
              Stat(t('dm.online'), fleet.updated ? totals.online + ' / ' + totals.total : '—', t('dm.fleet.title')),
              Stat(t('dm.activeReqs'), fleet.updated && totals.connsComplete ? String(totals.conns) : '—', fleet.updated && !totals.connsComplete ? t('status.partial') : ''),
              Stat(t('dm.totalDown'), fleet.updated ? fmtBytesStr(totals.down, true) : '—', partialRates),
              Stat(t('dm.totalUp'), fleet.updated ? fmtBytesStr(totals.up, true) : '—', partialRates)),

            data.error ? h('div', { className: 'sg-error', role: 'alert' }, data.error) : null,
            fleet.error ? h('div', { className: 'sg-error', role: 'alert' }, fleet.error + (fleet.updated ? ' · ' + t('status.stale') + ' ' + fmtTime(fleet.updated) : '')) : null,
            notice ? h('div', { className: 'sg-notice' + (notice.tone ? ' ' + notice.tone : ''), role: 'status' }, notice.text) : null,

            /* Add / edit form */
            form ? h('form', {
              className: 'sg-card',
              onSubmit: function (e) { e.preventDefault(); onSave(form, false); },
              onKeyDown: function (e) { if (e.key === 'Escape' && !busy) { e.preventDefault(); closeForm(); } }
            },
              h('div', { className: 'sg-card-h' },
                h('h2', { className: 'sg-card-t' }, I(form.id ? 'settings' : 'plus', 16), t(form.id ? 'dm.form.edit' : 'dm.form.add'))),
              h('div', { className: 'sg-form-grid' },
                fld('dm.field.name', 'name', form, setForm, 'text', 'Surge Mac mini'),
                fld('dm.field.protocol', 'protocol', form, setForm, null, null, protocolOpts),
                fld('dm.field.host', 'host', form, setForm, 'text', '192.0.2.10'),
                fld('dm.field.port', 'port', form, setForm, 'number', '6171'),
                fld('dm.field.platform', 'platform', form, setForm, null, null, platformOpts),
                fld('dm.field.key', 'apiKey', form, setForm, 'password', t('dm.field.keyHint'))),
              form.protocol === 'https' ? h('div', { className: 'sg-field', style: { margin: '0 0 14px' } },
                h('label', { htmlFor: 'sg-field-ca' }, t('dm.field.ca')),
                h('textarea', { className: 'sg-input', id: 'sg-field-ca', disabled: !!busy, rows: 4, value: form.caCert, maxLength: 16384, onChange: function (event) { setForm({ ...form, caCert: event.target.value }); } }),
                h('div', { className: 'sg-sub' }, t('dm.field.caHint'))) : null,
              formError ? h('div', { className: 'sg-error', role: 'alert', style: { marginBottom: '12px' } }, formError) : null,
              renderTestBanner('form'),
              h('div', { className: 'sg-form-actions' },
                Btn({ label: t('dm.save'), icon: 'check', primary: true, submit: true, disabled: !!busy }),
                Btn({ label: t('dm.saveActivate'), icon: 'link', onClick: function () { onSave(form, true); }, disabled: !!busy }),
                Btn({ label: t('dm.test'), icon: 'activity', onClick: function () { onTestForm(form); }, disabled: !!busy }),
                Btn({ label: t('dm.cancel'), disabled: !!busy, onClick: closeForm })))
              : null,

            /* Connection cards */
            saved.length === 0 && !data.loading && !data.error
              ? h('div', { className: 'sg-callout' }, I('info', 16), h('span', null, t('dm.emptyHint')))
              : null,

            h('div', null, Seg(fleetFilter, [
              { v: 'all', l: 'detail.all' }, { v: 'online', l: 'detail.online' }, { v: 'offline', l: 'detail.offline' }
            ], setFleetFilter, t('detail.filter'))),
            h('div', { className: 'sg-conn-list' }, connections.map(renderConnection)),
            !connections.length && !fleet.loading ? h('p', { className: 'sg-sub', role: 'status' }, t('detail.empty')) : null,

            fleet.loading ? h('div', { className: 'sg-sub' }, t('st.loading')) : null
          );
        }

        /* ================================================================ *
         * SETTINGS — restored appearance, refresh, display, diagnostics,
         * active-connection info and an honest About note.
         * ================================================================ */
        function SettingsPanel(props) {
          const fallbackActive = props.activeConnection;
          const [diag, setDiag] = useState({ running: false, data: null, error: '' });
          const [openChecks, setOpenChecks] = useState({});
          const [copyState, setCopyState] = useState('');
          const [resetDone, setResetDone] = useState(false);
          const diagRequest = useRef(new AbortController());
          const copyAttempt = useRef(0);
          const diagId = React.useId();
          const resetTimer = useRef(null);
          const p = prefs.get();
          const set = function (patch) { prefs.set(patch); };
          const state = store.get();
          const s = state.snap;
          const active = (s && s.activeConnection) || state.activeConnection || fallbackActive;

          useEffect(function () {
            const controller = new AbortController();
            diagRequest.current = controller;
            setDiag({ running: false, data: null, error: '' });
            setOpenChecks({});
            setCopyState('');
            return function () { controller.abort(); };
          }, [s && s.connectionRevision, active && active.id]);

          useEffect(function () {
            return function () { if (resetTimer.current) clearTimeout(resetTimer.current); };
          }, []);

          const onReset = function () {
            prefs.reset();
            setResetDone(true);
            if (resetTimer.current) clearTimeout(resetTimer.current);
            resetTimer.current = setTimeout(function () { setResetDone(false); }, 2500);
          };

          const refreshOpts = [2000, 5000, 10000, 30000, 60000].map(function (v) {
            return { v: v, l: (v / 1000) + ' ' + t('st.seconds') };
          });
          const sampleOpts = [24, 48, 96, 144].map(function (v) { return { v: v, l: String(v) }; });
          const devOpts = [4, 6, 8, 12, 16].map(function (v) { return { v: v, l: String(v) }; });
          const evOpts = [4, 6, 8, 12].map(function (v) { return { v: v, l: String(v) }; });

          const runDiag = function () {
            copyAttempt.current += 1;
            setOpenChecks({});
            setCopyState('');
            setDiag({ running: true, data: null, error: '' });
            const signal = diagRequest.current.signal;
            api('/surge-api/diagnostics', { signal }).then(function (r) {
              if (signal.aborted) return;
              if (r.ok) setDiag({ running: false, data: r, error: '' });
              else setDiag({ running: false, data: null, error: tCode(r, 'st.diag.retry') });
            }).catch(function (e) {
              if (!signal.aborted) setDiag({ running: false, data: null, error: String((e && e.message) || e) });
            });
          };

          const endpoint = diag.data && diag.data.endpoint;
          const gateway = t('st.diag.gateway') + ' · ' + (endpoint ? (endpoint.tls ? 'https://' : 'http://') + endpoint.base : '—');
          const checks = diag.data && Array.isArray(diag.data.checks) ? diag.data.checks : [];
          const columns = ['st.diag.endpoint', 'st.diag.status', 'st.diag.rtt', 'st.diag.shape'].map(function (key) { return t(key); });
          const rows = checks.map(function (check) {
            const status = check.status === 0 ? t('st.diag.noResponse') : String(check.status ?? '—');
            const rtt = Number.isFinite(check.rtt) ? check.rtt + ' ' + t('dm.rttUnit') : '—';
            return {
              ok: check.ok,
              path: String(check.path || '—'),
              result: t(check.ok ? 'st.diag.ok' : 'st.diag.fail'),
              status: status,
              rtt: rtt,
              shape: String(check.shape || '—'),
              message: String(check.message || t('st.diag.noMessage'))
            };
          });
          const report = function () {
            return [gateway].concat(rows.map(function (row) {
              return [
                row.path + ' · ' + row.result,
                t('st.diag.httpStatus') + ': ' + row.status,
                columns[2] + ': ' + row.rtt,
                columns[3] + ': ' + row.shape,
                t('st.diag.message') + ': ' + row.message
              ].join('\n');
            })).join('\n\n');
          };
          const copyDiagnostics = async function () {
            const attempt = ++copyAttempt.current;
            const signal = diagRequest.current.signal;
            let result = 'st.diag.copied';
            try {
              await navigator.clipboard.writeText(report());
            } catch {
              result = 'st.diag.copyFailed';
            }
            if (!signal.aborted && attempt === copyAttempt.current) setCopyState(result);
          };

          const diagBody = diag.data
            ? h('div', null,
                h('div', { className: 'sg-diag-summary' },
                  h('span', { className: 'sg-sub' }, gateway),
                  rows.length ? Btn({ label: t('st.diag.copy'), sm: true, onClick: copyDiagnostics }) : null),
                h('div', { className: 'sg-sub sg-diag-copy-status', role: 'status' }, copyState ? t(copyState) : null),
                copyState === 'st.diag.copyFailed' ? h('textarea', {
                  className: 'sg-input sg-diag-report', readOnly: true, rows: 5,
                  'aria-label': t('st.diagnostics'), value: report(),
                  onFocus: function (e) { e.currentTarget.select(); }
                }) : null,
                rows.length ? h('div', { className: 'sg-table-wrap sg-diag-wrap', role: 'region', tabIndex: 0, 'aria-label': t('st.diagnostics') },
                  h('table', { className: 'sg-diag-tbl', role: 'table', 'aria-label': t('st.diagnostics') },
                    h('thead', { role: 'rowgroup' }, h('tr', { role: 'row' }, columns.map(function (label) {
                      return h('th', { key: label, scope: 'col', role: 'columnheader' }, label);
                    }))),
                    h('tbody', { role: 'rowgroup' }, rows.map(function (row, i) {
                      const isOpen = !!openChecks[i];
                      const detailId = diagId + '-check-' + i;
                      return h(React.Fragment, { key: i },
                        h('tr', { role: 'row' },
                          h('td', { role: 'rowheader', 'data-label': columns[0] },
                            h('button', {
                              className: 'sg-diag-toggle sg-mono', type: 'button',
                              'aria-expanded': isOpen, 'aria-controls': isOpen ? detailId : undefined,
                              onClick: function () {
                                setOpenChecks(function (current) { return { ...current, [i]: !current[i] }; });
                              }
                            }, I('chevronDown', 13), row.path)),
                          h('td', { role: 'cell', 'data-label': columns[1] },
                            h('span', { className: row.ok ? 'sg-pill-ok' : 'sg-pill-fail' }, row.result + ' · ' + row.status)),
                          h('td', { role: 'cell', 'data-label': columns[2], className: 'sg-mono' }, row.rtt),
                          h('td', { role: 'cell', 'data-label': columns[3], className: 'sg-mono' }, row.shape)),
                        isOpen ? h('tr', { className: 'sg-diag-detail', role: 'row' },
                          h('td', { colSpan: columns.length, role: 'cell' },
                            h('div', { id: detailId, className: 'sg-diag-detail-body' },
                              h('div', { className: 'sg-sub' }, t('st.diag.details') + ' · ' + row.path),
                              h('div', { className: 'sg-diag-message' }, t('st.diag.httpStatus') + ' · ' + row.status),
                              h('div', { className: 'sg-diag-message' }, t('st.diag.message') + ' · ' + row.message)))) : null);
                    })))) : h('div', { className: 'sg-sub' }, t('st.diag.noChecks')))
            : diag.error
              ? h('div', { className: 'sg-notice is-danger', role: 'alert' }, diag.error)
              : h('div', { className: 'sg-sub' }, t('st.diagnostics.desc'));

          const activeHost = active && active.host && active.port
            ? ' · ' + (active.host.includes(':') ? '[' + active.host + ']' : active.host) + ':' + active.port
            : '';
          const activeLabel = active
            ? connName(active) + activeHost + ((active.local || active.isLocal || active.id === 'local') ? ' (' + t('dm.local') + ')' : '')
            : '—';

          return h('div', { className: 'sg-stack sg-settings' },
            h('div', { className: 'sg-card' },
              h('div', { className: 'sg-card-h is-tall' },
                h('div', null,
                  h('h2', { className: 'sg-card-t' }, I('settings', 16), t('st.title')),
                  h('p', { className: 'sg-subtitle' }, t('st.subtitle'))),
                Btn({ label: t('st.reset'), icon: 'refresh', sm: true, onClick: onReset })),
              resetDone ? h('div', { className: 'sg-notice is-ok', role: 'status' }, t('st.resetDone')) : null),

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
                ], function (v) { set({ appearance: v }); }, t('st.appearance')))),

            /* Data refresh */
            h('div', { className: 'sg-card' },
              h('div', { className: 'sg-card-h' },
                h('h2', { className: 'sg-card-t' }, I('refresh', 16), t('st.data'))),
              SetRow('st.refresh', 'st.refresh.desc', function (id) {
                return Select(p.refreshMs, refreshOpts, function (v) { set({ refreshMs: Number(v) }); }, id);
              }),
              SetRow('st.samples', 'st.samples.desc', function (id) {
                return Select(p.samplePoints, sampleOpts, function (v) { set({ samplePoints: Number(v) }); }, id);
              }),
              SetRow('st.pause', 'st.pause.desc', function (id) {
                return Switch(p.paused, function (v) { set({ paused: v }); }, id);
              })),

            /* Display */
            h('div', { className: 'sg-card' },
              h('div', { className: 'sg-card-h' },
                h('h2', { className: 'sg-card-t' }, I('globe', 16), t('st.display'))),
              SetRow('st.maxDevices', 'st.maxDevices.desc', function (id) {
                return Select(p.maxDevices, devOpts, function (v) { set({ maxDevices: Number(v) }); }, id);
              }),
              SetRow('st.maxEvents', 'st.maxEvents.desc', function (id) {
                return Select(p.maxEvents, evOpts, function (v) { set({ maxEvents: Number(v) }); }, id);
              })),

            /* Active connection */
            h('div', { className: 'sg-card' },
              h('div', { className: 'sg-card-h is-tall' },
                h('div', null,
                  h('h2', { className: 'sg-card-t' }, I('link', 16), t('st.connection')),
                  h('p', { className: 'sg-subtitle' }, t('st.connection.desc'))),
                h('div', { className: 'sg-settings-connection' },
                  h('span', { className: 'sg-kv-val sg-mono' }, activeLabel),
                  Btn({ label: t('action.manageConns'), icon: 'link', sm: true, onClick: function () { props.onManageConnections(); } })))),

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
          const [selectedKey, setSelectedKey] = useState('');
          const [detail, setDetail] = useState(null);
          const [menuError, setMenuError] = useState('');
          const menuButton = useRef(null);
          const [conns, setConns] = useState({ connections: [], activeId: 'local' });
          const [menuOpen, setMenuOpen] = useState(false);
          const [switching, setSwitching] = useState(false);
          const switcherRef = useRef(null);
          const tabRefs = useRef({});
          const connReq = useRef({ controller: null, seq: 0 });

          const loadConns = function () {
            if (connReq.current.controller) connReq.current.controller.abort();
            const controller = new AbortController();
            const seq = ++connReq.current.seq;
            connReq.current.controller = controller;
            return api('/surge-api/connections', { signal: controller.signal }).then(function (r) {
              if (controller.signal.aborted || seq !== connReq.current.seq) return;
              if (!r.ok || !Array.isArray(r.connections)) throw new Error(tCode(r));
              setConns({ connections: r.connections, activeId: r.activeId || 'local' });
            }).catch(function () {
              if (!controller.signal.aborted) setMenuError(t('detail.loadError'));
            });
          };

          useEffect(function () {
            const bump = function () { force(function (v) { return v + 1; }); };
            const a = ctx.locale.subscribe(bump);
            const b = store.subscribe(bump);
            const c = prefs.subscribe(bump);
            loadConns();
            return function () {
              if (connReq.current.controller) connReq.current.controller.abort();
              if (typeof a === 'function') a();
              if (typeof b === 'function') b();
              if (typeof c === 'function') c();
            };
          }, []);

          useEffect(function () {
            if (!menuOpen) return undefined;
            const onDocDown = function (e) {
              if (switcherRef.current && !switcherRef.current.contains(e.target)) setMenuOpen(false);
            };
            const onDocKey = function (e) {
              if (e.key === 'Escape') {
                e.preventDefault();
                setMenuOpen(false);
                menuButton.current?.focus({ preventScroll: true });
              }
            };
            const first = switcherRef.current.querySelector('[role=menuitemradio], [role=menuitem]');
            if (first) first.focus({ preventScroll: true });
            document.addEventListener('pointerdown', onDocDown);
            document.addEventListener('keydown', onDocKey);
            return function () {
              document.removeEventListener('pointerdown', onDocDown);
              document.removeEventListener('keydown', onDocKey);
            };
          }, [menuOpen]);

          const state = store.get();
          const p = prefs.get();
          useEffect(function () { return startPolling(store, p); }, [p.paused, p.refreshMs]);
          const rootCls = 'sg-root' + (p.appearance === 'light' ? ' sg-force-light' : p.appearance === 'dark' ? ' sg-force-dark' : '');
          const onRefresh = function () { store.fetch(); };
          const onTogglePause = function () { prefs.set({ paused: !p.paused }); };
          const ui = {
            showDown: showDown, setShowDown: setShowDown,
            showUp: showUp, setShowUp: setShowUp,
            selectedKey: selectedKey, setSelectedKey: setSelectedKey
          };
          const listActive = conns.connections.find(function (c) { return c.active || c.id === conns.activeId; }) || null;
          const active = (state.snap && state.snap.activeConnection) || state.activeConnection || listActive;

          const switchTo = function (id) {
            if (switching) return;
            setMenuOpen(false);
            setMenuError('');
            menuButton.current?.focus({ preventScroll: true });
            if (active && active.id === id) return;
            setSwitching(true);
            post('/surge-api/connection/activate', { id: id }).then(function (r) {
              if (r && r.ok) {
                if (Array.isArray(r.connections)) setConns({ connections: r.connections, activeId: r.activeId || id });
                store.invalidate();
                store.fetch();
              } else {
                setMenuError(t('detail.switchError') + ' · ' + tCode(r));
              }
            }).catch(function () { setMenuError(t('detail.switchError')); }).finally(function () { setSwitching(false); });
          };

          const tabs = [
            { k: 'overview', l: 'tab.overview', i: 'activity' },
            { k: 'devices', l: 'tab.devices', i: 'server' },
            { k: 'settings', l: 'tab.settings', i: 'settings' }
          ];
          const onTabKeyDown = function (e, idx) {
            let nextIdx = -1;
            if (e.key === 'ArrowRight') nextIdx = (idx + 1) % tabs.length;
            else if (e.key === 'ArrowLeft') nextIdx = (idx - 1 + tabs.length) % tabs.length;
            else if (e.key === 'Home') nextIdx = 0;
            else if (e.key === 'End') nextIdx = tabs.length - 1;
            if (nextIdx >= 0) {
              e.preventDefault();
              const nextKey = tabs[nextIdx].k;
              setTab(nextKey);
              const el = tabRefs.current[nextKey];
              if (el && typeof el.focus === 'function') el.focus();
            }
          };

          const menuItems = conns.connections.length ? conns.connections : (active ? [active] : []);
          const connectionId = active && active.id;
          const revision = state.snap && state.snap.connectionRevision;
          const closeDetail = function () { setDetail(null); };
          const openDetail = function (kind, trigger, options) {
            setDetail({ kind, trigger, connectionId, revision, tab, ...options });
          };
          useEffect(function () {
            setDetail(null);
            setSelectedKey('');
          }, [connectionId, revision]);
          const goToTab = function (key) {
            closeDetail();
            setTab(key);
            const button = tabRefs.current[key];
            if (button) requestAnimationFrame(function () { button.focus({ preventScroll: true }); });
          };
          const visibleDetail = detail && detail.tab === tab && detail.connectionId === connectionId && detail.revision === revision;

          return h('div', { className: rootCls }, h('div', { className: 'sg-inner' },
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
                  type: 'button', className: 'sg-icon-btn' + (p.paused ? ' is-active' : ''),
                  title: t(p.paused ? 'action.resume' : 'action.pause'),
                  'aria-label': t(p.paused ? 'action.resume' : 'action.pause'),
                  'aria-pressed': p.paused ? 'true' : 'false',
                  onClick: onTogglePause
                }, I(p.paused ? 'play' : 'pause', 15)),
                h('button', {
                  type: 'button', className: 'sg-icon-btn', title: t('action.refresh'),
                  'aria-label': t('action.refresh'), 'aria-busy': state.fetching ? 'true' : 'false',
                  disabled: state.fetching, onClick: onRefresh
                }, I('refresh', 16, state.fetching ? 'sg-spin' : '')))),

            h('div', { className: 'sg-tabbar' },
              h('div', { className: 'sg-tabs', role: 'tablist', 'aria-label': t('panel.title') }, tabs.map(function (tb, idx) {
                const isActive = tab === tb.k;
                return h('button', {
                  key: tb.k, type: 'button', role: 'tab',
                  id: 'sg-tab-' + tb.k, 'aria-controls': 'sg-panel-' + tb.k,
                  tabIndex: isActive ? 0 : -1,
                  ref: function (el) { tabRefs.current[tb.k] = el; },
                  className: 'sg-tab' + (isActive ? ' is-active' : ''),
                  'aria-selected': isActive ? 'true' : 'false',
                  onKeyDown: function (e) { onTabKeyDown(e, idx); },
                  onClick: function () { setTab(tb.k); }
                }, I(tb.i, 15), t(tb.l));
              })),
              h('span', { className: 'sg-tabbar-sp' }),
              h('div', { className: 'sg-switcher', ref: switcherRef },
                h('button', {
                  type: 'button', className: 'sg-active-chip', ref: menuButton,
                  'aria-haspopup': 'menu', 'aria-expanded': menuOpen ? 'true' : 'false',
                  title: t('action.switchConn'),
                  'aria-label': t('action.switchConn') + (active ? ': ' + connName(active) : ''),
                  'aria-disabled': switching,
                  onClick: function () {
                    if (switching) return;
                    setMenuOpen(!menuOpen);
                    if (!menuOpen) { setMenuError(''); loadConns(); }
                  },
                  onKeyDown: function (e) {
                    if (e.key === 'ArrowDown' && !switching && !menuOpen) {
                      e.preventDefault(); setMenuError(''); setMenuOpen(true); loadConns();
                    }
                  }
                }, I('link', 13), h('span', null, active ? connName(active) : t('dm.localName')), I('chevronDown', 13, 'sg-chev')),
                menuOpen
                  ? h('div', { className: 'sg-popover', role: 'menu', 'aria-label': t('action.switchConn'),
                      onBlur: function (e) { if (e.relatedTarget && !switcherRef.current.contains(e.relatedTarget)) setMenuOpen(false); },
                      onKeyDown: function (e) {
                        if (e.key === 'Tab') {
                          menuButton.current?.focus({ preventScroll: true });
                          setMenuOpen(false);
                          return;
                        }
                        if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) return;
                        e.preventDefault();
                        const items = Array.from(e.currentTarget.querySelectorAll('button'));
                        const index = items.indexOf(document.activeElement);
                        const next = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1
                          : (index + (e.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length;
                        items[next]?.focus();
                      } },
                      menuItems.map(function (c) {
                        const isCur = active ? active.id === c.id : !!c.active;
                        const hostTxt = c.host && c.port ? (c.host.includes(':') ? '[' + c.host + ']' : c.host) + ':' + c.port : '';
                        return h('button', {
                          key: c.id, type: 'button', role: 'menuitemradio', tabIndex: -1,
                          'aria-checked': isCur ? 'true' : 'false',
                          className: 'sg-pop-item' + (isCur ? ' is-active' : ''),
                          onClick: function () { switchTo(c.id); }
                        },
                          I(isCur ? 'check' : 'server', 13),
                          h('span', { className: 'sg-pop-name' }, connName(c)),
                          hostTxt ? h('span', { className: 'sg-pop-host sg-mono' }, hostTxt) : null);
                      }),
                      h('div', { className: 'sg-pop-div' }),
                      h('button', {
                        type: 'button', role: 'menuitem', tabIndex: -1, className: 'sg-pop-item sg-pop-foot',
                        onClick: function () { setMenuOpen(false); goToTab('devices'); }
                      }, I('settings', 13), h('span', null, t('action.manageConns'))))
                  : null)),

            menuError ? h('div', { className: 'sg-notice is-danger', role: 'alert' }, menuError) : null,
            h('div', { role: 'tabpanel', id: 'sg-panel-' + tab, 'aria-labelledby': 'sg-tab-' + tab },
              tab === 'overview'
                ? h(Overview, { ui, openDetail })
                : tab === 'devices'
                  ? h(DevicesPanel, { key: 'devices', onConnectionsChanged: loadConns, openDetail, onOverview: function () { goToTab('overview'); } })
                  : h(SettingsPanel, { key: 'settings', activeConnection: active, onManageConnections: function () { goToTab('devices'); } })),
            visibleDetail ? h(DetailDrawer, { detail, onClose: closeDetail }) : null
          ));
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
