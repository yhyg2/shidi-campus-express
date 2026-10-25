// 本地演示数据层：没有开通云开发时，也能完整点通界面（数据存在本机 Storage）。
// 业务规则复用 shared/core.js，与云函数保持一致；差异只在“存储”和“鉴权”。
const core = require('./core');

const STORAGE = 'sd_local_db_v7'; // 换校区配置后升级版本，避免读到旧的演示数据
const ME = 'local-me';
const RUNNER = 'local-runner';
let cache = null;

function now() { return Date.now(); }

function buildOrder(settings, input, extra) {
  const price = core.quote(settings, input);
  const campus = core.campusOf(settings, input.campusId);
  const station = core.stationOf(settings, input.campusId, input.stationId);
  const owner = extra.owner || { _id: ME, nickname: '演示同学甲' };
  return Object.assign({
    _id: 'od_' + Math.random().toString(36).slice(2, 10),
    ownerId: owner._id,
    ownerNickname: owner.nickname,
    campusName: campus.name,
    stationLatitude: station.latitude,
    stationLongitude: station.longitude,
    sizeLabel: (core.sizeOf(settings, input.size) || {}).label || '',
    totalCents: price.totalCents,
    priceLines: price.lines,
    status: 'waiting_assignment',
    runnerId: null,
    runnerName: null,
    deliveryCode: String(Math.floor(1000 + Math.random() * 9000)),
    shareToken: core.makeCode(10).toLowerCase(),
    orderNo: core.makeOrderNo(),
    createdAt: now(),
    updatedAt: now(),
    timeline: [{ status: 'waiting_assignment', message: '委托已提交，等待同校代取接单', at: now(), actorId: owner._id }]
  }, input, extra.fields || {});
}

function seed() {
  const settings = core.defaultSettings();
  settings.bootstrapUsed = false;
  const users = {
    [ME]: { _id: ME, nickname: '演示同学甲', avatarUrl: '', campusId: 'demo-campus', role: 'user', runner: null, createdAt: now() },
    [RUNNER]: {
      _id: RUNNER, nickname: '演示同学乙', avatarUrl: '', campusId: 'demo-campus', role: 'user',
      runner: { status: 'approved', campusId: 'demo-campus', realName: '演示同学乙', studentNo: 'DEMO-0001', online: true, appliedAt: now() - 86400000 },
      createdAt: now() - 86400000
    }
  };
  const base = {
    campusId: 'demo-campus', stationId: 'demo-main', building: '', room: '3 号楼 502',
    recipient: '演示同学甲', phone: '10000000000', pickupCode: '12-3-4568', parcelCount: 2,
    size: 'small', slot: '自由接单', note: '', photoFileIds: []
  };
  const waiting = buildOrder(settings, base, {});
  const done = buildOrder(settings, Object.assign({}, base, { room: '5 号楼 301', pickupCode: '08-2-1024', parcelCount: 1 }), {
    fields: { status: 'completed', runnerId: RUNNER, runnerName: '演示同学乙', createdAt: now() - 3600000, updatedAt: now() - 600000 }
  });
  done.timeline = [
    { status: 'waiting_assignment', message: '委托已提交，等待同校代取接单', at: now() - 3600000, actorId: ME },
    { status: 'assigned', message: '代取接下了这份委托', at: now() - 3000000, actorId: RUNNER },
    { status: 'picked_up', message: '代取已取件，正在送往交接点', at: now() - 2400000, actorId: RUNNER },
    { status: 'delivered', message: '代取已送达，请确认收货', at: now() - 1200000, actorId: RUNNER },
    { status: 'completed', message: '你已确认收到快递', at: now() - 600000, actorId: ME }
  ];
  return { settings, users, meId: ME, orders: [waiting, done], invites: [], logs: [], complaints: [] };
}

const VALID_ROLES = ['user', 'admin', 'superadmin'];

function load() {
  if (cache) return cache;
  const saved = wx.getStorageSync(STORAGE);
  cache = saved && saved.settings ? saved : seed();
  // 旧数据里的废弃角色统一降为普通用户
  Object.keys(cache.users || {}).forEach(id => {
    if (!VALID_ROLES.includes(cache.users[id].role)) cache.users[id].role = 'user';
  });
  return cache;
}
function save() { wx.setStorageSync(STORAGE, cache); }
function me() { return load().users[load().meId]; }
function staffList() { const db = load(); return Object.keys(db.users).map(id => db.users[id]).filter(user => core.isStaff(user.role)); }
function pushLog(action, detail) {
  const db = load();
  db.logs.unshift({ action, actorId: db.meId, detail: detail || '', at: now() });
  db.logs = db.logs.slice(0, 50);
}
function need(ability) {
  if (!core.can(me().role, ability)) throw core.fail(403, '当前角色没有该操作权限');
}
function publicSettings(db) {
  const settings = db.settings;
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
function orderView(order) {
  const db = load();
  const runner = order.runnerId ? db.users[order.runnerId] : null;
  return core.orderView(order, me(), runner ? [runner] : []);
}
function dispatch(order) {
  const db = load();
  if (order.status !== 'waiting_assignment' || db.settings.rules.autoDispatch === false) return null;
  const picked = core.pickRunner({
    runners: Object.keys(db.users).map(id => db.users[id]),
    orders: db.orders,
    order,
    rules: db.settings.rules
  });
  if (!picked) return null;
  order.status = 'assigned';
  order.runnerId = picked.openid;
  order.runnerName = picked.nickname;
  order.updatedAt = now();
  order.timeline.push({ status: 'assigned', message: '系统已派给同校区的空闲代取', at: now(), actorId: 'system' });
  return picked;
}

const HANDLERS = {
  'image.urls': (data) => Array.isArray(data.fileIds) ? data.fileIds : [],
  'config.get': () => ({ settings: publicSettings(load()), me: core.publicUser(me()), openid: load().meId, subscribeTemplates: {} }),
  'me.get': () => core.publicUser(me()),
  'me.update': (data) => {
    const user = me();
    user.nickname = core.textField(data.nickname, '昵称', 1, 24);
    save();
    return core.publicUser(user);
  },
  'me.campus': (data) => {
    if (!core.campusOf(load().settings, data.campusId)) throw core.fail(400, '校区无效');
    me().campusId = data.campusId;
    save();
    return { campusId: data.campusId };
  },

  'order.quote': (data) => core.quote(load().settings, data),
  'order.create': (data) => {
    const db = load();
    const input = core.normalizeOrderInput(db.settings, data);
    const order = buildOrder(db.settings, input, {});
    db.orders.unshift(order);
    dispatch(order);
    save();
    return orderView(order);
  },
  'order.list': () => load().orders.filter(item => item.ownerId === load().meId).map(orderView),
  'order.get': (data) => {
    const order = load().orders.find(item => item._id === data.id);
    if (!order) throw core.fail(404, '订单不存在');
    const mine = order.ownerId === load().meId || order.runnerId === load().meId || core.isStaff(me().role);
    if (!mine) throw core.fail(403, '无权查看该订单');
    return orderView(order);
  },
  'order.cancel': (data) => {
    const order = load().orders.find(item => item._id === data.id && item.ownerId === load().meId);
    if (!order) throw core.fail(409, '订单不存在或已被处理');
    if (!['waiting_assignment', 'assigned'].includes(order.status)) throw core.fail(409, '订单已被接单或已结束，无法取消');
    order.status = 'cancelled';
    order.updatedAt = now();
    order.timeline.push({ status: 'cancelled', message: '你取消了这份委托', at: now(), actorId: load().meId });
    save();
    return orderView(order);
  },
  'order.confirm': (data) => {
    const order = load().orders.find(item => item._id === data.id && item.ownerId === load().meId);
    if (!order || order.status !== 'delivered') throw core.fail(409, '订单不在待确认状态');
    order.status = 'completed';
    order.completedAt = now();
    order.timeline.push({ status: 'completed', message: '你已确认收到快递', at: now(), actorId: load().meId });
    save();
    return orderView(order);
  },
  'order.share': (data) => {
    const order = load().orders.find(item => item.shareToken === data.token);
    if (!order) throw core.fail(404, '分享链接已失效');
    return core.shareView(order, order.ownerNickname);
  },

  'runner.hall': () => {
    const user = me();
    if (!user.runner || user.runner.status !== 'approved') throw core.fail(403, '请先完成代取认证');
    return load().orders
      .filter(item => item.status === 'waiting_assignment' && item.campusId === user.runner.campusId && item.ownerId !== load().meId)
      .map(core.hallView);
  },
  'runner.orders': () => {
    const user = me();
    if (!user.runner || user.runner.status !== 'approved') throw core.fail(403, '请先完成代取认证');
    return load().orders.filter(item => item.runnerId === load().meId).map(orderView);
  },
  'runner.availability': (data) => {
    const user = me();
    if (!user.runner || user.runner.status !== 'approved') throw core.fail(403, '请先完成代取认证');
    user.runner.online = Boolean(data.online);
    if (data.online) load().orders.filter(item => item.status === 'waiting_assignment').forEach(dispatch);
    save();
    return { online: user.runner.online };
  },
  'runner.claim': (data) => {
    const db = load();
    const user = me();
    if (!user.runner || user.runner.status !== 'approved') throw core.fail(403, '请先完成代取认证');
    if (!user.runner.online) throw core.fail(409, '请先开启接单');
    const active = db.orders.filter(item => item.runnerId === db.meId && core.ACTIVE_STATUS.includes(item.status)).length;
    if (active >= db.settings.rules.maxActivePerRunner) throw core.fail(409, '在手订单已达上限');
    const order = db.orders.find(item => item._id === data.id && item.status === 'waiting_assignment');
    if (!order) throw core.fail(409, '订单已被其他代取接走，请刷新');
    if (order.ownerId === db.meId || order.campusId !== user.runner.campusId) throw core.fail(403, '只能接同校区的其他用户订单');
    order.status = 'assigned';
    order.runnerId = db.meId;
    order.runnerName = user.nickname;
    order.updatedAt = now();
    order.timeline.push({ status: 'assigned', message: '代取接下了这份委托', at: now(), actorId: db.meId });
    save();
    return orderView(order);
  },
  'runner.progress': (data) => {
    if (!['pickup', 'deliver'].includes(data.action)) throw core.fail(400, '进度操作无效');
    const order = load().orders.find(item => item._id === data.id && item.runnerId === load().meId);
    if (!order) throw core.fail(403, '只能操作分配给自己的订单');
    const from = data.action === 'pickup' ? 'assigned' : 'picked_up';
    const to = data.action === 'pickup' ? 'picked_up' : 'delivered';
    if (order.status !== from) throw core.fail(409, '当前状态不能这样操作');
    order.status = to;
    order.updatedAt = now();
    order.timeline.push({ status: to, message: data.action === 'pickup' ? '代取已取件，正在送往交接点' : '代取已送达，请确认收货', at: now(), actorId: load().meId });
    save();
    return orderView(order);
  },
  'runner.apply': (data) => {
    const db = load();
    const user = me();
    if (user.runner && ['pending', 'approved'].includes(user.runner.status)) throw core.fail(409, '已提交认证或已经通过审核');
    if (data.consent !== true) throw core.fail(400, '请先同意认证信息使用说明');
    const realName = core.textField(data.realName, '姓名', 2, 30);
    const studentNo = core.textField(data.studentNo, '学号', 4, 32);
    if (!new RegExp(db.settings.rules.runnerStudentNoPattern).test(studentNo)) throw core.fail(400, '学号格式不正确');
    const code = String(data.code || '').trim().toUpperCase();
    const invite = db.invites.find(item => item.code === code && item.type === 'runner' && !item.usedBy);
    if (!invite) throw core.fail(400, '邀请码无效或已被使用');
    if (invite.expiresAt < now()) throw core.fail(400, '邀请码已过期');
    invite.usedBy = db.meId;
    invite.usedAt = now();
    user.runner = { status: 'pending', campusId: invite.campusId, realName, studentNo, online: false, appliedAt: now(), photoFileIds: data.photoFileIds || [] };
    pushLog('runner.apply', '已提交认证申请');
    save();
    return { status: 'pending' };
  },

  'member.join': (data) => {
    const db = load();
    const code = String(data.code || '').trim().toUpperCase();
    const invite = db.invites.find(item => item.code === code && item.type === 'member' && !item.usedBy);
    if (!invite) throw core.fail(400, '邀请码无效或已被使用');
    if (invite.expiresAt < now()) throw core.fail(400, '邀请码已过期');
    if (invite.role !== 'admin' || me().role === 'superadmin') throw core.fail(403, '不能使用此成员邀请');
    invite.usedBy = db.meId;
    me().role = invite.role;
    pushLog('member.join', invite.role);
    save();
    return core.publicUser(me());
  },

  'admin.bootstrap': () => {
    const db = load();
    if (db.settings.bootstrapUsed || staffList().length) throw core.fail(409, '已有管理员，请联系现任管理员添加你');
    me().role = 'superadmin';
    db.settings.bootstrapUsed = true;
    pushLog('admin.bootstrap', '初始化超级管理员');
    save();
    return core.publicUser(me());
  },
  'admin.overview': () => {
    need('overview.read');
    const db = load();
    const orders = db.orders;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    return {
      stats: {
        total: orders.length,
        waiting: orders.filter(item => item.status === 'waiting_assignment').length,
        active: orders.filter(item => core.ACTIVE_STATUS.includes(item.status)).length,
        completed: orders.filter(item => item.status === 'completed').length,
        cancelled: orders.filter(item => item.status === 'cancelled').length,
        onlineRunners: Object.keys(db.users).filter(id => db.users[id].runner && db.users[id].runner.online).length,
        pendingRunners: Object.keys(db.users).filter(id => db.users[id].runner && db.users[id].runner.status === 'pending').length,
        staff: staffList().length,
        today: orders.filter(item => item.createdAt >= today.getTime()).length,
        complaints: db.complaints.filter(item => item.status === 'open').length
      },
      complaints: db.complaints.filter(item => item.status === 'open').slice(0, 5),
      recent: orders.slice(0, 5).map(core.hallView),
      logs: db.logs.slice(0, 8)
    };
  },
  'admin.orders': (data) => {
    need('order.read');
    const filter = data.filter || 'all';
    return load().orders
      .filter(item => filter === 'all' || (filter === 'active' ? core.ACTIVE_STATUS.includes(item.status) : item.status === filter))
      .map(item => {
        const view = core.orderView(item, { _id: 'staff', role: 'admin' }, []);
        view.orderNo = item.orderNo;
        view.ownerNickname = item.ownerNickname;
        view.runnerId = item.runnerId;
        return view;
      });
  },
  'admin.order.candidates': (data) => {
    need('order.read');
    const db = load();
    const order = db.orders.find(item => item._id === data.id);
    if (!order) throw core.fail(404, '订单不存在');
    return core.rankRunners({
      runners: Object.keys(db.users).map(id => db.users[id]),
      orders: db.orders,
      order,
      rules: Object.assign({}, db.settings.rules, { requireRunnerOnline: false })
    });
  },
  'admin.order.assign': (data) => {
    need('order.write');
    const db = load();
    const order = db.orders.find(item => item._id === data.id && item.status === 'waiting_assignment');
    if (!order) throw core.fail(409, '订单不在待接单状态');
    const runner = db.users[data.runnerId];
    if (!runner || !runner.runner || runner.runner.status !== 'approved') throw core.fail(409, '该用户不是可接单的代取');
    const candidates = core.rankRunners({ runners: [runner], orders: db.orders, order, rules: Object.assign({}, db.settings.rules, { requireRunnerOnline: false }) });
    if (!candidates.length) throw core.fail(409, '该代取不符合接单条件');
    order.status = 'assigned';
    order.runnerId = data.runnerId;
    order.runnerName = runner.nickname;
    order.updatedAt = now();
    order.timeline.push({ status: 'assigned', message: '管理员指派了代取', at: now(), actorId: db.meId });
    pushLog('order.assign', order._id + ' → ' + runner.nickname);
    save();
    return { ok: true };
  },
  'admin.order.cancel': (data) => {
    need('order.write');
    const db = load();
    const order = db.orders.find(item => item._id === data.id);
    if (!order) throw core.fail(404, '订单不存在');
    if (['completed', 'cancelled'].includes(order.status)) throw core.fail(409, '订单已结束');
    order.status = 'cancelled';
    order.staffNote = data.reason || '';
    order.updatedAt = now();
    order.timeline.push({ status: 'cancelled', message: '管理员取消了订单：' + (data.reason || '未填写原因'), at: now(), actorId: db.meId });
    pushLog('order.cancel', order._id);
    save();
    return { ok: true };
  },
  'order.review': (data) => {
    const db = load();
    const order = db.orders.find(item => item._id === data.id && item.ownerId === db.meId);
    if (!order) throw core.fail(403, '只能评价自己的订单');
    if (order.status !== 'completed') throw core.fail(409, '订单完成后才能评价');
    if (order.review) throw core.fail(409, '这单已经评价过了');
    const score = Number(data.rating);
    if (!Number.isInteger(score) || score < 1 || score > 5) throw core.fail(400, '评分应为 1–5 星');
    order.review = {
      rating: score,
      tags: (Array.isArray(data.tags) ? data.tags : []).slice(0, 6),
      text: data.text ? String(data.text).slice(0, 200) : '',
      createdAt: now()
    };
    pushLog('order.review', order._id + ' ' + score + ' 星');
    save();
    return { ok: true };
  },

  'order.complaint': (data) => {
    const db = load();
    if (!['damaged', 'wrong', 'late', 'attitude', 'other'].includes(data.reason)) throw core.fail(400, '请选择投诉原因');
    const detail = core.textField(data.detail, '问题描述', 5, 300);
    const order = db.orders.find(item => item._id === data.id && item.ownerId === db.meId);
    if (!order) throw core.fail(403, '只能投诉自己的订单');
    if (db.complaints.some(item => item.orderId === order._id && item.status === 'open')) throw core.fail(409, '这单已有待处理的投诉');
    db.complaints.unshift({
      id: 'cp_' + now().toString(36), orderId: order._id, orderNo: order.orderNo,
      ownerId: db.meId, ownerNickname: me().nickname,
      runnerId: order.runnerId || '', runnerName: order.runnerName || '',
      stationName: order.stationName, reason: data.reason, detail,
      status: 'open', createdAt: now()
    });
    pushLog('order.complaint', order._id + ' ' + data.reason);
    save();
    return { ok: true };
  },

  'admin.complaints': () => {
    need('order.read');
    return load().complaints;
  },

  'admin.complaint.resolve': (data) => {
    need('order.write');
    const db = load();
    const note = core.textField(data.note, '处理说明', 2, 200);
    const item = db.complaints.find(entry => entry.id === data.id && entry.status === 'open');
    if (!item) throw core.fail(409, '投诉不存在或已处理');
    item.status = 'resolved';
    item.note = note;
    item.handledAt = now();
    pushLog('complaint.resolve', item.id);
    save();
    return { ok: true };
  },

  'admin.runner.invite': (data) => {
    need('runner.write');
    const db = load();
    if (!core.campusOf(db.settings, data.campusId)) throw core.fail(400, '校区无效');
    const code = core.makeCode(8);
    const expiresAt = now() + (db.settings.rules.runnerInviteTtlHours || 24) * 3600000;
    db.invites.unshift({ code, type: 'runner', role: '', campusId: data.campusId, expiresAt, usedBy: null, createdAt: now(), createdBy: db.meId });
    pushLog('runner.invite', data.campusId + ' ' + code);
    save();
    return { code, campusId: data.campusId, expiresAt };
  },
  'admin.runners': () => {
    need('runner.read');
    const db = load();
    return Object.keys(db.users)
      .filter(id => db.users[id].runner)
      .map(id => {
        const user = db.users[id];
        return {
          id, nickname: user.nickname, campusId: user.runner.campusId, status: user.runner.status,
          online: Boolean(user.runner.online), realName: user.runner.realName, studentNo: user.runner.studentNo,
          reason: user.runner.reason || '', appliedAt: user.runner.appliedAt
        };
      });
  },
  'admin.runner.review': (data) => {
    need('runner.write');
    const db = load();
    if (!['approved', 'rejected', 'suspended'].includes(data.decision)) throw core.fail(400, '审核决定无效');
    core.textField(data.reason, '审核备注', 2, 200);
    const user = db.users[data.id];
    if (!user || !user.runner) throw core.fail(404, '未找到认证申请');
    if (data.decision === 'suspended' && db.orders.some(item => item.runnerId === data.id && core.ACTIVE_STATUS.includes(item.status))) {
      throw core.fail(409, '该代取还有进行中的订单，请先处理');
    }
    user.runner.status = data.decision;
    user.runner.online = false;
    user.runner.reason = data.reason;
    pushLog('runner.' + data.decision, user.nickname);
    save();
    return { ok: true };
  },
  'admin.pricing.get': () => {
    need('pricing.read');
    const settings = load().settings;
    return { pricing: settings.pricing, slots: settings.slots, campuses: settings.school.campuses.map(item => ({ id: item.id, name: item.name })) };
  },
  'admin.pricing.save': (data) => {
    need('pricing.write');
    const db = load();
    const pricing = Object.assign({}, db.settings.pricing, data.pricing || {});
    if (!Array.isArray(pricing.sizes) || !pricing.sizes.length) throw core.fail(400, '至少保留一种包裹尺寸');
    if (Number(pricing.minTotal) > Number(pricing.maxTotal)) throw core.fail(400, '最低价不能高于最高价');
    db.settings.pricing = pricing;
    if (Array.isArray(data.slots) && data.slots.length) db.settings.slots = data.slots.map(item => ({ label: String(item.label).slice(0, 20), surcharge: Math.max(0, Number(item.surcharge) || 0) }));
    pushLog('pricing.save', '起送 ' + pricing.minTotal);
    save();
    return { pricing: db.settings.pricing, slots: db.settings.slots };
  },
  'admin.notice.list': () => { need('notice.read'); return load().settings.notices || []; },
  'admin.notice.save': (data) => {
    need('notice.write');
    const db = load();
    const title = core.textField(data.title, '公告标题', 2, 40);
    const content = core.textField(data.content, '公告内容', 2, 500);
    const notices = db.settings.notices || [];
    if (data.id) {
      const index = notices.findIndex(item => item.id === data.id);
      if (index < 0) throw core.fail(404, '公告不存在');
      notices[index] = Object.assign({}, notices[index], { title, content, level: data.level, pinned: Boolean(data.pinned), active: data.active !== false, updatedAt: now() });
    } else {
      notices.unshift({ id: 'ntc_' + now().toString(36), title, content, level: data.level === 'warn' ? 'warn' : 'info', pinned: Boolean(data.pinned), active: true, publishedAt: now(), publishedBy: db.meId });
    }
    db.settings.notices = notices.slice(0, 20);
    pushLog('notice.save', title);
    save();
    return { notices: db.settings.notices };
  },
  'admin.notice.remove': (data) => {
    need('notice.write');
    const db = load();
    db.settings.notices = (db.settings.notices || []).filter(item => item.id !== data.id);
    save();
    return { notices: db.settings.notices };
  },
  'admin.members': () => {
    need('member.read');
    const db = load();
    return {
      members: Object.keys(db.users).filter(id => core.isStaff(db.users[id].role)).map(id => ({
        id, nickname: db.users[id].nickname, role: db.users[id].role, roleLabel: core.roleLabel(db.users[id].role)
      })),
      invites: db.invites.filter(item => item.type === 'member').map(item => ({
        id: item.code, code: item.code, role: item.role, roleLabel: core.roleLabel(item.role), expiresAt: item.expiresAt, usedBy: item.usedBy
      }))
    };
  },
  'admin.member.invite': (data) => {
    need('member.write');
    const db = load();
    if (data.role !== 'admin') throw core.fail(400, '只能邀请管理员');
    const code = core.makeCode(8);
    const expiresAt = now() + (db.settings.rules.memberInviteTtlHours || 72) * 3600000;
    db.invites.unshift({ code, type: 'member', role: data.role, campusId: '', expiresAt, usedBy: null, createdAt: now(), createdBy: db.meId });
    pushLog('member.invite', data.role + ' ' + code);
    save();
    return { code, role: data.role, roleLabel: core.roleLabel(data.role), expiresAt };
  },
  'admin.member.remove': (data) => {
    need('member.write');
    const db = load();
    const target = db.users[data.id];
    if (!target) throw core.fail(404, '成员不存在');
    if (target.role === 'superadmin') throw core.fail(403, '不能移除超级管理员');
    target.role = 'user';
    pushLog('member.remove', data.id);
    save();
    return { ok: true };
  },
  'admin.settings.get': () => {
    need('settings.read');
    const settings = load().settings;
    return { school: settings.school, rules: settings.rules, slots: settings.slots, contact: settings.contact || {} };
  },
  'admin.settings.save': (data) => {
    need('settings.write');
    const db = load();
    if (data.contact) {
      const contact = {
        wechatId: String(data.contact.wechatId || '').trim().slice(0, 40),
        phone: String(data.contact.phone || '').trim().slice(0, 20)
      };
      if (contact.phone && !/^\d{6,20}$/.test(contact.phone)) throw core.fail(400, '客服电话格式不正确');
      db.settings.contact = contact;
    }
    if (data.school) db.settings.school = data.school;
    if (data.rules) {
      const rules = Object.assign({}, db.settings.rules, data.rules);
      if (rules.serviceHours) {
        const hours = rules.serviceHours;
        const valid = /^\d{2}:\d{2}$/.test(hours.start || '') && /^\d{2}:\d{2}$/.test(hours.end || '');
        if (!valid) throw core.fail(400, '取件时间格式应为 10:30');
        if (hours.start >= hours.end) throw core.fail(400, '结束时间要晚于开始时间');
        rules.serviceHours = { enabled: hours.enabled !== false, start: hours.start, end: hours.end };
      }
      rules.staleMinutes = Math.min(120, Math.max(1, Number(rules.staleMinutes) || 10));
      db.settings.rules = rules;
    }
    if (Array.isArray(data.slots) && data.slots.length) db.settings.slots = data.slots;
    pushLog('settings.save', '');
    save();
    return { school: db.settings.school, rules: db.settings.rules, slots: db.settings.slots, contact: db.settings.contact || {} };
  },
  'admin.export': (data) => {
    need('order.write');
    const db = load();
    const filter = data.filter || 'all';
    const rows = db.orders
      .filter(item => filter === 'all' || (filter === 'active' ? core.ACTIVE_STATUS.includes(item.status) : item.status === filter))
      .slice(0, 500);
    return { filename: 'orders-' + new Date().toISOString().slice(0, 10) + '.csv', csv: core.ordersCsv(rows) };
  },

  'admin.logs': () => { need('log.read'); return load().logs; }
};

function call(action, data) {
  const handler = Object.prototype.hasOwnProperty.call(HANDLERS, action) ? HANDLERS[action] : null;
  if (!handler) return Promise.reject(core.fail(404, '未实现的本地操作：' + action));
  try { return Promise.resolve(handler(data || {})); }
  catch (error) { return Promise.reject(error); }
}

/** 演示用：切换本地角色 / 重置数据（只在本地模式出现入口）。 */
function setRole(role) {
  if (!core.isStaff(role) && role !== 'user') throw core.fail(400, '角色无效');
  me().role = role;
  save();
  return core.publicUser(me());
}
function reset() {
  wx.removeStorageSync(STORAGE);
  cache = null;
  return true;
}

module.exports = { call, setRole, reset };
