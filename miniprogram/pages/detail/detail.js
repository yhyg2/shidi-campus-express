const api = require('../../utils/api');
const format = require('../../utils/format');
const ui = require('../../utils/ui');
const share = require('../../utils/share');

const REVIEW_TAGS = ['准时送达', '沟通顺畅', '包装完好', '态度友好', '价格公道'];
const COMPLAINT_REASONS = [
  { key: 'damaged', label: '快递损坏' },
  { key: 'wrong', label: '送错位置' },
  { key: 'late', label: '严重超时' },
  { key: 'attitude', label: '态度问题' },
  { key: 'other', label: '其他' }
];

Page({
  data: {
    mode: 'owner',
    loading: true,
    order: null,
    photos: [],
    busy: false,
    isOwner: false,
    isRunner: false,
    isStaff: false,
    cancellable: false,
    confirmable: false,
    pickupable: false,
    deliverable: false,
    hasAction: false,
    hint: '',
    contact: {},
    reviewTags: REVIEW_TAGS,
    reviewDraft: null,
    complaintBusy: false
  },

  onLoad(query) {
    this.orderId = (query && query.id) || '';
    this.shareToken = (query && query.share) || '';
    share.enableMenu();
    if (this.shareToken) wx.setNavigationBarTitle({ title: '同学的代取委托' });
  },

  onShow() {
    if (!getApp().ensureAgreement()) return;
    this.load();
  },
  onPullDownRefresh() { this.load().then(() => wx.stopPullDownRefresh()); },

  async load() {
    try {
      if (this.shareToken) {
        const data = await api.request('/share/orders/' + this.shareToken);
        this.setData({ loading: false, mode: 'share', order: format.order(data) });
        return;
      }
      if (!this.orderId) return;
      const app = getApp();
      await app.ready();
      this.setData({ contact: (app.globalData.settings && app.globalData.settings.contact) || {} });
      const order = await api.request('/orders/' + this.orderId);
      const me = app.globalData.user || {};
      const isOwner = order.ownerId === me.id;
      const isRunner = order.runnerId === me.id;
      const isStaff = Boolean(me.isStaff);
      const cancellable = isOwner && ['waiting_assignment', 'assigned'].includes(order.status);
      const confirmable = isOwner && order.status === 'delivered';
      const pickupable = isRunner && order.status === 'assigned';
      const deliverable = isRunner && order.status === 'picked_up';
      this.setData({
        loading: false,
        mode: isOwner ? 'owner' : isRunner ? 'runner' : isStaff ? 'staff' : 'guest',
        order: format.order(order),
        photos: await api.prepareImages(order.photoFileIds, this.orderId),
        isOwner, isRunner, isStaff,
        cancellable, confirmable, pickupable, deliverable,
        canReview: isOwner && order.status === 'completed' && !order.review,
        review: order.review || null,
        hasAction: cancellable || confirmable || pickupable || deliverable,
        hint: this.hintOf(order.status)
      });
    } catch (error) {
      this.setData({ loading: false });
      ui.fail(error);
    }
  },

  hintOf(status) {
    const map = {
      waiting_assignment: '已进入同校区接单大厅，代取接单后会显示取件人',
      assigned: '代取已接单，正在前往驿站',
      picked_up: '已取件，正在送往你填写的交接位置',
      delivered: '代取已送达，确认拿到快递后点「确认收货」',
      completed: '委托已完成，费用请与代取线下结算',
      cancelled: '本次委托已取消'
    };
    return map[status] || '';
  },

  async action(event) {
    const action = event.currentTarget.dataset.action;
    if (this.data.busy) return;
    if (action === 'cancel' || action === 'confirm') {
      const copy = action === 'cancel'
        ? { title: '取消委托', content: '取消后订单不再出现在接单大厅。' }
        : { title: '确认收货', content: '确认已经拿到快递？确认后委托完成。' };
      const agreed = await ui.confirm(Object.assign({ confirmText: '确认' }, copy));
      if (!agreed) return;
    }
    this.setData({ busy: true });
    try {
      if (action === 'cancel') {
        await api.request('/orders/' + this.orderId + '/cancel', 'POST', {});
        ui.ok('已取消');
      } else if (action === 'confirm') {
        await api.request('/orders/' + this.orderId + '/confirm', 'POST', {});
        ui.ok('已确认收货');
      } else if (action === 'pickup' || action === 'deliver') {
        await api.request('/orders/' + this.orderId + '/progress', 'POST', { action });
        ui.ok(action === 'pickup' ? '已确认取件' : '已标记送达');
      }
      await this.load();
    } catch (error) {
      ui.fail(error);
    } finally {
      this.setData({ busy: false });
    }
  },

  copyCode() { ui.copy(this.data.order.pickupCode, '取件码已复制'); },
  copyDelivery() { ui.copy(this.data.order.deliveryCode, '收货码已复制'); },
  callRecipient() { ui.call(this.data.order.phone); },
  openReview() {
    this.setData({ reviewDraft: { rating: 5, tags: [], text: '' } });
  },
  pickStar(event) {
    this.setData({ 'reviewDraft.rating': Number(event.currentTarget.dataset.value) });
  },
  toggleTag(event) {
    const tag = event.currentTarget.dataset.tag;
    const tags = this.data.reviewDraft.tags.slice();
    const index = tags.indexOf(tag);
    if (index >= 0) tags.splice(index, 1); else tags.push(tag);
    this.setData({ 'reviewDraft.tags': tags });
  },
  reviewInput(event) { this.setData({ 'reviewDraft.text': event.detail.value }); },
  closeReview() { this.setData({ reviewDraft: null }); },
  async submitReview() {
    if (this.data.busy) return;
    this.setData({ busy: true });
    try {
      await api.request('/orders/' + this.orderId + '/review', 'POST', {
        rating: this.data.reviewDraft.rating,
        tags: this.data.reviewDraft.tags,
        text: this.data.reviewDraft.text
      });
      ui.ok('评价已提交');
      this.setData({ reviewDraft: null });
      await this.load();
    } catch (error) { ui.fail(error); } finally { this.setData({ busy: false }); }
  },

  async complain() {
    if (this.data.complaintBusy) return;
    const reason = await new Promise(resolve => {
      wx.showActionSheet({
        itemList: COMPLAINT_REASONS.map(item => item.label),
        success: result => resolve(COMPLAINT_REASONS[result.tapIndex]),
        fail: () => resolve(null)
      });
    });
    if (!reason) return;
    const detail = await ui.confirm({
      title: '投诉：' + reason.label,
      content: '请描述发生了什么（至少 5 个字），管理员会联系双方处理。',
      editable: true,
      placeholder: '例如：下午 6 点约好送到 3 栋楼下，一直没到',
      confirmText: '提交投诉'
    });
    if (detail === false) return;
    this.setData({ complaintBusy: true });
    try {
      await api.request('/orders/' + this.orderId + '/complaint', 'POST', { reason: reason.key, detail: String(detail).trim() });
      ui.ok('投诉已提交，管理员会处理');
    } catch (error) { ui.fail(error); } finally { this.setData({ complaintBusy: false }); }
  },

  copyWechat() { ui.copy(this.data.contact.wechatId, '客服微信已复制'); },
  callService() { ui.call(this.data.contact.phone); },
  preview(event) { wx.previewImage({ current: event.currentTarget.dataset.url, urls: this.data.photos }); },
  goHome() { wx.switchTab({ url: '/pages/home/home' }); },

  onShareAppMessage() {
    if (this.data.mode === 'share') return share.forApp();
    return share.forOrder(this.data.order || {});
  },
  onShareTimeline() { return share.timelineFor(this.data.mode === 'share' ? null : this.data.order); }
});
