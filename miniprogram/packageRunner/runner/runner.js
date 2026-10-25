const api = require('../../utils/api');
const core = require('../../utils/core');
const format = require('../../utils/format');
const ui = require('../../utils/ui');
const share = require('../../utils/share');

Page({
  data: {
    loading: true,
    verified: false,
    online: false,
    campusName: '',
    tasks: [],
    hallCount: 0,
    stats: { active: 0, completed: 0 },
    busy: false,
    isLocal: false,
    serviceTip: '',
    serviceOpen: true,
    staleCount: 0,
    staleTip: ''
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
      const verified = Boolean(me.runner && me.runner.status === 'approved');
      const campus = app.campuses().find(item => item.id === (me.runner && me.runner.campusId));
      this.setData({
        loading: false,
        verified,
        online: Boolean(me.runner && me.runner.online),
        campusName: campus ? campus.name : '',
        isLocal: app.isLocal()
      });
      if (!verified) return this.setData({ tasks: [], hallCount: 0, stats: { active: 0, completed: 0 } });
      const hours = core.serviceHours(app.globalData.settings);
      this.setData({
        serviceOpen: hours.open,
        serviceTip: hours.enabled && !hours.open ? '现在不在取件时间（' + hours.text + '），驿站没开门' : ''
      });
      const results = await Promise.all([api.request('/runner/orders'), api.request('/runner/hall')]);
      const orders = results[0];
      const active = orders.filter(item => ['assigned', 'picked_up', 'delivered'].includes(item.status));
      const hall = results[1];
      const threshold = (app.globalData.settings && app.globalData.settings.rules && app.globalData.settings.rules.staleMinutes) || core.STALE_MINUTES;
      const staleCount = hall.filter(item => (item.waitMinutes || 0) >= threshold).length;
      this.setData({
        tasks: format.list(active),
        hallCount: hall.length,
        staleCount,
        staleTip: staleCount ? '有 ' + staleCount + ' 单等待超过 ' + threshold + ' 分钟' : '',
        stats: { active: active.length, completed: orders.filter(item => item.status === 'completed').length }
      });
    } catch (error) {
      this.setData({ loading: false });
      ui.fail(error);
    }
  },

  async toggle() {
    if (this.data.busy) return;
    const next = !this.data.online;
    this.setData({ busy: true });
    try {
      await api.request('/runner/availability', 'POST', { online: next });
      ui.ok(next ? '已开始接单' : '已暂停接单');
      await this.load();
    } catch (error) {
      ui.fail(error);
    } finally {
      this.setData({ busy: false });
    }
  },

  async quick(event) {
    const { id, action } = event.currentTarget.dataset;
    if (this.data.busy) return;
    this.setData({ busy: true });
    try {
      await api.request('/orders/' + id + '/progress', 'POST', { action });
      ui.ok(action === 'pickup' ? '已确认取件' : '已标记送达');
      await this.load();
    } catch (error) {
      ui.fail(error);
    } finally {
      this.setData({ busy: false });
    }
  },

  detail(event) { wx.navigateTo({ url: '/pages/detail/detail?id=' + event.currentTarget.dataset.id }); },
  hall() { wx.navigateTo({ url: '/packageRunner/hall/hall' }); },
  apply() { wx.navigateTo({ url: '/packageRunner/apply/apply' }); },
  onShareAppMessage() { return share.forApp(); }
});
