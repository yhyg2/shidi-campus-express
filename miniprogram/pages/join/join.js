const api = require('../../utils/api');
const ui = require('../../utils/ui');

Page({
  data: { code: '', busy: false, joined: null, error: '' },

  onLoad(query) {
    if (query && query.code) this.setData({ code: String(query.code).toUpperCase() });
  },

  onInput(event) { this.setData({ code: event.detail.value.toUpperCase(), error: '' }); },

  async submit() {
    if (this.data.busy) return;
    const code = String(this.data.code).trim();
    if (code.length < 6) return ui.toast('请输入完整的邀请码');
    this.setData({ busy: true });
    ui.loading('验证中');
    try {
      const user = await api.request('/member/join', 'POST', { code });
      getApp().setUser(user);
      await getApp().retry();
      ui.hideLoading();
      this.setData({ joined: user });
      ui.ok('已加入：' + user.roleLabel);
    } catch (error) {
      ui.hideLoading();
      this.setData({ error: error.message });
      ui.fail(error);
    } finally {
      this.setData({ busy: false });
    }
  },

  admin() { wx.redirectTo({ url: '/packageAdmin/admin/admin' }); },
  back() { wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/profile/profile' }) }); }
});
