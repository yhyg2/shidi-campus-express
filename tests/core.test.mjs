// 业务核心单测：定价、派单、视图裁剪、权限矩阵。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const core = require('../shared/core.js');

const settings = core.defaultSettings();

test('默认配置结构完整：校区、驿站、尺寸、时段、规则都在', () => {
  assert.equal(settings.school.campuses.length, 1, '只保留一个校区');
  assert.equal(settings.school.campuses[0].name, '示例校区');
  assert.equal(settings.school.campuses[0].buildings.length, 0, '不配楼栋');
  assert.equal(settings.school.campuses[0].stations.length, 3, '三个驿站');
  assert.ok(settings.school.campuses[0].stations.every(item => item.openHours === '10:30–21:30'), '三个驿站统一营业时间');
  assert.deepEqual(settings.rules.serviceHours, { enabled: true, start: '10:30', end: '21:30' });
  assert.ok(settings.pricing.sizes.length >= 3);
  assert.ok(settings.slots.length >= 1);
  assert.equal(settings.rules.maxActivePerRunner, 3);
});

test('按件计费：起步价 + 单价 × 件数 + 时段加价，并按取整单位取整', () => {
  const quote = core.quote(settings, { campusId: 'demo-campus', stationId: 'demo-main', size: 'small', parcelCount: 2, slot: '自由接单' });
  assert.equal(quote.totalCents, 100 + 300 * 2);
  assert.equal(quote.lines.length, 2);
  assert.equal(quote.lines[1].label, '小件 × 2 件');
});

test('按单计费：只算一次单价，不看件数', () => {
  const custom = JSON.parse(JSON.stringify(settings));
  custom.pricing.chargeMode = 'perOrder';
  const one = core.quote(custom, { campusId: 'demo-campus', stationId: 'demo-main', size: 'small', parcelCount: 1, slot: '自由接单' });
  const five = core.quote(custom, { campusId: 'demo-campus', stationId: 'demo-main', size: 'small', parcelCount: 5, slot: '自由接单' });
  assert.equal(one.totalCents, five.totalCents);
  assert.match(five.lines[1].label, /按单/);
});

test('时段加价与校区加价会体现在明细里', () => {
  const custom = JSON.parse(JSON.stringify(settings));
  custom.pricing.campusAdjust = { 'demo-campus': 200 };
  custom.slots = [{ label: '自由接单', surcharge: 0 }, { label: '17:00–19:00', surcharge: 100 }];
  const quote = core.quote(custom, { campusId: 'demo-campus', stationId: 'demo-main', size: 'medium', parcelCount: 1, slot: '17:00–19:00' });
  assert.ok(quote.lines.some(item => item.label.includes('时段加价')));
  assert.ok(quote.lines.some(item => item.label.includes('校区加价')));
  assert.equal(quote.totalCents, 100 + 500 + 100 + 200);
});

test('总价受最低价与最高价约束', () => {
  const cheap = JSON.parse(JSON.stringify(settings));
  cheap.pricing.baseFee = 0;
  cheap.pricing.minTotal = 500;
  assert.equal(core.quote(cheap, { campusId: 'demo-campus', stationId: 'demo-main', size: 'small', parcelCount: 1, slot: '自由接单' }).totalCents, 500);

  const expensive = JSON.parse(JSON.stringify(settings));
  expensive.pricing.maxTotal = 800;
  assert.equal(core.quote(expensive, { campusId: 'demo-campus', stationId: 'demo-main', size: 'large', parcelCount: 10, slot: '自由接单' }).totalCents, 800);
});

test('报价会拒绝跨校区驿站、非法尺寸与件数', () => {
  assert.throws(() => core.quote(settings, { campusId: 'demo-campus', stationId: 'not-exist', size: 'small', parcelCount: 1, slot: '自由接单' }), /驿站不属于/);
  assert.throws(() => core.quote(settings, { campusId: 'demo-campus', stationId: 'demo-main', size: 'huge', parcelCount: 1, slot: '自由接单' }), /包裹大小/);
  assert.throws(() => core.quote(settings, { campusId: 'demo-campus', stationId: 'demo-main', size: 'small', parcelCount: 0, slot: '自由接单' }), /1–10/);
});

test('下单入参会做规范化与校验（手机号、送达地址、取件码）', () => {
  const input = core.normalizeOrderInput(settings, {
    campusId: 'demo-campus', stationId: 'demo-main', room: ' 3 号楼 502 ',
    recipient: '演示同学甲', phone: '10000000000', pickupCode: ' 12-3-4568 ', parcelCount: 2, size: 'small', slot: '自由接单', note: '', photoFileIds: ['x', 'y', 'z', 'w']
  });
  assert.equal(input.room, '3 号楼 502');
  assert.equal(input.building, '', '没配楼栋时楼栋留空');
  assert.equal(input.pickupCode, '12-3-4568');
  assert.equal(input.photoFileIds.length, 3, '截图最多保留 3 张');
  assert.throws(() => core.normalizeOrderInput(settings, { campusId: 'demo-campus', stationId: 'demo-main', room: 'a', recipient: 'b', phone: '123', pickupCode: '12-3-4568', parcelCount: 1, size: 'small', slot: '自由接单' }), /手机号/);
});

test('配了楼栋的校区仍然要求楼栋合法', () => {
  const custom = JSON.parse(JSON.stringify(settings));
  custom.school.campuses[0].buildings = ['1 号楼', '2 号楼'];
  const ok = core.normalizeOrderInput(custom, { campusId: 'demo-campus', stationId: 'demo-main', building: '2 号楼', room: '502', recipient: 'b', phone: '10000000000', pickupCode: '12-3-4568', parcelCount: 1, size: 'small', slot: '自由接单' });
  assert.equal(ok.building, '2 号楼');
  assert.equal(core.destinationOf(ok), '2 号楼 · 502');
  assert.throws(() => core.normalizeOrderInput(custom, { campusId: 'demo-campus', stationId: 'demo-main', building: '9 号楼', room: '502', recipient: 'b', phone: '10000000000', pickupCode: '12-3-4568', parcelCount: 1, size: 'small', slot: '自由接单' }), /楼栋/);
  assert.equal(core.destinationOf({ room: '3 号楼 502' }), '3 号楼 502');
});

const runner = (id, options = {}) => ({
  _id: id,
  nickname: id,
  runner: { status: options.status || 'approved', campusId: options.campusId || 'demo-campus', online: options.online !== false },
  lastLocation: options.location || null
});
const order = { _id: 'o1', ownerId: 'owner', campusId: 'demo-campus', stationId: 'demo-main', status: 'waiting_assignment', stationLatitude: 30.5422, stationLongitude: 114.3655 };

test('派单候选：排除跨校区、本人、离线、满单', () => {
  const candidates = core.rankRunners({
    runners: [runner('ok'), runner('other', { campusId: 'other-campus' }), runner('owner'), runner('off', { online: false }), runner('pending', { status: 'pending' })],
    orders: [],
    order,
    rules: settings.rules
  });
  assert.deepEqual(candidates.map(item => item.openid), ['ok']);
});

test('派单候选：开启按距离优先时，近的排前面', () => {
  const rules = Object.assign({}, settings.rules, { preferNearby: true });
  const near = runner('near', { location: { latitude: 30.5423, longitude: 114.3656 } });
  const far = runner('far', { location: { latitude: 30.5480, longitude: 114.3720 } });
  const noLocation = runner('blind');
  const candidates = core.rankRunners({ runners: [far, noLocation, near], orders: [], order, rules });
  assert.equal(candidates[0].openid, 'near');
  assert.ok(candidates[0].distanceMeters < 100);
  assert.equal(candidates[2].openid, 'blind');
});

test('派单候选：相同距离时按在手单量轮转', () => {
  const rules = Object.assign({}, settings.rules, { preferNearby: true });
  const busyOrder = { _id: 'o2', ownerId: 'x', campusId: 'demo-campus', status: 'assigned', runnerId: 'a' };
  const candidates = core.rankRunners({
    runners: [runner('a', { location: { latitude: 30.5423, longitude: 114.3656 } }), runner('b', { location: { latitude: 30.5423, longitude: 114.3656 } })],
    orders: [busyOrder],
    order,
    rules
  });
  assert.equal(candidates[0].openid, 'b');
});

test('订单视图：取件码只给本人/接单代取/管理成员，分享视图完全脱敏', () => {
  const full = {
    _id: 'o1', orderNo: 'SD1', ownerId: 'student', ownerNickname: '演示同学甲', campusId: 'demo-campus', campusName: '示例校区',
    stationName: '示例校内驿站', building: '', room: '一楼大厅', recipient: '演示同学甲', phone: '10000000000',
    pickupCode: '12-3-4568', parcelCount: 1, size: 'small', sizeLabel: '小件', slot: '自由接单', totalCents: 400,
    priceLines: [{ label: '小件 × 1 件', cents: 300 }], status: 'assigned', runnerId: 'runner', deliveryCode: '1234',
    shareToken: 'tok123', timeline: [{ status: 'assigned', message: '已接单', at: 1 }], createdAt: 1, updatedAt: 1
  };
  const student = { _id: 'student', role: 'user' };
  const view = core.orderView(full, student, []);
  assert.equal(view.pickupCode, '12-3-4568');
  assert.equal(view.shareToken, 'tok123');
  assert.equal(view.deliveryCode, '1234');
  assert.equal(view.statusLabel, '待取件');

  const stranger = core.orderView(full, { _id: 'other', role: 'user' }, []);
  assert.equal(stranger.pickupCode, undefined);
  assert.equal(stranger.phone, undefined);
  assert.equal(stranger.deliveryCode, undefined);

  const shared = core.shareView(full, '演示同学甲');
  const text = JSON.stringify(shared);
  assert.ok(!text.includes('10000000000'));
  assert.ok(!text.includes('12-3-4568'));
  assert.ok(!text.includes('一楼大厅'));
  assert.ok(!text.includes('1234'));
  assert.equal(shared.ownerNickname, '演****');

  const hall = core.hallView(full);
  assert.equal(hall.pickupCode, undefined);
  assert.equal(hall.ownerId, undefined);
});

test('身份只有三种：普通用户、管理员、超级管理员', () => {
  assert.deepEqual(Object.keys(core.ABILITIES).sort(), ['admin', 'superadmin']);
  assert.equal(core.can('user', 'overview.read'), false);
  assert.equal(core.can('operator', 'overview.read'), false, '旧角色已删除');
  assert.equal(core.can('developer', 'settings.write'), false, '旧角色已删除');
  assert.equal(core.can('analyst', 'overview.read'), false, '旧角色已删除');
  assert.equal(core.can('superadmin', 'anything.at.all'), true);
  assert.equal(core.can('admin', 'member.write'), true);
  assert.equal(core.can('admin', 'settings.write'), true);
  assert.equal(core.can('admin', 'pricing.write'), true);
  assert.equal(core.roleLabel('user'), '普通用户');
  assert.equal(core.isStaff('operator'), false);
});

test('公告：置顶优先、按发布时间倒序、最多 20 条', () => {
  const custom = JSON.parse(JSON.stringify(settings));
  custom.notices = [
    { id: 'a', title: 'A', active: true, publishedAt: 100 },
    { id: 'b', title: 'B', active: true, publishedAt: 200, pinned: true },
    { id: 'c', title: 'C', active: false, publishedAt: 300 },
    { id: 'd', title: 'D', active: true, publishedAt: 150 }
  ];
  const list = core.activeNotices(custom);
  assert.deepEqual(list.map(item => item.id), ['b', 'd', 'a']);
});

test('订单号与邀请码格式稳定，便于人工核对', () => {
  assert.match(core.makeOrderNo(), /^SD\d{6}[A-Z2-9]{6}$/);
  const code = core.makeCode(8);
  assert.equal(code.length, 8);
  assert.match(code, /^[A-Z2-9]{8}$/);
  assert.equal(new Set(Array.from({ length: 50 }, () => core.makeCode(8))).size > 40, true);
});

test('取件时间：10:30–21:30 内可上门，之外只提示不拦下单', () => {
  const inside = core.serviceHours(settings, new Date('2026-10-24T12:00:00'));
  assert.equal(inside.open, true);
  assert.equal(inside.text, '10:30–21:30');
  const before = core.serviceHours(settings, new Date('2026-10-24T09:10:00'));
  assert.equal(before.open, false);
  const after = core.serviceHours(settings, new Date('2026-10-24T22:00:00'));
  assert.equal(after.open, false);
  const boundary = core.serviceHours(settings, new Date('2026-10-24T21:30:00'));
  assert.equal(boundary.open, false, '21:30 整点已经关门');

  const off = JSON.parse(JSON.stringify(settings));
  off.rules.serviceHours.enabled = false;
  assert.equal(core.serviceHours(off).open, true, '关掉限制就随时可去');

  off.rules.serviceHours = { enabled: true, start: 'bad', end: '21:30' };
  assert.equal(core.serviceHours(off).start, '00:00', '格式不对时退回默认值');
});

test('取件码只接受 2-1-4 位数字，且前后空格会被清掉', () => {
  const base = { campusId: 'demo-campus', stationId: 'demo-main', room: '示例交接点', recipient: '演示同学甲', phone: '10000000000', parcelCount: 1, size: 'small', slot: '自由接单' };
  assert.equal(core.normalizeOrderInput(settings, Object.assign({}, base, { pickupCode: ' 12-3-4568 ' })).pickupCode, '12-3-4568');
  for (const bad of ['6-1-2368', '1234567', '12-3-456', '12-3-45678', '12a3b4567', '1-2-3456']) {
    assert.throws(() => core.normalizeOrderInput(settings, Object.assign({}, base, { pickupCode: bad })), /取件码格式/, bad + ' 应该被拒绝');
  }
});

test('大厅隐藏完整送达位置以及取件码/联系人/电话/备注/截图', () => {
  const order = {
    _id: 'o9', ownerId: 'student', ownerNickname: '演示同学甲', campusId: 'demo-campus', campusName: '示例校区',
    stationName: '示例校内驿站', building: '', room: '示例交接点',
    recipient: '演示同学甲', phone: '10000000000', pickupCode: '12-3-4568', note: '易碎',
    photoFileIds: ['cloud://a.png'], parcelCount: 1, sizeLabel: '小件', slot: '自由接单',
    totalCents: 400, status: 'waiting_assignment', timeline: [], createdAt: 1
  };
  const hall = core.hallView(order);
  assert.equal(hall.destination, '接单后可见', '未接单时不应泄露完整送达地址');
  for (const key of ['pickupCode', 'phone', 'recipient', 'note', 'photoFileIds', 'ownerId', 'shareToken', 'deliveryCode']) {
    assert.equal(key in hall, false, '大厅不应返回 ' + key);
  }
  assert.equal(core.orderView(order, { _id: 'student', role: 'user' }, []).destination, '示例交接点');
  assert.equal(core.shareView(order, '演示同学甲').destination, '已隐藏');
  assert.ok(!('review' in core.hallView(order)), '大厅不应带评价');
  assert.ok(hall.waitMinutes >= 0, '大厅要带等待分钟数');
  const stale = core.hallView(Object.assign({}, order, { createdAt: Date.now() - 11 * 60000 }));
  assert.ok(stale.waitMinutes >= 10, '超时阈值 staleMinutes=10 应该生效');

  const withReview = Object.assign({}, order, {
    status: 'completed', runnerId: 'r1',
    review: { rating: 5, tags: ['准时送达'], text: '很快', createdAt: 2 }
  });
  const ownerView = core.orderView(withReview, { _id: 'student', role: 'user' }, []);
  assert.equal(ownerView.review.rating, 5, '本人能看到自己的评价');
  const runnerView = core.orderView(withReview, { _id: 'r1', role: 'user' }, []);
  assert.equal(runnerView.review.rating, 5, '被评价的代取也能看到');
  assert.ok(!('review' in core.orderView(withReview, { _id: 'other', role: 'user' }, [])), '无关用户不带评价');
  assert.ok(!('review' in core.shareView(withReview, '演示同学甲')), '分享页不带评价');
});
