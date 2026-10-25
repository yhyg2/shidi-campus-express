const api = require('./utils/api');
const session = require('./utils/session');
const config = require('./config');
const content = require('./content/agreement');

App({
  globalData: {
    settings: null,
    user: null,
    openid: '',
    campusId: '',
    booted: false,
    agreed: false,
    error: '',
    source: ''
  },

  onLaunch() {
    this.globalData.agreed = Boolean(wx.getStorageSync('sd_agreed_' + content.currentVersion));
    this.globalData.source = api.source();
    this.globalData.campusId = session.getCampus();
    if (this.globalData.agreed) {
      this.boot = this.bootstrap();
      this.boot.catch(() => {});
    }
  },

  /** 一次调用拿到：运营配置 + 当前用户 + openid。 */
  bootstrap() {
    this.boot = (async () => {
      if (!this.globalData.agreed) throw new Error('请先阅读并同意用户协议和隐私政策');
      if (api.source() === 'cloud' && wx.cloud && !this.cloudInitialized) {
        wx.cloud.init(config.CLOUD_ENV ? { env: config.CLOUD_ENV, traceUser: false } : { traceUser: false });
        this.cloudInitialized = true;
      }
      const data = await api.request('/config');
      this.globalData.settings = data.settings;
      this.globalData.subscribeTemplates = data.subscribeTemplates || {};
      this.globalData.user = session.setUser(data.me);
      this.globalData.openid = data.openid || '';
      this.globalData.canBootstrap = Boolean(data.canBootstrap);
      this.globalData.source = api.source();
      const campuses = this.campuses();
      if (!this.globalData.campusId || !campuses.some(item => item.id === this.globalData.campusId)) {
        const fallback = (data.me && data.me.campusId) || (campuses[0] && campuses[0].id) || '';
        this.setCampus(fallback);
      }
      this.globalData.booted = true;
      this.globalData.error = '';
      return data;
    })();
    return this.boot;
  },

  ready() { return this.boot || this.bootstrap(); },

  /** 未同意协议时跳到协议页并返回 false，调用方直接 return。 */
  ensureAgreement() {
    if (this.globalData.agreed) return true;
    wx.reLaunch({ url: '/pages/agreement/agreement?gate=1' });
    return false;
  },
  retry() { return this.bootstrap(); },

  campuses() {
    const settings = this.globalData.settings;
    return (settings && settings.school && settings.school.campuses) || [];
  },
  campus() {
    return this.campuses().find(item => item.id === this.globalData.campusId) || this.campuses()[0] || null;
  },
  setCampus(id) {
    this.globalData.campusId = session.setCampus(id);
    return this.globalData.campusId;
  },
  setUser(user) {
    this.globalData.user = session.setUser(user);
    return user;
  },
  isStaff() { return Boolean(this.globalData.user && this.globalData.user.isStaff); },
  can(ability) {
    const abilities = (this.globalData.user && this.globalData.user.abilities) || [];
    return abilities.includes('*') || abilities.includes(ability);
  },
  notices() {
    const settings = this.globalData.settings;
    return (settings && settings.notices) || [];
  },
  isLocal() { return this.globalData.source === 'local'; },
  version: config.VERSION
});
