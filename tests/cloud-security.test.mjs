import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { harness } from './helpers/cloud-harness.mjs';
const require = createRequire(import.meta.url);
const core = require('../shared/core.js');
const security = require('../cloudfunctions/api/lib/security.js');
const input = () => ({ campusId: 'demo-campus', stationId: 'demo-main', room: '示例交接点', recipient: '演示用户', phone: '10000000000', pickupCode: '12-3-4567', parcelCount: 1, size: 'small', slot: '自由接单', photoFileIds: [] });
const success = result => { assert.equal(result.ok, true, JSON.stringify(result.error)); return result.data; };
const denied = (result, match) => { assert.equal(result.ok, false); if (match) assert.match(result.error.message, match); };

test('云函数拒绝无微信身份、非对象参数、查询对象注入和继承属性 action', async () => {
  const h = harness();
  denied(await h.call('', 'config.get'), /登录/);
  denied(await h.raw('user', { action: 'config.get', data: [] }), /格式/);
  denied(await h.call('user', 'order.get', { id: { $ne: null } }), /标识/);
  denied(await h.call('user', 'constructor'), /未知/);
  denied(await h.call('user', 'admin.orders', { filter: { $ne: null } }), /筛选/);
});

test('云端初始化默认关闭，仅指定账号能初始化且并发只能成功一次', async () => {
  const unconfigured = harness();
  denied(await unconfigured.call('visitor', 'admin.bootstrap'), /环境变量/);
  const h = harness({ bootstrap: 'maintainer' });
  denied(await h.call('visitor', 'admin.bootstrap'), /不能初始化/);
  const results = await Promise.all([h.call('maintainer', 'admin.bootstrap'), h.call('maintainer', 'admin.bootstrap')]);
  assert.equal(results.filter(result => result.ok).length, 1);
  assert.equal(h.state.users.maintainer.role, 'superadmin');
  denied(await h.call('maintainer', 'admin.bootstrap'), /已有管理员/);
});

test('订单私有数据只给授权用户，分享进度不会带出管理员备注', async () => {
  const h = harness();
  h.order('o1', { status: 'cancelled', timeline: [{ status: 'cancelled', message: '联系电话10000000000，保密地址', at: 1 }] });
  denied(await h.call('stranger', 'order.get', { id: 'o1' }), /无权/);
  const owner = success(await h.call('owner', 'order.get', { id: 'o1' }));
  assert.equal(owner.phone, '10000000000');
  const shared = success(await h.call('stranger', 'order.share', { token: 'a'.repeat(24) }));
  assert.ok(!JSON.stringify(shared).includes('10000000000'));
  assert.ok(!JSON.stringify(shared).includes('保密地址'));
  assert.equal(shared.destination, '已隐藏');
});

test('接单大厅不返回完整地址、身份、取件码和图片', async () => {
  const h = harness(); h.user('runner', true); h.order('o1');
  const rows = success(await h.call('runner', 'runner.hall'));
  assert.equal(rows[0].destination, '接单后可见');
  for (const key of ['room', 'phone', 'pickupCode', 'ownerId', 'photoFileIds']) assert.ok(!(key in rows[0]));
});

test('手动接单和管理员指派均拒绝自己、跨校区和不合格的代取', async () => {
  const h = harness(); h.user('owner', true); h.user('other', true, 'other-campus'); h.user('admin', false, 'demo-campus', 'admin'); h.order('o1');
  denied(await h.call('owner', 'runner.claim', { id: 'o1' }), /同校区/);
  denied(await h.call('other', 'runner.claim', { id: 'o1' }), /同校区/);
  denied(await h.call('admin', 'admin.order.assign', { id: 'o1', runnerId: 'other' }), /同校区/);
  h.user('pending', true).runner.status = 'pending';
  denied(await h.call('pending', 'runner.claim', { id: 'o1' }), /认证/);
  assert.equal(h.state.orders.o1.status, 'waiting_assignment');
});

test('同一代取并发接两单不会超过容量，完成后可释放容量', async () => {
  const h = harness(); h.user('runner', true); h.order('o1'); h.order('o2');
  h.state.settings.main.rules.maxActivePerRunner = 1;
  const results = await Promise.all([h.call('runner', 'runner.claim', { id: 'o1' }), h.call('runner', 'runner.claim', { id: 'o2' })]);
  assert.equal(results.filter(result => result.ok).length, 1);
  const assigned = Object.values(h.state.orders).find(order => order.status === 'assigned');
  assigned.status = 'delivered';
  success(await h.call('owner', 'order.confirm', { id: assigned._id }));
  const waiting = Object.values(h.state.orders).find(order => order.status === 'waiting_assignment');
  success(await h.call('runner', 'runner.claim', { id: waiting._id }));
});

test('两名代取并发抢同一单只能一人成功', async () => {
  const h = harness(); h.user('a', true); h.user('b', true); h.order('o1');
  const results = await Promise.all(['a', 'b'].map(id => h.call(id, 'runner.claim', { id: 'o1' })));
  assert.equal(results.filter(result => result.ok).length, 1);
  assert.ok(['a', 'b'].includes(h.state.orders.o1.runnerId));
});

test('暂停代取与分配订单并发时不会留下已暂停账号的新订单', async () => {
  const h = harness(); h.user('runner', true); h.user('admin', false, 'demo-campus', 'admin'); h.order('o1');
  const results = await Promise.all([
    h.call('admin', 'admin.runner.review', { id: 'runner', decision: 'suspended', reason: '演示暂停原因' }),
    h.call('admin', 'admin.order.assign', { id: 'o1', runnerId: 'runner' })
  ]);
  assert.equal(results.filter(result => result.ok).length, 1);
  if (h.state.users.runner.runner.status === 'suspended') assert.equal(h.state.orders.o1.status, 'waiting_assignment');
  else assert.equal(h.state.orders.o1.status, 'assigned');
});

test('接单状态切换不能恢复已经被暂停的代取资格', async () => {
  const h = harness(); h.user('runner', true).runner.status = 'suspended';
  denied(await h.call('runner', 'runner.availability', { online: true }), /认证/);
  assert.equal(h.state.users.runner.runner.status, 'suspended');
});

test('进度接口拒绝未知操作及非接单人操作', async () => {
  const h = harness(); h.user('runner', true); h.order('o1', { status: 'assigned', runnerId: 'runner' });
  denied(await h.call('runner', 'runner.progress', { id: 'o1', action: 'anything' }), /无效/);
  denied(await h.call('stranger', 'runner.progress', { id: 'o1', action: 'pickup' }));
  success(await h.call('runner', 'runner.progress', { id: 'o1', action: 'pickup' }));
  success(await h.call('runner', 'runner.progress', { id: 'o1', action: 'deliver' }));
});

test('邀请码与成员加入在同一事务消费，不能被两人重复使用', async () => {
  const h = harness();
  h.state.invites.inv1 = { _id: 'inv1', code: 'DEMO1234', type: 'member', role: 'admin', usedBy: null, expiresAt: Date.now() + 60000 };
  const results = await Promise.all(['a', 'b'].map(id => h.call(id, 'member.join', { code: 'DEMO1234' })));
  assert.equal(results.filter(result => result.ok).length, 1);
  assert.equal(Object.values(h.state.users).filter(user => user.role === 'admin').length, 1);
});

test('超级管理员不能因接受普通管理员邀请而丢失唯一超管身份', async () => {
  const h = harness(); h.user('super', false, 'demo-campus', 'superadmin');
  h.state.invites.inv1 = { _id: 'inv1', code: 'DEMO1234', type: 'member', role: 'admin', usedBy: null, expiresAt: Date.now() + 60000 };
  denied(await h.call('super', 'member.join', { code: 'DEMO1234' }), /超级管理员/);
  assert.equal(h.state.users.super.role, 'superadmin');
  assert.equal(h.state.invites.inv1.usedBy, null);
});

test('同一订单并发评价只写入一次', async () => {
  const h = harness(); h.order('o1', { status: 'completed' });
  const results = await Promise.all([5, 1].map(rating => h.call('owner', 'order.review', { id: 'o1', rating, text: '演示评价' })));
  assert.equal(results.filter(result => result.ok).length, 1);
});

test('同一订单并发投诉只创建一条，处理完成后可以再次投诉', async () => {
  const h = harness(); h.user('admin', false, 'demo-campus', 'admin'); h.order('o1');
  const data = { id: 'o1', reason: 'late', detail: '演示投诉内容' };
  const results = await Promise.all([h.call('owner', 'order.complaint', data), h.call('owner', 'order.complaint', data)]);
  assert.equal(results.filter(result => result.ok).length, 1);
  const complaint = Object.values(h.state.complaints)[0];
  success(await h.call('admin', 'admin.complaint.resolve', { id: complaint._id, note: '演示处理说明' }));
  success(await h.call('owner', 'order.complaint', data));
  assert.equal(Object.values(h.state.complaints).filter(item => item.status === 'open').length, 1);
});

test('图片临时链接必须关联已授权订单，不能提交任意文件请求签名', async () => {
  const h = harness();
  const file = 'cloud://demo.bucket/orders/owner/demo.png';
  h.order('o1', { photoFileIds: [file] });
  denied(await h.call('stranger', 'image.urls', { orderId: 'o1', fileIds: [file] }), /无权/);
  denied(await h.call('owner', 'image.urls', { orderId: 'o1', fileIds: ['cloud://demo.bucket/orders/other/demo.png'] }), /无权/);
  assert.equal(success(await h.call('owner', 'image.urls', { orderId: 'o1', fileIds: [file] })).length, 1);
  assert.throws(() => security.ownedPhotos(['cloud://demo.bucket/orders/other/demo.png'], 'owner'), /自己/);
  assert.throws(() => security.ownedPhotos([], 'owner', true), /认证/);
});

test('内容检查判违规或故障时均拒绝写入订单', async () => {
  for (const options of [{ blockContent: true }, { secFailure: true }]) {
    const h = harness(options);
    denied(await h.call('owner', 'order.create', input()));
    assert.equal(Object.keys(h.state.orders).length, 0);
  }
});

test('一分钟下单限额跨请求共享，不接受客户端报价或提交的距离', async () => {
  const h = harness();
  for (let i = 0; i < 6; i++) {
    const order = success(await h.call('owner', 'order.create', { ...input(), totalCents: 1, distanceMeters: -99999 }));
    assert.equal(order.totalCents, 400);
    assert.match(order.shareToken, /^[a-z2-9]{24}$/);
  }
  denied(await h.call('owner', 'order.create', input()), /频繁/);
  assert.equal(Object.keys(h.state.orders).length, 6);
});

test('云端 CSV 导出正常运行，拒绝普通用户，防止表格公式注入', async () => {
  const h = harness(); h.user('admin', false, 'demo-campus', 'admin'); h.order('o1', { note: '=1+1', ownerNickname: '+DEMO', room: '\t=HYPERLINK("example.invalid")' });
  denied(await h.call('owner', 'admin.export'), /权限/);
  const data = success(await h.call('admin', 'admin.export'));
  assert.ok(data.csv.includes("'=1+1"));
  assert.ok(data.csv.includes("'+DEMO"));
  assert.ok(data.csv.includes("'\t=HYPERLINK"));
});

test('定价配置将数字字符串规范为整数，拒绝负数、异常金额及距离计费', () => {
  const defaults = core.defaultSettings();
  const pricing = security.pricingOf(defaults.pricing, { baseFee: '100' });
  assert.equal(pricing.baseFee, 100);
  assert.throws(() => security.pricingOf(defaults.pricing, { baseFee: -1 }));
  assert.throws(() => security.pricingOf(defaults.pricing, { maxTotal: Infinity }));
  assert.throws(() => security.pricingOf(defaults.pricing, { distance: { enabled: true } }));
  assert.throws(() => security.rulesOf(defaults.rules, { serviceHours: { start: '25:00', end: '29:00' } }));
  assert.throws(() => security.rulesOf(defaults.rules, { runnerStudentNoPattern: '^(a+)+$' }));
  assert.equal(security.rulesOf(defaults.rules, { runnerStudentNoPattern: '^[0-9]{10}$' }).runnerStudentNoPattern, '^[0-9]{10}$');
});

test('公开公告不会返回发布者身份，未知角色没有权限', () => {
  const settings = core.defaultSettings(); settings.notices = [{ id: 'n', title: '示例公告', publishedBy: 'private-openid', active: true }];
  assert.equal(core.activeNotices(settings)[0].publishedBy, undefined);
  assert.equal(core.can('constructor', 'settings.write'), false);
});
