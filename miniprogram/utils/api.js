// 统一数据层：页面只管调用 /orders 这样的路径，背后是云函数还是本地演示由这里决定。
const config = require('../config');
const routes = require('./routes');

function source() {
  const mode = config.DATA_SOURCE || 'auto';
  if (!['auto', 'cloud', 'local', 'http'].includes(mode)) throw new Error('数据源配置无效');
  if (mode !== 'auto') return mode;
  return config.CLOUD_ENV ? 'cloud' : 'local';
}

function callCloud(action, data) {
  return new Promise((resolve, reject) => {
    if (!wx.cloud) return reject(Object.assign(new Error('当前基础库不支持云开发，请升级微信'), { code: 'NO_CLOUD' }));
    wx.cloud.callFunction({
      name: config.CLOUD_FUNCTION || 'api',
      data: { action, data },
      success(result) {
        const payload = result && result.result;
        if (payload && payload.ok) return resolve(payload.data);
        const info = (payload && payload.error) || {};
        reject(Object.assign(new Error(info.message || '操作失败'), { code: info.code || 'CLOUD_ERROR' }));
      },
      fail(error) {
        const message = (error && error.errMsg) || '';
        if (message.indexOf('FunctionName') >= 0 || message.indexOf('not found') >= 0) {
          return reject(Object.assign(new Error('云函数 api 尚未部署：请右键 cloudfunctions/api → 上传并部署（云端安装依赖）'), { code: 'NO_FUNCTION' }));
        }
        reject(Object.assign(new Error('云开发调用失败：' + message), { code: 'CLOUD_FAIL' }));
      }
    });
  });
}

function callHttp(path, method, data) {
  if (!config.API_BASE) return Promise.reject(Object.assign(new Error('http 模式未配置 API_BASE'), { code: 'NO_API' }));
  return new Promise((resolve, reject) => {
    wx.request({
      url: config.API_BASE + path,
      method: method || 'GET',
      data: data || undefined,
      timeout: 15000,
      header: { 'content-type': 'application/json' },
      success(response) {
        const payload = response.data || {};
        if (response.statusCode >= 200 && response.statusCode < 300) return resolve(payload.data);
        reject(Object.assign(new Error((payload.error && payload.error.message) || '请求失败'), { status: response.statusCode }));
      },
      fail: () => reject(Object.assign(new Error('网络连接失败'), { code: 'NETWORK' }))
    });
  });
}

function request(path, method, data) {
  const route = routes.match(method || 'GET', path);
  if (!route) return Promise.reject(Object.assign(new Error('未实现的接口：' + path), { code: 'NO_ROUTE' }));
  const payload = Object.assign({}, data || {}, route.params || {});
  const mode = source();
  const task = mode === 'cloud'
    ? callCloud(route.action, payload)
    : mode === 'http'
      ? callHttp(path, method, data)
      : require('./local').call(route.action, payload);
  return Promise.resolve(task).catch(error => Promise.reject(error && error.message ? error : Object.assign(new Error('操作失败'), { code: 'UNKNOWN' })));
}

/** 图片上传：云开发走云存储，本地演示直接用临时路径（仅当前会话可见）。 */
function uploadImage(filePath) {
  if (source() !== 'cloud') return Promise.resolve({ fileID: filePath, local: true });
  return new Promise((resolve, reject) => {
    const openid = getApp().globalData.openid;
    if (!/^[\w-]{1,128}$/.test(openid || '')) return reject(new Error('请先登录'));
    const ext = ((filePath.match(/\.(\w+)$/) || [])[1] || 'jpg').toLowerCase();
    if (!['jpg', 'jpeg', 'png', 'webp'].includes(ext)) return reject(new Error('图片格式不支持'));
    const cloudPath = 'orders/' + openid + '/' + Date.now() + '-' + Math.random().toString(36).slice(2, 14) + '.' + ext;
    wx.cloud.uploadFile({
      cloudPath,
      filePath,
      success: result => resolve({ fileID: result.fileID }),
      fail: error => reject(Object.assign(new Error('图片上传失败：' + ((error && error.errMsg) || '')), { code: 'UPLOAD_FAIL' }))
    });
  });
}

/** 云存储图片转临时链接，供 <image> 与 previewImage 使用。 */
function prepareImages(fileIds, orderId) {
  const list = (fileIds || []).filter(Boolean);
  if (!list.length) return Promise.resolve([]);
  if (source() !== 'cloud') return Promise.resolve(list);
  return request('/images/urls', 'POST', { orderId, fileIds: list }).then(urls => urls.filter(Boolean));
}

/** 一次性订阅授权：模板 ID 未配置时静默跳过，不阻塞业务。 */
function requestSubscribe(keys) {
  const app = getApp();
  const map = app.globalData.subscribeTemplates || {};
  const ids = (keys || []).map(key => map[key]).filter(Boolean).slice(0, 3);
  if (!ids.length || !wx.requestSubscribeMessage) return Promise.resolve({ accepted: [] });
  return new Promise(resolve => {
    wx.requestSubscribeMessage({
      tmplIds: ids,
      success: result => resolve({ accepted: ids.filter(id => result[id] === 'accept'), result }),
      fail: () => resolve({ accepted: [] })
    });
  });
}

module.exports = { request, uploadImage, prepareImages, source, requestSubscribe };
