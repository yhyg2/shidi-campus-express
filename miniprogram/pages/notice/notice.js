const format = require('../../utils/format');
const share = require('../../utils/share');

Page({
  data: { list: [], loading: true, error: '' },

  onLoad() { share.enableMenu(); this.load(); },
  onPullDownRefresh() { this.load().then(() => wx.stopPullDownRefresh()); },

  async load() {
    try {
      const app = getApp();
      await app.ready();
      const list = app.notices().map(item => Object.assign({}, item, {
        dateText: format.date(item.publishedAt),
        levelLabel: item.level === 'warn' ? '重要' : '公告'
      }));
      this.setData({ list, loading: false, error: '' });
    } catch (error) {
      this.setData({ loading: false, error: error.message || '加载失败' });
    }
  },

  goHome() { wx.switchTab({ url: '/pages/home/home' }); },
  onShareAppMessage() { return share.forApp(); }
});
