const crypto = require('node:crypto');
const core = require('./core');

function assert(condition, status, message) {
  if (!condition) throw core.fail(status, message);
}

function validateRequest(event, openid) {
  assert(typeof openid === 'string' && /^[\w-]{1,128}$/.test(openid), 401, '请通过微信小程序登录');
  assert(event && typeof event === 'object' && !Array.isArray(event), 400, '请求格式错误');
  assert(typeof event.action === 'string' && /^[a-z][a-zA-Z.]{1,79}$/.test(event.action), 400, '操作格式错误');
  const data = event.data === undefined ? {} : event.data;
  assert(data && typeof data === 'object' && !Array.isArray(data), 400, '参数格式错误');
  assert(Buffer.byteLength(JSON.stringify(data)) <= 32768, 400, '请求内容过大');
  for (const key of ['id', 'runnerId', 'campusId', 'stationId']) {
    if (data[key] !== undefined) assert(typeof data[key] === 'string' && /^[\w-]{1,128}$/.test(data[key]), 400, '标识格式错误');
  }
  if (data.filter !== undefined) assert(['all', 'active', ...Object.keys(core.STATUS)].includes(data.filter), 400, '筛选条件无效');
  return Object.assign({}, event, { data });
}

function assertBootstrap(openid, expected) {
  assert(typeof expected === 'string' && expected.trim().length > 0, 403, '请先在云函数环境变量配置初始化管理员账号');
  assert(openid === expected.trim(), 403, '当前账号不能初始化管理员');
}

function randomCode(length = 10) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length }, () => alphabet[crypto.randomInt(alphabet.length)]).join('');
}

function ownedPhotos(files, openid, required = false) {
  assert(files === undefined || Array.isArray(files), 400, '图片列表格式错误');
  const list = files || [];
  assert(list.length <= 3 && (!required || list.length > 0), 400, '请上传 1–3 张认证图片');
  for (const id of list) {
    assert(typeof id === 'string' && id.length < 1024, 400, '图片标识无效');
    const marker = '/orders/' + openid + '/';
    assert(/^cloud:\/\/[^/]+\//.test(id) && id.includes(marker), 403, '只能使用自己上传的图片');
    const file = id.slice(id.indexOf(marker) + marker.length);
    assert(/^[A-Za-z0-9_-]+\.(jpg|jpeg|png|webp)$/i.test(file), 400, '图片格式不支持');
  }
  return [...new Set(list)];
}

function money(value, label, max = 1000000) {
  const number = Number(value);
  assert(Number.isSafeInteger(number) && number >= 0 && number <= max, 400, label + '应为范围内的整数金额（分）');
  return number;
}

function pricingOf(current, patch = {}) {
  const input = Object.assign({}, current, patch);
  assert(['perParcel', 'perOrder'].includes(input.chargeMode), 400, '计费方式无效');
  const result = { currency: 'CNY', chargeMode: input.chargeMode };
  for (const key of ['baseFee', 'minTotal', 'maxTotal', 'roundTo']) result[key] = money(input[key], key);
  assert(result.minTotal <= result.maxTotal, 400, '最低价不能高于最高价');
  assert(Array.isArray(input.sizes) && input.sizes.length > 0 && input.sizes.length <= 20, 400, '至少保留一种包裹尺寸');
  const ids = new Set();
  result.sizes = input.sizes.map(item => {
    assert(item && typeof item.id === 'string' && /^[\w-]{1,32}$/.test(item.id) && !ids.has(item.id), 400, '尺寸标识无效或重复');
    ids.add(item.id);
    return { id: item.id, label: core.textField(item.label, '尺寸名称', 1, 30), hint: String(item.hint || '').slice(0, 100), cents: money(item.cents, '尺寸价格') };
  });
  result.campusAdjust = {};
  for (const [key, value] of Object.entries(input.campusAdjust || {})) {
    assert(/^[\w-]{1,64}$/.test(key) && !['__proto__', 'constructor', 'prototype'].includes(key), 400, '校区加价标识无效');
    result.campusAdjust[key] = money(value, '校区加价');
  }
  // 当前版本没有可信的服务端距离来源，不能采用客户端提交的距离计费。
  assert(!input.distance || input.distance.enabled !== true, 400, '距离计费尚未接入，不能启用');
  result.distance = Object.assign({}, current.distance, { enabled: false });
  result.settleNote = core.textField(input.settleNote, '结算说明', 1, 300);
  return result;
}

function slotsOf(slots) {
  assert(Array.isArray(slots) && slots.length > 0 && slots.length <= 20, 400, '至少保留一个配送时段');
  const names = new Set();
  return slots.map(item => {
    const label = core.textField(item && item.label, '时段', 1, 20);
    assert(!names.has(label), 400, '配送时段不能重复');
    names.add(label);
    return { label, surcharge: money(item.surcharge, '时段加价') };
  });
}

function rulesOf(current, patch) {
  const result = Object.assign({}, current);
  for (const key of ['autoDispatch', 'requireRunnerOnline', 'requireRunnerIdPhoto']) {
    if (patch[key] !== undefined) { assert(typeof patch[key] === 'boolean', 400, '规则开关格式错误'); result[key] = patch[key]; }
  }
  for (const [key, min, max] of [['maxActivePerRunner', 1, 10], ['staleMinutes', 1, 120], ['runnerInviteTtlHours', 1, 168], ['memberInviteTtlHours', 1, 168]]) {
    if (patch[key] !== undefined) {
      const value = Number(patch[key]);
      assert(Number.isInteger(value) && value >= min && value <= max, 400, key + '超出范围');
      result[key] = value;
    }
  }
  // 仅支持安全的字符集与长度模式，避免可配置正则导致回溯耗尽。
  if (patch.runnerStudentNoPattern !== undefined) {
    assert(typeof patch.runnerStudentNoPattern === 'string' && /^\^\[[A-Za-z0-9\\d-]+\]\{\d{1,2}(,\d{1,2})?\}\$$/.test(patch.runnerStudentNoPattern), 400, '学号规则仅支持字符集与长度，例如 ^[A-Za-z0-9-]{4,24}$');
    const lengths = patch.runnerStudentNoPattern.match(/\{(\d+)(?:,(\d+))?\}/);
    assert(Number(lengths[1]) >= 1 && Number(lengths[2] || lengths[1]) <= 32 && Number(lengths[1]) <= Number(lengths[2] || lengths[1]), 400, '学号长度范围无效');
    new RegExp(patch.runnerStudentNoPattern);
    result.runnerStudentNoPattern = patch.runnerStudentNoPattern;
  }
  if (patch.serviceHours) {
    const h = patch.serviceHours;
    const valid = value => typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
    assert(valid(h.start) && valid(h.end) && h.start < h.end, 400, '取件时间格式或范围无效');
    result.serviceHours = { enabled: h.enabled !== false, start: h.start, end: h.end };
  }
  if (patch.preferNearby !== undefined) assert(patch.preferNearby === false, 400, '按距离派单尚未接入');
  result.preferNearby = false;
  return result;
}

module.exports = { validateRequest, assertBootstrap, randomCode, ownedPhotos, pricingOf, slotsOf, rulesOf };
