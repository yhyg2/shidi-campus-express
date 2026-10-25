const api = require('../../utils/api');
const core = require('../../utils/core');
const ui = require('../../utils/ui');
const share = require('../../utils/share');

Page({
  data: {
    ready: false,
    campusId: '',
    campusName: '',
    stations: [],
    buildings: [],
    buildingIndex: 0,
    sizes: [],
    slots: [],
    form: { stationId: '', building: '', room: '', recipient: '', phone: '', pickupCode: '', parcelCount: 1, size: 'small', slot: '自由接单', note: '' },
    photos: [],
    priceLines: [],
    totalCents: 0,
    totalText: '0.00',
    settleNote: '',
    serviceTip: '',
    serviceOpen: true,
    errors: {},
    busy: false
  },

  onLoad(query) {
    this.initialCampus = (query && query.campusId) || '';
    share.enableMenu();
    this.load();
  },

  async load() {
    try {
      const app = getApp();
      await app.ready();
      const user = app.globalData.user || {};
      this.applyCampus(this.initialCampus || app.globalData.campusId, user);
    } catch (error) {
      ui.fail(error);
      this.setData({ ready: true });
    }
  },

  applyCampus(campusId, user) {
    const app = getApp();
    const campuses = app.campuses();
    const campus = campuses.find(item => item.id === campusId) || campuses[0];
    if (!campus) return;
    app.setCampus(campus.id);
    const settings = app.globalData.settings;
    this.setData({
      ready: true,
      campusId: campus.id,
      campusName: campus.name,
      stations: campus.stations,
      buildings: campus.buildings,
      buildingIndex: 0,
      sizes: settings.pricing.sizes.map(item => ({ id: item.id, label: item.label, hint: item.hint || '', price: (item.cents / 100).toFixed(item.cents % 100 === 0 ? 0 : 2) })),
      slots: settings.slots,
      settleNote: settings.pricing.settleNote || '',
      serviceTip: this.serviceTipOf(settings),
      serviceOpen: core.serviceHours(settings).open,
      'form.stationId': campus.stations[0].id,
      'form.building': campus.buildings[0] || '',
      'form.recipient': this.data.form.recipient || (user && user.nickname) || '',
      'form.slot': (settings.slots[0] || {}).label || '自由接单',
      'form.size': this.data.form.size || (settings.pricing.sizes[0] || {}).id
    }, () => this.quote());
  },

  /** 取件时间只做提示，下单不拦截。 */
  serviceTipOf(settings) {
    const hours = core.serviceHours(settings);
    if (!hours.enabled) return '驿站取件时间请联系代取同学确认';
    return hours.open
      ? '驿站取件时间 ' + hours.text + '，下单不限时间'
      : '现在不在取件时间（' + hours.text + '），代取同学会在开门后去取件';
  },

  onInput(event) {
    const field = event.currentTarget.dataset.field;
    this.setData({ ['form.' + field]: event.detail.value, ['errors.' + field]: '' });
  },

  /** 取件码只收数字，按 2-1-4 位自动补短横线，例如 1234567 → 12-3-4567。 */
  onPickupCode(event) {
    const digits = String(event.detail.value || '').replace(/\D/g, '').slice(0, 7);
    let code = digits;
    if (digits.length > 2) code = digits.slice(0, 2) + '-' + digits.slice(2);
    if (digits.length > 3) code = digits.slice(0, 2) + '-' + digits.slice(2, 3) + '-' + digits.slice(3);
    this.setData({ 'form.pickupCode': code, 'errors.pickupCode': '' });
  },
  pickStation(event) { this.setData({ 'form.stationId': event.currentTarget.dataset.id }); },
  pickBuilding(event) {
    const index = Number(event.detail.value);
    this.setData({ buildingIndex: index, 'form.building': this.data.buildings[index], 'errors.building': '' });
  },
  pickSize(event) {
    this.setData({ 'form.size': event.currentTarget.dataset.id });
    this.quote();
  },
  pickSlot(event) {
    const index = Number(event.detail.value);
    this.setData({ 'form.slot': this.data.slots[index].label });
    this.quote();
  },
  step(event) {
    const delta = Number(event.currentTarget.dataset.delta);
    const next = Math.min(10, Math.max(1, Number(this.data.form.parcelCount || 1) + delta));
    this.setData({ 'form.parcelCount': next, 'errors.parcelCount': '' });
    this.quote();
  },

  /** 报价由服务端计算，本页只展示明细。 */
  quote() {
    clearTimeout(this.quoteTimer);
    this.quoteTimer = setTimeout(async () => {
      const form = this.data.form;
      if (!this.data.campusId || !form.stationId) return;
      try {
        const result = await api.request('/quotes', 'POST', {
          campusId: this.data.campusId, stationId: form.stationId,
          size: form.size, parcelCount: Number(form.parcelCount), slot: form.slot
        });
        this.setData({
          priceLines: (result.lines || []).map(item => ({ label: item.label, amount: (item.cents / 100).toFixed(2) })),
          totalCents: result.totalCents,
          totalText: (result.totalCents / 100).toFixed(2)
        });
      } catch (error) {
        this.setData({ priceLines: [], totalCents: 0, totalText: '0.00' });
      }
    }, 120);
  },

  async upload() {
    if (this.data.photos.length >= 3) return ui.toast('最多上传 3 张截图');
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sizeType: ['compressed'],
      sourceType: ['album', 'camera'],
      success: async result => {
        const file = result.tempFiles[0];
        if (!file) return;
        if (file.size > 8 * 1024 * 1024) return ui.toast('图片过大，请选择 8MB 以内的图片');
        ui.loading('上传中');
        try {
          const uploaded = await api.uploadImage(file.tempFilePath);
          this.setData({ photos: this.data.photos.concat({ fileID: uploaded.fileID, path: file.tempFilePath }) });
        } catch (error) {
          ui.fail(error);
        } finally {
          ui.hideLoading();
        }
      }
    });
  },
  removePhoto(event) {
    const index = Number(event.currentTarget.dataset.index);
    const photos = this.data.photos.slice();
    photos.splice(index, 1);
    this.setData({ photos });
  },
  previewPhoto(event) {
    wx.previewImage({ current: event.currentTarget.dataset.path, urls: this.data.photos.map(item => item.path) });
  },

  validate() {
    const form = this.data.form;
    const errors = {};
    if (!String(form.pickupCode).trim()) errors.pickupCode = '请填写取件码';
    else if (!/^\d{2}-\d-\d{4}$/.test(String(form.pickupCode))) errors.pickupCode = '取件码应为 2-1-4 位数字，例如 12-3-4567';
    if (!String(form.room).trim()) errors.room = '请填写楼下交接位置';
    if (!String(form.recipient).trim()) errors.recipient = '请填写收件人';
    if (!/^1\d{10}$/.test(String(form.phone).trim())) errors.phone = '请填写 11 位手机号码';
    this.setData({ errors });
    const first = Object.keys(errors)[0];
    if (first) { ui.toast(errors[first]); return false; }
    return true;
  },

  async submit() {
    // 趁用户还在点击流程里，顺手申请订单状态提醒的订阅授权（未配置模板时自动跳过）
    await api.requestSubscribe(['assigned', 'pickedUp', 'delivered']);
    if (this.data.busy) return;
    if (!this.validate()) return;
    this.setData({ busy: true });
    ui.loading('提交中');
    try {
      const form = this.data.form;
      const order = await api.request('/orders', 'POST', {
        campusId: this.data.campusId,
        stationId: form.stationId,
        building: form.building,
        room: String(form.room).trim(),
        recipient: String(form.recipient).trim(),
        phone: String(form.phone).trim(),
        pickupCode: String(form.pickupCode).trim(),
        parcelCount: Number(form.parcelCount),
        size: form.size,
        slot: form.slot,
        note: String(form.note || '').trim(),
        photoFileIds: this.data.photos.map(item => item.fileID)
      });
      ui.hideLoading();
      ui.ok('委托已提交');
      wx.redirectTo({ url: '/pages/detail/detail?id=' + order.id });
    } catch (error) {
      ui.hideLoading();
      ui.fail(error);
    } finally {
      this.setData({ busy: false });
    }
  },

  onShareAppMessage() { return share.forApp(); }
});
