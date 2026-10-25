import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const require = createRequire(import.meta.url);
const routes = require('../miniprogram/utils/routes.js');

test('管理端筛选 query 参数确实进入云函数 payload，路径参数不会被 query 覆盖', () => {
  assert.equal(routes.match('GET', '/admin/orders?filter=completed').params.filter, 'completed');
  assert.equal(routes.match('GET', '/admin/export?filter=cancelled').params.filter, 'cancelled');
  assert.equal(routes.match('GET', '/orders/o1?id=o2').params.id, 'o1');
});

test('已配置云环境时缺少云能力也不会默默切换本地演示', () => {
  const exported = { exports: {} };
  vm.runInNewContext(readFileSync(new URL('../miniprogram/utils/api.js', import.meta.url), 'utf8'), {
    require: path => path === '../config' ? { DATA_SOURCE: 'auto', CLOUD_ENV: 'demo' } : routes,
    module: exported,
    wx: {}
  });
  assert.equal(exported.exports.source(), 'cloud');
});

test('用户尚未同意协议时不会主动初始化云服务或创建用户', () => {
  let definition;
  let requests = 0;
  let cloudInits = 0;
  vm.runInNewContext(readFileSync(new URL('../miniprogram/app.js', import.meta.url), 'utf8'), {
    App: app => { definition = app; },
    require: path => path.endsWith('/api') ? { source: () => 'cloud', request: () => { requests++; } } : path.endsWith('/session') ? { getCampus: () => '' } : path.endsWith('/agreement') ? { currentVersion: 'v2' } : {},
    wx: { getStorageSync: () => false, cloud: { init: () => cloudInits++ } }
  });
  definition.onLaunch();
  assert.equal(requests, 0);
  assert.equal(cloudInits, 0);
});
