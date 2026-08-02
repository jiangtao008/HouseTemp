/* 全屋温湿度监控 —— 前端逻辑（Vue 3 全局版，免构建） */
const { createApp } = Vue;

const POLL_INTERVAL = 10000;      // 数据刷新周期（节点 5 分钟一报，10s 足够）
const SAVE_DEBOUNCE = 400;        // 拖拽保存防抖（毫秒）

function clamp(v, lo, hi) {
  return Math.min(Math.max(v, lo), hi);
}

createApp({
  data() {
    return {
      tab: 'main',
      nodes: [],                 // 全部节点（含未订阅）
      layouts: {},               // device_id -> {x,y,w,h}（百分比）
      settings: { background: null, lock_all: false },
      status: { mqtt_connected: false, mqtt_last_error: null, node_count: 0 },
      drag: null,                // 拖拽状态
      saveTimer: null,
      pollTimer: null,
      refreshing: false,
      showMqttSettings: false,
      mqttForm: { host: '127.0.0.1', port: 1883, username: '', password: '', password_set: false, connected: false },
      mqttSaving: false,
    };
  },

  computed: {
    allNodes() {
      return [...this.nodes].sort((a, b) => a.device_id - b.device_id);
    },
    subscribedNodes() {
      return this.nodes.filter((n) => n.subscribed);
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
    async refreshLayouts() {
      try {
        const { layouts } = await this.api('/api/layout');
        const map = {};
        for (const l of layouts) map[l.node_id] = l;
        this.layouts = map;
      } catch (e) { console.warn('刷新布局失败', e); }
    },
    async refreshStatus() {
      try { this.status = await this.api('/api/status'); }
      catch (e) { console.warn('刷新状态失败', e); }
    },
    async refreshMqtt() {
      try {
        const m = await this.api('/api/mqtt');
        this.mqttForm.host = m.host;
        this.mqttForm.port = m.port;
        this.mqttForm.username = m.username || '';
        this.mqttForm.password_set = m.password_set;
        this.mqttForm.connected = m.connected;
        // 不重置 password 输入框，避免轮询时打断用户输入
      } catch (e) { console.warn('刷新 MQTT 配置失败', e); }
    },
    async saveMqtt() {
      this.mqttSaving = true;
      try {
        const body = {
          host: this.mqttForm.host,
          port: this.mqttForm.port,
          username: this.mqttForm.username,
        };
        if (this.mqttForm.password) body.password = this.mqttForm.password; // 留空则不修改
        await this.api('/api/mqtt', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        this.mqttForm.password = '';
        await this.refreshMqtt();
        this.refreshStatus();
      } catch (e) {
        alert('保存 MQTT 配置失败：' + e.message);
      } finally {
        this.mqttSaving = false;
      }
    },
    async clearMqttPassword() {
      try {
        await this.api('/api/mqtt', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            host: this.mqttForm.host,
            port: this.mqttForm.port,
            username: this.mqttForm.username,
            clear_password: true,
          }),
        });
        await this.refreshMqtt();
      } catch (e) { alert('清除密码失败：' + e.message); }
    },

    /** 为已订阅但尚无布局行的节点初始化默认面板位置并落库 */
    async ensureLayouts() {
      for (let i = 0; i < this.subscribedNodes.length; i++) {
        const node = this.subscribedNodes[i];
        if (this.layouts[node.device_id]) continue;
        const col = i % 4, row = Math.floor(i / 4);
        try {
          const saved = await this.api(`/api/layout/${node.device_id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ x: 6 + col * 24, y: 8 + row * 28, w: 20, h: 24 }),
          });
          this.layouts[saved.node_id] = saved;
        } catch (e) { console.warn('初始化面板位置失败', e); }
      }
    },

    async refreshAll() {
      if (this.refreshing) return;
      this.refreshing = true;
      try {
        await Promise.all([this.refreshNodes(), this.refreshSettings(), this.refreshLayouts()]);
        await this.ensureLayouts();
        if (this.tab === 'subs') {
          await Promise.all([this.refreshStatus(), this.refreshMqtt()]);
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
    layoutFor(node, index) {
      const l = this.layouts[node.device_id];
      if (l) return l;
      const col = index % 4, row = Math.floor(index / 4);
      return { x: 6 + col * 24, y: 8 + row * 28, w: 20, h: 24 };
    },

    panelStyle(node, index) {
      const l = this.layoutFor(node, index);
      return {
        left: l.x + '%',
        top: l.y + '%',
        width: l.w + '%',
        height: l.h + '%',
        cursor: this.settings.lock_all ? 'default' : 'grab',
      };
    },

    startDrag(e, node) {
      if (this.settings.lock_all) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;   // 仅左键
      const l = this.layouts[node.device_id];
      if (!l) return;
      e.preventDefault();
      const stage = e.currentTarget.parentElement;
      this.drag = {
        nodeId: node.device_id,
        startX: e.clientX,
        startY: e.clientY,
        origX: l.x,
        origY: l.y,
        stageW: stage.clientWidth,
        stageH: stage.clientHeight,
        el: e.currentTarget,
      };
      e.currentTarget.setPointerCapture(e.pointerId);
      e.currentTarget.style.cursor = 'grabbing';
    },

    onDrag(e, node) {
      const d = this.drag;
      if (!d || d.nodeId !== node.device_id) return;
      e.preventDefault();
      const l = this.layouts[node.device_id];
      if (!l) return;
      const dx = ((e.clientX - d.startX) / d.stageW) * 100;
      const dy = ((e.clientY - d.startY) / d.stageH) * 100;
      l.x = clamp(d.origX + dx, 0, 100 - l.w);
      l.y = clamp(d.origY + dy, 0, 100 - l.h);
    },

    endDrag(e, node) {
      const d = this.drag;
      if (!d || d.nodeId !== node.device_id) return;
      this.drag = null;
      d.el.style.cursor = '';
      this.scheduleSave(node.device_id);
    },

    scheduleSave(deviceId) {
      if (this.saveTimer) clearTimeout(this.saveTimer);
      this.saveTimer = setTimeout(() => this.saveLayout(deviceId), SAVE_DEBOUNCE);
    },

    async saveLayout(deviceId) {
      const l = this.layouts[deviceId];
      if (!l) return;
      try {
        const saved = await this.api(`/api/layout/${deviceId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ x: l.x, y: l.y, w: l.w, h: l.h }),
        });
        this.layouts[deviceId] = saved;
      } catch (e) { console.warn('保存布局失败', e); }
    },

    // ---------- 订阅 / 改名 ----------
    editableName(node) {
      if (node.display_name) return node.display_name;
      if (node.name && node.name !== 'Unnamed') return node.name;
      return '';
    },

    async setSubscribed(node, event) {
      const sub = event.target.checked;
      try {
        const updated = await this.api(`/api/nodes/${node.device_id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ subscribed: sub }),
        });
        Object.assign(node, updated);
      } catch (e) {
        event.target.checked = !sub;   // 失败回滚
        console.warn('设置订阅失败', e);
      }
    },

    async renameNode(node, event) {
      const value = event.target.value.trim();
      try {
        const updated = await this.api(`/api/nodes/${node.device_id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ display_name: value || null }),
        });
        Object.assign(node, updated);
      } catch (e) { console.warn('改名失败', e); }
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
        const res = await this.api('/api/background', { method: 'POST', body: form });
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
      if (t == null) return '—';
      return t.toFixed(1) + ' °C';
    },
    batteryText(node) {
      const b = node.battery;
      if (b == null || b <= 0.01) return '—';   // ADC 未启用时为 0
      return b.toFixed(2) + ' V';
    },
    fmtSeen(iso) {
      const d = new Date(iso);
      if (isNaN(d.getTime())) return '—';
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
