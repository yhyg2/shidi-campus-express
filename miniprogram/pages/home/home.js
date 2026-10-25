const api = require('../../utils/api');
const format = require('../../utils/format');
const campUtil = require('../../utils/campus');
const share = require('../../utils/share');
const ui = require('../../utils/ui');
const core = require('../../utils/core');
const config = require('../../config');

Page({
  data: {
    loading: true,
    error: '',
    version: config.VERSION,
    campusName: '',
    pickerShow: false,
    campusList: [],
    orders: [],
    notices: [],
    contact: {},
    runnerStatus: 'none',
    staleCount: 0,
    staleTip: '',
    runnerTitle: '',
    runnerDesc: '',
    isStaff: false,
    roleLabel: '',
    isLocal: false
  },

  onLoad() { share.enableMenu(); },
  onShow() {
    if (!getApp().ensureAgreement()) return;
    this.load();
  },
  onPullDownRefresh() { this.load().then(() => wx.stopPullDownRefresh()); },

  async load() {
    try {
      const app = getApp();
      await app.ready();
      const me = await api.request('/me');
      app.setUser(me);
      const orders = await api.request('/orders');
      const active = orders.filter(item => item.status !== 'completed' && item.status !== 'cancelled').slice(0, 2);
      let stale = { staleCount: 0, staleTip: '' };
      if (me.runner && me.runner.status === 'approved') {
        try {
          const hall = await api.request('/runner/hall');
          const threshold = (app.globalData.settings && app.globalData.settings.rules && app.globalData.settings.rules.staleMinutes) || core.STALE_MINUTES;
          const staleList = hall.filter(item => (item.waitMinutes || 0) >= threshold);
          stale = { staleCount: staleList.length, staleTip: staleList.length ? staleList.length + ' 单已等待超过 ' + threshold + ' 分钟' : '' };
        } catch (_) { /* 未认证等情况忽略 */ }
      }
      const copy = this.runnerCopy(me.runner);
      this.setData({
        loading: false,
        error: '',
        orders: format.list(active),
        notices: app.notices(),
        contact: (app.globalData.settings && app.globalData.settings.contact) || {},
        runnerStatus: me.runner ? me.runner.status : 'none',
        staleCount: stale.staleCount,
        staleTip: stale.staleTip,
        runnerTitle: copy.title,
        runnerDesc: copy.desc,
        isStaff: Boolean(me.isStaff),
        roleLabel: me.roleLabel,
        isLocal: app.isLocal(),
        campusName: campUtil.label(app.campuses(), app.globalData.campusId),
        campusList: campUtil.options(app.campuses(), app.globalData.campusId)
      });
    } catch (error) {
      this.setData({ loading: false, error: error.message || '加载失败', isLocal: getApp().isLocal() });
    }
  },

  runnerCopy(runner) {
    if (!runner) return { title: '成为校园代取', desc: '你现在就是普通用户；向管理员要一个代取邀请码，提交学号核验后即可接单' };
    if (runner.status === 'approved') {
      return runner.online
        ? { title: '接单中', desc: '同校区的待接订单会出现在工作台，也能直接在大厅抢单' }
        : { title: '已休息', desc: '开启接单后才能接到新订单' };
    }
    if (runner.status === 'pending') return { title: '认证审核中', desc: '管理员核验校园证件后即可接单' };
    if (runner.status === 'suspended') return { title: '接单权限已暂停', desc: runner.reason || '请联系校区管理员' };
    return { title: '认证未通过', desc: runner.reason || '可补充资料后重新申请' };
  },

  openPicker() {
    const app = getApp();
    this.setData({ pickerShow: true, campusList: campUtil.options(app.campuses(), app.globalData.campusId) });
  },
  closePicker() { this.setData({ pickerShow: false }); },
  pickCampus(event) {
    const app = getApp();
    app.setCampus(event.detail.id);
    this.setData({
      pickerShow: false,
      campusName: campUtil.label(app.campuses(), event.detail.id),
      campusList: campUtil.options(app.campuses(), event.detail.id)
    });
  },

  create() { wx.navigateTo({ url: '/pages/create/create?campusId=' + getApp().globalData.campusId }); },
  orders() { wx.switchTab({ url: '/pages/orders/orders' }); },
  detail(event) { wx.navigateTo({ url: '/pages/detail/detail?id=' + event.detail.id }); },
  notice() { wx.navigateTo({ url: '/pages/notice/notice' }); },
  runner() { wx.navigateTo({ url: '/packageRunner/runner/runner' }); },
  hall() { wx.navigateTo({ url: '/packageRunner/hall/hall' }); },
  apply() { wx.navigateTo({ url: '/packageRunner/apply/apply' }); },
  admin() { wx.navigateTo({ url: '/packageAdmin/admin/admin' }); },
  openTerms() { wx.navigateTo({ url: '/pages/agreement/agreement?type=terms' }); },
  openPrivacy() { wx.navigateTo({ url: '/pages/agreement/agreement?type=privacy' }); },
  copyWechat() { ui.copy(this.data.contact.wechatId, '客服微信已复制'); },
  callService() { ui.call(this.data.contact.phone); },

  async retry() {
    this.setData({ loading: true });
    try { await getApp().retry(); } catch (_) { /* load 会显示错误 */ }
    this.load();
  },

  onShareAppMessage() { return share.forApp(); },
  onShareTimeline() { return share.timelineFor(null); }
});
