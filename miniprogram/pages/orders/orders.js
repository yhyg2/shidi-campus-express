const api = require('../../utils/api');
const format = require('../../utils/format');
const share = require('../../utils/share');

const TABS = [
  { id: 'all', label: '全部' },
  { id: 'waiting_assignment', label: '待接单' },
  { id: 'processing', label: '进行中' },
  { id: 'delivered', label: '待确认' },
  { id: 'completed', label: '已完成' }
];

Page({
  data: {
    tabs: TABS.map(item => Object.assign({ count: 0 }, item)),
    active: 'all',
    orders: [],
    loading: true,
    error: ''
  },

  onLoad() { share.enableMenu(); },
  onShow() { this.load(); },
  onPullDownRefresh() { this.load().then(() => wx.stopPullDownRefresh()); },

  async load() {
    try {
      await getApp().ready();
      const orders = await api.request('/orders');
      this.all = format.list(orders);
      this.setData({ loading: false, error: '' });
      this.refresh();
    } catch (error) {
      this.setData({ loading: false, error: error.message || '加载失败' });
    }
  },

  refresh() {
    const all = this.all || [];
    const count = {
      all: all.length,
      waiting_assignment: all.filter(item => item.status === 'waiting_assignment').length,
      processing: all.filter(item => ['assigned', 'picked_up'].includes(item.status)).length,
      delivered: all.filter(item => item.status === 'delivered').length,
      completed: all.filter(item => item.status === 'completed').length
    };
    this.setData({
      tabs: TABS.map(item => Object.assign({}, item, { count: count[item.id] || 0 })),
      orders: all.filter(item => this.match(item.status, this.data.active))
    });
  },

  match(status, tab) {
    if (tab === 'all') return true;
    if (tab === 'processing') return ['assigned', 'picked_up'].includes(status);
    return status === tab;
  },

  switchTab(event) { this.setData({ active: event.currentTarget.dataset.id }, () => this.refresh()); },
  detail(event) { wx.navigateTo({ url: '/pages/detail/detail?id=' + event.detail.id }); },
  create() { wx.navigateTo({ url: '/pages/create/create' }); },
  onShareAppMessage() { return share.forApp(); }
});
