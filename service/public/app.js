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
      tab: 'main',
      nodes: [],                 // 全部节点（订阅页信息列表用）
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
    };
  },

  computed: {
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
    // 未关联到任何连接（连接被删 / 旧数据迁移）的节点，按网关分组展示
    unassignedNodes() {
      return this.nodes
        .filter((n) => (n.connection_id ?? null) == null)
        .sort((a, b) => a.gateway_id - b.gateway_id || a.device_id - b.device_id);
    },
    unassignedGroups() {
      const groups = [];
      const byGateway = new Map();
      for (const n of this.unassignedNodes) {
        if (!byGateway.has(n.gateway_id)) {
          const g = { gateway_id: n.gateway_id, nodes: [] };
          byGateway.set(n.gateway_id, g);
          groups.push(g);
        }
        byGateway.get(n.gateway_id).nodes.push(n);
      }
      return groups;
    },
  },

  methods: {
    /** 节点复合键：(gateway_id, device_id)。 */
    nodeKey(n) {
      return n.gateway_id + '/' + n.device_id;
    },

    async api(path, opts) {
      const res = await fetch(path, opts);
      if (!res.ok) {
        let detail = res.status;
        try { detail = (await res.json()).detail || res.status; } catch (e) { /* ignore */ }
        throw new Error(detail);
      }
      return res.json();
    },

    async refreshNodes() {
      try { this.nodes = await this.api('/api/nodes'); }
      catch (e) { console.warn('刷新节点失败', e); }
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
        topics: Array.isArray(s.topics) ? s.topics.map((t) => ({ topic: t.topic, name: t.name || '', type: t.type || 'thermo' })) : [],
        password: '',       // 瞬态：明文密码不回显
        newTopic: '',       // 瞬态：待添加主题输入
        newTopicName: '',   // 瞬态：待添加主题的节点名字
        newTopicType: 'thermo', // 瞬态：待添加主题的类型
        saving: false,      // 瞬态：保存中标记
        showConfig: false,  // 瞬态：服务器配置折叠状态（默认收起）
        showNodes: false,   // 瞬态：节点列表折叠状态（默认收起，可展开）
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
          } else {
            this.mqttConns.push(this.normalizeConn(s));
          }
        }
        this.mqttConns.sort((a, b) => a.id - b.id);
      } catch (e) { console.warn('刷新 MQTT 配置失败', e); }
    },
    /** 某条连接上报的节点列表（connection_id 与该连接 id 精确匹配）。 */
    nodesForConn(connId) {
      return this.nodes.filter((n) => (n.connection_id ?? null) === connId);
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
        const showNodes = conn.showNodes;
        Object.assign(conn, this.normalizeConn(updated));
        conn.newTopic = newTopic;
        conn.newTopicName = newTopicName;
        conn.newTopicType = newTopicType;
        conn.showConfig = showConfig;
        conn.showNodes = showNodes;
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
        await Promise.all([this.refreshNodes(), this.refreshPanels(), this.refreshAvailableNodes()]);
        if (this.tab === 'subs') {
          await this.refreshMqtt();
        }
      } finally {
        this.refreshing = false;
      }
    },

    switchTab(t) {
      this.tab = t;
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
    },
    /** 开始拖动小面板：命中右下角手柄 → 调整大小，否则移动位置（仅面板未锁定）。 */
    startWidgetDrag(e, w) {
      if (!this.panelEditable) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;   // 仅左键
      e.preventDefault();
      const resize = !!e.target.closest('.resize-handle');
      this.dragState = {
        id: w.id,
        mode: resize ? 'resize' : 'move',
        startX: e.clientX,
        startY: e.clientY,
        origX: w.x, origY: w.y, origW: w.w, origH: w.h,
      };
      e.currentTarget.setPointerCapture(e.pointerId);
      e.currentTarget.style.cursor = resize ? 'nwse-resize' : 'grabbing';
    },
    onWidgetDrag(e, w) {
      const d = this.dragState;
      if (!d || d.id !== w.id) return;
      e.preventDefault();
      const s = this.stageScale || 1;
      const dx = (e.clientX - d.startX) / s;   // 屏幕位移 → 舞台坐标位移
      const dy = (e.clientY - d.startY) / s;
      const snap = (v) => Math.round(v / SNAP) * SNAP;   // 吸附到 10px 网格
      if (d.mode === 'resize') {
        // 固定左上角，右下角跟随鼠标；夹取最小/最大尺寸后再吸附
        w.w = snap(Math.min(Math.max(d.origW + dx, WIDGET_MIN_W), STAGE_W - d.origX));
        w.h = snap(Math.min(Math.max(d.origH + dy, WIDGET_MIN_H), STAGE_H - d.origY));
      } else {
        w.x = snap(Math.min(Math.max(d.origX + dx, 0), STAGE_W - w.w));
        w.y = snap(Math.min(Math.max(d.origY + dy, 0), STAGE_H - w.h));
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
      } catch (e) {
        alert('删除节点小面板失败：' + e.message);
      }
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

  mounted() {
    // 恢复上次保存的侧边栏宽度
    try {
      const saved = parseInt(localStorage.getItem('monitor.sideRailWidth'), 10);
      if (Number.isFinite(saved) && saved >= this.sideRailMin && saved <= this.sideRailMax) {
        this.sideRailWidth = saved;
      }
    } catch (err) { /* 忽略 */ }
    // 舞台等比缩放：随容器尺寸变化实时重算（窗口缩放 / 侧边栏拖宽都会触发）
    this.measureStage();
    if (typeof ResizeObserver !== 'undefined') {
      this.measureObs = new ResizeObserver(() => this.measureStage());
      if (this.$refs.stageBox) this.measureObs.observe(this.$refs.stageBox);
    }
    this.refreshAll();
    this.pollTimer = setInterval(() => this.refreshAll(), POLL_INTERVAL);
  },
  beforeUnmount() {
    clearInterval(this.pollTimer);
    if (this.measureObs) this.measureObs.disconnect();
  },
}).mount('#app');
