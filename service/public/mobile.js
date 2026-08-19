/* 全屋温湿度监控 —— 手机视图（宫格展示 + 布局编辑）
 * 复用主界面登录态（localStorage.monitor.auth），轮询读 /api/panels。
 * 查看模式：宫格多列展示（每面板可配列数），点卡片进详情、左右滑动切面板、页内纵向滚动。
 * 编辑模式：长按卡片进入，拖拽卡片按宫格插入位移重排，列数可调；顺序/列数落库（与桌面 2560×1440 布局独立）。
 * 布局编辑仅改移动端 grid_order/grid_cols，不影响桌面主页面。 */
const { createApp } = Vue;

const POLL_INTERVAL = 10000;   // 数据刷新周期（与主页面一致）
const CHART_LIMIT = 300;       // 曲线目标点数（后端抽稀）
const LONG_PRESS_MS = 450;     // 长按进入编辑模式的判定时长
const DRAG_SLOP = 10;          // 长按检测的位移阈值（px），超过视为滚动/取消
const COL_OPTIONS = [1, 2, 3, 4];   // 宫格列数可选值（服务端按 1..6 收紧）

// 图表时间范围选项（与主页面 / 服务端白名单一致）
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
function chartRangeMs(range) {
  const r = CHART_RANGES.find((x) => x.key === range);
  return r ? r.ms : 24 * 3600e3;
}

createApp({
  data() {
    return {
      token: '',                    // Bearer token（复用主界面登录态）
      needsLogin: false,            // 未登录 / 会话失效 → 显示登录弹窗
      authBusy: false,              // 登录/注册请求进行中
      authError: '',                // 登录/注册错误提示
      loginTab: 'login',            // 登录弹窗当前 Tab：'login' | 'register'
      loginForm: { username: '', password: '' },
      registerForm: { username: '', password: '', confirm: '', regCode: '' },
      username: '',                 // 当前用户名（顶部用户菜单）
      role: '',                     // 当前用户角色
      userId: null,                 // 当前用户 id
      avatar: '',                   // 当前用户头像 URL（/uploads/xxx；空=显示用户名首字符）
      userMenuOpen: false,          // 顶部用户下拉菜单
      changePwdOpen: false,         // 修改密码弹窗
      changePwdSaving: false,       // 修改密码请求进行中
      changePwdError: '',           // 修改密码错误提示
      changePwdForm: { oldPassword: '', newPassword: '' },   // 修改密码表单（旧密码 + 新密码）
      changeAvatarOpen: false,      // 修改头像弹窗
      changeAvatarSaving: false,    // 修改头像上传请求进行中
      changeAvatarError: '',        // 修改头像错误提示
      avatarPreview: '',            // 修改头像弹窗里的本地图片预览（objectURL）
      avatarFile: null,             // 修改头像弹窗里选中的文件
      panels: [],                   // 面板容器（一次一个，横向分页）
      widgets: [],                  // 节点小面板
      currentIndex: 0,              // 当前显示的面板索引
      detailId: null,               // 详情页当前小面板 id（null = 未打开）
      detailRange: '1d',            // 详情曲线时间范围
      detailPoints: [],             // 详情曲线数据点
      refreshing: false,            // 轮询去重
      pollTimer: null,
      // ---- 宫格布局编辑 ----
      editPanelId: null,            // 正在编辑布局的面板 id（null = 查看模式）
      editCols: 2,                  // 编辑中面板的宫格列数（工作值）
      editOrder: [],                // 编辑中面板的宫格顺序（小面板 id 数组，工作值）
      dragId: null,                 // 正在拖拽的小面板 id
      dragPointerId: null,          // 拖拽指针 id
      dragIndex: null,              // 拖拽小面板当前所处槽位索引
      dragX: 0, dragY: 0,           // 浮动卡片位置（视口坐标，卡片左上角）
      dragOffsetX: 0, dragOffsetY: 0, // 手指相对卡片左上角的抓取偏移
      dragWidth: 0,                 // 浮动卡片宽度
      cardH: 0,                     // 卡片行高（卡片高 + 间距），拖拽开始时测量
      gridEl: null,                 // 当前面板的宫格容器元素
      pageEl: null,                 // 当前面板的滚动容器元素
      _lp: null,                    // 长按检测状态
      _lpLast: null,                // 长按指针最近位置
      _dragStartOrder: [],          // 拖拽开始时的顺序（判断是否有变化）
    };
  },

  computed: {
    COL_OPTIONS() { return COL_OPTIONS; },
    // 用户头像兜底文字：未设置头像时显示用户名首个字符
    userAvatarText() {
      return this.username ? this.username.charAt(0).toUpperCase() : '?';
    },
    currentPanel() {
      return this.panels[this.currentIndex] || null;
    },
    prevPanel() {
      return this.currentIndex > 0 ? this.panels[this.currentIndex - 1] : null;
    },
    nextPanel() {
      return this.currentIndex < this.panels.length - 1 ? this.panels[this.currentIndex + 1] : null;
    },
    detailWidget() {
      return this.widgets.find((w) => w.id === this.detailId) || null;
    },
    detailChartKeys() {
      return ['temperature', 'humidity', 'battery'];
    },
    chartRanges() {
      return CHART_RANGES;
    },
    /** 详情曲线时间窗口：右端锚定最新数据点、向左铺满所选时间范围。 */
    detailWin() {
      let t1 = null;
      for (const p of this.detailPoints) {
        const t = Date.parse(p.received_at);
        if (!Number.isNaN(t) && (t1 === null || t > t1)) t1 = t;
      }
      if (t1 === null) return null;
      return { t0: t1 - chartRangeMs(this.detailRange), t1, span: chartRangeMs(this.detailRange) };
    },
    /** x 轴时间刻度：锚定窗口最新时间向左铺开（右端 = 最新数据时刻，标签为绝对时间）。 */
    xTicks() {
      const win = this.detailWin;
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
        const transform = i === 0 ? 'translateX(0)'
          : i === n - 1 ? 'translateX(-100%)'
          : 'translateX(-50%)';
        return { x, label: this.fmtTickTime(tk.t, win), style: { left: left + '%', transform } };
      });
    },
    // ---- 拖拽浮动卡片 ----
    ghostWidget() {
      if (this.dragId == null) return null;
      return this.widgets.find((w) => w.id === this.dragId) || null;
    },
    ghostName() {
      const w = this.ghostWidget;
      return w ? this.widgetName(w) : '';
    },
    ghostStale() {
      return !!(this.ghostWidget && this.ghostWidget.stale);
    },
    ghostTemp() {
      return this.fmtTemp(this.ghostWidget ? this.ghostWidget.temperature : null);
    },
    ghostHum() {
      const w = this.ghostWidget;
      return w && w.humidity != null ? w.humidity + ' %' : '--';
    },
    ghostBat() {
      return this.batteryText(this.ghostWidget);
    },
    ghostStyle() {
      return { left: this.dragX + 'px', top: this.dragY + 'px', width: this.dragWidth + 'px' };
    },
    ghostClass() {
      return (this.ghostWidget && this.ghostWidget.stale) ? { stale: true } : {};
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
        if (res.status === 401) { this.showLogin(); throw new Error('未登录'); }
        throw new Error(detail);
      }
      return res.json();
    },

    // ---------- 认证（移动端登录弹窗，复用主界面接口与 localStorage.monitor.auth 存储键） ----------
    startPolling() {
      this.refreshPanels();
      if (this.pollTimer) clearInterval(this.pollTimer);
      this.pollTimer = setInterval(() => this.refreshPanels(), POLL_INTERVAL);
    },
    showLogin() {
      if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
      this.token = '';
      this.username = ''; this.role = ''; this.userId = null; this.avatar = '';
      this.userMenuOpen = false;
      this.changePwdOpen = false; this.changeAvatarOpen = false;
      try { localStorage.removeItem('monitor.auth'); } catch (e) { /* ignore */ }
      this.needsLogin = true;
      this.authError = '';
      this.loginTab = 'login';
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
        this.setAuthed(data);
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
      const regCode = this.registerForm.regCode.trim();
      if (!username || !password) { this.authError = '请输入用户名和密码'; return; }
      if (password !== confirm) { this.authError = '两次输入的密码不一致'; return; }
      if (!regCode) { this.authError = '请输入注册码'; return; }
      this.authBusy = true; this.authError = '';
      try {
        const res = await fetch('/api/auth/register', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, password, regCode }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) { this.authError = data.detail || '注册失败'; return; }
        this.setAuthed(data);
      } catch (e) {
        this.authError = '网络错误：' + e.message;
      } finally {
        this.authBusy = false;
      }
    },
    /** 登录/注册成功：写与主界面同键的 localStorage（跨页共享登录态）→ 关弹窗 → 拉数据并轮询。 */
    setAuthed(data) {
      this.token = data.token;
      this.username = data.username || '';
      this.role = data.role || '';
      this.userId = data.userId != null ? data.userId : null;
      this.avatar = data.avatar || '';
      this.saveAuthLocal();
      this.needsLogin = false;
      this.authError = '';
      this.loginForm.password = '';
      this.registerForm = { username: '', password: '', confirm: '', regCode: '' };
      this.startPolling();
    },
    /** 持久化登录态到 localStorage（与主界面同键，跨页共享）。 */
    saveAuthLocal() {
      try {
        localStorage.setItem('monitor.auth', JSON.stringify({
          token: this.token, username: this.username, role: this.role, userId: this.userId, avatar: this.avatar,
        }));
      } catch (e) { /* ignore */ }
    },

    // ---------- 数据 ----------
    widgetsOf(panelId) {
      return this.widgets.filter((w) => w.panel_id === panelId)
        .sort((a, b) => (a.grid_order - b.grid_order) || (a.id - b.id));
    },
    widgetName(w) {
      return (w && (w.name || w.topic)) || '未命名';
    },
    async refreshPanels() {
      if (this.refreshing) return;
      this.refreshing = true;
      try {
        const res = await this.api('/api/panels');
        this.panels = res.panels || [];
        this.widgets = res.widgets || [];
        // 编辑模式中：保留工作顺序，只并入新增的小面板（避免轮询把未落库的拖拽结果冲掉）
        if (this.editPanelId !== null) {
          const cur = this.editOrder;
          const ids = this.widgets.filter((w) => w.panel_id === this.editPanelId).map((w) => w.id);
          const keep = cur.filter((id) => ids.includes(id));
          const added = ids.filter((id) => !keep.includes(id));
          this.editOrder = keep.concat(added);
        }
        // 当前面板被删 / 越界 → 回退到合法索引
        if (!this.panels.length) {
          this.currentIndex = 0;
        } else {
          this.currentIndex = Math.min(Math.max(this.currentIndex, 0), this.panels.length - 1);
        }
        // 分页器滚动位置与索引对齐（仅在明显偏离时校正，不打断滑动）
        const el = this.$refs.pager;
        if (el && this.panels.length && this.editPanelId === null) {
          const expect = this.currentIndex * el.clientWidth;
          if (Math.abs(el.scrollLeft - expect) > el.clientWidth / 2) el.scrollLeft = expect;
        }
        // 详情里的小面板被删 → 关闭详情；否则刷新详情曲线（新数据到达即更新）
        if (this.detailId && !this.widgets.some((w) => w.id === this.detailId)) {
          this.closeDetail(true);
        } else if (this.detailId) {
          this.fetchDetailChart();
        }
      } catch (e) {
        console.warn('刷新失败', e);
      } finally {
        this.refreshing = false;
      }
    },

    // ---------- 面板切换（箭头按钮 / 左右滑动） ----------
    /** 用户手指按下分页器：解除箭头平滑滚动期间的索引抑制，让滑动立即接管。 */
    onPagerPointerDown() {
      this._suppress = null;
    },
    onPagerScroll() {
      const el = this.$refs.pager;
      if (!el || !this.panels.length || this.editPanelId !== null) return;
      const ratio = el.scrollLeft / el.clientWidth;
      // 箭头平滑滚动中：保持目标索引，避免中间帧闪回；到达目标附近后解除
      if (this._suppress != null) {
        if (Math.abs(ratio - this._suppress) > 0.5) return;
        this._suppress = null;
        return;
      }
      const i = Math.round(ratio);
      if (i >= 0 && i < this.panels.length) this.currentIndex = i;
    },
    prev() {
      this.switchTo(this.currentIndex - 1);
    },
    next() {
      this.switchTo(this.currentIndex + 1);
    },
    /** 第一个面板无「上一个」时，左上角显示用户头像 → 点击弹出用户菜单。 */
    toggleUserMenu() {
      this.userMenuOpen = !this.userMenuOpen;
    },
    /** 菜单「PC页」→ 返回桌面主页面。 */
    goPC() {
      this.userMenuOpen = false;
      location.href = '/';
    },
    /** 菜单「退出登录」→ 清本地登录态并停留本页登录/注册弹窗，再调服务端注销。 */
    async logout() {
      const t = this.token;
      this.showLogin();
      if (t) {
        try { await fetch('/api/auth/logout', { method: 'POST', headers: { Authorization: 'Bearer ' + t } }); } catch (e) { /* ignore */ }
      }
    },

    // ---------- 修改密码（顶部用户菜单进入，与主界面同接口） ----------
    openChangePwd() {
      this.userMenuOpen = false;
      this.changePwdForm = { oldPassword: '', newPassword: '' };
      this.changePwdError = '';
      this.changePwdOpen = true;
    },
    closeChangePwd() {
      this.changePwdOpen = false;
      this.changePwdError = '';
    },
    /** 确认修改：前端基本校验，服务端先验证旧密码再更新；结果用 alert 提示。 */
    async saveChangePwd() {
      const oldPassword = this.changePwdForm.oldPassword;
      const newPassword = this.changePwdForm.newPassword;
      if (!oldPassword || !newPassword) { this.changePwdError = '请输入旧密码和新密码'; return; }
      if (newPassword.length < 6) { this.changePwdError = '新密码至少 6 位'; return; }
      this.changePwdSaving = true; this.changePwdError = '';
      try {
        await this.api('/api/auth/password', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ oldPassword, newPassword }),
        });
        this.changePwdOpen = false;
        this.changePwdError = '';
        alert('密码修改成功');
      } catch (e) {
        this.changePwdError = e.message;
      } finally {
        this.changePwdSaving = false;
      }
    },

    // ---------- 修改头像（顶部用户菜单进入，与主界面同接口） ----------
    openChangeAvatar() {
      this.userMenuOpen = false;
      this.changeAvatarError = '';
      this.avatarPreview = '';
      this.avatarFile = null;
      this.changeAvatarOpen = true;
    },
    closeChangeAvatar() {
      this.changeAvatarOpen = false;
      this.changeAvatarError = '';
      this.avatarPreview = '';
      this.avatarFile = null;
    },
    /** 选择头像文件：本地即时预览（不发起请求）；类型/大小不合法则清空并提示。 */
    onAvatarFileChange(e) {
      const file = e.target.files && e.target.files[0];
      this.avatarFile = file || null;
      this.changeAvatarError = '';
      if (!file) { this.avatarPreview = ''; return; }
      if (!/^image\/(png|jpe?g|gif|webp)$/.test(file.type)) {
        this.changeAvatarError = '仅支持 PNG / JPG / GIF / WebP 图片';
        this.avatarFile = null;
        this.avatarPreview = '';
        return;
      }
      if (file.size > 2 * 1024 * 1024) {
        this.changeAvatarError = '图片不能超过 2MB';
        this.avatarFile = null;
        this.avatarPreview = '';
        return;
      }
      this.avatarPreview = URL.createObjectURL(file);
    },
    /** 确认修改：multipart 上传头像，成功后刷新顶部头像并持久化登录态。 */
    async saveChangeAvatar() {
      if (!this.avatarFile) { this.changeAvatarError = '请先选择图片'; return; }
      this.changeAvatarSaving = true; this.changeAvatarError = '';
      try {
        const fd = new FormData();
        fd.append('avatar', this.avatarFile);
        const data = await this.api('/api/auth/avatar', { method: 'POST', body: fd });
        this.avatar = data.avatar;
        this.saveAuthLocal();
        this.closeChangeAvatar();
        alert('头像修改成功');
      } catch (e) {
        this.changeAvatarError = e.message;
      } finally {
        this.changeAvatarSaving = false;
      }
    },
    switchTo(i) {
      const el = this.$refs.pager;
      if (!el || !this.panels.length || this.editPanelId !== null) return;
      i = Math.min(Math.max(i, 0), this.panels.length - 1);
      this.currentIndex = i;
      this._suppress = i;
      el.scrollTo({ left: i * el.clientWidth, behavior: 'smooth' });
    },

    // ---------- 宫格布局（查看排序 + 长按编辑 + 拖拽插入位移） ----------
    /** 某面板的宫格渲染序列：编辑中的面板用工作顺序 editOrder，其余按 grid_order 排序。 */
    gridWidgets(panelId) {
      if (this.editPanelId === panelId) {
        const map = {};
        for (const w of this.widgets) map[w.id] = w;
        return this.editOrder.map((id) => map[id]).filter(Boolean);
      }
      return this.widgetsOf(panelId);
    },
    /** 宫格列数：编辑中的面板用工作值 editCols（切换列数立即生效），其余读面板配置。 */
    gridStyle(panelId) {
      let cols = 2;
      if (this.editPanelId === panelId) {
        cols = this.editCols;
      } else {
        const p = this.panels.find((x) => x.id === panelId);
        if (p && p.grid_cols) cols = p.grid_cols;
      }
      return { gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` };
    },
    onGridPointerDown(e) {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      const card = e.target.closest('.widget-card');
      if (!card) return;
      const wid = Number(card.getAttribute('data-wid'));
      if (!Number.isFinite(wid)) return;
      const page = card.closest('.page');
      if (!page || !this.currentPanel) return;
      if (Number(page.getAttribute('data-panel')) !== this.currentPanel.id) return;   // 滑动中途触碰其它页 → 忽略
      this.gridEl = e.currentTarget;
      this.pageEl = (this.$refs.pager && this.$refs.pager.children[this.currentIndex]) || null;
      if (this.editPanelId === this.currentPanel.id) {
        // 编辑模式：按下即开始拖拽
        if (e.cancelable) e.preventDefault();
        this.beginDrag(wid, e.pointerId, e.clientX, e.clientY);
        return;
      }
      if (this.editPanelId !== null) return;
      // 查看模式：开始长按检测
      this._lpLast = { x: e.clientX, y: e.clientY };
      this._lp = {
        pointerId: e.pointerId,
        widgetId: wid,
        panelId: this.currentPanel.id,
        startX: e.clientX,
        startY: e.clientY,
        timer: setTimeout(() => this.onLongPress(this.currentPanel.id, wid), LONG_PRESS_MS),
      };
    },
    onLongPress(panelId, wid) {
      const pid = this._lp ? this._lp.pointerId : null;
      const last = this._lpLast;
      this.clearLongPress();
      const panel = this.panels.find((p) => p.id === panelId);
      if (!panel) return;
      this.enterEditMode(panel);
      // 同一指针继续拖拽。注意：该手势在查看模式下 touch-action 为 pan-y，纵向拖动可能被浏览器
      // 接管成滚动（pointercancel）→ 拖拽中断；此时停在编辑模式，用户松开重新拖拽即可——
      // 编辑模式卡片已是 touch-action:none，新手势可全向拖拽。
      if (pid != null && last) this.beginDrag(wid, pid, last.x, last.y);
    },
    clearLongPress() {
      if (!this._lp) return;
      clearTimeout(this._lp.timer);
      this._lp = null;
    },
    enterEditMode(panel) {
      this.editPanelId = panel.id;
      this.editCols = panel.grid_cols || 2;
      this.editOrder = this.widgets
        .filter((w) => w.panel_id === panel.id)
        .sort((a, b) => (a.grid_order - b.grid_order) || (a.id - b.id))
        .map((w) => w.id);
    },
    exitEditMode() {
      this.editPanelId = null;
      this.editCols = 2;
      this.editOrder = [];
      this.dragId = null;
      this.dragPointerId = null;
      this.dragIndex = null;
      this._dragStartOrder = [];
    },
    /** 开始拖拽：网格内占位卡片隐藏（drag-src），浮动卡片跟随手指。 */
    beginDrag(wid, pointerId, x, y) {
      if (!this.gridEl || !this.editOrder.includes(wid)) return;
      const cardEl = this.gridEl.querySelector(`[data-wid="${wid}"]`);
      if (!cardEl) return;
      const rect = cardEl.getBoundingClientRect();
      const gap = parseFloat(getComputedStyle(this.gridEl).columnGap) || 10;
      this.dragPointerId = pointerId;
      this.dragId = wid;
      this.dragOffsetX = x - rect.left;
      this.dragOffsetY = y - rect.top;
      this.dragWidth = rect.width;
      this.cardH = rect.height + gap;
      this.dragX = x - this.dragOffsetX;
      this.dragY = y - this.dragOffsetY;
      this.dragIndex = this.editOrder.indexOf(wid);
      this._dragStartOrder = this.editOrder.slice();
    },
    onDragMove(e) {
      if (this.dragPointerId !== e.pointerId) return;
      this.dragX = e.clientX - this.dragOffsetX;
      this.dragY = e.clientY - this.dragOffsetY;
      this.autoScroll(e.clientY);
      const gridEl = this.gridEl;
      if (!gridEl || !this.editCols || !this.cardH) return;
      const rect = gridEl.getBoundingClientRect();
      if (rect.width <= 0) return;
      const cols = this.editCols;
      const gap = parseFloat(getComputedStyle(gridEl).columnGap) || 10;
      const cellW = (rect.width - gap * (cols - 1)) / cols;
      const n = this.editOrder.length;
      if (!(cellW > 0) || n === 0) return;
      let col = Math.floor((e.clientX - rect.left) / cellW);
      let row = Math.floor((e.clientY - rect.top) / this.cardH);
      col = Math.max(0, Math.min(cols - 1, col));
      const maxRows = Math.ceil(n / cols);
      row = Math.max(0, Math.min(maxRows - 1, row));
      let idx = row * cols + col;
      idx = Math.max(0, Math.min(n - 1, idx));
      if (idx !== this.dragIndex) this.moveTo(idx);
    },
    /** 插入位移：把拖拽卡片从当前位置移动到目标槽位，其余卡片顺移。 */
    moveTo(idx) {
      const id = this.dragId;
      const from = this.dragIndex;
      if (from === idx) return;
      const next = this.editOrder.slice();
      next.splice(from, 1);
      next.splice(idx, 0, id);
      this.editOrder = next;
      this.dragIndex = idx;
    },
    onDragUp(e) {
      if (this.dragPointerId !== e.pointerId) return;
      this.dragPointerId = null;
      this.dragId = null;
      this.dragIndex = null;
      if (JSON.stringify(this._dragStartOrder) !== JSON.stringify(this.editOrder)) this.saveGridOrder();
    },
    /** 拖拽靠近面板顶部/底部边缘时自动滚动，露出更多卡片。 */
    autoScroll(y) {
      if (!this.pageEl) return;
      const rect = this.pageEl.getBoundingClientRect();
      const edge = 48;
      if (y < rect.top + edge) {
        this.pageEl.scrollTop = Math.max(0, this.pageEl.scrollTop - 24);
      } else if (y > rect.bottom - edge) {
        this.pageEl.scrollTop = Math.min(this.pageEl.scrollHeight, this.pageEl.scrollTop + 24);
      }
    },
    /** 一次性提交整面板宫格顺序（插入位移重排后）。 */
    async saveGridOrder() {
      if (!this.editPanelId) return;
      try {
        const res = await this.api(`/api/panels/${this.editPanelId}/grid-order`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ order: this.editOrder }),
        });
        const idx = {};
        this.editOrder.forEach((id, i) => { idx[id] = i; });
        this.widgets = this.widgets.map((w) =>
          w.panel_id === this.editPanelId && idx[w.id] !== undefined
            ? { ...w, grid_order: idx[w.id] }
            : w
        );
      } catch (err) {
        console.warn('保存宫格顺序失败', err);
      }
    },
    /** 切换当前面板的宫格列数（立即落库）。 */
    async setCols(n) {
      if (!this.editPanelId) return;
      const cols = Math.max(1, Math.min(6, Math.trunc(n)));
      this.editCols = cols;
      try {
        await this.api(`/api/panels/${this.editPanelId}/grid-cols`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cols }),
        });
        this.panels = this.panels.map((p) => (p.id === this.editPanelId ? { ...p, grid_cols: cols } : p));
      } catch (err) {
        console.warn('保存宫格列数失败', err);
      }
    },
    // 全局指针监听：查看模式 = 长按检测；编辑模式 = 拖拽跟随
    onWindowPointerMove(e) {
      if (this._lp) {
        if (Math.hypot(e.clientX - this._lp.startX, e.clientY - this._lp.startY) > DRAG_SLOP) {
          this.clearLongPress();
        } else if (this._lpLast) {
          this._lpLast = { x: e.clientX, y: e.clientY };
        }
      } else if (this.dragId && e.pointerId === this.dragPointerId) {
        this.onDragMove(e);
      }
    },
    onWindowPointerUp(e) {
      if (this._lp) this.clearLongPress();
      if (this.dragId && e.pointerId === this.dragPointerId) this.onDragUp(e);
    },
    onWindowPointerCancel(e) {
      if (this._lp) this.clearLongPress();
      if (this.dragId && e.pointerId === this.dragPointerId) this.onDragUp(e);
    },
    _bindWinHandlers() {
      this._winMove = (e) => this.onWindowPointerMove(e);
      this._winUp = (e) => this.onWindowPointerUp(e);
      this._winCancel = (e) => this.onWindowPointerCancel(e);
      window.addEventListener('pointermove', this._winMove);
      window.addEventListener('pointerup', this._winUp);
      window.addEventListener('pointercancel', this._winCancel);
    },
    _unbindWinHandlers() {
      if (this._winMove) window.removeEventListener('pointermove', this._winMove);
      if (this._winUp) window.removeEventListener('pointerup', this._winUp);
      if (this._winCancel) window.removeEventListener('pointercancel', this._winCancel);
      this._winMove = this._winUp = this._winCancel = null;
    },

    // ---------- 详情页（全屏覆盖 + 历史记录，支持系统返回 / 边缘滑动返回） ----------
    openDetail(w) {
      if (this.detailId || this.editPanelId !== null) return;
      this.detailId = w.id;
      this.detailRange = '1d';
      this.detailPoints = [];
      window.history.pushState({ view: 'detail' }, '');
      this.fetchDetailChart();
    },
    /** noHistory=true 用于「目标小面板被删」等不需要退历史的情况（调用方直接清状态）。 */
    closeDetail(noHistory) {
      if (!this.detailId) return;
      this.detailId = null;
      this.detailPoints = [];
      if (!noHistory) window.history.back();
    },
    onDetailRangeChange() {
      this.detailPoints = [];   // 换范围立即清旧图，避免短暂显示旧范围数据
      this.fetchDetailChart();
    },
    async fetchDetailChart() {
      const w = this.detailWidget;
      if (!w || this._chartBusy) return;
      this._chartBusy = true;
      try {
        const res = await this.api(
          `/api/panels/widgets/${w.id}/telemetry?limit=${CHART_LIMIT}&range=${encodeURIComponent(this.detailRange)}`
        );
        if (this.detailId !== w.id) return;   // 请求期间详情已关闭/切换 → 丢弃
        this.detailPoints = res.points || [];
      } catch (e) {
        console.warn('图表加载失败', e);
      } finally {
        this._chartBusy = false;
      }
    },

    // ---------- 曲线绘制（移植自主页面 app.js 的迷你曲线逻辑） ----------
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
    /** x 轴刻度 → 绝对时间：n时m分（整点省略「分」）；窗口跨度 >24h 时前缀「M/D」，跨天也不混淆。 */
    fmtTickTime(t, win) {
      const d = new Date(t);
      if (isNaN(d.getTime())) return '--';
      const m = d.getMinutes();
      const hm = d.getHours() + '时' + (m ? (m < 10 ? '0' : '') + m + '分' : '');
      if (win.span > 24 * 3600e3) {
        return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + hm;
      }
      return hm;
    },
    /** 曲线纵轴「好看」范围：圆整刻度完全包住数据，且 ≥3 个刻度。 */
    seriesYRange(key) {
      let lo = null, hi = null;
      for (const p of this.detailPoints) {
        const v = p[key];
        if (typeof v !== 'number' || !Number.isFinite(v)) continue;
        if (lo === null || v < lo) lo = v;
        if (hi === null || v > hi) hi = v;
      }
      if (lo === null) return null;
      const minSpan = key === 'temperature' ? 0.5 : key === 'humidity' ? 2 : 0.1;
      const span = hi - lo;
      if (span < minSpan) {
        const pad = (minSpan - span) / 2;
        lo -= pad; hi += pad;
      }
      const niceStep = (raw) => {
        if (!(raw > 0)) return 1e-9;
        const pow = Math.pow(10, Math.floor(Math.log10(raw)));
        const mag = raw / pow;
        const n = mag < 1.5 ? 1 : mag < 3 ? 2 : mag < 3.5 ? 2.5 : mag < 7 ? 5 : 10;
        return n * pow;
      };
      let step = niceStep((hi - lo) / 2);
      let yLo = null, yHi = null;
      for (let guard = 0; guard < 60; guard++) {
        const a = Math.floor(lo / step + 1e-9) * step;
        const b = Math.ceil(hi / step - 1e-9) * step;
        if (b - a >= step * 2 - 1e-9) { yLo = a; yHi = b; break; }
        step = niceStep(step * 0.5);
      }
      if (yLo === null) return null;
      const ticks = [];
      for (let v = yLo; v <= yHi + step * 1e-6; v += step) ticks.push(v);
      if (ticks.length < 3) ticks.push(yHi);
      return { yLo: ticks[0], yHi: ticks[ticks.length - 1], ticks, step };
    },
    tickDecimals(step, key) {
      const base = key === 'temperature' ? 1 : key === 'battery' ? 2 : 0;
      const need = step >= 1 ? 0 : Math.min(3, Math.ceil(-Math.log10(step)));
      return Math.max(base, need);
    },
    fmtY(v, key, decimals) {
      if (key === 'humidity') {
        return (decimals > 0 ? v.toFixed(decimals) : String(Math.round(v))) + '%';
      }
      return v.toFixed(decimals);
    },
    /** y 轴刻度值（≥3 个）：位置随网格线，首尾贴边、中间居中。 */
    yTicks(key) {
      const r = this.seriesYRange(key);
      if (!r) return [];
      let ticks = r.ticks;
      if (ticks.length > 4) {
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
        if (i === 0) style = { bottom: '1px' };
        else if (i === n - 1) style = { top: '1px' };
        else style = { top: (y / H * 100) + '%', transform: 'translateY(-50%)' };
        return { v, y, label: this.fmtY(v, key, decimals), style };
      });
    },
    hasSpark(key) {
      return this.detailPoints.filter((p) => typeof p[key] === 'number' && Number.isFinite(p[key])).length >= 2;
    },
    sparkPoints(key) {
      const pts = this.detailPoints.filter((p) => typeof p[key] === 'number' && Number.isFinite(p[key]));
      if (pts.length < 2) return '';
      const r = this.seriesYRange(key);
      const win = this.detailWin;
      if (!r) return '';
      const W = 100, H = 60, P = 2;
      const xOf = (p, i) => {
        if (win) {
          const t = Date.parse(p.received_at);
          if (!Number.isNaN(t)) return P + ((t - win.t0) / win.span) * (W - P * 2);
        }
        return P + (i / (pts.length - 1)) * (W - P * 2);
      };
      return pts.map((p, i) => {
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
    batteryText(w) {
      if (!w) return '--';
      const b = w.battery;
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
    miniChartClass(key) {
      return key === 'temperature' ? 'temp' : key === 'humidity' ? 'hum' : 'bat';
    },
    miniChartLabel(key) {
      return key === 'temperature' ? '温度' : key === 'humidity' ? '湿度' : '电量';
    },
  },

  mounted() {
    // 复用主界面登录态；无 token 或校验失败 → 就地显示登录弹窗（登录成功留在本页并刷新数据）
    this._bindWinHandlers();
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem('monitor.auth')); } catch (e) { saved = null; }
    if (!saved || !saved.token) { this.needsLogin = true; return; }
    this.token = saved.token;
    (async () => {
      try {
        const res = await fetch('/api/auth/me', { headers: { Authorization: 'Bearer ' + this.token } });
        if (!res.ok) throw new Error('auth failed');
        const me = await res.json();
        this.username = me.username || saved.username || '';
        this.role = me.role || saved.role || '';
        this.userId = me.userId != null ? me.userId : (saved.userId != null ? saved.userId : null);
        this.avatar = me.avatar || saved.avatar || '';
        this.saveAuthLocal();
        this.startPolling();
      } catch (e) {
        this.showLogin();
      }
    })();
    // 点击页面其他区域时收起顶部用户菜单
    this._closeMenu = (e) => {
      if (this.userMenuOpen && !(e.target && e.target.closest && e.target.closest('.user-area'))) {
        this.userMenuOpen = false;
      }
    };
    document.addEventListener('click', this._closeMenu);
    // 详情页历史记录：系统返回键 / 边缘滑动返回触发 popstate → 关闭详情
    this._onPop = () => {
      if (this.detailId) { this.detailId = null; this.detailPoints = []; }
    };
    window.addEventListener('popstate', this._onPop);
  },

  beforeUnmount() {
    clearInterval(this.pollTimer);
    this.pollTimer = null;
    this._unbindWinHandlers();
    if (this._onPop) window.removeEventListener('popstate', this._onPop);
    if (this._closeMenu) document.removeEventListener('click', this._closeMenu);
  },
}).mount('#app');
