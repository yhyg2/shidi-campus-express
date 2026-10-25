const api = require('../../utils/api');
const core = require('../../utils/core');
const format = require('../../utils/format');
const ui = require('../../utils/ui');
const share = require('../../utils/share');

Page({
  data: { loading: true, verifying: true, online: false, orders: [], busy: false, error: '', serviceTip: '', serviceOpen: true, staleCount: 0, staleTip: '' },

  onLoad() { share.enableMenu(); },
  onShow() { this.load(); },
  onPullDownRefresh() { this.load().then(() => wx.stopPullDownRefresh()); },

  async load() {
    try {
      const app = getApp();
      await app.ready();
      const me = await api.request('/me');
      app.setUser(me);
      const verified = Boolean(me.runner && me.runner.status === 'approved');
      this.setData({ verifying: !verified, online: Boolean(me.runner && me.runner.online) });
      if (!verified) return this.setData({ loading: false, orders: [], staleCount: 0, staleTip: '' });
      const hours = core.serviceHours(app.globalData.settings);
      this.setData({
        serviceOpen: hours.open,
        serviceTip: hours.enabled && !hours.open ? '现在不在取件时间（' + hours.text + '），驿站没开门，接了也取不到' : ''
      });
      const list = await api.request('/runner/hall');
      const threshold = (app.globalData.settings && app.globalData.settings.rules && app.globalData.settings.rules.staleMinutes) || core.STALE_MINUTES;
      const staleCount = list.filter(item => (item.waitMinutes || 0) >= threshold).length;
      this.setData({
        loading: false,
        error: '',
        orders: format.list(list),
        staleCount,
        staleTip: staleCount ? '有 ' + staleCount + ' 单已等待超过 ' + threshold + ' 分钟，建议优先接取' : ''
      });
    } catch (error) {
      this.setData({ loading: false, error: error.message || '加载失败' });
    }
  },

  async claim(event) {
    if (this.data.busy) return;
    const id = event.detail.id;
    const agreed = await ui.confirm({
      title: '接下这份委托',
      content: '接单后才能看到取件码、联系人和电话，请在取件时间内完成。',
      confirmText: '接单'
    });
    if (!agreed) return;
    this.setData({ busy: true });
    try {
      await api.request('/orders/' + id + '/claim', 'POST', {});
      ui.ok('接单成功');
      wx.navigateTo({ url: '/pages/detail/detail?id=' + id });
    } catch (error) {
      ui.fail(error);
      this.load();
    } finally {
      this.setData({ busy: false });
    }
  },

  runner() { wx.navigateTo({ url: '/packageRunner/runner/runner' }); },
  apply() { wx.navigateTo({ url: '/packageRunner/apply/apply' }); },
  onShareAppMessage() { return share.forApp(); }
});
