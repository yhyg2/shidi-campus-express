// 分享能力：卡片分享（好友/群）+ 朋友圈。
// 订单分享只带 shareToken，服务端返回脱敏摘要——分享出去的链接看不到手机号和取件码。
const config = require('../config');

const APP_TITLE = config.BRAND + ' · 校园代取｜把取快递的时间，留给校园生活';

function enableMenu() {
  if (!wx.showShareMenu) return;
  wx.showShareMenu({ withShareTicket: true, menus: ['shareAppMessage', 'shareTimeline'] });
}

function forApp() {
  return { title: APP_TITLE, path: '/pages/home/home' };
}

function forOrder(order) {
  if (!order || !order.shareToken) return forApp();
  return {
    title: '帮个忙：去' + order.stationName + '取 ' + order.parcelCount + ' 件快递',
    path: '/pages/detail/detail?share=' + order.shareToken
  };
}

/** 代取招募：路径带一次性邀请码，好友点开即落到认证页并自动填码。 */
function forRecruit(inviteCode) {
  return {
    title: '来当校园代取：顺路帮同学取快递，按单结算',
    path: inviteCode ? '/packageRunner/apply/apply?code=' + inviteCode : '/packageRunner/apply/apply'
  };
}

function timelineFor(order) {
  return { title: order ? '帮个忙：去' + order.stationName + '取件｜' + config.BRAND : APP_TITLE, query: order && order.shareToken ? 'share=' + order.shareToken : '' };
}

module.exports = { enableMenu, forApp, forOrder, forRecruit, timelineFor };
