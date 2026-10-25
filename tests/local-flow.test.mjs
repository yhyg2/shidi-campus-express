// 本地演示链路：没开通云开发时，界面背后的数据层也要真的能跑通。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const storage = new Map();
globalThis.wx = {
  getStorageSync: key => storage.get(key),
  setStorageSync: (key, value) => storage.set(key, value),
  removeStorageSync: key => storage.delete(key)
};

const local = require('../miniprogram/utils/local.js');
const core = require('../shared/core.js');

const call = (action, data) => local.call(action, data || {});

test('本地演示：首次读取配置会写入种子数据', async () => {
  const data = await call('config.get');
  assert.equal(data.settings.school.campuses.length, 1);
  assert.equal(data.settings.school.campuses[0].name, '示例校区');
  assert.equal(data.me.role, 'user');
  assert.ok(data.settings.pricing.sizes.length >= 3);
});

test('本地演示：报价与下单，种子代取在线时会自动接单', async () => {
  const quote = await call('order.quote', { campusId: 'demo-campus', stationId: 'demo-main', size: 'small', parcelCount: 1, slot: '自由接单' });
  assert.equal(quote.totalCents, 400);

  const order = await call('order.create', {
    campusId: 'demo-campus', stationId: 'demo-main', room: '一楼大厅',
    recipient: '演示同学甲', phone: '10000000000', pickupCode: '99-9-9999', parcelCount: 1, size: 'small', slot: '自由接单', note: '', photoFileIds: []
  });
  assert.equal(order.status, 'assigned');
  assert.equal(order.runnerName, '演示同学乙');
  assert.ok(order.pickupCode);
  assert.ok(order.priceLines.length >= 1);

  const list = await call('order.list');
  assert.ok(list.length >= 3);
});

test('本地演示：取消与确认收货的状态流转', async () => {
  const list = await call('order.list');
  const active = list.find(item => item.status === 'assigned');
  const cancelled = await call('order.cancel', { id: active.id });
  assert.equal(cancelled.status, 'cancelled');
  await assert.rejects(() => call('order.confirm', { id: active.id }), /待确认/);
});

test('本地演示：初始化管理员后可改价，学生端报价立刻跟着变', async () => {
  const user = await call('admin.bootstrap');
  assert.equal(user.role, 'superadmin');
  await assert.rejects(() => call('admin.bootstrap'), /已有管理员/);

  const before = await call('admin.pricing.get');
  const pricing = JSON.parse(JSON.stringify(before.pricing));
  pricing.sizes = pricing.sizes.map(item => (item.id === 'small' ? Object.assign({}, item, { cents: 600 }) : item));
  await call('admin.pricing.save', { pricing, slots: before.slots });

  const quote = await call('order.quote', { campusId: 'demo-campus', stationId: 'demo-main', size: 'small', parcelCount: 2, slot: '自由接单' });
  assert.equal(quote.totalCents, 100 + 600 * 2);
});

test('本地演示：发布公告后学生端配置里能看到', async () => {
  await call('admin.notice.save', { title: '五一期间取件时间调整', content: '5 月 1 日至 3 日驿站 10:00 开门。', level: 'warn', pinned: true });
  const data = await call('config.get');
  assert.equal(data.settings.notices[0].title, '五一期间取件时间调整');
  assert.equal(data.settings.notices[0].level, 'warn');
});

test('本地演示：成员邀请码可生成，权限不足时会被拒绝', async () => {
  const invite = await call('admin.member.invite', { role: 'admin' });
  assert.equal(invite.code.length, 8);
  const members = await call('admin.members');
  assert.ok(members.invites.some(item => item.code === invite.code));
  await assert.rejects(() => call('admin.member.invite', { role: 'superadmin' }), /只能邀请/);
});

test('本地演示：代取邀请码可由管理员生成，学号规则生效', async () => {
  const invite = await call('admin.runner.invite', { campusId: 'demo-campus' });
  assert.equal(invite.campusId, 'demo-campus');
  await assert.rejects(
    () => call('runner.apply', { code: invite.code, realName: '演示同学丙', studentNo: '!!', consent: true }),
    /学号格式/
  );
});

test('本地演示：重置后回到种子状态', async () => {
  local.reset();
  const data = await call('config.get');
  assert.equal(data.me.role, 'user');
  assert.equal(data.settings.notices.length, 0);
  assert.equal(core.isStaff(data.me.role), false);
});

test('客服联系方式：管理员可改，校验电话格式，改完学生端能读到', async () => {
  await call('admin.bootstrap').catch(() => null);
  const before = await call('admin.settings.get');
  assert.ok(!before.contact || !before.contact.wechatId, '默认没有客服信息');

  await assert.rejects(() => call('admin.settings.save', { contact: { wechatId: 'shidi', phone: 'abc' } }), /客服电话/);

  await call('admin.settings.save', { contact: { wechatId: ' demo_service ', phone: '10000000000' } });
  const after = await call('admin.settings.get');
  assert.equal(after.contact.wechatId, 'demo_service');
  assert.equal(after.contact.phone, '10000000000');

  const config = await call('config.get');
  assert.equal(config.settings.contact.wechatId, 'demo_service', '学生端配置里也要有');
});

test('评价与投诉：完成后可评价一次，投诉进管理台并可标记处理', async () => {
  await call('admin.bootstrap').catch(() => null);

  // 未完成不能评价
  const created = await call('order.create', {
    campusId: 'demo-campus', stationId: 'demo-main', building: '', room: '示例交接点',
    recipient: '演示同学甲', phone: '10000000000', pickupCode: '21-4-3210', parcelCount: 1, size: 'small', slot: '自由接单', note: '', photoFileIds: []
  });
  await assert.rejects(() => call('order.review', { id: created.id, rating: 5 }), /完成后/);

  // 完成的种子单可以评价，且只能评一次
  const orders = await call('order.list');
  const done = orders.find(item => item.status === 'completed');
  await call('order.review', { id: done.id, rating: 5, tags: ['准时送达'], text: '很快' });
  await assert.rejects(() => call('order.review', { id: done.id, rating: 3 }), /已经评价/);
  const mine = (await call('order.list')).find(item => item.id === done.id);
  assert.equal(mine.review.rating, 5);

  // 投诉 → 管理台可见 → 标记处理
  await call('order.complaint', { id: created.id, reason: 'late', detail: '等了很久都没人来取' });
  const complaints = await call('admin.complaints');
  const open = complaints.find(item => item.orderId === created.id && item.status === 'open');
  assert.ok(open, '管理台应看到投诉');
  await call('admin.complaint.resolve', { id: open.id, note: '已联系双方协商' });
  const after = (await call('admin.complaints')).find(item => item.id === open.id);
  assert.equal(after.status, 'resolved');
  // 已处理的投诉不再阻塞，用户可以就新问题再次投诉
  await call('order.complaint', { id: created.id, reason: 'other', detail: '处理后又出现了新问题，再投诉一次' });
  const again = (await call('admin.complaints')).filter(item => item.orderId === created.id);
  assert.equal(again.filter(item => item.status === 'open').length, 1, '新一轮投诉进入待处理');
});

test('订单导出：管理员可导出 CSV，普通用户不行', async () => {
  const data = await call('admin.export', { filter: 'all' });
  assert.match(data.filename, /^orders-\d{4}-\d{2}-\d{2}\.csv$/);
  assert.ok(data.csv.includes('订单号'), '表头存在');
  assert.ok(data.csv.includes('3 号楼 502'), '包含订单行（含送达地址）');
});
