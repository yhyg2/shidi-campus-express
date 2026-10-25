const api = require('../../utils/api');
const ui = require('../../utils/ui');
const share = require('../../utils/share');
const campUtil = require('../../utils/campus');
const config = require('../../config');

const ROLE_OPTIONS = [
  { key: 'user', label: '普通用户（学生/代取）' },
  { key: 'admin', label: '管理员' },
  { key: 'superadmin', label: '超级管理员' }
];

Page({
  data: {
    user: null,
    avatar: '拾',
    campusName: '',
    runnerLabel: '',
    runnerTone: 'dead',
    identityLabel: '普通用户',
    roleTag: '学生',
    runnerState: '',
    isRunner: false,
    isStaff: false,
    roleLabel: '',
    isLocal: false,
    version: config.VERSION,
    noticeCount: 0
  },

  onLoad() { share.enableMenu(); },
  onShow() { this.load(); },

  async load() {
    try {
      const app = getApp();
      await app.ready();
      const user = await api.request('/me');
      app.setUser(user);
      const runner = user.runner;
      const approved = Boolean(runner && runner.status === 'approved');
      // 账号只有一种：普通用户。学生 / 代取 是同一账号下的两种使用身份。
      const runnerLabel = !runner ? '还未取得代取资格，认证后可以接单'
        : approved ? (runner.online ? '代取 · 接单中' : '代取 · 已休息')
          : runner.status === 'pending' ? '代取认证审核中'
            : runner.status === 'suspended' ? '接单权限已暂停' : '认证未通过';
      this.setData({
        user,
        avatar: (user.nickname || '拾').slice(0, 1),
        campusName: campUtil.label(app.campuses(), user.campusId || app.globalData.campusId),
        runnerLabel,
        identityLabel: user.isStaff ? user.roleLabel : '普通用户',
        roleTag: approved ? '代取' : '学生',
        runnerState: !runner ? '' : approved ? (runner.online ? '接单中' : '已休息') : runner.status === 'pending' ? '审核中' : runner.status === 'suspended' ? '已暂停' : '未通过',
        runnerTone: runner ? (runner.status === 'approved' ? 'progress' : runner.status === 'pending' ? 'pending' : 'dead') : 'dead',
        isRunner: Boolean(runner && runner.status === 'approved'),
        isStaff: Boolean(user.isStaff),
        roleLabel: user.roleLabel,
        isLocal: app.isLocal(),
        noticeCount: app.notices().length
      });
    } catch (error) {
      ui.fail(error);
    }
  },

  async editName() {
    const name = await ui.confirm({ title: '修改昵称', content: '展示给代取同学与管理员看', editable: true, placeholder: this.data.user.nickname, confirmText: '保存' });
    if (name === false) return;
    if (!String(name).trim()) return ui.toast('昵称不能为空');
    try {
      const user = await api.request('/me', 'PATCH', { nickname: String(name).trim() });
      getApp().setUser(user);
      ui.ok('已保存');
      this.load();
    } catch (error) { ui.fail(error); }
  },

  join() { wx.navigateTo({ url: '/pages/join/join' }); },
  notice() { wx.navigateTo({ url: '/pages/notice/notice' }); },
  privacy() { wx.navigateTo({ url: '/pages/privacy/privacy' }); },
  runner() { wx.navigateTo({ url: '/packageRunner/runner/runner' }); },
  hall() { wx.navigateTo({ url: '/packageRunner/hall/hall' }); },
  apply() { wx.navigateTo({ url: '/packageRunner/apply/apply' }); },
  admin() { wx.navigateTo({ url: '/packageAdmin/admin/admin' }); },

  switchRole() {
    const labels = ROLE_OPTIONS.map(item => item.label);
    wx.showActionSheet({
      itemList: labels,
      success: async result => {
        const option = ROLE_OPTIONS[result.tapIndex];
        try {
          require('../../utils/local').setRole(option.key);
          await getApp().retry();
          ui.ok('已切换到' + option.label);
          this.load();
        } catch (error) { ui.fail(error); }
      }
    });
  },

  async resetLocal() {
    const agreed = await ui.confirm({ title: '重置本地演示数据', content: '会清空本机的演示订单、公告与成员设置。', confirmText: '重置', danger: true });
    if (!agreed) return;
    require('../../utils/local').reset();
    await getApp().retry();
    ui.ok('已重置');
    this.load();
  },

  onShareAppMessage() { return share.forApp(); },
  onShareTimeline() { return share.timelineFor(null); }
});
