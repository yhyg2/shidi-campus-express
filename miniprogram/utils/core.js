// 业务核心：纯函数，不依赖云开发 SDK，可被单测直接调用。
// 云函数 index.js 只负责“取数据 → 调这里 → 写数据”。

const ROLES = {
  user: { label: '普通用户', desc: '下单时是学生，认证代取后可接单' },
  superadmin: { label: '超级管理员', desc: '拥有全部管理权限' },
  admin: { label: '管理员', desc: '除转移超管外的全部管理权限' }
};

const ABILITIES = {
  superadmin: ['*'],
  admin: ['overview.read', 'order.read', 'order.write', 'runner.read', 'runner.write', 'pricing.read', 'pricing.write', 'notice.read', 'notice.write', 'member.read', 'member.write', 'settings.read', 'settings.write', 'log.read']
};

const STATUS = {
  waiting_assignment: { label: '待接单', tone: 'progress', step: 1 },
  assigned: { label: '待取件', tone: 'progress', step: 2 },
  picked_up: { label: '配送中', tone: 'progress', step: 3 },
  delivered: { label: '待确认', tone: 'progress', step: 4 },
  completed: { label: '已完成', tone: 'done', step: 5 },
  cancelled: { label: '已取消', tone: 'dead', step: 0 }
};
const ACTIVE_STATUS = ['assigned', 'picked_up', 'delivered'];
// 订单等待超过这个分钟数算「超时未接单」
const STALE_MINUTES = 10;

function isStaff(role) { return Object.prototype.hasOwnProperty.call(ABILITIES, role); }
function can(role, ability) {
  const list = isStaff(role) ? ABILITIES[role] : null;
  if (!list) return false;
  if (list.includes('*')) return true;
  if (list.includes(ability)) return true;
  const [group] = ability.split('.');
  return list.includes(group + '.*');
}
function roleLabel(role) { return (ROLES[role] && ROLES[role].label) || '普通用户'; }

/** 默认配置。管理端修改后整体写入 settings/main。 */
function defaultSettings() {
  return {
    version: 3,
    school: {
      name: '示例校区',
      campuses: [
        {
          // 坐标供「按距离优先」派单使用，可在管理台修改
          id: 'demo-campus', name: '示例校区', latitude: null, longitude: null, radiusMeters: 6000,
          buildings: [],
          stations: [
            { id: 'demo-main', name: '示例校内驿站', openHours: '10:30–21:30', latitude: null, longitude: null },
            { id: 'demo-east', name: '示例东门驿站', openHours: '10:30–21:30', latitude: null, longitude: null },
            { id: 'demo-north', name: '示例北门驿站', openHours: '10:30–21:30', latitude: null, longitude: null }
          ]
        }
      ]
    },
    // 客服联系方式：管理台可改，首页和订单页展示
    contact: { wechatId: '', phone: '' },
    pricing: {
      currency: 'CNY',
      baseFee: 100,
      chargeMode: 'perParcel',
      sizes: [
        { id: 'small', label: '小件', hint: '文件、小盒、单件快递', cents: 300 },
        { id: 'medium', label: '中件', hint: '鞋盒、双肩包大小', cents: 500 },
        { id: 'large', label: '大件', hint: '行李箱、大纸箱', cents: 800 }
      ],
      distance: { enabled: false, freeMeters: 500, perKmCents: 100, maxCents: 1000 },
      campusAdjust: {},
      minTotal: 200,
      maxTotal: 3000,
      roundTo: 10,
      settleNote: '平台不代收费用，请与代取同学线下结算；本页价格仅作为结算参考。'
    },
    // 只有一个时段：不承诺送达时间
    slots: [
      { label: '自由接单', surcharge: 0 }
    ],
    rules: {
      // 平台取件时间：只有这段时间能去驿站拿件；下单不受限制
      serviceHours: { enabled: true, start: '10:30', end: '21:30' },
      staleMinutes: 10,
      maxActivePerRunner: 3,
      autoDispatch: true,
      requireRunnerOnline: true,
      preferNearby: false,
      runnerStudentNoPattern: '^[A-Za-z0-9-]{4,24}$',
      runnerInviteTtlHours: 24,
      requireRunnerIdPhoto: false,
      memberInviteTtlHours: 72
    },
    notices: [],
    updatedAt: Date.now(),
    updatedBy: 'system'
  };
}

function toMinutes(hhmm) {
  const parts = String(hhmm || '').split(':');
  return (Number(parts[0]) || 0) * 60 + (Number(parts[1]) || 0);
}

/** 当前是否在取件时间内。下单不拦，只用于提示代取同学。 */
function serviceHours(settings, at) {
  const hours = (settings && settings.rules && settings.rules.serviceHours) || {};
  const start = /^\d{2}:\d{2}$/.test(hours.start || '') ? hours.start : '00:00';
  const end = /^\d{2}:\d{2}$/.test(hours.end || '') ? hours.end : '23:59';
  const enabled = hours.enabled !== false;
  const date = at ? new Date(at) : new Date();
  const minutes = date.getHours() * 60 + date.getMinutes();
  const open = !enabled || (minutes >= toMinutes(start) && minutes < toMinutes(end));
  return { enabled, start, end, text: start + '–' + end, open };
}

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const roundTo = (cents, unit) => (unit > 0 ? Math.round(cents / unit) * unit : Math.round(cents));

function campusOf(settings, campusId) {
  return (settings.school.campuses || []).find(item => item.id === campusId) || null;
}
function stationOf(settings, campusId, stationId) {
  const campus = campusOf(settings, campusId);
  return campus ? (campus.stations || []).find(item => item.id === stationId) || null : null;
}
function sizeOf(settings, sizeId) {
  return (settings.pricing.sizes || []).find(item => item.id === sizeId) || null;
}
function slotOf(settings, label) {
  return (settings.slots || []).find(item => item.label === label) || null;
}
function distanceMeters(a, b) {
  if (!a || !b || ![a.latitude, a.longitude, b.latitude, b.longitude].every(Number.isFinite)) return null;
  const rad = n => n * Math.PI / 180;
  const x = Math.sin(rad(b.latitude - a.latitude) / 2) ** 2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(rad(b.longitude - a.longitude) / 2) ** 2;
  return Math.round(6371000 * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x)));
}

/**
 * 报价：所有金额由服务端计算，前端只展示。
 * 返回明细行，便于页面解释“为什么是这个价”。
 */
function quote(settings, input) {
  const campus = campusOf(settings, input.campusId);
  if (!campus) throw fail(400, '请选择有效校区');
  if (!stationOf(settings, input.campusId, input.stationId)) throw fail(400, '驿站不属于所选校区');
  const size = sizeOf(settings, input.size);
  if (!size) throw fail(400, '请选择包裹大小');
  const count = Number(input.parcelCount);
  if (!Number.isInteger(count) || count < 1 || count > 10) throw fail(400, '包裹件数应为 1–10');
  const slot = slotOf(settings, input.slot);
  if (!slot) throw fail(400, '配送时段无效');

  const pricing = settings.pricing;
  const lines = [];
  if (pricing.baseFee > 0) lines.push({ label: '起步价', cents: pricing.baseFee });
  const goods = pricing.chargeMode === 'perOrder' ? size.cents : size.cents * count;
  lines.push({ label: pricing.chargeMode === 'perOrder' ? size.label + '（按单）' : size.label + ' × ' + count + ' 件', cents: goods });
  if (slot.surcharge > 0) lines.push({ label: slot.label + ' 时段加价', cents: slot.surcharge });
  const adjust = Number((pricing.campusAdjust || {})[input.campusId] || 0);
  if (adjust) lines.push({ label: campus.name + ' 校区加价', cents: adjust });

  let total = lines.reduce((sum, item) => sum + item.cents, 0);
  if (pricing.distance && pricing.distance.enabled && Number.isFinite(input.distanceMeters)) {
    const extra = clamp(Math.ceil(Math.max(0, input.distanceMeters - pricing.distance.freeMeters) / 1000) * pricing.distance.perKmCents, 0, pricing.distance.maxCents);
    if (extra) lines.push({ label: '距离加价（' + Math.round(input.distanceMeters) + ' m）', cents: extra });
    total += extra;
  }
  total = clamp(roundTo(total, pricing.roundTo), pricing.minTotal, pricing.maxTotal);

  return {
    lines,
    totalCents: total,
    unitCents: size.cents,
    parcelCount: count,
    chargeMode: pricing.chargeMode,
    currency: pricing.currency,
    settleNote: pricing.settleNote
  };
}

function fail(status, message, code) {
  return Object.assign(new Error(message), { status, code: code || 'BAD_REQUEST' });
}

/** 取件码格式：2-1-4 位数字，短横线分隔。 */
const PICKUP_CODE = /^\d{2}-\d-\d{4}$/;
function pickupCodeOf(value) {
  const text = textField(value, '取件码', 1, 20);
  if (!PICKUP_CODE.test(text)) throw fail(400, '取件码格式应为 12-3-4567');
  return text;
}

function textField(value, label, min = 1, max = 100) {
  if (typeof value !== 'string') throw fail(400, label + '格式不正确');
  const text = value.trim();
  if (text.length < min || text.length > max) throw fail(400, label + '格式不正确');
  return text;
}

/** 校验下单入参并返回规范化字段（价格另算）。 */
function normalizeOrderInput(settings, body) {
  const campus = campusOf(settings, body.campusId);
  if (!campus) throw fail(400, '请选择有效校区');
  const station = stationOf(settings, body.campusId, body.stationId);
  if (!station) throw fail(400, '驿站不属于所选校区');
  const buildings = campus.buildings || [];
  if (buildings.length && !buildings.includes(body.building)) throw fail(400, '请选择该校区的配送楼栋');
  const slot = slotOf(settings, body.slot);
  if (!slot) throw fail(400, '配送时段无效');
  const phone = textField(body.phone, '手机号码', 11, 11);
  if (!/^1\d{10}$/.test(phone)) throw fail(400, '请输入 11 位手机号码');
  return {
    campusId: campus.id,
    campusName: campus.name,
    stationId: station.id,
    stationName: station.name,
    building: buildings.length ? body.building : '',
    room: textField(body.room, '送达位置', 1, 60),
    recipient: textField(body.recipient, '收件人', 1, 24),
    phone,
    pickupCode: pickupCodeOf(body.pickupCode),
    parcelCount: Number(body.parcelCount),
    size: body.size,
    slot: slot.label,
    note: body.note ? textField(body.note, '备注', 1, 200) : '',
    photoFileIds: Array.isArray(body.photoFileIds) ? body.photoFileIds.slice(0, 3).filter(item => typeof item === 'string') : []
  };
}

/** 代取候选：校区硬条件，距离/在手单量做排序。 */
function rankRunners({ runners, orders, order, rules }) {
  const activeLoad = runnerId => orders.filter(item => item.runnerId === runnerId && ACTIVE_STATUS.includes(item.status)).length;
  return runners
    .filter(user => user.runner && user.runner.status === 'approved')
    .map(user => {
      const distance = user.lastLocation && order.stationLatitude != null
        ? distanceMeters(user.lastLocation, { latitude: order.stationLatitude, longitude: order.stationLongitude })
        : null;
      const load = activeLoad(user._id);
      const reasons = [];
      if (user._id === order.ownerId) reasons.push('不能接自己的单');
      if (user.runner.campusId !== order.campusId) reasons.push('不在同一校区');
      if (rules.requireRunnerOnline !== false && !user.runner.online) reasons.push('已休息');
      if (load >= (rules.maxActivePerRunner || 3)) reasons.push('在手订单已达上限');
      return { openid: user._id, nickname: user.nickname, distanceMeters: distance, load, eligible: reasons.length === 0, reasons };
    })
    .filter(item => item.eligible)
    .sort((a, b) => (rules.preferNearby ? (a.distanceMeters ?? Infinity) - (b.distanceMeters ?? Infinity) : 0) || a.load - b.load || String(a.openid).localeCompare(String(b.openid)));
}

function pickRunner(args) {
  const ranked = rankRunners(args);
  return ranked[0] || null;
}

/** 订单对外视图：按角色裁剪字段。 */
function orderView(order, viewer, users) {
  if (!viewer || (viewer._id !== order.ownerId && viewer._id !== order.runnerId && !isStaff(viewer.role))) return shareView(order, order.ownerNickname);
  const meta = STATUS[order.status] || { label: order.status, tone: 'dead', step: 0 };
  const runner = order.runnerId && users ? users.find(item => item._id === order.runnerId) : null;
  const destination = destinationOf(order);
  const isOwner = viewer && viewer._id === order.ownerId;
  const isRunner = viewer && viewer._id === order.runnerId;
  const staff = viewer && isStaff(viewer.role);
  const view = {
    id: order._id,
    orderNo: order.orderNo || order._id,
    ownerId: order.ownerId,
    ownerNickname: order.ownerNickname,
    campusId: order.campusId,
    campusName: order.campusName,
    stationId: order.stationId,
    stationName: order.stationName,
    building: order.building,
    destination,
    parcelCount: order.parcelCount,
    size: order.size,
    sizeLabel: order.sizeLabel,
    slot: order.slot,
    totalCents: order.totalCents,
    priceLines: order.priceLines || [],
    status: order.status,
    statusLabel: meta.label,
    statusTone: meta.tone,
    runnerId: order.runnerId || null,
    runnerName: runner ? runner.nickname : (order.runnerName || null),
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    timeline: (order.timeline || []).map(item => ({ status: item.status, message: item.message, at: item.at }))
  };
  if (isOwner || isRunner || staff) {
    view.room = order.room;
    view.recipient = order.recipient;
    view.phone = order.phone;
    view.pickupCode = order.pickupCode;
    view.note = order.note;
    view.photoFileIds = order.photoFileIds || [];
    view.review = order.review || null;
  }
  if (isOwner) {
    view.deliveryCode = order.deliveryCode;
    view.shareToken = order.shareToken;
  }
  if (staff) view.staffNote = order.staffNote || '';
  return view;
}

/** 大厅视图：不含取件码、手机号、门牌。 */
function hallView(order) {
  const meta = STATUS[order.status] || { label: order.status, tone: 'dead', step: 0 };
  return {
    id: order._id,
    campusId: order.campusId,
    campusName: order.campusName,
    stationName: order.stationName,
    building: order.building,
    destination: order.building || '接单后可见',
    parcelCount: order.parcelCount,
    size: order.size,
    sizeLabel: order.sizeLabel,
    slot: order.slot,
    totalCents: order.totalCents,
    status: order.status,
    statusLabel: meta.label,
    statusTone: meta.tone,
    createdAt: order.createdAt,
    waitMinutes: Math.max(0, Math.round((Date.now() - order.createdAt) / 60000))
  };
}

/** 分享视图：连订单归属人都不给。 */
function shareView(order, ownerNickname) {
  const meta = STATUS[order.status] || { label: order.status, tone: 'dead', step: 0 };
  return {
    id: order._id,
    status: order.status,
    statusLabel: meta.label,
    statusTone: meta.tone,
    campusName: order.campusName,
    stationName: order.stationName,
    destination: '已隐藏',
    parcelCount: order.parcelCount,
    sizeLabel: order.sizeLabel,
    totalCents: order.totalCents,
    slot: order.slot,
    createdAt: order.createdAt,
    ownerNickname: maskName(ownerNickname),
    timeline: (order.timeline || []).map(item => ({ status: item.status, message: (STATUS[item.status] || {}).label || '进度更新', at: item.at }))
  };
}

/** 目的地文案：有楼栋拼楼栋，否则用送达地址。 */
function destinationOf(order) {
  if (!order) return '';
  if (order.building && order.room) return order.building + ' · ' + order.room;
  return order.building || order.room || '';
}

function maskName(name) {
  if (!name) return '';
  const chars = String(name).split('');
  if (chars.length <= 1) return name;
  return chars[0] + '*'.repeat(Math.max(1, chars.length - 1));
}

/** 订单导出 CSV（带 BOM，Excel 直接打开不乱码）。 */
function csvCell(value) {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^[\s\u0000-\u001f]*[=+@-]/.test(text) || /^[\t\r\n]/.test(text)) text = "'" + text;
  return /[",\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
}

function ordersCsv(rows) {
  const head = ['订单号', '创建时间', '状态', '驿站', '送达地址', '件数', '尺寸', '费用(元)', '下单人', '联系电话', '代取', '备注'];
  const lines = [head.join(',')];
  for (const order of rows) {
    lines.push([
      order.orderNo,
      new Date(order.createdAt).toLocaleString('zh-CN', { hour12: false }),
      (STATUS[order.status] || {}).label || order.status,
      order.stationName,
      destinationOf(order),
      order.parcelCount,
      order.sizeLabel,
      (order.totalCents / 100).toFixed(2),
      order.ownerNickname,
      order.phone || '',
      order.runnerName || '',
      order.note || ''
    ].map(csvCell).join(','));
  }
  return '\ufeff' + lines.join('\n');
}

function publicUser(user) {
  if (!user) return null;
  return {
    id: user._id,
    nickname: user.nickname,
    avatarUrl: user.avatarUrl || '',
    campusId: user.campusId || '',
    role: user.role || 'user',
    roleLabel: isStaff(user.role) ? roleLabel(user.role) : '',
    isStaff: isStaff(user.role),
    abilities: ABILITIES[user.role] || [],
    runner: user.runner || null,
    createdAt: user.createdAt
  };
}

function makeCode(length = 8) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < length; i += 1) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

function makeOrderNo() {
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  return 'SD' + String(now.getFullYear()).slice(2) + pad(now.getMonth() + 1) + pad(now.getDate()) + makeCode(6);
}

function activeNotices(settings, limit = 3) {
  return (settings.notices || [])
    .filter(item => item.active !== false)
    .sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || (b.publishedAt || 0) - (a.publishedAt || 0))
    .slice(0, limit)
    .map(({ id, title, content, level, pinned, active, publishedAt, updatedAt }) => ({ id, title, content, level, pinned, active, publishedAt, updatedAt }));
}

module.exports = {
  ROLES, ABILITIES, STATUS, ACTIVE_STATUS, STALE_MINUTES, ordersCsv,
  isStaff, can, roleLabel,
  defaultSettings,
  campusOf, stationOf, sizeOf, slotOf, distanceMeters, serviceHours,
  quote, normalizeOrderInput, fail, textField,
  rankRunners, pickRunner, orderView, hallView, shareView, publicUser, maskName, destinationOf,
  makeCode, makeOrderNo, activeNotices,
  clamp, roundTo
};
