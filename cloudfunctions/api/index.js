// 拾递 · 云开发聚合云函数
// 一个函数承载全部业务，前端通过 { action, data } 调用；权限全部在服务端判断。
const cloud = require('wx-server-sdk');
const core = require('./lib/core');
const security = require('./lib/security');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const C = { users: 'users', orders: 'orders', settings: 'settings', invites: 'invites', logs: 'logs', complaints: 'complaints', limits: 'rate_limits' };

// 订阅消息模板 ID：小程序后台申请后填到这里；留空表示不推送。
// 前端会在提交委托前调 wx.requestSubscribeMessage 申请这几类授权。
const SUBSCRIBE_TEMPLATES = {
  assigned: '',   // 订单被接单 → 通知下单人
  pickedUp: '',   // 代取已取件 → 通知下单人
  delivered: '',  // 已送达 → 通知下单人确认
  cancelled: ''   // 订单被取消 → 通知下单人/代取
};

/** 发订阅消息：未配置模板或发送失败都只记日志，不影响主流程。 */
async function pushSubscribe(type, touser, page, data) {
  const templateId = SUBSCRIBE_TEMPLATES[type];
  if (!templateId || !touser) return;
  try {
    await cloud.openapi.subscribeMessage.send({ touser, templateId, page, data });
  } catch (error) {
    await log('subscribe.fail', touser, type + ' ' + ((error && error.errMsg) || String(error)));
  }
}
const SETTINGS_ID = 'main';
let initialized = false;

/** 云开发不会自动建集合；首次调用时创建并写入默认配置。 */
async function ensureInit() {
  if (initialized) return;
  for (const name of Object.values(C)) {
    try { await db.createCollection(name); } catch (error) { /* 已存在 */ }
  }
  try {
    const existing = await db.collection(C.settings).doc(SETTINGS_ID).get();
    if (!existing.data) throw new Error('empty');
  } catch (error) {
    await db.collection(C.settings).add({ data: Object.assign({ _id: SETTINGS_ID }, core.defaultSettings()) }).catch(() => {});
  }
  initialized = true;
}

async function getSettings() {
  const result = await db.collection(C.settings).doc(SETTINGS_ID).get();
  return Object.assign(core.defaultSettings(), result.data || {});
}

async function saveSettings(settings, openid) {
  settings.updatedAt = Date.now();
  settings.updatedBy = openid;
  const payload = Object.assign({}, settings);
  delete payload._id; // _id 不能出现在 set 的 data 里
  await db.collection(C.settings).doc(SETTINGS_ID).set({ data: payload });
  return settings;
}

async function ensureUser(openid) {
  try {
    const result = await db.collection(C.users).doc(openid).get();
    if (result.data) return result.data;
  } catch (error) { /* 不存在，走创建 */ }
  const settings = await getSettings();
  const campusId = settings.school.campuses[0] ? settings.school.campuses[0].id : '';
  const user = {
    _id: openid, openid, nickname: '微信同学', avatarUrl: '', campusId, role: 'user',
    runner: null, lastLoginAt: Date.now(), createdAt: Date.now()
  };
  try { await db.collection(C.users).add({ data: user }); }
  catch (error) {
    const fresh = await db.collection(C.users).doc(openid).get();
    if (fresh.data) return fresh.data;
    throw error;
  }
  return user;
}

async function log(action, openid, detail) {
  await db.collection(C.logs).add({
    data: { action, actorId: openid, detail: detail || '', at: Date.now() }
  }).catch(() => {});
}

const assert = (condition, status, message) => { if (!condition) throw core.fail(status, message); };

/** 内容检查：接口故障和未明确通过的结果均拒绝提交。 */
async function secCheck(openid, text, scene) {
  if (!text || !String(text).trim()) return;
  let result;
  try {
    result = await cloud.openapi.security.msgSecCheck({ openid, scene: scene || 2, version: 2, content: String(text).slice(0, 2500) });
  } catch (error) {
    if (error && error.errCode === 87014) throw core.fail(400, '内容包含违规信息，请修改后再提交');
    await log('seccheck.fail', openid, '内容检测接口不可用');
    throw core.fail(503, '内容检查暂不可用，请稍后再试');
  }
  assert(result && (!result.errCode || result.errCode === 0) && result.result && result.result.suggest === 'pass', 400, '内容未通过检查，请修改后再提交');
}
const requireAbility = (user, ability) => assert(core.can(user.role, ability), 403, '当前角色没有该操作权限');

async function transaction(work) {
  let value;
  await db.runTransaction(async tx => { value = await work(tx); return value; });
  return value;
}

async function docOrNull(store, collection, id) {
  try { return (await store.collection(collection).doc(id).get()).data || null; }
  catch (error) {
    const code = error && (error.errCode || error.code);
    if (code === -502005 || code === 'DATABASE_DOCUMENT_NOT_EXIST' || error.status === 404 || /document.*(not exist|not found)/i.test(error.message || error.errMsg || '')) return null;
    throw error;
  }
}

/** 同一账号限速保存在数据库，多实例共享；被拒绝的调用不会修改业务数据。 */
async function throttle(openid, group, maximum) {
  const bucket = Math.floor(Date.now() / 60000);
  const id = openid + '-' + group;
  await transaction(async tx => {
    const current = await docOrNull(tx, C.limits, id);
    const count = current && current.bucket === bucket ? current.count : 0;
    assert(count < maximum, 429, '操作过于频繁，请稍后再试');
    await tx.collection(C.limits).doc(id).set({ data: { bucket, count: count + 1, expiresAt: Date.now() + 120000 } });
  });
}

/** 在同一事务内锁定代取与订单，最终校验资格、校区和容量。 */
async function assignOrder(id, runnerId, settings, actorId, manual = false) {
  const initial = await db.collection(C.users).doc(runnerId).get();
  let seedIds = [];
  if (!Array.isArray(initial.data.activeOrderIds)) {
    const active = await db.collection(C.orders).where({ runnerId, status: _.in(core.ACTIVE_STATUS) }).limit(100).get();
    seedIds = active.data.map(item => item._id);
  }
  return transaction(async tx => {
    const runner = await docOrNull(tx, C.users, runnerId);
    const order = await docOrNull(tx, C.orders, id);
    assert(order && order.status === 'waiting_assignment', 409, '订单不在待接单状态');
    assert(runner && runner.runner && runner.runner.status === 'approved', 403, '请先完成代取认证');
    assert(runnerId !== order.ownerId && runner.runner.campusId === order.campusId, 403, '只能接同校区的其他用户订单');
    assert(manual || runner.runner.online, 409, '请先开启接单');
    const ids = [...new Set(Array.isArray(runner.activeOrderIds) ? runner.activeOrderIds : seedIds)];
    const activeIds = [];
    assert(ids.length <= 20, 409, '在手订单记录异常，请联系管理员核对');
    for (const activeId of ids) {
      const active = await docOrNull(tx, C.orders, activeId);
      if (active && active.runnerId === runnerId && core.ACTIVE_STATUS.includes(active.status)) activeIds.push(activeId);
    }
    assert(activeIds.length < settings.rules.maxActivePerRunner, 409, '在手订单已达上限');
    const at = Date.now();
    const patch = {
      status: 'assigned', runnerId, runnerName: runner.nickname, assignedAt: at, updatedAt: at,
      timeline: (order.timeline || []).concat({ status: 'assigned', message: manual ? '管理员指派了代取' : '代取接下了这份委托', at, actorId })
    };
    await tx.collection(C.users).doc(runnerId).update({ data: { activeOrderIds: activeIds.concat(id) } });
    await tx.collection(C.orders).doc(id).update({ data: patch });
    return Object.assign({}, order, patch);
  });
}

async function dispatch(order, settings) {
  if (order.status !== 'waiting_assignment' || settings.rules.autoDispatch === false) return null;
  const users = await db.collection(C.users).where({ 'runner.status': 'approved' }).limit(100).get();
  const active = await db.collection(C.orders).where({ campusId: order.campusId, status: _.in(core.ACTIVE_STATUS) }).limit(100).get();
  const candidates = core.rankRunners({ runners: users.data, orders: active.data, order, rules: settings.rules });
  for (const picked of candidates) {
    try { await assignOrder(order._id, picked.openid, settings, 'system'); return picked; }
    catch (error) { if (!error.status || error.status >= 500) throw error; }
  }
  return null;
}

function publicSettings(settings) {
  return {
    school: settings.school,
    pricing: settings.pricing,
    slots: settings.slots,
    contact: settings.contact || { wechatId: '', phone: '' },
    rules: {
      serviceHours: settings.rules.serviceHours,
      staleMinutes: settings.rules.staleMinutes,
      maxActivePerRunner: settings.rules.maxActivePerRunner,
      autoDispatch: settings.rules.autoDispatch,
      requireRunnerOnline: settings.rules.requireRunnerOnline,
      runnerInviteTtlHours: settings.rules.runnerInviteTtlHours,
      requireRunnerIdPhoto: settings.rules.requireRunnerIdPhoto,
      runnerStudentNoPatternHint: '4–24 位字母、数字或短横线'
    },
    notices: core.activeNotices(settings, 20)
  };
}

const ACTIONS = {
  // ---------------- 基础 ----------------
  async 'config.get'({ openid, user, settings }) {
    return { settings: publicSettings(settings), me: core.publicUser(user), openid, canBootstrap: !settings.bootstrapUsed && openid === (process.env.BOOTSTRAP_ADMIN_OPENID || '').trim(), subscribeTemplates: SUBSCRIBE_TEMPLATES };
  },

  async 'me.get'({ user }) { return core.publicUser(user); },

  async 'me.update'({ event, openid }) {
    const nickname = core.textField(event.data && event.data.nickname, '昵称', 1, 24);
    await secCheck(openid, nickname, 2);
    await db.collection(C.users).doc(openid).update({ data: { nickname, updatedAt: Date.now() } });
    const fresh = await db.collection(C.users).doc(openid).get();
    return core.publicUser(fresh.data);
  },

  async 'me.campus'({ event, openid, settings }) {
    const campusId = event.data && event.data.campusId;
    assert(core.campusOf(settings, campusId), 400, '校区无效');
    await db.collection(C.users).doc(openid).update({ data: { campusId } });
    return { campusId };
  },

  async 'image.urls'({ event, openid, user }) {
    const { orderId, fileIds } = event.data;
    assert(typeof orderId === 'string' && /^[\w-]{1,128}$/.test(orderId), 400, '缺少订单标识');
    const order = await docOrNull(db, C.orders, orderId);
    assert(order, 404, '订单不存在');
    assert(order.ownerId === openid || order.runnerId === openid || core.isStaff(user.role), 403, '无权查看订单图片');
    assert(Array.isArray(fileIds) && fileIds.length <= 3 && fileIds.every(id => typeof id === 'string' && (order.photoFileIds || []).includes(id)), 403, '无权查看图片');
    if (!fileIds.length) return [];
    const result = await cloud.getTempFileURL({ fileList: fileIds.map(fileID => ({ fileID, maxAge: 300 })) });
    return (result.fileList || []).map(item => item.tempFileURL || '');
  },

  // ---------------- 订单 ----------------
  async 'order.quote'({ event, settings }) { return core.quote(settings, event.data || {}); },

  async 'order.create'({ event, openid, user, settings }) {
    const input = core.normalizeOrderInput(settings, event.data || {});
    input.photoFileIds = security.ownedPhotos(event.data.photoFileIds, openid);
    await secCheck(openid, input.recipient + ' ' + input.note, 2);
    const price = core.quote(settings, input);
    const campus = core.campusOf(settings, input.campusId);
    const station = core.stationOf(settings, input.campusId, input.stationId);
    const now = Date.now();
    const order = Object.assign({}, input, {
      ownerId: openid,
      ownerNickname: user.nickname,
      stationName: input.stationName,
      stationLatitude: station.latitude,
      stationLongitude: station.longitude,
      campusName: campus.name,
      sizeLabel: (core.sizeOf(settings, input.size) || {}).label || '',
      totalCents: price.totalCents,
      priceLines: price.lines,
      status: 'waiting_assignment',
      runnerId: null,
      runnerName: null,
      deliveryCode: String(require('node:crypto').randomInt(1000, 10000)),
      shareToken: security.randomCode(24).toLowerCase(),
      orderNo: 'SD' + Date.now() + security.randomCode(8),
      createdAt: now, updatedAt: now,
      timeline: [{ status: 'waiting_assignment', message: '委托已提交，等待同校代取接单', at: now, actorId: openid }]
    });
    delete order.distanceMeters;
    const added = await db.collection(C.orders).add({ data: order });
    order._id = added._id;
    if (settings.rules.autoDispatch !== false) {
      try { await dispatch(order, settings); }
      catch (error) { await log('dispatch.fail', openid, '订单已保存，等待手动接单'); }
    }
    const fresh = await db.collection(C.orders).doc(added._id).get();
    return core.orderView(fresh.data, user, []);
  },

  async 'order.list'({ openid, user }) {
    const result = await db.collection(C.orders).where({ ownerId: openid }).orderBy('createdAt', 'desc').limit(50).get();
    return result.data.map(item => core.orderView(item, user, []));
  },

  async 'order.get'({ event, openid, user }) {
    const id = event.data && event.data.id;
    const result = await db.collection(C.orders).doc(id).get().catch(() => null);
    const order = result && result.data;
    assert(order, 404, '订单不存在');
    const isOwner = order.ownerId === openid;
    const isRunner = order.runnerId === openid;
    assert(isOwner || isRunner || core.isStaff(user.role), 403, '无权查看该订单');
    const runner = order.runnerId ? (await db.collection(C.users).doc(order.runnerId).get().catch(() => null)) : null;
    return core.orderView(order, user, runner && runner.data ? [runner.data] : []);
  },

  /** 分享：只凭 token，返回脱敏摘要，任何人可看。 */
  async 'order.share'({ event }) {
    const token = event.data && event.data.token;
    assert(typeof token === 'string' && /^[a-z2-9]{24}$/.test(token), 404, '分享链接已失效');
    const result = await db.collection(C.orders).where({ shareToken: token }).limit(1).get();
    const order = result.data[0];
    assert(order, 404, '分享链接已失效');
    const owner = await db.collection(C.users).doc(order.ownerId).get().catch(() => null);
    return core.shareView(order, owner && owner.data ? owner.data.nickname : '');
  },

  async 'order.cancel'({ event, openid, user }) {
    const id = event.data && event.data.id;
    const result = await db.collection(C.orders).where({ _id: id, ownerId: openid, status: _.in(['waiting_assignment', 'assigned']) }).update({
      data: {
        status: 'cancelled', updatedAt: Date.now(),
        timeline: _.push([{ status: 'cancelled', message: '你取消了这份委托', at: Date.now(), actorId: openid }])
      }
    });
    assert(result.stats.updated === 1, 409, '订单已被接单或已结束，无法取消');
    const fresh = await db.collection(C.orders).doc(id).get();
    if (fresh.data.runnerId) {
      await pushSubscribe('cancelled', fresh.data.runnerId, 'pages/detail/detail?id=' + id, {
        thing1: { value: fresh.data.orderNo }, thing2: { value: '下单人取消了委托' }
      });
    }
    return core.orderView(fresh.data, user, []);
  },

  async 'order.confirm'({ event, openid, user }) {
    const id = event.data && event.data.id;
    const result = await db.collection(C.orders).where({ _id: id, ownerId: openid, status: 'delivered' }).update({
      data: {
        status: 'completed', updatedAt: Date.now(), completedAt: Date.now(),
        timeline: _.push([{ status: 'completed', message: '你已确认收到快递', at: Date.now(), actorId: openid }])
      }
    });
    assert(result.stats.updated === 1, 409, '订单不在待确认状态');
    const fresh = await db.collection(C.orders).doc(id).get();
    return core.orderView(fresh.data, user, []);
  },

  // ---------------- 代取 ----------------
  async 'runner.hall'({ user, settings }) {
    assert(user.runner && user.runner.status === 'approved', 403, '请先完成代取认证');
    const result = await db.collection(C.orders)
      .where({ status: 'waiting_assignment', campusId: user.runner.campusId })
      .orderBy('createdAt', 'asc').limit(30).get();
    return result.data.filter(item => item.ownerId !== user._id).map(core.hallView);
  },

  async 'runner.orders'({ openid, user }) {
    assert(user.runner && user.runner.status === 'approved', 403, '请先完成代取认证');
    const result = await db.collection(C.orders).where({ runnerId: openid }).orderBy('createdAt', 'desc').limit(50).get();
    return result.data.map(item => core.orderView(item, user, []));
  },

  async 'runner.availability'({ event, openid, user }) {
    const online = event.data.online;
    assert(typeof online === 'boolean', 400, '接单状态格式无效');
    await transaction(async tx => {
      const current = await docOrNull(tx, C.users, openid);
      assert(current && current.runner && current.runner.status === 'approved', 403, '请先完成代取认证');
      await tx.collection(C.users).doc(openid).update({ data: { 'runner.online': online } });
    });
    if (online) {
      const settings = await getSettings();
      const waiting = await db.collection(C.orders).where({ campusId: user.runner.campusId, status: 'waiting_assignment' }).limit(20).get();
      for (const order of waiting.data) {
        try { await dispatch(order, settings); }
        catch (error) { await log('dispatch.fail', openid, '等待手动接单'); }
      }
    }
    return { online };
  },

  async 'runner.claim'({ event, openid, user, settings }) {
    const order = await assignOrder(event.data.id, openid, settings, openid);
    await pushSubscribe('assigned', order.ownerId, 'pages/detail/detail?id=' + order._id, {
      thing1: { value: order.orderNo }, thing2: { value: '代取已接单' }
    });
    return core.orderView(order, user, [user]);
  },

  async 'runner.progress'({ event, openid, user }) {
    const id = event.data && event.data.id;
    const action = event.data && event.data.action;
    assert(['pickup', 'deliver'].includes(action), 400, '进度操作无效');
    assert(user.runner && user.runner.status === 'approved', 403, '代取资格无效');
    const order = (await db.collection(C.orders).doc(id).get().catch(() => null));
    assert(order && order.data, 404, '订单不存在');
    assert(order.data.runnerId === openid, 403, '只能操作分配给自己的订单');
    const from = action === 'pickup' ? 'assigned' : 'picked_up';
    const to = action === 'pickup' ? 'picked_up' : 'delivered';
    assert(order.data.status === from, 409, '当前状态不能这样操作');
    const message = action === 'pickup' ? '代取已取件，正在送往交接点' : '代取已送达，请确认收货';
    const result = await db.collection(C.orders).where({ _id: id, status: from, runnerId: openid }).update({
      data: { status: to, updatedAt: Date.now(), timeline: _.push([{ status: to, message, at: Date.now(), actorId: openid }]) }
    });
    assert(result.stats.updated === 1, 409, '状态已变化，请刷新');
    const fresh = await db.collection(C.orders).doc(id).get();
    await pushSubscribe(action === 'pickup' ? 'pickedUp' : 'delivered', fresh.data.ownerId, 'pages/detail/detail?id=' + id, {
      thing1: { value: fresh.data.orderNo },
      thing2: { value: action === 'pickup' ? '代取已取件，配送中' : '已送达，请确认收货' }
    });
    return core.orderView(fresh.data, user, [user]);
  },

  /** 代取认证：邀请码 + 学号规则，之后等管理员审核。 */
  async 'runner.apply'({ event, openid }) {
    const data = event.data || {};
    const code = String(data.code || '').trim().toUpperCase();
    const realName = core.textField(data.realName, '姓名', 2, 30);
    const studentNo = core.textField(data.studentNo, '学号', 4, 32);
    assert(data.consent === true, 400, '请先同意认证信息使用说明');
    const current = await db.collection(C.users).doc(openid).get().catch(() => null);
    const existing = current && current.data && current.data.runner;
    assert(!(existing && ['pending', 'approved'].includes(existing.status)), 409, '已提交认证或已通过，无需重复申请');
    const settings = await getSettings();
    assert(new RegExp(settings.rules.runnerStudentNoPattern).test(studentNo), 400, '学号格式不正确');
    const found = await db.collection(C.invites).where({ code, type: 'runner', usedBy: null }).limit(1).get();
    const invite = found.data[0];
    assert(invite, 400, '邀请码无效或已被使用');
    assert(invite.expiresAt > Date.now(), 400, '邀请码已过期');
    const photos = security.ownedPhotos(data.photoFileIds, openid, settings.rules.requireRunnerIdPhoto === true);
    await transaction(async tx => {
      const freshInvite = await docOrNull(tx, C.invites, invite._id);
      const freshUser = await docOrNull(tx, C.users, openid);
      assert(freshInvite && !freshInvite.usedBy && freshInvite.expiresAt > Date.now() && freshInvite.type === 'runner', 409, '邀请码已使用或失效');
      assert(!(freshUser.runner && ['pending', 'approved'].includes(freshUser.runner.status)), 409, '已提交认证或已经通过审核');
      await tx.collection(C.invites).doc(invite._id).update({ data: { usedBy: openid, usedAt: Date.now() } });
      await tx.collection(C.users).doc(openid).update({ data: { runner: { status: 'pending', campusId: freshInvite.campusId, realName, studentNo, online: false, appliedAt: Date.now(), photoFileIds: photos } } });
    });
    await log('runner.apply', openid, '已提交认证申请');
    return { status: 'pending' };
  },

  // ---------------- 评价与投诉 ----------------
  /** 订单完成后由下单人提交，一单一评。 */
  async 'order.review'({ event, openid }) {
    const { id, rating, tags, text } = event.data;
    const score = Number(rating);
    assert(Number.isInteger(score) && score >= 1 && score <= 5, 400, '评分应为 1–5 星');
    const words = text ? core.textField(text, '评价内容', 1, 200) : '';
    const allowed = ['准时送达', '沟通顺畅', '包装完好', '态度友好', '价格公道'];
    const list = Array.isArray(tags) ? [...new Set(tags.filter(tag => allowed.includes(tag)))].slice(0, 5) : [];
    await secCheck(openid, words, 2);
    await transaction(async tx => {
      const order = await docOrNull(tx, C.orders, id);
      assert(order, 404, '订单不存在');
      assert(order.ownerId === openid, 403, '只能评价自己的订单');
      assert(order.status === 'completed', 409, '订单完成后才能评价');
      assert(!order.review, 409, '这单已经评价过了');
      await tx.collection(C.orders).doc(id).update({ data: { review: { rating: score, tags: list, text: words, createdAt: Date.now() }, updatedAt: Date.now() } });
    });
    await log('order.review', openid, id + ' ' + score + ' 星');
    return { ok: true };
  },

  /** 投诉：仅下单人，一单同时只能有一条未处理的。 */
  async 'order.complaint'({ event, openid, user }) {
    const { id, reason, detail } = event.data;
    assert(['damaged', 'wrong', 'late', 'attitude', 'other'].includes(reason), 400, '请选择投诉原因');
    const words = core.textField(detail, '问题描述', 5, 300);
    await secCheck(openid, words, 2);
    const complaintId = 'cp_' + security.randomCode(24);
    await transaction(async tx => {
      const order = await docOrNull(tx, C.orders, id);
      assert(order, 404, '订单不存在');
      assert(order.ownerId === openid, 403, '只能投诉自己的订单');
      assert(!order.openComplaintId, 409, '这单已有待处理的投诉');
      await tx.collection(C.complaints).doc(complaintId).set({ data: {
        orderId: id, orderNo: order.orderNo, ownerId: openid, ownerNickname: user.nickname,
        runnerId: order.runnerId || '', runnerName: order.runnerName || '', stationName: order.stationName,
        reason, detail: words, status: 'open', createdAt: Date.now()
      } });
      await tx.collection(C.orders).doc(id).update({ data: { openComplaintId: complaintId } });
    });
    await log('order.complaint', openid, id + ' ' + reason);
    return { ok: true };
  },

  async 'admin.complaints'({ user }) {
    requireAbility(user, 'order.read');
    const list = await db.collection(C.complaints).orderBy('createdAt', 'desc').limit(50).get();
    return list.data;
  },

  async 'admin.complaint.resolve'({ event, openid, user }) {
    requireAbility(user, 'order.write');
    const { id, note } = event.data;
    const words = core.textField(note, '处理说明', 2, 200);
    await transaction(async tx => {
      const complaint = await docOrNull(tx, C.complaints, id);
      assert(complaint && complaint.status === 'open', 409, '投诉不存在或已处理');
      const order = await docOrNull(tx, C.orders, complaint.orderId);
      await tx.collection(C.complaints).doc(id).update({ data: { status: 'resolved', note: words, handledBy: openid, handledAt: Date.now() } });
      if (order && order.openComplaintId === id) await tx.collection(C.orders).doc(complaint.orderId).update({ data: { openComplaintId: '' } });
    });
    await log('complaint.resolve', openid, id);
    return { ok: true };
  },

  // ---------------- 成员邀请 ----------------
  async 'member.join'({ event, openid, user }) {
    const code = String((event.data && event.data.code) || '').trim().toUpperCase();
    assert(code, 400, '请输入邀请码');
    const found = await db.collection(C.invites).where({ code, type: 'member', usedBy: null }).limit(1).get();
    const invite = found.data[0];
    assert(invite, 400, '邀请码无效或已被使用');
    assert(invite.expiresAt > Date.now(), 400, '邀请码已过期');
    assert(invite.role === 'admin', 400, '邀请码角色无效');
    await transaction(async tx => {
      const fresh = await docOrNull(tx, C.invites, invite._id);
      const current = await docOrNull(tx, C.users, openid);
      assert(current.role !== 'superadmin', 403, '超级管理员不能使用成员邀请');
      assert(fresh && fresh.type === 'member' && fresh.role === 'admin' && !fresh.usedBy && fresh.expiresAt > Date.now(), 409, '邀请码已使用或失效');
      await tx.collection(C.invites).doc(invite._id).update({ data: { usedBy: openid, usedAt: Date.now() } });
      await tx.collection(C.users).doc(openid).update({ data: { role: 'admin', joinedAt: Date.now() } });
    });
    await log('member.join', openid, 'role=' + invite.role);
    const fresh = await db.collection(C.users).doc(openid).get();
    return core.publicUser(fresh.data);
  },

  // ---------------- 管理端 ----------------
  /** 首个管理员初始化：仅当系统内没有任何管理角色时可用，且只能用一次。 */
  async 'admin.bootstrap'({ openid }) {
    security.assertBootstrap(openid, process.env.BOOTSTRAP_ADMIN_OPENID);
    const existing = await db.collection(C.users).where({ role: _.in(Object.keys(core.ABILITIES)) }).count();
    assert(existing.total === 0, 409, '已有管理员，请联系现任管理员添加你');
    await transaction(async tx => {
      const settings = await docOrNull(tx, C.settings, SETTINGS_ID);
      assert(settings && !settings.bootstrapUsed, 409, '已有管理员，请联系现任管理员添加你');
      await tx.collection(C.settings).doc(SETTINGS_ID).update({ data: { bootstrapUsed: true, updatedAt: Date.now() } });
      await tx.collection(C.users).doc(openid).update({ data: { role: 'superadmin', joinedAt: Date.now() } });
    });
    await log('admin.bootstrap', openid, '初始化超级管理员');
    return core.publicUser((await db.collection(C.users).doc(openid).get()).data);
  },

  async 'admin.overview'({ user }) {
    requireAbility(user, 'overview.read');
    const [total, waiting, active, completed, cancelled] = await Promise.all([
      db.collection(C.orders).count(),
      db.collection(C.orders).where({ status: 'waiting_assignment' }).count(),
      db.collection(C.orders).where({ status: _.in(core.ACTIVE_STATUS) }).count(),
      db.collection(C.orders).where({ status: 'completed' }).count(),
      db.collection(C.orders).where({ status: 'cancelled' }).count()
    ]);
    const [onlineRunners, pendingRunners, staffCount] = await Promise.all([
      db.collection(C.users).where({ 'runner.status': 'approved', 'runner.online': true }).count(),
      db.collection(C.users).where({ 'runner.status': 'pending' }).count(),
      db.collection(C.users).where({ role: _.in(Object.keys(core.ABILITIES)) }).count()
    ]);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayOrders = await db.collection(C.orders).where({ createdAt: _.gte(today.getTime()) }).count();
    const recent = await db.collection(C.orders).orderBy('createdAt', 'desc').limit(5).get();
    const logs = await db.collection(C.logs).orderBy('at', 'desc').limit(8).get();
    const [openComplaints, complaintsCount] = await Promise.all([
      db.collection(C.complaints).where({ status: 'open' }).orderBy('createdAt', 'desc').limit(5).get(),
      db.collection(C.complaints).where({ status: 'open' }).count()
    ]);
    return {
      stats: {
        total: total.total, waiting: waiting.total, active: active.total, completed: completed.total,
        cancelled: cancelled.total, onlineRunners: onlineRunners.total, pendingRunners: pendingRunners.total,
        staff: staffCount.total, today: todayOrders.total, complaints: complaintsCount.total
      },
      complaints: openComplaints.data,
      recent: recent.data.map(core.hallView),
      logs: logs.data
    };
  },

  async 'admin.orders'({ event, user }) {
    requireAbility(user, 'order.read');
    const filter = (event.data && event.data.filter) || 'all';
    const where = filter === 'all' ? {} : { status: filter === 'active' ? _.in(core.ACTIVE_STATUS) : filter };
    const result = await db.collection(C.orders).where(where).orderBy('createdAt', 'desc').limit(60).get();
    return result.data.map(item => {
      const view = core.orderView(item, { _id: 'staff', role: 'admin' }, []);
      view.orderNo = item.orderNo;
      view.ownerNickname = item.ownerNickname;
      view.runnerId = item.runnerId;
      return view;
    });
  },

  /** 管理员手动指派时的候选代取（含离线，便于临时安排） */
  async 'admin.order.candidates'({ event, user, settings }) {
    requireAbility(user, 'order.read');
    const id = event.data && event.data.id;
    const order = (await db.collection(C.orders).doc(id).get().catch(() => null));
    assert(order && order.data, 404, '订单不存在');
    const users = await db.collection(C.users).where({ 'runner.status': 'approved' }).limit(200).get();
    const active = await db.collection(C.orders).where({ campusId: order.data.campusId, status: _.in(core.ACTIVE_STATUS) }).limit(500).get();
    return core.rankRunners({ runners: users.data, orders: active.data, order: order.data, rules: Object.assign({}, settings.rules, { requireRunnerOnline: false }) });
  },

  async 'admin.order.assign'({ event, openid, user, settings }) {
    requireAbility(user, 'order.write');
    const { id, runnerId } = event.data;
    assert(id && runnerId, 400, '参数不完整');
    await assignOrder(id, runnerId, settings, openid, true);
    await log('order.assign', openid, id);
    return { ok: true };
  },

  async 'admin.order.cancel'({ event, openid, user }) {
    requireAbility(user, 'order.write');
    const { id, reason } = event.data || {};
    assert(id, 400, '缺少订单号');
    const words = reason ? core.textField(reason, '取消原因', 1, 200) : ''; 
    const result = await db.collection(C.orders).where({ _id: id, status: _.nin(['completed', 'cancelled']) }).update({
      data: {
        status: 'cancelled', updatedAt: Date.now(), staffNote: words,
        timeline: _.push([{ status: 'cancelled', message: '管理员取消了订单', at: Date.now(), actorId: openid }])
      }
    });
    assert(result.stats.updated === 1, 404, '订单不存在或已结束');
    await log('order.cancel', openid, id + ' ' + (reason || ''));
    return { ok: true };
  },

  /** 代取邀请码：绑定校区，一次性，过期作废。 */
  async 'admin.runner.invite'({ event, openid, user, settings }) {
    requireAbility(user, 'runner.write');
    const campusId = event.data && event.data.campusId;
    assert(core.campusOf(settings, campusId), 400, '校区无效');
    const code = security.randomCode(8);
    const expiresAt = Date.now() + (settings.rules.runnerInviteTtlHours || 24) * 3600 * 1000;
    await db.collection(C.invites).add({ data: { code, type: 'runner', role: '', campusId, expiresAt, usedBy: null, createdAt: Date.now(), createdBy: openid } });
    await log('runner.invite', openid, campusId);
    return { code, campusId, expiresAt };
  },

  async 'admin.runners'({ user }) {
    requireAbility(user, 'runner.read');
    const result = await db.collection(C.users).where({ runner: _.neq(null) }).limit(100).get();
    return result.data.map(item => ({
      id: item._id,
      nickname: item.nickname,
      campusId: item.runner.campusId,
      status: item.runner.status,
      online: Boolean(item.runner.online),
      realName: item.runner.realName,
      studentNo: item.runner.studentNo,
      reason: item.runner.reason || '',
      appliedAt: item.runner.appliedAt
    }));
  },

  async 'admin.runner.review'({ event, openid, user }) {
    requireAbility(user, 'runner.write');
    const { id, decision, reason } = event.data;
    assert(['approved', 'rejected', 'suspended'].includes(decision), 400, '审核决定无效');
    const words = core.textField(reason, '审核备注', 2, 200);
    const existing = await db.collection(C.orders).where({ runnerId: id, status: _.in(core.ACTIVE_STATUS) }).limit(100).get();
    await transaction(async tx => {
      const target = await docOrNull(tx, C.users, id);
      assert(target && target.runner, 404, '未找到认证申请');
      if (decision !== 'approved') {
        const ids = [...new Set((target.activeOrderIds || []).concat(existing.data.map(order => order._id)))];
        assert(ids.length <= 20, 409, '请先核对进行中的订单');
        for (const orderId of ids) {
          const order = await docOrNull(tx, C.orders, orderId);
          assert(!order || order.runnerId !== id || !core.ACTIVE_STATUS.includes(order.status), 409, '该代取还有进行中的订单，请先处理');
        }
      }
      await tx.collection(C.users).doc(id).update({ data: {
        runner: Object.assign({}, target.runner, { status: decision, online: false, reason: words, reviewedBy: openid, reviewedAt: Date.now() })
      } });
    });
    await log('runner.' + decision, openid, id);
    return { ok: true };
  },

  async 'admin.pricing.get'({ user, settings }) {
    requireAbility(user, 'pricing.read');
    return { pricing: settings.pricing, slots: settings.slots, campuses: settings.school.campuses.map(item => ({ id: item.id, name: item.name })) };
  },

  async 'admin.pricing.save'({ event, openid, user }) {
    requireAbility(user, 'pricing.write');
    const settings = await getSettings();
    const patch = (event.data && event.data.pricing) || {};
    const pricing = security.pricingOf(settings.pricing, patch);
    if (event.data.slots !== undefined) settings.slots = security.slotsOf(event.data.slots);
    settings.pricing = pricing;
    await saveSettings(settings, openid);
    await log('pricing.save', openid, '起送 ' + pricing.minTotal + ' / 最高 ' + pricing.maxTotal);
    return { pricing: settings.pricing, slots: settings.slots };
  },

  async 'admin.notice.list'({ user, settings }) {
    requireAbility(user, 'notice.read');
    return settings.notices || [];
  },

  async 'admin.notice.save'({ event, openid, user }) {
    requireAbility(user, 'notice.write');
    const settings = await getSettings();
    const data = event.data || {};
    const title = core.textField(data.title, '公告标题', 2, 40);
    const content = core.textField(data.content, '公告内容', 2, 500);
    await secCheck(openid, content, 2);
    const notices = settings.notices || [];
    if (data.id) {
      const index = notices.findIndex(item => item.id === data.id);
      assert(index >= 0, 404, '公告不存在');
      notices[index] = Object.assign({}, notices[index], {
        title, content, level: data.level === 'warn' ? 'warn' : 'info',
        pinned: Boolean(data.pinned), active: data.active !== false, updatedAt: Date.now()
      });
    } else {
      notices.unshift({
        id: 'ntc_' + Date.now().toString(36), title, content,
        level: data.level === 'warn' ? 'warn' : 'info',
        pinned: Boolean(data.pinned), active: true,
        publishedAt: Date.now(), publishedBy: openid
      });
    }
    settings.notices = notices.slice(0, 20);
    await saveSettings(settings, openid);
    await log('notice.save', openid, title);
    return { notices: settings.notices };
  },

  async 'admin.notice.remove'({ event, openid, user }) {
    requireAbility(user, 'notice.write');
    const settings = await getSettings();
    const id = event.data && event.data.id;
    settings.notices = (settings.notices || []).filter(item => item.id !== id);
    await saveSettings(settings, openid);
    await log('notice.remove', openid, id);
    return { notices: settings.notices };
  },

  async 'admin.members'({ user }) {
    requireAbility(user, 'member.read');
    const staff = await db.collection(C.users).where({ role: _.in(Object.keys(core.ABILITIES)) }).limit(50).get();
    const invites = await db.collection(C.invites).where({ type: 'member' }).orderBy('createdAt', 'desc').limit(20).get();
    return {
      members: staff.data.map(item => ({
        id: item._id, nickname: item.nickname, role: item.role, roleLabel: core.roleLabel(item.role),
        joinedAt: item.joinedAt || item.createdAt
      })),
      invites: invites.data.map(item => ({ id: item._id, code: item.code, role: item.role, roleLabel: core.roleLabel(item.role), expiresAt: item.expiresAt, usedBy: item.usedBy }))
    };
  },

  async 'admin.member.invite'({ event, openid, user, settings }) {
    requireAbility(user, 'member.write');
    const role = event.data && event.data.role;
    assert(role === 'admin', 400, '只能邀请管理员');
    const code = security.randomCode(8);
    const expiresAt = Date.now() + (settings.rules.memberInviteTtlHours || 72) * 3600 * 1000;
    await db.collection(C.invites).add({
      data: { code, type: 'member', role, campusId: '', expiresAt, usedBy: null, createdAt: Date.now(), createdBy: openid }
    });
    await log('member.invite', openid, role);
    return { code, role, roleLabel: core.roleLabel(role), expiresAt };
  },

  async 'admin.member.remove'({ event, openid, user }) {
    requireAbility(user, 'member.write');
    const id = event.data && event.data.id;
    assert(id !== openid, 403, '不能移除自己');
    const target = await db.collection(C.users).doc(id).get().catch(() => null);
    assert(target && target.data, 404, '成员不存在');
    assert(target.data.role !== 'superadmin', 403, '不能移除超级管理员');
    await db.collection(C.users).doc(id).update({ data: { role: 'user' } });
    await log('member.remove', openid, id);
    return { ok: true };
  },

  async 'admin.settings.get'({ user, settings }) {
    requireAbility(user, 'settings.read');
    return { school: settings.school, rules: settings.rules, slots: settings.slots, contact: settings.contact || {} };
  },

  async 'admin.settings.save'({ event, openid, user }) {
    requireAbility(user, 'settings.write');
    const settings = await getSettings();
    const data = event.data || {};
    if (data.contact) {
      const contact = {
        wechatId: String(data.contact.wechatId || '').trim().slice(0, 40),
        phone: String(data.contact.phone || '').trim().slice(0, 20)
      };
      if (contact.phone && !/^\d{6,20}$/.test(contact.phone)) throw core.fail(400, '客服电话格式不正确');
      settings.contact = contact;
    }
    if (data.school) {
      assert(Array.isArray(data.school.campuses) && data.school.campuses.length, 400, '至少保留一个校区');
      for (const campus of data.school.campuses) {
        assert(campus.id && campus.name, 400, '校区缺少名称');
        assert(Array.isArray(campus.stations) && campus.stations.length, 400, campus.name + ' 至少需要一个驿站');
      }
      settings.school = { name: String(data.school.name || settings.school.name).slice(0, 30), campuses: data.school.campuses };
    }
    if (data.rules) settings.rules = security.rulesOf(settings.rules, data.rules);
    if (data.slots !== undefined) settings.slots = security.slotsOf(data.slots);
    await saveSettings(settings, openid);
    await log('settings.save', openid, '');
    return { school: settings.school, rules: settings.rules, slots: settings.slots, contact: settings.contact || {} };
  },

  /** 导出订单 CSV：仅管理员及以上；一次最多 500 条。 */
  async 'admin.export'({ event, openid, user }) {
    requireAbility(user, 'order.write');
    const filter = (event.data && event.data.filter) || 'all';
    const where = filter === 'all' ? {} : filter === 'active' ? { status: _.in(core.ACTIVE_STATUS) } : { status: filter };
    const result = await db.collection(C.orders).where(where).orderBy('createdAt', 'desc').limit(500).get();
    return {
      filename: 'orders-' + new Date().toISOString().slice(0, 10) + '.csv',
      csv: core.ordersCsv(result.data)
    };
  },

  async 'admin.logs'({ user }) {
    requireAbility(user, 'log.read');
    const result = await db.collection(C.logs).orderBy('at', 'desc').limit(50).get();
    return result.data;
  }
};

exports.main = async (input = {}) => {
  let action = '';
  try {
    const { OPENID } = cloud.getWXContext();
    const event = security.validateRequest(input, OPENID);
    action = event.action;
    assert(Object.prototype.hasOwnProperty.call(ACTIONS, action), 404, '未知操作');
    await ensureInit();
    const settings = await getSettings();
    const user = await ensureUser(OPENID);
    const group = ['runner.apply', 'member.join'].includes(action) ? 'invite' : action === 'order.create' ? 'create' : 'request';
    await throttle(OPENID, group, group === 'invite' ? 10 : group === 'create' ? 6 : 120);
    const data = await ACTIONS[action]({ event, openid: OPENID, user, settings });
    return { ok: true, data, version: 3 };
  } catch (error) {
    const status = error.status || 500;
    // 不向控制台打印请求体、姓名、电话、邀请码或完整异常对象。
    if (status >= 500) console.error('[api]', action, 'internal failure');
    return { ok: false, error: { code: status >= 500 ? 'INTERNAL_ERROR' : error.code || 'BAD_REQUEST', message: status >= 500 ? '服务暂不可用，请稍后再试' : error.message } };
  }
};
