// 轻交互封装：统一 toast / 确认框 / loading 计数，避免各页面重复写 wx.* 回调。
let loadingCount = 0;

function toast(title, icon) {
  wx.showToast({ title: String(title || '操作失败').slice(0, 40), icon: icon || 'none', duration: 2200 });
}
const ok = title => toast(title || '已完成', 'success');

function confirm(options) {
  const opts = typeof options === 'string' ? { content: options } : options || {};
  return new Promise(resolve => {
    wx.showModal({
      title: opts.title || '确认操作',
      content: opts.content || '',
      confirmText: opts.confirmText || '确定',
      cancelText: opts.cancelText || '取消',
      confirmColor: opts.danger ? '#a9503f' : '#24563f',
      editable: Boolean(opts.editable),
      placeholderText: opts.placeholder || '',
      success: result => resolve(result.confirm ? (opts.editable ? result.content || '' : true) : false),
      fail: () => resolve(false)
    });
  });
}

function loading(text) {
  loadingCount += 1;
  wx.showLoading({ title: text || '处理中', mask: true });
}
function hideLoading() {
  loadingCount = Math.max(0, loadingCount - 1);
  if (!loadingCount) wx.hideLoading();
}

/** 统一错误提示：网络类错误给出可执行建议，业务错误直接显示服务端文案。 */
function fail(error) {
  if (!error) return;
  if (error === 'cancel') return;
  if (error.status === 401) return toast('登录已过期，请重新进入小程序');
  toast(error.message || '网络异常，请稍后重试');
}

function copy(text, tip) {
  wx.setClipboardData({ data: String(text || ''), success: () => toast(tip || '已复制') });
}

function call(phone) {
  if (!phone) return toast('暂未获取到联系电话');
  wx.makePhoneCall({ phoneNumber: String(phone), fail: () => {} });
}

module.exports = { toast, ok, confirm, loading, hideLoading, fail, copy, call };
