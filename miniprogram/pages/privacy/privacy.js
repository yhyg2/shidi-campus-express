const content = require('../../content/agreement');
const ui = require('../../utils/ui');
Page({
  data: { doc: content.privacy, contact: {} },
  onShow() { const app = getApp(); this.setData({ contact: (app.globalData.settings && app.globalData.settings.contact) || {} }); },
  copyContact() { if (this.data.contact.wechatId) ui.copy(this.data.contact.wechatId, '客服微信已复制'); else ui.toast('运营方尚未配置客服微信'); }
});
