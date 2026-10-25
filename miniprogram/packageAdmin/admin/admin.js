const api = require('../../utils/api');
const format = require('../../utils/format');
const ui = require('../../utils/ui');
const share = require('../../utils/share');

const TABS = [
  { id: 'overview', label: '概览', ability: 'overview.read' },
  { id: 'orders', label: '订单', ability: 'order.read' },
  { id: 'members', label: '成员', ability: 'member.read' },
  { id: 'runners', label: '代取', ability: 'runner.read' },
  { id: 'pricing', label: '定价', ability: 'pricing.read' },
  { id: 'notice', label: '公告', ability: 'notice.read' },
  { id: 'settings', label: '设置', ability: 'settings.read' }
];
const ROLE_KEYS = ['admin'];
const ORDER_FILTERS = [
  { id: 'waiting_assignment', label: '待接单' },
  { id: 'active', label: '进行中' },
  { id: 'completed', label: '已完成' },
  { id: 'cancelled', label: '已取消' },
  { id: 'all', label: '全部' }
];
const yuan = cents => (Number(cents || 0) / 100).toFixed(2);
const REASON_LABELS = { damaged: '快递损坏', wrong: '送错位置', late: '严重超时', attitude: '态度问题', other: '其他' };
const cents = value => Math.round(Number(value || 0) * 100);

Page({
  data: {
    loading: true,
    isStaff: false,
    roleLabel: '',
    isLocal: false,
    tabs: TABS,
    tab: 'overview',
    busy: false,
    bootstrapable: false,
    stats: {},
    complaints: [],
    recent: [],
    logs: [],
    orderFilter: 'waiting_assignment',
    orderFilters: ORDER_FILTERS,
    orders: [],
    members: [],
    memberInvites: [],
    newInvite: null,
    runners: [],
    runnerInvite: null,
    pricingForm: null,
    notices: [],
    noticeDraft: null,
    school: null,
    rulesDraft: {},
    contactDraft: { wechatId: '', phone: '' }
  },

  onLoad() { share.enableMenu(); },
  onShow() { this.load(); },
  onPullDownRefresh() { this.load().then(() => wx.stopPullDownRefresh()); },

  async load() {
    try {
      const app = getApp();
      await app.ready();
      const me = await api.request('/me');
      app.setUser(me);
      if (!me.isStaff) {
        this.setData({ loading: false, isStaff: false, isLocal: app.isLocal(), bootstrapable: app.isLocal() || app.globalData.canBootstrap });
        return;
      }
      const tabs = TABS.filter(item => app.can(item.ability));
      const tab = tabs.some(item => item.id === this.data.tab) ? this.data.tab : (tabs[0] && tabs[0].id) || 'overview';
      this.setData({
        loading: false,
        isStaff: true,
        roleLabel: me.roleLabel,
        isLocal: app.isLocal(),
        tabs,
        tab
      });
      await this.loadTab(tab);
    } catch (error) {
      this.setData({ loading: false });
      ui.fail(error);
    }
  },

  async loadTab(tab) {
    if (tab === 'overview') return this.loadOverview();
    if (tab === 'orders') return this.loadOrders();
    if (tab === 'members') return this.loadMembers();
    if (tab === 'runners') return this.loadRunners();
    if (tab === 'pricing') return this.loadPricing();
    if (tab === 'notice') return this.loadNotices();
    if (tab === 'settings') return this.loadSettings();
    return null;
  },

  switchTab(event) {
    const tab = event.currentTarget.dataset.id;
    this.setData({ tab });
    this.loadTab(tab);
  },

  // ---------------- 概览 ----------------
  async loadOverview() {
    const data = await api.request('/admin/overview');
    this.setData({
      stats: data.stats,
      complaints: (data.complaints || []).map(item => Object.assign({}, item, {
        reasonLabel: REASON_LABELS[item.reason] || item.reason,
        timeText: format.time(item.createdAt)
      })),
      recent: format.list(data.recent || []),
      logs: (data.logs || []).map(item => Object.assign({}, item, { timeText: format.time(item.at) }))
    });
  },

  async resolveComplaint(event) {
    const id = event.currentTarget.dataset.id;
    const note = await ui.confirm({ title: '标记已处理', content: '填写处理结果，例如：已联系双方协商退款。', editable: true, placeholder: '处理说明', confirmText: '确认' });
    if (note === false) return;
    try {
      await api.request('/admin/complaints/' + id + '/resolve', 'POST', { note: String(note || '').trim() || '已处理' });
      ui.ok('已处理');
      this.loadOverview();
    } catch (error) { ui.fail(error); }
  },

  /** 导出 CSV：写入临时文件后发给微信（文件传输助手），失败降级为复制文本。 */
  async exportOrders() {
    if (this.data.busy) return;
    this.setData({ busy: true });
    try {
      const result = await api.request('/admin/export?filter=' + this.data.orderFilter);
      const path = wx.env.USER_DATA_PATH + '/' + (result.filename || 'orders.csv');
      const fs = wx.getFileSystemManager();
      fs.writeFileSync(path, result.csv, 'utf8');
      wx.shareFileMessage({
        filePath: path,
        fileName: result.filename,
        success: () => ui.ok('已导出，请在微信里选择「文件传输助手」'),
        fail: () => {
          ui.copy(result.csv.slice(0, 5000), '当前环境不支持发文件，已复制前 5000 字');
        }
      });
    } catch (error) {
      ui.fail(error);
    } finally {
      this.setData({ busy: false });
    }
  },

  async bootstrap() {
    const agreed = await ui.confirm({ title: '初始化管理员', content: '初始化后你将成为超级管理员。云端仅允许部署者指定的账号操作，且只能初始化一次。', confirmText: '确认初始化' });
    if (!agreed) return;
    try {
      ui.loading('初始化中');
      const user = await api.request('/admin/bootstrap', 'POST', {});
      getApp().setUser(user);
      ui.hideLoading();
      ui.ok('你已成为超级管理员');
      this.load();
    } catch (error) { ui.hideLoading(); ui.fail(error); }
  },

  // ---------------- 订单 ----------------
  async loadOrders() {
    const orders = await api.request('/admin/orders?filter=' + this.data.orderFilter);
    this.setData({ orders: format.list(orders) });
  },

  filterOrders(event) {
    this.setData({ orderFilter: event.currentTarget.dataset.id }, () => this.loadOrders());
  },

  openOrder(event) { wx.navigateTo({ url: '/pages/detail/detail?id=' + event.currentTarget.dataset.id }); },

  async assign(event) {
    const id = event.currentTarget.dataset.id;
    try {
      ui.loading('查找代取');
      const candidates = await api.request('/admin/orders/' + id + '/candidates');
      ui.hideLoading();
      if (!candidates.length) return ui.toast('同校区暂无可指派的代取');
      wx.showActionSheet({
        itemList: candidates.slice(0, 6).map(item => item.nickname + ' · 在手 ' + item.load + ' 单'),
        success: async result => {
          const target = candidates[result.tapIndex];
          if (!target) return;
          try {
            await api.request('/admin/orders/' + id + '/assign', 'POST', { runnerId: target.openid });
            ui.ok('已指派给 ' + target.nickname);
            this.loadTab('orders');
          } catch (error) { ui.fail(error); }
        }
      });
    } catch (error) { ui.hideLoading(); ui.fail(error); }
  },

  async cancelOrder(event) {
    const id = event.currentTarget.dataset.id;
    const reason = await ui.confirm({ title: '取消订单', content: '填写原因，会写进订单轨迹，双方都能看到。', editable: true, placeholder: '例如：同学已自行取件', confirmText: '确认取消', danger: true });
    if (reason === false) return;
    try {
      await api.request('/admin/orders/' + id + '/cancel', 'POST', { reason: String(reason || '').trim() || '管理员取消' });
      ui.ok('已取消');
      this.loadTab('orders');
    } catch (error) { ui.fail(error); }
  },

  // ---------------- 成员 ----------------
  async loadMembers() {
    const data = await api.request('/admin/members');
    this.setData({
      members: (data.members || []).map(item => Object.assign({}, item, { joinedText: format.date(item.joinedAt) })),
      memberInvites: (data.invites || []).map(item => Object.assign({}, item, { expireText: format.time(item.expiresAt), used: Boolean(item.usedBy) }))
    });
  },

  roleName(key) {
    const map = { superadmin: '超级管理员', admin: '管理员' };
    return map[key] || key;
  },

  async inviteMember() {
    try {
      ui.loading('生成中');
      const invite = await api.request('/admin/members/invite', 'POST', { role: ROLE_KEYS[0] });
      ui.hideLoading();
      this.setData({ newInvite: Object.assign({}, invite, { roleLabel: this.roleName(ROLE_KEYS[0]), expireText: format.time(invite.expiresAt) }) });
      this.loadMembers();
    } catch (error) { ui.hideLoading(); ui.fail(error); }
  },

  copyInvite() { ui.copy(this.data.newInvite.code, '邀请码已复制'); },

  async removeMember(event) {
    const { id, name } = event.currentTarget.dataset;
    const agreed = await ui.confirm({ title: '移除成员', content: '将「' + name + '」移出管理团队？对方会变回普通用户。', confirmText: '移除', danger: true });
    if (!agreed) return;
    try {
      await api.request('/admin/members/' + id + '/remove', 'POST', {});
      ui.ok('已移除');
      this.loadMembers();
    } catch (error) { ui.fail(error); }
  },

  // ---------------- 代取审核 ----------------
  async loadRunners() {
    const runners = await api.request('/admin/runners');
    this.setData({
      runners: runners.map(item => Object.assign({}, item, {
        statusText: { pending: '待审核', approved: '已通过', rejected: '已驳回', suspended: '已暂停' }[item.status] || item.status,
        appliedText: format.date(item.appliedAt)
      }))
    });
  },

  async reviewRunner(event) {
    const { id, decision, name } = event.currentTarget.dataset;
    const copy = decision === 'approved'
      ? { title: '通过认证', content: '填写核验方式，例如：已核对校园卡与学号。', placeholder: '已线下核对校园卡', danger: false }
      : decision === 'rejected'
        ? { title: '驳回申请', content: '填写原因，申请人可以看到。', placeholder: '资料不清晰，请重新提交', danger: true }
        : { title: '暂停接单权限', content: '暂停后该代取不再接收新订单。', placeholder: '多次超时未送达', danger: true };
    const reason = await ui.confirm(Object.assign({ confirmText: '确认', editable: true }, copy));
    if (reason === false) return;
    try {
      await api.request('/admin/runners/' + id + '/review', 'POST', {
        decision,
        reason: String(reason || '').trim() || (decision === 'approved' ? '管理员已核验校园证件' : '资料不符合要求')
      });
      ui.ok('已处理');
      this.loadRunners();
    } catch (error) { ui.fail(error); }
  },

  async makeRunnerInvite() {
    const campuses = getApp().campuses();
    if (!campuses.length) return ui.toast('还没有校区');
    wx.showActionSheet({
      itemList: campuses.map(item => item.name),
      success: async result => {
        const campus = campuses[result.tapIndex];
        if (!campus) return;
        try {
          ui.loading('生成中');
          const invite = await api.request('/admin/runners/invite', 'POST', { campusId: campus.id });
          ui.hideLoading();
          this.setData({ runnerInvite: Object.assign({}, invite, { campusName: campus.name, expireText: format.time(invite.expiresAt) }) });
        } catch (error) { ui.hideLoading(); ui.fail(error); }
      }
    });
  },

  copyRunnerInvite() { ui.copy(this.data.runnerInvite.code, '代取邀请码已复制'); },

  copyStudentNo(event) { ui.copy(event.currentTarget.dataset.value, '学号已复制'); },

  // ---------------- 定价 ----------------
  async loadPricing() {
    const data = await api.request('/admin/pricing');
    const pricing = data.pricing;
    this.rawSlots = data.slots || [];
    this.setData({
      pricingForm: {
        baseFeeYuan: yuan(pricing.baseFee),
        minTotalYuan: yuan(pricing.minTotal),
        maxTotalYuan: yuan(pricing.maxTotal),
        chargeMode: pricing.chargeMode,
        distanceEnabled: Boolean(pricing.distance && pricing.distance.enabled),
        settleNote: pricing.settleNote || '',
        sizes: (pricing.sizes || []).map(item => ({ id: item.id, label: item.label, hint: item.hint || '', centsYuan: yuan(item.cents) })),
        slots: (data.slots || []).map(item => ({ label: item.label, surchargeYuan: yuan(item.surcharge) }))
      }
    });
  },

  priceInput(event) {
    const field = event.currentTarget.dataset.field;
    this.setData({ ['pricingForm.' + field]: event.detail.value });
  },
  priceSizeInput(event) {
    const index = Number(event.currentTarget.dataset.index);
    const field = event.currentTarget.dataset.field;
    this.setData({ ['pricingForm.sizes[' + index + '].' + field]: event.detail.value });
  },
  priceSlotInput(event) {
    const index = Number(event.currentTarget.dataset.index);
    this.setData({ ['pricingForm.slots[' + index + '].surchargeYuan']: event.detail.value });
  },
  toggleChargeMode() {
    this.setData({ 'pricingForm.chargeMode': this.data.pricingForm.chargeMode === 'perParcel' ? 'perOrder' : 'perParcel' });
  },
  toggleDistance() {
    this.setData({ 'pricingForm.distanceEnabled': !this.data.pricingForm.distanceEnabled });
  },
  addSlot() {
    const slots = this.data.pricingForm.slots.concat({ label: '新时段', surchargeYuan: '0.00' });
    this.setData({ 'pricingForm.slots': slots });
  },
  removeSlot(event) {
    const index = Number(event.currentTarget.dataset.index);
    const slots = this.data.pricingForm.slots.slice();
    slots.splice(index, 1);
    this.setData({ 'pricingForm.slots': slots });
  },

  async savePricing() {
    const form = this.data.pricingForm;
    if (!form.sizes.length) return ui.toast('至少保留一种尺寸');
    const pricing = {
      baseFee: cents(form.baseFeeYuan),
      minTotal: cents(form.minTotalYuan),
      maxTotal: cents(form.maxTotalYuan),
      chargeMode: form.chargeMode,
      settleNote: form.settleNote,
      distance: { enabled: form.distanceEnabled, freeMeters: 500, perKmCents: 100, maxCents: 1000 },
      sizes: form.sizes.map(item => ({ id: item.id, label: item.label, hint: item.hint, cents: cents(item.centsYuan) }))
    };
    const slots = form.slots.map(item => ({ label: item.label, surcharge: cents(item.surchargeYuan) }));
    try {
      ui.loading('保存中');
      await api.request('/admin/pricing', 'POST', { pricing, slots });
      ui.hideLoading();
      ui.ok('价格已更新');
      await getApp().retry();
      this.loadPricing();
    } catch (error) { ui.hideLoading(); ui.fail(error); }
  },

  // ---------------- 公告 ----------------
  async loadNotices() {
    const notices = await api.request('/admin/notices');
    this.setData({
      notices: (notices || []).map(item => Object.assign({}, item, {
        dateText: format.date(item.publishedAt),
        levelText: item.level === 'warn' ? '重要' : '普通'
      }))
    });
  },

  newNotice() {
    this.setData({ noticeDraft: { id: '', title: '', content: '', level: 'info', pinned: false, active: true } });
  },
  editNotice(event) {
    const id = event.currentTarget.dataset.id;
    const notice = this.data.notices.find(item => item.id === id);
    if (!notice) return;
    this.setData({ noticeDraft: { id, title: notice.title, content: notice.content, level: notice.level, pinned: Boolean(notice.pinned), active: notice.active !== false } });
  },
  noticeInput(event) {
    const field = event.currentTarget.dataset.field;
    this.setData({ ['noticeDraft.' + field]: event.detail.value });
  },
  pickNoticeLevel(event) { this.setData({ 'noticeDraft.level': event.currentTarget.dataset.value }); },
  toggleNoticeFlag(event) {
    const field = event.currentTarget.dataset.field;
    this.setData({ ['noticeDraft.' + field]: !this.data.noticeDraft[field] });
  },
  closeNoticeDraft() { this.setData({ noticeDraft: null }); },

  async saveNotice() {
    const draft = this.data.noticeDraft;
    if (!String(draft.title).trim()) return ui.toast('请填写标题');
    if (!String(draft.content).trim()) return ui.toast('请填写内容');
    try {
      ui.loading('发布中');
      await api.request('/admin/notices', 'POST', draft);
      ui.hideLoading();
      ui.ok(draft.id ? '公告已更新' : '公告已发布');
      this.setData({ noticeDraft: null });
      await getApp().retry();
      this.loadNotices();
    } catch (error) { ui.hideLoading(); ui.fail(error); }
  },

  async removeNotice(event) {
    const id = event.currentTarget.dataset.id;
    const agreed = await ui.confirm({ title: '删除公告', content: '删除后首页不再展示。', confirmText: '删除', danger: true });
    if (!agreed) return;
    try {
      await api.request('/admin/notices/' + id, 'DELETE');
      ui.ok('已删除');
      await getApp().retry();
      this.loadNotices();
    } catch (error) { ui.fail(error); }
  },

  // ---------------- 设置 ----------------
  async loadSettings() {
    const data = await api.request('/admin/settings');
    this.setData({
      contactDraft: {
        wechatId: (data.contact && data.contact.wechatId) || '',
        phone: (data.contact && data.contact.phone) || ''
      },
      school: data.school,
      rulesDraft: {
        maxActivePerRunner: data.rules.maxActivePerRunner,
        staleMinutes: data.rules.staleMinutes,
        runnerInviteTtlHours: data.rules.runnerInviteTtlHours,
        serviceStart: (data.rules.serviceHours && data.rules.serviceHours.start) || '10:30',
        serviceEnd: (data.rules.serviceHours && data.rules.serviceHours.end) || '21:30',
        memberInviteTtlHours: data.rules.memberInviteTtlHours || 72,
        runnerStudentNoPattern: data.rules.runnerStudentNoPattern,
        autoDispatch: data.rules.autoDispatch !== false,
        requireRunnerOnline: data.rules.requireRunnerOnline !== false,
        preferNearby: Boolean(data.rules.preferNearby),
        requireRunnerIdPhoto: Boolean(data.rules.requireRunnerIdPhoto)
      }
    });
  },

  ruleInput(event) {
    const field = event.currentTarget.dataset.field;
    this.setData({ ['rulesDraft.' + field]: event.detail.value });
  },
  contactInput(event) {
    const field = event.currentTarget.dataset.field;
    this.setData({ ['contactDraft.' + field]: event.detail.value });
  },
  toggleRule(event) {
    const field = event.currentTarget.dataset.field;
    this.setData({ ['rulesDraft.' + field]: !this.data.rulesDraft[field] });
  },

  async addBuilding(event) {
    const campusIndex = Number(event.currentTarget.dataset.index);
    const name = await ui.confirm({ title: '添加楼栋', content: '填写楼栋名称，例如「知行苑 4 栋」', editable: true, placeholder: '知行苑 4 栋', confirmText: '添加' });
    if (name === false || !String(name).trim()) return;
    const school = JSON.parse(JSON.stringify(this.data.school));
    school.campuses[campusIndex].buildings.push(String(name).trim());
    this.setData({ school });
  },
  async removeBuilding(event) {
    const { index, name } = event.currentTarget.dataset;
    const school = JSON.parse(JSON.stringify(this.data.school));
    const campus = school.campuses[Number(index)];
    // 楼栋是可选项：允许删到 0，此时下单页只让填送达地址
    campus.buildings = campus.buildings.filter(item => item !== name);
    this.setData({ school });
  },
  async addStation(event) {
    const campusIndex = Number(event.currentTarget.dataset.index);
    const name = await ui.confirm({ title: '添加驿站', content: '填写驿站名称，例如「东门菜鸟驿站」', editable: true, placeholder: '东门菜鸟驿站', confirmText: '添加' });
    if (name === false || !String(name).trim()) return;
    const school = JSON.parse(JSON.stringify(this.data.school));
    const campus = school.campuses[campusIndex];
    campus.stations.push({ id: 'st_' + Date.now().toString(36), name: String(name).trim(), openHours: '08:00–21:00' });
    this.setData({ school });
  },
  async removeStation(event) {
    const { index, id } = event.currentTarget.dataset;
    const school = JSON.parse(JSON.stringify(this.data.school));
    const campus = school.campuses[Number(index)];
    if (campus.stations.length <= 1) return ui.toast('每个校区至少保留一个驿站');
    campus.stations = campus.stations.filter(item => item.id !== id);
    this.setData({ school });
  },

  async saveSettings() {
    try {
      ui.loading('保存中');
      const draft = this.data.rulesDraft;
      const rules = Object.assign({}, draft, {
        serviceHours: { enabled: true, start: draft.serviceStart, end: draft.serviceEnd }
      });
      delete rules.serviceStart;
      delete rules.serviceEnd;
      await api.request('/admin/settings', 'POST', {
        school: this.data.school,
        rules,
        contact: this.data.contactDraft
      });
      ui.hideLoading();
      ui.ok('设置已保存');
      await getApp().retry();
      this.loadSettings();
    } catch (error) { ui.hideLoading(); ui.fail(error); }
  },

  goHome() { wx.switchTab({ url: '/pages/home/home' }); },

  onShareAppMessage() {
    if (this.data.newInvite) return share.forRecruit(this.data.newInvite.code);
    return share.forApp();
  }
});
