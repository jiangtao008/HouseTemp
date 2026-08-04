/* 全屋温湿度监控 —— 前端逻辑（Vue 3 全局版，免构建） */
const { createApp } = Vue;

const POLL_INTERVAL = 10000;      // 数据刷新周期（节点 5 分钟一报，10s 足够）
const GRID = 5;                   // 布局吸附网格（像素）：位置 xy 与大小 wh 都对齐到网格
const MIN_W = 120;                // 面板最小宽度（像素，与 CSS min-width 一致）
const MIN_H = 90;                 // 面板最小高度（像素，与 CSS min-height 一致）
// 主页面虚拟舞台尺寸（像素）：面板位置/大小以此为固定坐标系，与浏览器窗口大小无关。
// 注意：服务端 service/db.js 的 STAGE_W/STAGE_H 需与此保持一致。
const STAGE_W = 2560;
const STAGE_H = 1440;

function clamp(v, lo, hi) {
  return Math.min(Math.max(v, lo), hi);
}
/** 吸附到 GRID 像素网格：取最近的倍数。 */
function snapPx(v) {
  return Math.round(v / GRID) * GRID;
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
      tab: 'main',
      nodes: [],                 // 全部节点（订阅页信息列表用）
      panels: [],                // 主页面节点面板（一个订阅主题 = 一个面板）
      settings: { lock_all: false },
      sideRailCollapsed: false,  // 主页面右侧边栏折叠状态（默认展开）
      drag: null,                // 拖拽状态
      pollTimer: null,
      refreshing: false,
      mqttConns: [],            // MQTT 连接列表（每条含瞬态编辑字段 password/newTopic/saving）
      addingConn: false,
    };
  },

  computed: {
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
    async refreshSettings() {
      try { this.settings = await this.api('/api/settings'); }
      catch (e) { console.warn('刷新设置失败', e); }
    },
    async refreshPanels() {
      try {
        const res = await this.api('/api/panels');
        this.panels = res.panels || [];
      } catch (e) { console.warn('刷新面板失败', e); }
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
          this.refreshPanels();            // 同步增删对应的主面板
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
        await Promise.all([this.refreshNodes(), this.refreshSettings(), this.refreshPanels()]);
        if (this.tab === 'subs') {
          await this.refreshMqtt();
        }
      } finally {
        this.refreshing = false;
      }
    },

    switchTab(t) {
      this.tab = t;
      this.refreshAll();
    },

    // ---------- 面板布局 / 拖拽 ----------
    panelStyle(panel) {
      return {
        left: panel.x + 'px',
        top: panel.y + 'px',
        width: panel.w + 'px',
        height: panel.h + 'px',
        cursor: this.settings.lock_all ? 'default' : 'grab',
      };
    },

    startDrag(e, panel) {
      if (this.settings.lock_all) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;   // 仅左键
      e.preventDefault();
      const resize = !!e.target.closest('.resize-handle');       // 从右下角手柄开始 → 调整大小
      this.drag = {
        id: panel.id,
        mode: resize ? 'resize' : 'move',
        startX: e.clientX,
        startY: e.clientY,
        origX: panel.x,
        origY: panel.y,
        origW: panel.w,
        origH: panel.h,
        stageW: STAGE_W,   // 固定虚拟舞台，不受窗口大小影响
        stageH: STAGE_H,
        el: e.currentTarget,
      };
      e.currentTarget.setPointerCapture(e.pointerId);
      e.currentTarget.style.cursor = resize ? 'nwse-resize' : 'grabbing';
    },

    onDrag(e, panel) {
      const d = this.drag;
      if (!d || d.id !== panel.id) return;
      e.preventDefault();
      const dx = e.clientX - d.startX;
      const dy = e.clientY - d.startY;

      if (d.mode === 'resize') {
        // 固定左上角，右下角吸附网格 → 宽度/高度为 5px 倍数（像素坐标系，单位即像素）
        const rightPx = snapPx(d.origX + d.origW + dx);
        const bottomPx = snapPx(d.origY + d.origH + dy);
        const wPx = clamp(rightPx - d.origX, MIN_W, d.stageW - d.origX);
        const hPx = clamp(bottomPx - d.origY, MIN_H, d.stageH - d.origY);
        panel.w = wPx;
        panel.h = hPx;
      } else {
        // 移动：位置 xy 吸附到 5px 网格（像素坐标系）
        const maxXPx = d.stageW - panel.w;
        const maxYPx = d.stageH - panel.h;
        panel.x = clamp(snapPx(d.origX + dx), 0, maxXPx);
        panel.y = clamp(snapPx(d.origY + dy), 0, maxYPx);
      }
    },

    endDrag(e, panel) {
      const d = this.drag;
      if (!d || d.id !== panel.id) return;
      this.drag = null;
      d.el.style.cursor = '';
      // 一次手势只松手一次，无需防抖；立即保存避免轮询窗口内被服务端旧值覆盖
      this.saveLayout(panel);
    },

    async saveLayout(panel) {
      const sent = { x: panel.x, y: panel.y, w: panel.w, h: panel.h };
      try {
        const saved = await this.api(`/api/panels/${panel.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(sent),
        });
        // 保存期间该面板又被拖动过（值已变）则不覆盖本地新值，等待下一次保存
        if (panel.x === sent.x && panel.y === sent.y && panel.w === sent.w && panel.h === sent.h) {
          Object.assign(panel, saved);
        }
      } catch (e) { console.warn('保存面板布局失败', e); }
    },

    // ---------- 锁定 ----------
    async toggleLock() {
      const next = !this.settings.lock_all;
      try {
        this.settings = await this.api('/api/settings', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ lock_all: next }),
        });
      } catch (e) { console.warn('保存锁定状态失败', e); }
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
    this.refreshAll();
    this.pollTimer = setInterval(() => this.refreshAll(), POLL_INTERVAL);
  },
  beforeUnmount() {
    clearInterval(this.pollTimer);
  },
}).mount('#app');
