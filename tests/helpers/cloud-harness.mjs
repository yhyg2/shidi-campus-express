// SDK 与数据库的最小替身，用于运行实际云函数入口；不代表真实云环境验证。
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { AsyncLocalStorage } from 'node:async_hooks';
import vm from 'node:vm';
const require = createRequire(import.meta.url);
const core = require('../../shared/core.js');
const security = require('../../cloudfunctions/api/lib/security.js');
const clone = value => structuredClone(value);
const missing = () => Object.assign(new Error('document not found'), { status: 404 });

export function harness(options = {}) {
  const context = new AsyncLocalStorage();
  let revision = 0;
  let serial = 0;
  const state = { users: {}, orders: {}, settings: { main: core.defaultSettings() }, invites: {}, logs: {}, complaints: {}, rate_limits: {} };
  state.settings.main.rules.autoDispatch = false;
  const command = Object.fromEntries(['in', 'nin', 'gte', 'neq', 'push'].map(op => [op, value => ({ op, value })]));
  const at = (row, key) => key.split('.').reduce((value, part) => value && value[part], row);
  function matches(row, where) {
    return Object.entries(where).every(([key, expected]) => {
      const value = at(row, key);
      if (!expected || typeof expected !== 'object') return value === expected;
      if (expected.op === 'in') return expected.value.includes(value);
      if (expected.op === 'nin') return !expected.value.includes(value);
      if (expected.op === 'gte') return value >= expected.value;
      if (expected.op === 'neq') return value !== expected.value;
      return JSON.stringify(value) === JSON.stringify(expected);
    });
  }
  function patch(row, data) {
    for (const [key, value] of Object.entries(data)) {
      const parts = key.split('.');
      let target = row;
      for (const part of parts.slice(0, -1)) target = target[part] ||= {};
      const last = parts.at(-1);
      target[last] = value && value.op === 'push' ? (target[last] || []).concat(clone(value.value)) : clone(value);
    }
  }
  function collection(name, snapshot = state, transaction = false) {
    snapshot[name] ||= {};
    const changed = () => { if (!transaction) revision++; };
    return {
      doc(id) {
        if (typeof id !== 'string' || !id) throw new Error('invalid document id');
        return {
          async get() { if (!snapshot[name][id]) throw missing(); return { data: clone(snapshot[name][id]) }; },
          async set({ data }) { snapshot[name][id] = Object.assign(clone(data), { _id: id }); changed(); return {}; },
          async update({ data }) { if (!snapshot[name][id]) throw missing(); patch(snapshot[name][id], data); changed(); return { stats: { updated: 1 } }; }
        };
      },
      async add({ data }) {
        const id = data._id || 'doc_' + (++serial);
        if (snapshot[name][id]) throw new Error('duplicate document');
        snapshot[name][id] = Object.assign(clone(data), { _id: id }); changed(); return { _id: id };
      },
      where(where) {
        if (transaction) throw new Error('Transactions only support document operations');
        return query(where);
      },
      orderBy(key, direction) { return query({}).orderBy(key, direction); },
      limit(size) { return query({}).limit(size); },
      async count() { return query({}).count(); }
    };
    function query(where) {
      let limit = Infinity;
      let sort;
      const rows = () => {
        let values = Object.values(snapshot[name]).filter(row => matches(row, where));
        if (sort) values.sort((a, b) => (at(a, sort[0]) > at(b, sort[0]) ? 1 : at(a, sort[0]) < at(b, sort[0]) ? -1 : 0) * (sort[1] === 'desc' ? -1 : 1));
        return values.slice(0, limit);
      };
      return {
        orderBy(key, direction) { sort = [key, direction]; return this; },
        limit(size) { limit = size; return this; },
        async get() { return { data: clone(rows()) }; },
        async count() { return { total: rows().length }; },
        async update({ data }) { const values = rows(); values.forEach(row => patch(row, data)); if (values.length) changed(); return { stats: { updated: values.length } }; }
      };
    }
  }
  const database = {
    command,
    collection,
    async createCollection(name) { state[name] ||= {}; },
    async runTransaction(callback) {
      for (let retry = 0; retry < 30; retry++) {
        const version = revision;
        const snapshot = clone(state);
        const result = await callback({ collection: name => collection(name, snapshot, true) });
        if (version !== revision) continue;
        for (const key of Object.keys(state)) state[key] = snapshot[key];
        revision++;
        return { result, errMsg: 'runTransaction:ok' };
      }
      throw new Error('transaction conflict');
    }
  };
  const cloud = {
    init() {},
    DYNAMIC_CURRENT_ENV: 'demo',
    database: () => database,
    getWXContext: () => ({ OPENID: context.getStore() }),
    async getTempFileURL({ fileList }) { return { fileList: fileList.map(({ fileID }) => ({ fileID, tempFileURL: 'https://example.invalid/' + encodeURIComponent(fileID) })) }; },
    openapi: { security: { async msgSecCheck() {
      if (options.secFailure) throw new Error('service unavailable');
      return { errCode: 0, result: { suggest: options.blockContent ? 'risky' : 'pass' } };
    } }, subscribeMessage: { async send() {} } }
  };
  const exported = {};
  vm.runInNewContext(readFileSync(new URL('../../cloudfunctions/api/index.js', import.meta.url), 'utf8'), {
    require: id => id === 'wx-server-sdk' ? cloud : id === './lib/core' ? core : id === './lib/security' ? security : require(id),
    exports: exported,
    process: { env: { BOOTSTRAP_ADMIN_OPENID: options.bootstrap || '' } },
    console: { error() {} }, Buffer
  }, { filename: 'cloudfunctions/api/index.js' });
  return {
    state,
    call: (openid, action, data = {}) => context.run(openid, () => exported.main({ action, data })),
    raw: (openid, event) => context.run(openid, () => exported.main(event)),
    user(id, runner = false, campusId = 'demo-campus', role = 'user') {
      state.users[id] = { _id: id, nickname: '演示用户', campusId, role, runner: runner ? { status: 'approved', campusId, online: true } : null };
      return state.users[id];
    },
    order(id, patch = {}) {
      state.orders[id] = Object.assign({ _id: id, ownerId: 'owner', ownerNickname: '演示用户', campusId: 'demo-campus', stationId: 'demo-main', stationName: '示例驿站', room: '保密地址', pickupCode: '12-3-4567', recipient: '演示收件人', phone: '10000000000', status: 'waiting_assignment', runnerId: null, photoFileIds: [], shareToken: 'a'.repeat(24), orderNo: 'SD-DEMO', totalCents: 400, createdAt: Date.now(), timeline: [] }, patch);
      return state.orders[id];
    }
  };
}
