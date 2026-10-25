const content = require('../../content/agreement');

Page({
  data: { type: 'terms', doc: null, gate: false },

  onLoad(query) {
    const type = query && query.type === 'privacy' ? 'privacy' : 'terms';
    this.setData({ type, gate: Boolean(query && query.gate), doc: content[type] });
    wx.setNavigationBarTitle({ title: type === 'privacy' ? '隐私政策' : '用户协议' });
  },

  switchTo(event) {
    const type = event.currentTarget.dataset.type;
    if (type === this.data.type) return;
    this.setData({ type, doc: content[type] });
    wx.setNavigationBarTitle({ title: type === 'privacy' ? '隐私政策' : '用户协议' });
    wx.pageScrollTo({ scrollTop: 0, duration: 0 });
  },

  agree() {
    wx.setStorageSync('sd_agreed_' + content.currentVersion, Date.now());
    const app = getApp();
    if (app && app.globalData) app.globalData.agreed = true;
    wx.reLaunch({ url: '/pages/home/home' });
  },

  refuse() {
    wx.showModal({
      title: '无法继续使用',
      content: '需要同意《用户协议》与《隐私政策》才能使用拾递。',
      showCancel: false,
      confirmText: '知道了',
      success: () => { if (wx.exitMiniProgram) wx.exitMiniProgram({ fail: () => {} }); }
    });
  },

  back() {
    wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/home/home' }) });
  }
});
