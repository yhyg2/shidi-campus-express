const api = require('../../utils/api');
const ui = require('../../utils/ui');
const share = require('../../utils/share');

Page({
  data: {
    loading: true,
    user: null,
    status: 'none',
    campusName: '',
    reason: '',
    form: { code: '', realName: '', studentNo: '' },
    consent: false,
    studentNoHint: '4–24 位字母、数字或短横线',
    requireIdPhoto: false,
    photos: [],
    busy: false
  },

  onLoad(query) {
    if (query && query.code) this.setData({ 'form.code': String(query.code).toUpperCase() });
    share.enableMenu();
  },

  onShow() { this.load(); },

  async load() {
    try {
      const app = getApp();
      await app.ready();
      const me = await api.request('/me');
      app.setUser(me);
      const runner = me.runner;
      const campus = app.campuses().find(item => item.id === (runner && runner.campusId));
      const rules = (app.globalData.settings && app.globalData.settings.rules) || {};
      this.setData({
        loading: false,
        user: me,
        status: runner ? runner.status : 'none',
        campusName: campus ? campus.name : '',
        reason: (runner && runner.reason) || '',
        studentNoHint: rules.runnerStudentNoPatternHint || '4–24 位字母、数字或短横线',
        requireIdPhoto: Boolean(rules.requireRunnerIdPhoto),
        'form.realName': this.data.form.realName || (runner && runner.realName) || '',
        'form.studentNo': this.data.form.studentNo || (runner && runner.studentNo) || ''
      });
    } catch (error) {
      this.setData({ loading: false });
      ui.fail(error);
    }
  },

  onInput(event) {
    const field = event.currentTarget.dataset.field;
    const value = field === 'code' ? event.detail.value.toUpperCase() : event.detail.value;
    this.setData({ ['form.' + field]: value });
  },
  toggleConsent() { this.setData({ consent: !this.data.consent }); },

  async uploadId() {
    if (this.data.photos.length >= 2) return ui.toast('最多上传 2 张');
    wx.chooseMedia({
      count: 1, mediaType: ['image'], sizeType: ['compressed'], sourceType: ['album', 'camera'],
      success: async result => {
        const file = result.tempFiles[0];
        if (!file) return;
        ui.loading('上传中');
        try {
          const uploaded = await api.uploadImage(file.tempFilePath);
          this.setData({ photos: this.data.photos.concat({ fileID: uploaded.fileID, path: file.tempFilePath }) });
        } catch (error) { ui.fail(error); } finally { ui.hideLoading(); }
      }
    });
  },
  removeId(event) {
    const index = Number(event.currentTarget.dataset.index);
    const photos = this.data.photos.slice();
    photos.splice(index, 1);
    this.setData({ photos });
  },

  async submit() {
    if (this.data.busy) return;
    const form = this.data.form;
    if (String(form.code).trim().length < 6) return ui.toast('请填写完整的邀请码');
    if (String(form.realName).trim().length < 2) return ui.toast('请填写真实姓名');
    if (String(form.studentNo).trim().length < 4) return ui.toast('请填写学号');
    if (this.data.requireIdPhoto && !this.data.photos.length) return ui.toast('请上传学生证或校园卡照片');
    if (!this.data.consent) return ui.toast('请先同意认证信息使用说明');
    this.setData({ busy: true });
    ui.loading('提交中');
    try {
      await api.request('/runner/apply', 'POST', {
        code: String(form.code).trim().toUpperCase(),
        realName: String(form.realName).trim(),
        studentNo: String(form.studentNo).trim(),
        photoFileIds: this.data.photos.map(item => item.fileID),
        consent: true
      });
      ui.hideLoading();
      ui.ok('申请已提交');
      await this.load();
    } catch (error) {
      ui.hideLoading();
      ui.fail(error);
    } finally {
      this.setData({ busy: false });
    }
  },

  runner() { wx.navigateTo({ url: '/packageRunner/runner/runner' }); },
  privacy() { wx.navigateTo({ url: '/pages/privacy/privacy' }); },
  onShareAppMessage() { return share.forRecruit(this.data.status === 'none' ? this.data.form.code : ''); }
});
