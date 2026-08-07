/* 全屋温湿度监控 —— 前端逻辑（Vue 3 全局版，免构建） */
const { createApp } = Vue;

const POLL_INTERVAL = 10000;      // 数据刷新周期（节点 5 分钟一报，10s 足够）

// 主舞台虚拟画布尺寸（像素）：与 service/db.js 的 STAGE_W/STAGE_H 保持一致。
// 小面板坐标以该坐标系保存，前端按窗口等比缩放渲染，文字不随缩放变形。
const STAGE_W = 2560;
const STAGE_H = 1440;
const WIDGET_MIN_W = 120;   // 与后端 MIN_W 一致（public/style.css .node-panel min-width）
const WIDGET_MIN_H = 90;    // 与后端 MIN_H 一致（public/style.css .node-panel min-height）
const SNAP = 10;            // 位置/尺寸吸附网格：10px 倍数，方便对齐

// 曲线小图表显示规则（响应式）：图表区为纵向堆叠、按布局均分剩余高度；
// 放不下全部就只显示前面的几个（温度→湿度→电量），绝不挤压、不用滚动区。
// 渲染尺寸 = 舞台坐标 × stageScale，随窗口缩放变化，才反映面板"够不够显示"。
const CHART_MIN_W = 110;        // 渲染宽度低于此 → 隐藏全部图表（略低于面板 CSS 最小宽 120，让边界面板也能出图）
const CHART_INFO_H = 165;       // 数字信息区（节点名/温度/湿度/电量/信号 + 内边距）估算高度
const CHART_ROW_MIN = 66;       // 每个曲线行占用高度（含行距 + 底部时间轴行）：不够 → 少显示前面几个
const CHART_REFRESH_MS = 120000;   // 曲线数据缓存有效期（节点约 5 分钟一报，2 分钟足够新）
const CHART_LIMIT = 300;           // 曲线目标点数（后端按此抽稀，mini 图足够密又不至于拖慢渲染）

// 图表时间范围选项（与后端 CHART_RANGES 白名单一致）：key = 设置存库值，label = 下拉显示，ms = 窗口时长
const CHART_RANGES = [
  { key: '1h',  label: '近 1 小时', ms: 1 * 3600e3 },
  { key: '6h',  label: '近 6 小时', ms: 6 * 3600e3 },
  { key: '1d',  label: '近 1 天',   ms: 24 * 3600e3 },
  { key: '3d',  label: '近 3 天',   ms: 3 * 24 * 3600e3 },
  { key: '7d',  label: '近 7 天',   ms: 7 * 24 * 3600e3 },
  { key: '15d', label: '近 15 天',  ms: 15 * 24 * 3600e3 },
  { key: '1M',  label: '近 1 个月', ms: 30 * 24 * 3600e3 },
  { key: '3M',  label: '近 3 个月', ms: 90 * 24 * 3600e3 },
  { key: '6M',  label: '近 6 个月', ms: 180 * 24 * 3600e3 },
  { key: '1Y',  label: '近 1 年',   ms: 365 * 24 * 3600e3 },
];
/** 某小面板图表时间窗口时长（毫秒），未知/缺省按 1d。 */
function chartRangeMs(range) {
  const r = CHART_RANGES.find((x) => x.key === range);
  return r ? r.ms : 24 * 3600e3;
}

/** MQTT 主题合法性校验（与服务端一致）：# 只能作最后一个完整层级，+ 必须独占一个层级。 */
function isValidMqttTopic(t) {
  if (typeof t !== 'string' || t.trim() === '') return false;
  if (t.includes("\u0000")) return false;
  const levels = t.split('/');
  for (let i = 0; i < levels.length; i++) {
    const lv = levels[i];
    if (lv.includes('#') && (lv !== '#' || i !== levels.length - 1)) return false;
    if (lv.includes('+') && lv !== '+') return false;
  }
  return true;
}

createApp({
  data() {
    return {
      // 认证状态
      authed: false,             // 是否已登录（未登录显示登录页）
      authBusy: false,           // 登录/注册请求进行中
      token: '',                 // Bearer token
      username: '',
      role: '',                  // 'admin' | 'user'
      userId: null,              // 当前用户 id（用户管理里禁用删除自己）
      userMenuOpen: false,       // 右上角用户下拉菜单
      loginTab: 'login',         // 登录页当前 Tab：'login' | 'register'
      loginForm: { username: '', password: '' },
      registerForm: { username: '', password: '', confirm: '' },
      authError: '',             // 登录/注册错误提示
      users: [],                 // 用户管理列表（仅管理员加载）
      tab: 'main',
      panels: [],                // 面板容器（主舞台一次显示一个）
      widgets: [],               // 节点小面板（归属某个面板容器）
      availableNodes: [],        // 可添加的节点（订阅主题池）
      selectedPanelId: null,     // 主舞台当前显示的面板容器 id
      expandedPanelId: null,     // 侧边栏展开的面板（显示其节点小面板 + 添加下拉）
      newWidgetIndex: -1,        // 展开面板里「添加节点」下拉选中的索引
      renamingPanelId: null,     // 正在改名的面板 id
      renameText: '',            // 改名输入框内容
      sideRailCollapsed: false,  // 主页面右侧边栏折叠状态（默认展开）
      sideRailWidth: 200,        // 侧边栏展开宽度（px，可拖拽调节）
      sideRailMin: 160,          // 拖拽最小宽度
      sideRailMax: 480,          // 拖拽最大宽度
      railResizing: false,       // 是否正在拖拽调节宽度
      stageScale: 1,             // 虚拟舞台等比缩放系数（由容器尺寸计算）
      dragState: null,           // 小面板拖拽状态 { id, mode, startX, startY, origX, origY, origW, origH }
      measureObs: null,          // 舞台尺寸监听（ResizeObserver）
      pollTimer: null,
      refreshing: false,
      mqttConns: [],            // MQTT 连接列表（每条含瞬态编辑字段 password/newTopic/saving）
      addingConn: false,
      widgetSettings: null,     // 节点小面板图表设置弹窗 { widgetId, name, show_temp, show_hum, show_bat, chart_range, saving }
      widgetDetail: null,       // 节点小面板详情大弹窗：当前展示的小面板 id（双击锁定面板的小面板打开）
      detailRange: '1d',        // 详情大弹窗的时间范围（与设置一致，默认近 1 天）
      detailHover: null,        // 详情大弹窗曲线十字线：{ key, x, y }（0..100 × 0..60 坐标系）
      widgetCharts: {},         // 曲线数据缓存：widgetId -> { points, lastSeen, fetchedAt }
    };
  },

  computed: {
    // 用户 logo：暂无头像，显示用户名首个字符
    userAvatarText() {
      return this.username ? this.username.charAt(0).toUpperCase() : '?';
    },
    // 当前选中的面板容器（主舞台只显示它）
    selectedPanel() {
      return this.panels.find((p) => p.id === this.selectedPanelId) || null;
    },
    // 当前面板是否可编辑（未锁定）：可拖动/缩放小面板
    panelEditable() {
      return this.selectedPanel && !this.selectedPanel.locked;
    },
    // 虚拟舞台渲染尺寸：等比缩放保持 2560:1440，居中铺在舞台容器内
    stageStyle() {
      const s = this.stageScale || 1;
      return { width: (STAGE_W * s) + 'px', height: (STAGE_H * s) + 'px' };
    },
    // 当前面板里的节点小面板
    widgetsOfSelected() {
      return this.widgets.filter((w) => w.panel_id === this.selectedPanelId);
    },
    // 图表时间范围下拉选项（常量暴露给模板）
    chartRanges() {
      return CHART_RANGES;
    },
    // 详情大弹窗当前展示的节点小面板（被删除/失效时返回 null，弹窗自动隐藏）
    detailWidget() {
      return this.widgets.find((w) => w.id === this.widgetDetail) || null;
    },
    // 详情大弹窗固定展示的三条曲线 key（温度→湿度→电量，垂直布局）
    detailChartKeys() {
      return ['temperature', 'humidity', 'battery'];
    },
  },

  methods: {
    async api(path, opts) {
      opts = opts || {};
      if (this.token) {
        opts.headers = Object.assign({}, opts.headers, { Authorization: 'Bearer ' + this.token });
      }
      const res = await fetch(path, opts);
      if (!res.ok) {
        let detail = res.status;
        try { detail = (await res.json()).detail || res.status; } catch (e) { /* ignore */ }
        if (res.status === 401 && !String(path).startsWith('/api/auth/')) this.forceLogout();  // 会话失效 → 回登录页
        throw new Error(detail);
      }
      return res.json();
    },

    // ---------- 认证 / 用户管理 ----------
    setAuth(token, username, role, userId) {
      this.token = token;
      this.username = username;
      this.role = role;
      this.userId = userId;
      this.authed = true;
      try { localStorage.setItem('monitor.auth', JSON.stringify({ token, username, role, userId })); } catch (e) { /* 忽略 */ }
    },
    clearAuth() {
      this.token = ''; this.username = ''; this.role = ''; this.userId = null;
      this.authed = false; this.userMenuOpen = false; this.tab = 'main';
      // 清空上一用户的数据，避免下一用户短暂看到缓存
      this.panels = []; this.widgets = []; this.availableNodes = [];
      this.mqttConns = []; this.users = []; this.widgetCharts = {};
      this.selectedPanelId = null; this.widgetSettings = null; this.widgetDetail = null;
      this.detailRange = '1d'; this.detailHover = null;
      // 释放舞台监听，重新登录后再建（旧 stageBox 已随 v-else 移除）
      if (this.measureObs) { this.measureObs.disconnect(); this.measureObs = null; }
      try { localStorage.removeItem('monitor.auth'); } catch (e) { /* 忽略 */ }
    },
    /** 401 时登出（保留前端本地状态清理，不调服务端——token 已失效）。 */
    forceLogout() {
      this.stopApp();
      this.clearAuth();
    },
    async login() {
      const username = this.loginForm.username.trim();
      const password = this.loginForm.password;
      if (!username || !password) { this.authError = '请输入用户名和密码'; return; }
      this.authBusy = true; this.authError = '';
      try {
        const res = await fetch('/api/auth/login', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, password }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) { this.authError = data.detail || '登录失败'; return; }
        this.setAuth(data.token, data.username, data.role, data.userId);
        this.startApp();
      } catch (e) {
        this.authError = '网络错误：' + e.message;
      } finally {
        this.authBusy = false;
      }
    },
    async register() {
      const username = this.registerForm.username.trim();
      const password = this.registerForm.password;
      const confirm = this.registerForm.confirm;
      if (!username || !password) { this.authError = '请输入用户名和密码'; return; }
      if (password !== confirm) { this.authError = '两次输入的密码不一致'; return; }
      this.authBusy = true; this.authError = '';
      try {
        const res = await fetch('/api/auth/register', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, password }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) { this.authError = data.detail || '注册失败'; return; }
        this.setAuth(data.token, data.username, data.role, data.userId);
        this.startApp();
      } catch (e) {
        this.authError = '网络错误：' + e.message;
      } finally {
        this.authBusy = false;
      }
    },
    async logout() {
      const t = this.token;
      this.stopApp();
      this.clearAuth();
      if (t) {
        try { await fetch('/api/auth/logout', { method: 'POST', headers: { Authorization: 'Bearer ' + t } }); } catch (e) { /* 忽略 */ }
      }
    },
    toggleUserMenu() {
      this.userMenuOpen = !this.userMenuOpen;
    },
    goAdminUsers() {
      this.userMenuOpen = false;
      this.switchTab('users');
    },
    async loadUsers() {
      try {
        const res = await this.api('/api/users');
        this.users = res.users || [];
      } catch (e) { console.warn('加载用户列表失败', e); }
    },
    async resetUserPassword(u) {
      const pw = prompt(`为用户「${u.username}」设置新密码（至少 6 位）：`);
      if (pw == null) return;
      if (pw.length < 6) { alert('密码至少 6 位'); return; }
      try {
        await this.api(`/api/users/${u.id}/password`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: pw }),
        });
        alert('密码已重置');
      } catch (e) { alert('重置密码失败：' + e.message); }
    },
    async deleteUser(u) {
      if (u.id === this.userId) { alert('不能删除自己'); return; }
      if (!confirm(`确定删除用户「${u.username}」？其全部配置与数据将被删除，不可恢复`)) return;
      try {
        await this.api(`/api/users/${u.id}`, { method: 'DELETE' });
        this.users = this.users.filter((x) => x.id !== u.id);
      } catch (e) { alert('删除用户失败：' + e.message); }
    },
    /** 用户注册时间显示为本地 `YYYY-MM-DD HH:mm`。 */
    fmtDate(iso) {
      if (!iso) return '--';
      const d = new Date(iso);
      if (isNaN(d.getTime())) return '--';
      const p = (n) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
    },
    /** 登录成功后启动轮询与舞台测量。 */
    startApp() {
      this.$nextTick(() => this.measureStage());
      if (!this.measureObs && typeof ResizeObserver !== 'undefined' && this.$refs.stageBox) {
        this.measureObs = new ResizeObserver(() => this.measureStage());
        this.measureObs.observe(this.$refs.stageBox);
      }
      if (this.tab === 'users') this.loadUsers();
      this.refreshAll();
      if (!this.pollTimer) this.pollTimer = setInterval(() => this.refreshAll(), POLL_INTERVAL);
    },
    stopApp() {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    },

    async refreshPanels() {
      try {
        const res = await this.api('/api/panels');
        if (this.dragState) return;   // 拖拽中不覆盖本地位置，落手后统一保存
        this.panels = res.panels || [];
        this.widgets = res.widgets || [];
        // 选中/展开项失效（被删 / 初次加载）时回退到第一个面板
        if (!this.panels.some((p) => p.id === this.selectedPanelId)) {
          this.selectedPanelId = this.panels.length ? this.panels[0].id : null;
        }
        if (this.expandedPanelId && !this.panels.some((p) => p.id === this.expandedPanelId)) {
          this.expandedPanelId = null;
        }
        this.autoPlaceWidgets();       // 旧数据/新添加的重叠小面板自动摆开
        this.ensureWidgetCharts();     // 随轮询更新曲线（last_seen 变化即重拉）
      } catch (e) { console.warn('刷新面板失败', e); }
    },
    /** 可添加的节点（订阅主题池），供侧边栏「添加节点」下拉使用。 */
    async refreshAvailableNodes() {
      try {
        const res = await this.api('/api/panels/nodes');
        this.availableNodes = res.nodes || [];
      } catch (e) { console.warn('刷新可用节点失败', e); }
    },
    /** 服务端连接对象 → 可编辑的本地连接对象（补瞬态字段）。 */
    normalizeConn(s) {
      return {
        id: s.id,
        name: s.name,
        host: s.host,
        port: s.port,
        username: s.username || '',
        password_set: !!s.password_set,
        enabled: !!s.enabled,
        connected: !!s.connected,
        last_error: s.last_error || null,
        topics: Array.isArray(s.topics) ? s.topics.map((t) => ({ topic: t.topic, name: t.name || '', type: t.type || 'thermo', latest: t.latest || null })) : [],
        password: '',       // 瞬态：明文密码不回显
        newTopic: '',       // 瞬态：待添加主题输入
        newTopicName: '',   // 瞬态：待添加主题的节点名字
        newTopicType: 'thermo', // 瞬态：待添加主题的类型
        saving: false,      // 瞬态：保存中标记
        showConfig: false,  // 瞬态：服务器配置折叠状态（默认收起）
      };
    },
    async refreshMqtt() {
      try {
        const res = await this.api('/api/mqtt');
        const server = res.connections || [];
        // 服务端已不存在的本地连接删掉
        this.mqttConns = this.mqttConns.filter((local) => server.some((s) => s.id === local.id));
        // 已存在的只刷新状态字段，避免轮询打断正在编辑的表单
        for (const s of server) {
          const local = this.mqttConns.find((c) => c.id === s.id);
          if (local) {
            local.connected = !!s.connected;
            local.last_error = s.last_error || null;
            local.password_set = !!s.password_set;
            // 只刷新每主题的最新节点数据（数据/时间/状态），不覆盖用户正在编辑的名字/类型
            for (const st of s.topics) {
              const lt = local.topics.find((t) => t.topic === st.topic);
              if (lt) lt.latest = st.latest;
            }
          } else {
            this.mqttConns.push(this.normalizeConn(s));
          }
        }
        this.mqttConns.sort((a, b) => a.id - b.id);
      } catch (e) { console.warn('刷新 MQTT 配置失败', e); }
    },
    /** 保存单条连接（PUT 全字段 + 非空密码）。成功后应用服务端权威状态。 */
    async saveMqttConn(conn) {
      if (!conn.name.trim()) { alert('连接名不能为空'); return; }
      if (!conn.host.trim()) { alert('服务器地址不能为空'); return; }
      const port = Number(conn.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        alert('端口需为 1-65535 的整数'); return;
      }
      conn.saving = true;
      try {
        const body = {
          name: conn.name,
          host: conn.host,
          port,
          username: conn.username,
          topics: conn.topics,
          enabled: conn.enabled,
        };
        if (conn.password) body.password = conn.password; // 留空则不修改
        const updated = await this.api(`/api/mqtt/${conn.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const newTopic = conn.newTopic;
        const newTopicName = conn.newTopicName;
        const newTopicType = conn.newTopicType;
        const showConfig = conn.showConfig;
        Object.assign(conn, this.normalizeConn(updated));
        conn.newTopic = newTopic;
        conn.newTopicName = newTopicName;
        conn.newTopicType = newTopicType;
        conn.showConfig = showConfig;
      } catch (e) {
        alert('保存连接失败：' + e.message);
      } finally {
        conn.saving = false;
      }
    },
    async addMqttConn() {
      this.addingConn = true;
      try {
        const created = await this.api('/api/mqtt', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: '新连接', host: '127.0.0.1', port: 1883, username: '', topics: [], enabled: true }),
        });
        const conn = this.normalizeConn(created);
        conn.showConfig = true;   // 新连接默认展开配置，便于立即编辑
        this.mqttConns.push(conn);
      } catch (e) {
        alert('添加连接失败：' + e.message);
      } finally {
        this.addingConn = false;
      }
    },
    async removeMqttConn(conn) {
      if (!confirm(`确定删除连接「${conn.name}」？`)) return;
      try {
        await this.api(`/api/mqtt/${conn.id}`, { method: 'DELETE' });
        this.mqttConns = this.mqttConns.filter((c) => c.id !== conn.id);
      } catch (e) {
        alert('删除连接失败：' + e.message);
      }
    },
    /** 启用开关只提交 {enabled}，避免连带提交未保存的表单内容。 */
    async toggleConnEnabled(conn) {
      try {
        const updated = await this.api(`/api/mqtt/${conn.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: conn.enabled }),
        });
        conn.connected = !!updated.connected;
        conn.last_error = updated.last_error || null;
      } catch (e) {
        conn.enabled = !conn.enabled;   // 失败回滚
        alert('切换连接状态失败：' + e.message);
      }
    },
    /** 向某条连接追加一个主题并即时提交：去空白、校验合法性、去重。 */
    async addConnTopic(conn) {
      const t = conn.newTopic.trim();
      if (!t) return;
      if (!isValidMqttTopic(t)) { alert('主题不合法：' + t); return; }
      if (conn.topics.some((x) => x.topic === t)) {
        alert('该主题已存在：' + t);
        return;
      }
      conn.topics.push({ topic: t, name: conn.newTopicName.trim(), type: conn.newTopicType || 'thermo' });
      conn.newTopic = '';
      conn.newTopicName = '';
      conn.newTopicType = 'thermo';
      await this.applyTopics(conn);
    },
    async removeConnTopic(conn, i) {
      const [removed] = conn.topics.splice(i, 1);
      if (!(await this.applyTopics(conn))) {
        conn.topics.push(removed);   // 服务端拒绝时回滚
      }
    },
    /** 主题增删即时生效：只提交主题列表，服务端对在线连接增量订阅、不重连。 */
    applyTopics(conn) {
      // 同一连接的多次主题修改串行提交，避免乱序覆盖
      if (!conn._topicChain) conn._topicChain = Promise.resolve();
      const run = async () => {
        try {
          const updated = await this.api(`/api/mqtt/${conn.id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ topics: conn.topics }),
          });
          conn.topics = updated.topics;   // 采纳服务端归一化结果（去空、去重、截断）
          this.refreshPanels();            // 同步主面板小面板
          this.refreshAvailableNodes();    // 同步可添加的节点池
          return true;
        } catch (e) {
          alert('更新主题失败：' + e.message);
          return false;
        }
      };
      const p = conn._topicChain.then(run, run);
      conn._topicChain = p.then(() => {}, () => {});
      return p;
    },
    async clearMqttPassword(conn) {
      try {
        await this.api(`/api/mqtt/${conn.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ clear_password: true }),
        });
        conn.password = '';
        conn.password_set = false;
      } catch (e) { alert('清除密码失败：' + e.message); }
    },

    async refreshAll() {
      if (this.refreshing) return;
      this.refreshing = true;
      try {
        await Promise.all([this.refreshPanels(), this.refreshAvailableNodes()]);
        if (this.tab === 'subs') {
          await this.refreshMqtt();
        }
      } finally {
        this.refreshing = false;
      }
    },

    switchTab(t) {
      this.tab = t;
      if (t === 'users') this.loadUsers();         // 进入用户管理页刷新列表
      this.$nextTick(() => this.measureStage());   // 主/订阅页切换后重测舞台尺寸
      this.refreshAll();
    },

    // ---------- 侧边栏宽度拖拽 ----------
    /** 开始拖拽调节侧边栏宽度（pointer 事件同时覆盖鼠标/触摸）。 */
    startRailResize(e) {
      e.preventDefault();
      this.railResizing = true;
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      const onMove = (ev) => {
        const w = window.innerWidth - ev.clientX;
        this.sideRailWidth = Math.min(this.sideRailMax, Math.max(this.sideRailMin, w));
      };
      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        this.railResizing = false;
        try { localStorage.setItem('monitor.sideRailWidth', String(this.sideRailWidth)); } catch (err) { /* 忽略 */ }
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
    },

    // ---------- 主舞台小面板：自由布局（拖动/缩放） ----------
    /** 小面板渲染样式：舞台坐标 × 缩放系数 → 屏幕像素。 */
    widgetStyle(w) {
      const s = this.stageScale || 1;
      return {
        left: (w.x * s) + 'px',
        top: (w.y * s) + 'px',
        width: (w.w * s) + 'px',
        height: (w.h * s) + 'px',
      };
    },
    /** 测量主舞台容器尺寸，更新虚拟舞台缩放系数（等比缩放居中）。 */
    measureStage() {
      const box = this.$refs.stageBox;
      if (!box) return;
      const w = box.clientWidth;
      const h = box.clientHeight;
      this.stageScale = w > 0 && h > 0 ? Math.min(w / STAGE_W, h / STAGE_H) : 1;
      this.ensureWidgetCharts();   // 面板缩放变化 → 尺寸足够/不足时图表随之出现/隐藏
    },
    /** 开始拖动小面板：命中四边手柄 → 调整大小（对边固定、被拖边跟随），否则移动位置（仅面板未锁定）。 */
    startWidgetDrag(e, w) {
      if (!this.panelEditable) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;   // 仅左键
      e.preventDefault();
      const handle = e.target.closest('.resize-edge');
      const edge = handle ? handle.getAttribute('data-edge') : null;
      this.dragState = {
        id: w.id,
        mode: edge ? 'resize' : 'move',
        edge,
        startX: e.clientX,
        startY: e.clientY,
        origX: w.x, origY: w.y, origW: w.w, origH: w.h,
      };
      e.currentTarget.setPointerCapture(e.pointerId);
      const CURSORS = { left: 'ew-resize', right: 'ew-resize', top: 'ns-resize', bottom: 'ns-resize' };
      e.currentTarget.style.cursor = edge ? CURSORS[edge] : 'grabbing';
    },
    onWidgetDrag(e, w) {
      const d = this.dragState;
      if (!d || d.id !== w.id) return;
      e.preventDefault();
      const s = this.stageScale || 1;
      const dx = (e.clientX - d.startX) / s;   // 屏幕位移 → 舞台坐标位移
      const dy = (e.clientY - d.startY) / s;
      const snap = (v) => Math.round(v / SNAP) * SNAP;   // 吸附到 10px 网格
      if (d.mode === 'move') {
        w.x = snap(Math.min(Math.max(d.origX + dx, 0), STAGE_W - w.w));
        w.y = snap(Math.min(Math.max(d.origY + dy, 0), STAGE_H - w.h));
        return;
      }
      // 四边缩放：对边固定，被拖边跟随鼠标（左/上边同时改动坐标与尺寸，右/下边只改尺寸）
      switch (d.edge) {
        case 'left':
          w.x = snap(Math.min(Math.max(d.origX + dx, 0), d.origX + d.origW - WIDGET_MIN_W));
          w.w = d.origX + d.origW - w.x;
          break;
        case 'right':
          w.w = snap(Math.min(Math.max(d.origW + dx, WIDGET_MIN_W), STAGE_W - d.origX));
          break;
        case 'top':
          w.y = snap(Math.min(Math.max(d.origY + dy, 0), d.origY + d.origH - WIDGET_MIN_H));
          w.h = d.origY + d.origH - w.y;
          break;
        case 'bottom':
          w.h = snap(Math.min(Math.max(d.origH + dy, WIDGET_MIN_H), STAGE_H - d.origY));
          break;
      }
    },
    endWidgetDrag(e, w) {
      const d = this.dragState;
      if (!d || d.id !== w.id) return;
      this.dragState = null;
      e.currentTarget.style.cursor = '';
      if (w.x === d.origX && w.y === d.origY && w.w === d.origW && w.h === d.origH) return;  // 没动
      this.saveWidgetLayout(w);
    },
    /** 保存小面板布局（PUT，后端会做边界夹取）。 */
    async saveWidgetLayout(w) {
      try {
        await this.api(`/api/panels/widgets/${w.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ x: Math.round(w.x), y: Math.round(w.y), w: Math.round(w.w), h: Math.round(w.h) }),
        });
      } catch (e) { console.warn('保存小面板布局失败', e); }
    },
    /** 旧数据/新添加的小面板初始坐标重叠时，自动按网格摆开并持久化（一次性，摆开后不再重叠）。 */
    autoPlaceWidgets() {
      const GAP = 30, MARGIN = 20;   // 均为 10 的倍数，保证自动摆开的网格也对齐
      const snap = (v) => Math.round(v / SNAP) * SNAP;
      const byPanel = new Map();
      for (const w of this.widgets) {
        if (!byPanel.has(w.panel_id)) byPanel.set(w.panel_id, []);
        byPanel.get(w.panel_id).push(w);
      }
      for (const [panelId, ws] of byPanel) {
        const panel = this.panels.find((p) => p.id === panelId);
        if (panel && panel.locked) continue;   // 锁定面板不自动改布局
        const overlaps = (a, b) =>
          !(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y);
        const used = [];
        const moved = [];
        for (const w of ws) {
          // 先把坐标/尺寸吸附到 10px 网格（同时夹取边界），保证已保存的位置也对齐
          const nw = snap(Math.min(Math.max(w.w, WIDGET_MIN_W), STAGE_W));
          const nh = snap(Math.min(Math.max(w.h, WIDGET_MIN_H), STAGE_H));
          const nx = snap(Math.min(Math.max(w.x, 0), STAGE_W - nw));
          const ny = snap(Math.min(Math.max(w.y, 0), STAGE_H - nh));
          if (nx !== w.x || ny !== w.y || nw !== w.w || nh !== w.h) {
            w.x = nx; w.y = ny; w.w = nw; w.h = nh;
            moved.push(w);
          }
          if (!used.some((u) => overlaps(u, w))) {   // 吸附后位置未被占用：保持原样
            used.push({ x: w.x, y: w.y, w: w.w, h: w.h });
            continue;
          }
          let placed = false;
          for (let row = 0; row < 50 && !placed; row++) {
            for (let col = 0; col < 50; col++) {
              const slot = { x: MARGIN + col * (w.w + GAP), y: MARGIN + row * (w.h + GAP), w: w.w, h: w.h };
              if (slot.x + slot.w > STAGE_W || slot.y + slot.h > STAGE_H) break;
              if (!used.some((u) => overlaps(u, slot))) {
                if (slot.x !== w.x || slot.y !== w.y) { w.x = slot.x; w.y = slot.y; moved.push(w); }
                used.push(slot);
                placed = true;
                break;
              }
            }
          }
          if (!placed) used.push({ x: w.x, y: w.y, w: w.w, h: w.h });
        }
        for (const w of moved) this.saveWidgetLayout(w);
      }
    },

    // ---------- 面板 / 节点小面板管理 ----------
    /** 节点小面板显示名：优先节点名字，其次主题。 */
    widgetName(w) {
      return (w && (w.name || w.topic)) || '未命名';
    },
    selectPanel(panel) {
      this.selectedPanelId = panel.id;
    },
    /** 面板行点击：选中 + 展开/收起其小面板列表。 */
    onPanelRowClick(panel) {
      this.selectPanel(panel);
      this.expandedPanelId = this.expandedPanelId === panel.id ? null : panel.id;
    },
    widgetsOf(panelId) {
      return this.widgets.filter((w) => w.panel_id === panelId);
    },
    /** 某面板还没添加过的可添加节点。 */
    availableForPanel(panelId) {
      const taken = new Set(this.widgetsOf(panelId).map((w) => w.connection_id + '|' + w.topic));
      return this.availableNodes.filter((n) => !taken.has(n.connection_id + '|' + n.topic));
    },
    async addPanel() {
      try {
        const panel = await this.api('/api/panels', { method: 'POST' });
        this.panels.push(panel);
        this.selectedPanelId = panel.id;   // 新建后主舞台立即显示
      } catch (e) {
        alert('添加面板失败：' + e.message);
      }
    },
    async removePanel(panel) {
      if (panel.locked) return;
      if (!confirm(`确定删除面板「${panel.name}」？其内节点小面板将一并删除`)) return;
      try {
        await this.api(`/api/panels/${panel.id}`, { method: 'DELETE' });
        this.panels = this.panels.filter((p) => p.id !== panel.id);
        this.widgets = this.widgets.filter((w) => w.panel_id !== panel.id);
        if (this.widgetDetail && !this.widgets.some((w) => w.id === this.widgetDetail)) this.widgetDetail = null;
        if (this.selectedPanelId === panel.id) {
          this.selectedPanelId = this.panels.length ? this.panels[0].id : null;
        }
      } catch (e) {
        alert('删除面板失败：' + e.message);
      }
    },
    /** 锁定/解锁面板：锁定后禁止改名、删除、增删小面板（仍可查看）。 */
    async togglePanelLock(panel) {
      try {
        const updated = await this.api(`/api/panels/${panel.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ locked: !panel.locked }),
        });
        const target = this.panels.find((p) => p.id === panel.id);
        if (target) Object.assign(target, updated);
      } catch (e) {
        alert('切换锁定失败：' + e.message);
      }
    },
    /** 开始改名：进入行内编辑。 */
    startRename(panel) {
      if (panel.locked) return;
      this.renamingPanelId = panel.id;
      this.renameText = panel.name;
    },
    async saveRename(panel) {
      const name = this.renameText.trim();
      if (!name) { this.cancelRename(); return; }
      try {
        const updated = await this.api(`/api/panels/${panel.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name }),
        });
        const target = this.panels.find((p) => p.id === panel.id);
        if (target) Object.assign(target, updated);
      } catch (e) {
        alert('重命名失败：' + e.message);
      }
      this.renamingPanelId = null;
      this.renameText = '';
    },
    cancelRename() {
      this.renamingPanelId = null;
      this.renameText = '';
    },
    /** 展开面板里「添加节点」下拉触发。 */
    onAddWidget(panel) {
      const idx = this.newWidgetIndex;
      this.newWidgetIndex = -1;
      if (idx < 0) return;
      const node = this.availableForPanel(panel.id)[idx];
      if (node) this.addWidget(panel, node);
    },
    async addWidget(panel, node) {
      try {
        const w = await this.api(`/api/panels/${panel.id}/widgets`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ connection_id: node.connection_id, topic: node.topic }),
        });
        this.widgets.push(w);
      } catch (e) {
        alert('添加节点小面板失败：' + e.message);
      }
    },
    async removeWidget(widget) {
      if (!confirm(`确定删除节点小面板「${this.widgetName(widget)}」？`)) return;
      try {
        await this.api(`/api/panels/widgets/${widget.id}`, { method: 'DELETE' });
        this.widgets = this.widgets.filter((w) => w.id !== widget.id);
        delete this.widgetCharts[widget.id];   // 清理曲线缓存
        if (this.widgetDetail === widget.id) this.widgetDetail = null;   // 详情弹窗目标被删 → 关闭
      } catch (e) {
        alert('删除节点小面板失败：' + e.message);
      }
    },

    // ---------- 图表设置与曲线 ----------
    /** 打开某节点小面板的图表设置弹窗（默认值取当前设置，缺省视为开）。 */
    openWidgetSettings(w) {
      this.widgetSettings = {
        widgetId: w.id,
        name: this.widgetName(w),
        show_temp: w.show_temp !== false,
        show_hum: w.show_hum !== false,
        show_bat: w.show_bat !== false,
        chart_range: w.chart_range || '1d',
        saving: false,
      };
    },
    closeWidgetSettings() {
      this.widgetSettings = null;
    },

    // ---------- 节点小面板详情大弹窗（双击锁定面板的小面板打开；点击弹窗外空白处自动关闭） ----------
    /** 双击节点小面板：仅面板锁定时打开详情大弹窗（解锁态双击保留给拖动/缩放，不干扰）。 */
    onWidgetDblclick(w) {
      if (this.panelEditable) return;
      this.openWidgetDetail(w);
    },
    openWidgetDetail(w) {
      this.widgetDetail = w.id;
      this.detailRange = '1d';   // 默认近 1 天
      this.ensureWidgetCharts();   // 立即拉取详情图表数据（面板放不下小图表时也要拉）
    },
    closeWidgetDetail() {
      this.widgetDetail = null;
      this.detailHover = null;
    },
    /** 详情大弹窗时间范围下拉变化：清掉旧范围缓存并按新范围重拉（避免短暂显示旧范围数据）。 */
    onDetailRangeChange() {
      if (this.widgetDetail) delete this.widgetCharts[this.widgetDetail];
      this.detailHover = null;
      this.ensureWidgetCharts();
    },

    // ---------- 详情大弹窗曲线十字线 ----------
    /** 鼠标在曲线图上移动：记录十字线位置（夹到数据区，保证线不越界）。 */
    onDetailChartMove(e, key) {
      const rect = e.currentTarget.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const X = 100, Y = 60, P = 2;
      const rx = (e.clientX - rect.left) / rect.width * X;
      const ry = (e.clientY - rect.top) / rect.height * Y;
      this.detailHover = {
        key,
        x: Math.min(Math.max(rx, P), X - P),
        y: Math.min(Math.max(ry, P), Y - P),
      };
    },
    onDetailChartLeave() {
      this.detailHover = null;
    },
    /** 十字线 x 轴时间标签：按鼠标 x 位置换算窗口内时间，格式随窗口跨度自适应。 */
    timeAtX(h) {
      const w = this.detailWidget;
      if (!w || !h) return null;
      const win = this.chartWindow(w);
      if (!win) return null;
      const X = 100, P = 2;
      const t = win.t0 + ((h.x - P) / (X - P * 2)) * win.span;
      return this.fmtCrossTime(t, win.span);
    },
    /** 十字线 y 轴数值标签：按鼠标 y 位置换算该曲线圆整刻度区间内的数值。 */
    yValueAt(h, key) {
      const w = this.detailWidget;
      if (!w || !h) return '--';
      const yr = this.seriesYRange(w, key);
      if (!yr) return '--';
      const Y = 60, P = 2;
      const v = yr.yHi - ((h.y - P) / (Y - P * 2)) * (yr.yHi - yr.yLo);
      return this.fmtY(v, key, this.tickDecimals(yr.step, key));   // 与刻度标签一致的小数位
    },
    /** 十字线时间格式化：<1 天只显示时分，<3 个月显示月日时分，更长显示日期。 */
    fmtCrossTime(t, span) {
      const d = new Date(t);
      if (isNaN(d.getTime())) return '--';
      const p = (n) => String(n).padStart(2, '0');
      const hhmm = p(d.getHours()) + ':' + p(d.getMinutes());
      if (span <= 24 * 3600e3) return hhmm;
      if (span <= 90 * 24 * 3600e3) return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${hhmm}`;
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    },
    crosshairDotStyle(h) {
      return { left: (h.x / 100 * 100) + '%', top: (h.y / 60 * 100) + '%' };
    },
    crosshairYStyle(h) {
      return { top: (h.y / 60 * 100) + '%', transform: 'translateY(-50%)' };
    },
    crosshairXStyle(h) {
      const pct = (h.x / 100 * 100) + '%';
      const transform = h.x < 14 ? 'translateX(0)' : h.x > 86 ? 'translateX(-100%)' : 'translateX(-50%)';
      return { left: pct, transform };
    },
    /** 保存图表设置（显示开关 + 时间范围；PUT；面板锁定不拦截——显示偏好，非结构性修改）。 */
    async saveWidgetSettings() {
      const s = this.widgetSettings;
      if (!s) return;
      s.saving = true;
      try {
        const updated = await this.api(`/api/panels/widgets/${s.widgetId}/settings`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            show_temp: s.show_temp,
            show_hum: s.show_hum,
            show_bat: s.show_bat,
            chart_range: s.chart_range,
          }),
        });
        const w = this.widgets.find((x) => x.id === s.widgetId);
        if (w) {
          w.show_temp = updated.show_temp;
          w.show_hum = updated.show_hum;
          w.show_bat = updated.show_bat;
          w.chart_range = updated.chart_range;
        }
        this.closeWidgetSettings();
        this.ensureWidgetCharts();   // 立即按新设置拉取/隐藏图表
      } catch (e) {
        alert('保存图表设置失败：' + e.message);
      } finally {
        s.saving = false;
      }
    },
    /** 某图表开关是否打开（缺省视为开，兼容旧数据）。 */
    chartFlag(w, key) {
      return w ? w[key] !== false : true;
    },
    /** 该面板能显示几个曲线：按剩余高度计算，放不下就少显示前面的几个，绝不挤压/滚动。 */
    chartCount(w) {
      const s = this.stageScale || 1;
      if ((w.w * s) < CHART_MIN_W) return 0;
      const avail = (w.h * s) - CHART_INFO_H;
      if (avail < CHART_ROW_MIN) return 0;
      const enabled = (this.chartFlag(w, 'show_temp') ? 1 : 0)
                    + (this.chartFlag(w, 'show_hum') ? 1 : 0)
                    + (this.chartFlag(w, 'show_bat') ? 1 : 0);
      return Math.max(0, Math.min(enabled, Math.floor(avail / CHART_ROW_MIN)));
    },
    /** 面板是否显示图表区（至少能放下一个曲线）。 */
    showCharts(w) {
      return this.chartCount(w) > 0;
    },
    /** 按顺序返回实际要显示的曲线 key（温度→湿度→电量，多出的放不下就不显示）。 */
    chartsToShow(w) {
      const keys = [];
      if (this.chartFlag(w, 'show_temp')) keys.push('temperature');
      if (this.chartFlag(w, 'show_hum')) keys.push('humidity');
      if (this.chartFlag(w, 'show_bat')) keys.push('battery');
      return keys.slice(0, this.chartCount(w));
    },
    /** 曲线 key → 样式类名（temp/hum/bat）。 */
    miniChartClass(key) {
      return key === 'temperature' ? 'temp' : key === 'humidity' ? 'hum' : 'bat';
    },
    /** 曲线 key → 中文标题。 */
    miniChartLabel(key) {
      return key === 'temperature' ? '温度' : key === 'humidity' ? '湿度' : '电量';
    },
    /** 拉取当前面板里需要展示曲线的图表数据（缓存未过期且数据未更新则跳过，防并发）。
     * 详情大弹窗固定展示三条曲线：按弹窗选中的时间范围单独拉取，不受面板尺寸/显示开关影响。 */
    ensureWidgetCharts() {
      for (const w of this.widgetsOfSelected) {
        if (w._chartFetching) continue;
        const isDetail = this.widgetDetail === w.id;
        const range = isDetail ? this.detailRange : (w.chart_range || '1d');
        if (!isDetail) {
          const need = this.chartFlag(w, 'show_temp') || this.chartFlag(w, 'show_hum') || this.chartFlag(w, 'show_bat');
          if (!need || !this.showCharts(w)) continue;
        }
        const cache = this.widgetCharts[w.id];
        // 时间范围改变时即使数据未更新也重拉（窗口不同数据不同）
        if (cache && cache.range === range
            && cache.lastSeen === w.last_seen && (Date.now() - cache.fetchedAt) < CHART_REFRESH_MS) continue;
        w._chartFetching = true;
        this.fetchWidgetChart(w, range).finally(() => { w._chartFetching = false; });
      }
    },
    async fetchWidgetChart(w, range) {
      try {
        const r = range || w.chart_range || '1d';
        const res = await this.api(`/api/panels/widgets/${w.id}/telemetry?limit=${CHART_LIMIT}&range=${encodeURIComponent(r)}`);
        this.widgetCharts = {
          ...this.widgetCharts,
          [w.id]: { points: res.points || [], range: r, lastSeen: w.last_seen, fetchedAt: Date.now() },
        };
      } catch (e) {
        console.warn('刷新图表数据失败', e);
      }
    },
    /** 某条曲线的有效数据点是否 ≥ 2（可绘制）。 */
    hasSpark(w, key) {
      const cache = this.widgetCharts[w.id];
      if (!cache || !cache.points) return false;
      return cache.points.filter((p) => typeof p[key] === 'number' && Number.isFinite(p[key])).length >= 2;
    },
    /** 曲线时间窗口（毫秒）：右端锚定最新数据点、向左铺满所选时间范围（如近 1 天）。
     * 窗口与已拉取数据的 range 一致，保证时间轴始终显示完整的所选范围（数据稀疏时左侧留空）。 */
    chartWindow(w) {
      const cache = this.widgetCharts[w.id];
      const pts = cache ? cache.points : [];
      const range = chartRangeMs((cache && cache.range) || (w.chart_range || '1d'));
      let t1 = null;
      for (const p of pts) {
        const t = Date.parse(p.received_at);
        if (!Number.isNaN(t) && (t1 === null || t > t1)) t1 = t;
      }
      if (t1 === null) return null;
      return { t0: t1 - range, t1, span: range };
    },
    /** 自适应时间刻度步长：按窗口跨度从阶梯里选「步长 ≤ 跨度/目标段数」的第一档（5m~6M）。 */
    pickTimeStep(span, target) {
      const M = 60e3, H = 3600e3, D = 24 * H;
      const ladder = [
        5 * M, 15 * M, 30 * M, 1 * H, 2 * H, 3 * H, 6 * H, 12 * H,
        1 * D, 2 * D, 3 * D, 7 * D, 15 * D, 30 * D, 60 * D, 90 * D, 180 * D,
      ];
      for (const s of ladder) {
        if (span / s <= target) return s;
      }
      return 365 * D;
    },
    /** 相对时长 → 紧凑标签：15m / 6h / 3d / 1M / 1Y。 */
    fmtAgo(ms) {
      const min = ms / 60000;
      if (min < 60) return Math.round(min) + 'm';
      const h = min / 60;
      if (h < 24) return (Number.isInteger(h) ? h : h.toFixed(1)) + 'h';
      const d = h / 24;
      if (d < 30) return (Number.isInteger(d) ? d : d.toFixed(1)) + 'd';
      const mon = d / 30;
      if (mon < 12) return Math.round(mon) + 'M';
      return Math.round(mon / 12) + 'Y';
    },
    /** x 轴时间刻度：锚定窗口最新时间向左铺开；x 为 0..100 坐标系位置，标签为距最新点的相对时长（右端=现在）。 */
    xTicksFor(w, key) {
      const win = this.chartWindow(w);
      if (!win) return [];
      const step = this.pickTimeStep(win.span, 5);
      const W = 100, P = 2;
      const raw = [];
      for (let k = 0; k <= 12; k++) {
        const t = win.t1 - k * step;
        if (t < win.t0 - step * 1e-6) break;
        raw.push({ t, k });
      }
      raw.reverse();   // 左 → 右
      const n = raw.length;
      return raw.map((tk, i) => {
        const x = P + ((tk.t - win.t0) / win.span) * (W - P * 2);
        const left = (x / 100) * 100;
        // 首尾刻度贴边对齐，避免文字被裁切；中间居中
        const transform = i === 0 ? 'translateX(0)'
          : i === n - 1 ? 'translateX(-100%)'
          : 'translateX(-50%)';
        return {
          x,
          label: tk.k === 0 ? '现在' : this.fmtAgo(win.t1 - tk.t),
          style: { left: left + '%', transform },
        };
      });
    },
    /** 曲线纵轴「好看」范围：以圆整刻度把数据 min/max 完全包住（下界 ≤min、上界 ≥max），且 ≥3 个刻度。
     * 返回刻度列表与刻度步长（供网格、曲线与标签小数位共用同一坐标）。
     * 注意：范围必须覆盖数据区间，否则曲线尖峰/谷底会超出 y 轴被裁切。 */
    seriesYRange(w, key) {
      const cache = this.widgetCharts[w.id];
      const pts = cache ? cache.points : [];
      let lo = null, hi = null;
      for (const p of pts) {
        const v = p[key];
        if (typeof v !== 'number' || !Number.isFinite(v)) continue;
        if (lo === null || v < lo) lo = v;
        if (hi === null || v > hi) hi = v;
      }
      if (lo === null) return null;
      // 最小「有意义」跨度：数据波动低于它时按常量向两侧撑开——既保证能出 ≥3 个可读刻度，
      // 也避免把亚传感器分辨率的噪声放大成满幅波动（同时范围始终包住数据，曲线不会顶出边界）。
      const minSpan = key === 'temperature' ? 0.5 : key === 'humidity' ? 2 : 0.1;
      const span = hi - lo;
      if (span < minSpan) {
        const pad = (minSpan - span) / 2;
        lo -= pad; hi += pad;
      }
      // 圆整步长：向下取 1/2/2.5/5 × 10^n
      const niceStep = (raw) => {
        if (!(raw > 0)) return 1e-9;
        const pow = Math.pow(10, Math.floor(Math.log10(raw)));
        const mag = raw / pow;
        const n = mag < 1.5 ? 1 : mag < 3 ? 2 : mag < 3.5 ? 2.5 : mag < 7 ? 5 : 10;
        return n * pow;
      };
      // 目标 ~2 步覆盖数据；不足 3 刻度则缩半步长重算。下界取 ≤lo 的最大刻度、上界取 ≥hi 的最小刻度。
      let step = niceStep((hi - lo) / 2);
      let yLo = null, yHi = null;
      for (let guard = 0; guard < 60; guard++) {
        const a = Math.floor(lo / step + 1e-9) * step;
        const b = Math.ceil(hi / step - 1e-9) * step;
        if (b - a >= step * 2 - 1e-9) {   // 至少 3 个刻度
          yLo = a; yHi = b;
          break;
        }
        step = niceStep(step * 0.5);
      }
      if (yLo === null) return null;
      const ticks = [];
      for (let v = yLo; v <= yHi + step * 1e-6; v += step) ticks.push(v);
      if (ticks.length < 3) ticks.push(yHi);   // 浮点边界兜底：保证 ≥3
      return { yLo: ticks[0], yHi: ticks[ticks.length - 1], ticks, step };
    },
    /** y 轴刻度值（≥3 个）：位置随网格线，首尾贴边、中间居中，避免重叠/裁切。 */
    yTicksFor(w, key) {
      const r = this.seriesYRange(w, key);
      if (!r) return [];
      let ticks = r.ticks;
      if (ticks.length > 4) {               // 过密抽稀：首尾 + 两等分中间，仍 ≥3 个
        const len = ticks.length;
        const idxs = Array.from(new Set([0, len - 1,
          Math.round((len - 1) / 3), Math.round((len - 1) * 2 / 3)])).sort((a, b) => a - b);
        ticks = idxs.map((i) => ticks[i]);
      }
      const H = 60, P = 2;
      const n = ticks.length;
      const decimals = this.tickDecimals(r.step, key);
      return ticks.map((v, i) => {
        const y = P + (H - P * 2) * (1 - (v - r.yLo) / (r.yHi - r.yLo));
        let style;
        if (i === 0) style = { bottom: '1px' };                       // 底部刻度贴边
        else if (i === n - 1) style = { top: '1px' };                 // 顶部刻度贴边
        else style = { top: (y / H * 100) + '%', transform: 'translateY(-50%)' };
        return { v, y, label: this.fmtY(v, key, decimals), style };
      });
    },
    /** 刻度标签小数位：保证相邻刻度显示互不相同——步长越小小数位越多（step ≥ 10^-d 时 d 位可区分），
     * 同时不低于各量程的自然精度（温度 1 位、电量 2 位、湿度取整）。 */
    tickDecimals(step, key) {
      const base = key === 'temperature' ? 1 : key === 'battery' ? 2 : 0;
      const need = step >= 1 ? 0 : Math.min(3, Math.ceil(-Math.log10(step)));
      return Math.max(base, need);
    },
    /** 刻度数值格式化：小数位随刻度步长自适应（窄范围自动增位，避免标签重复如 25.3、25.3）；湿度 y 轴显示百分比。 */
    fmtY(v, key, decimals) {
      if (key === 'humidity') {
        return (decimals > 0 ? v.toFixed(decimals) : String(Math.round(v))) + '%';
      }
      return v.toFixed(decimals);   // temperature / battery
    },
    /** 生成 0..100 × 0..60 坐标系内的迷你折线 points：x 按真实时间、y 按圆整刻度区间，与网格线一致。 */
    sparkPoints(w, key) {
      const cache = this.widgetCharts[w.id];
      const pts = cache ? cache.points : [];
      const vals = pts.filter((p) => typeof p[key] === 'number' && Number.isFinite(p[key]));
      if (vals.length < 2) return '';
      const r = this.seriesYRange(w, key);
      const win = this.chartWindow(w);
      if (!r) return '';
      const W = 100, H = 60, P = 2;
      const xOf = (p, i) => {
        if (win) {
          const t = Date.parse(p.received_at);
          if (!Number.isNaN(t)) return P + ((t - win.t0) / win.span) * (W - P * 2);
        }
        return P + (i / (vals.length - 1)) * (W - P * 2);   // 兜底：无有效时间戳时按索引均分
      };
      return vals.map((p, i) => {
        const x = xOf(p, i);
        const y = P + (H - P * 2) * (1 - (p[key] - r.yLo) / (r.yHi - r.yLo));
        return x.toFixed(2) + ',' + y.toFixed(2);
      }).join(' ');
    },

    // ---------- 格式化 ----------
    fmtTemp(t) {
      if (t == null) return '--';
      return t.toFixed(1) + ' °C';
    },
    batteryText(panel) {
      const b = panel.battery;
      if (b == null || b <= 0.01) return '--';   // ADC 未启用时为 0
      return b.toFixed(2) + ' V';
    },
    fmtSeen(iso) {
      const d = new Date(iso);
      if (isNaN(d.getTime())) return '--';
      const diffMin = Math.round((Date.now() - d.getTime()) / 60000);
      if (diffMin < 1) return '刚刚';
      if (diffMin < 60) return diffMin + ' 分钟前';
      if (diffMin < 1440) return Math.round(diffMin / 60) + ' 小时前';
      return d.toLocaleDateString('zh-CN');
    },
  },

  async mounted() {
    // 恢复上次保存的侧边栏宽度
    try {
      const saved = parseInt(localStorage.getItem('monitor.sideRailWidth'), 10);
      if (Number.isFinite(saved) && saved >= this.sideRailMin && saved <= this.sideRailMax) {
        this.sideRailWidth = saved;
      }
    } catch (err) { /* 忽略 */ }
    // 点击页面其他区域时收起右上角用户菜单
    this._closeMenu = (e) => {
      if (this.userMenuOpen && !(e.target && e.target.closest && e.target.closest('.user-area'))) {
        this.userMenuOpen = false;
      }
    };
    document.addEventListener('click', this._closeMenu);
    // Esc 关闭详情大弹窗
    this._closeDetailEsc = (e) => {
      if (e.key === 'Escape' && this.widgetDetail) this.closeWidgetDetail();
    };
    document.addEventListener('keydown', this._closeDetailEsc);
    // 恢复登录态：本地有 token 则调 /api/auth/me 校验，有效则直接进入主界面
    let savedAuth = null;
    try { savedAuth = JSON.parse(localStorage.getItem('monitor.auth')); } catch (err) { /* 忽略 */ }
    if (savedAuth && savedAuth.token) {
      try {
        const res = await fetch('/api/auth/me', { headers: { Authorization: 'Bearer ' + savedAuth.token } });
        if (res.ok) {
          const me = await res.json();
          this.setAuth(savedAuth.token, me.username, me.role, me.userId);
          this.startApp();
          return;
        }
      } catch (err) { /* 网络异常 → 停在登录页 */ }
      try { localStorage.removeItem('monitor.auth'); } catch (err) { /* 忽略 */ }
    }
  },
  beforeUnmount() {
    clearInterval(this.pollTimer);
    this.pollTimer = null;
    if (this.measureObs) { this.measureObs.disconnect(); this.measureObs = null; }
    if (this._closeMenu) document.removeEventListener('click', this._closeMenu);
    if (this._closeDetailEsc) document.removeEventListener('keydown', this._closeDetailEsc);
  },
}).mount('#app');
