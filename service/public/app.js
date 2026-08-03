/* 全屋温湿度监控 —— 前端逻辑（Vue 3 全局版，免构建） */
const { createApp } = Vue;

const POLL_INTERVAL = 10000;      // 数据刷新周期（节点 5 分钟一报，10s 足够）
const SAVE_DEBOUNCE = 400;        // 拖拽保存防抖（毫秒）
const GRID = 5;                   // 布局吸附网格（像素）：位置 xy 与大小 wh 都对齐到网格
const MIN_W = 120;                // 面板最小宽度（像素，与 CSS min-width 一致）
const MIN_H = 90;                 // 面板最小高度（像素，与 CSS min-height 一致）

function clamp(v, lo, hi) {
  return Math.min(Math.max(v, lo), hi);
}
/** 吸附到 GRID 像素网格：取最近的倍数。 */
function snapPx(v) {
  return Math.round(v / GRID) * GRID;
}
/** 像素 → 百分比（0~100），保留 4 位小数，避免存储过长的浮点尾巴。 */
function toPct(px, stage) {
  return Math.round((px / stage) * 1000000) / 10000;
}

createApp({
  data() {
    return {
      tab: 'main',
      nodes: [],                 // 全部节点（订阅页信息列表用）
      panels: [],                // 主页面节点面板（一个订阅主题 = 一个面板）
      settings: { background: null, lock_all: false },
      drag: null,                // 拖拽状态
      saveTimer: null,
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
    stageStyle() {
      if (this.settings.background) {
        return {
          backgroundImage: `url(${this.settings.background})`,
          backgroundSize: 'cover',
          backgroundPosition: 'center',
        };
      }
      return {};
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
        showConfig: false,  // 瞬态：服务器配置折叠状态（默认收起，节点区始终可见）
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
    /** 向某条连接的待保存主题列表追加一个主题：去空白、去重。 */
    addConnTopic(conn) {
      const t = conn.newTopic.trim();
      if (!t) return;
      if (conn.topics.some((x) => x.topic === t)) {
        alert('该主题已存在：' + t);
        return;
      }
      conn.topics.push({ topic: t, name: conn.newTopicName.trim(), type: conn.newTopicType || 'thermo' });
      conn.newTopic = '';
      conn.newTopicName = '';
      conn.newTopicType = 'thermo';
    },
    removeConnTopic(conn, i) {
      conn.topics.splice(i, 1);
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
        left: panel.x + '%',
        top: panel.y + '%',
        width: panel.w + '%',
        height: panel.h + '%',
        cursor: this.settings.lock_all ? 'default' : 'grab',
      };
    },

    startDrag(e, panel) {
      if (this.settings.lock_all) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;   // 仅左键
      e.preventDefault();
      const stage = e.currentTarget.parentElement;
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
        stageW: stage.clientWidth,
        stageH: stage.clientHeight,
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
        // 固定左上角，右下角吸附网格 → 宽度/高度为 5px 倍数
        const xPx = (d.origX / 100) * d.stageW;
        const yPx = (d.origY / 100) * d.stageH;
        const rightPx = snapPx(xPx + (d.origW / 100) * d.stageW + dx);
        const bottomPx = snapPx(yPx + (d.origH / 100) * d.stageH + dy);
        const wPx = clamp(rightPx - xPx, MIN_W, d.stageW - xPx);
        const hPx = clamp(bottomPx - yPx, MIN_H, d.stageH - yPx);
        panel.w = toPct(wPx, d.stageW);
        panel.h = toPct(hPx, d.stageH);
      } else {
        // 移动：位置 xy 吸附到 5px 网格
        const maxXPx = d.stageW - (panel.w / 100) * d.stageW;
        const maxYPx = d.stageH - (panel.h / 100) * d.stageH;
        const xPx = clamp(snapPx((d.origX / 100) * d.stageW + dx), 0, maxXPx);
        const yPx = clamp(snapPx((d.origY / 100) * d.stageH + dy), 0, maxYPx);
        panel.x = toPct(xPx, d.stageW);
        panel.y = toPct(yPx, d.stageH);
      }
    },

    endDrag(e, panel) {
      const d = this.drag;
      if (!d || d.id !== panel.id) return;
      this.drag = null;
      d.el.style.cursor = '';
      this.scheduleSave(panel);
    },

    scheduleSave(panel) {
      if (this.saveTimer) clearTimeout(this.saveTimer);
      this.saveTimer = setTimeout(() => this.saveLayout(panel), SAVE_DEBOUNCE);
    },

    async saveLayout(panel) {
      try {
        const saved = await this.api(`/api/panels/${panel.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ x: panel.x, y: panel.y, w: panel.w, h: panel.h }),
        });
        Object.assign(panel, saved);
      } catch (e) { console.warn('保存面板布局失败', e); }
    },

    // ---------- 锁定 / 背景 ----------
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

    async uploadBackground(event) {
      const file = event.target.files[0];
      event.target.value = '';
      if (!file) return;
      const form = new FormData();
      form.append('file', file);
      try {
        const res = await this.api('/api/settings/background', { method: 'POST', body: form });
        this.settings.background = res.background;
      } catch (e) {
        alert('背景图上传失败：' + e.message);
      }
    },

    async removeBackground() {
      try {
        this.settings = await this.api('/api/settings', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ background: null }),
        });
      } catch (e) { console.warn('移除背景失败', e); }
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
    if (this.saveTimer) clearTimeout(this.saveTimer);
  },
}).mount('#app');
