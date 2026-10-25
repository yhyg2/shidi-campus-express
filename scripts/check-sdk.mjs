// 验证安装后的真实 SDK 适配层，不访问微信或云数据库。
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../cloudfunctions/api/package.json', import.meta.url));
const cloud = require('wx-server-sdk');
cloud.init({ env: 'demo' });
const db = cloud.database();
assert.equal(typeof db.runTransaction, 'function');
assert.equal(typeof cloud.getTempFileURL, 'function');
assert.equal(typeof cloud.getWXContext, 'function');

const writes = [];
const fakeCollection = {
  doc(id) {
    return {
      async get() { return { data: id === 'missing' ? [] : { _id: id, count: 1 } }; },
      async set(data) { writes.push(data); return { updated: 1 }; },
      async update(data) { writes.push(data); return { updated: 1 }; }
    };
  }
};
// 只替换 SDK 下方的传输层，保留真实的微信 SDK 参数和结果适配。
db._db.collection = () => fakeCollection;
db._db.runTransaction = async callback => ({ result: await callback({ collection: () => fakeCollection }) });
const result = await db.runTransaction(async tx => {
  const row = await tx.collection('demo').doc('entry').get();
  assert.equal(row.data.count, 1);
  await tx.collection('demo').doc('entry').update({ data: { count: 2 } });
  return 'ok';
});
assert.equal(result.result, 'ok');
assert.deepEqual(writes, [{ count: 2 }]);
await assert.rejects(db.collection('demo').doc('missing').get(), error => /document.*not exist/i.test(error.message || error.errMsg || ''));
console.log('SDK loaded and document/transaction adapters verified. No live cloud calls were made.');
