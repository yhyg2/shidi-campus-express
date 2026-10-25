// 一致性检查：三份 core 是否同步、路由与云函数/本地实现是否对齐、页面与组件引用是否完整。
// 通过检查 ≠ 微信开发者工具能编译，也不等于真机可用。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mp = join(root, 'miniprogram');

const read = file => readFileSync(join(root, file), 'utf8');
const actionsOf = (code, pattern) => new Set([...code.matchAll(pattern)].map(match => match[1]));

test('shared/core.js 与云函数、小程序两份副本完全一致', () => {
  const source = read('shared/core.js');
  assert.equal(read('cloudfunctions/api/lib/core.js'), source);
  assert.equal(read('miniprogram/utils/core.js'), source);
  assert.ok(source.includes('module.exports'), 'core 必须是 CommonJS，云函数才能直接 require');
});

test('路由里的每个 action 在云函数与本地演示里都有实现', () => {
  const { ROUTES } = require(join(mp, 'utils/routes.js'));
  const cloud = actionsOf(read('cloudfunctions/api/index.js'), /async '([a-z]+[a-zA-Z.]*)'\s*\(/g);
  const local = actionsOf(read('miniprogram/utils/local.js'), /'([a-z]+[a-zA-Z.]*)':\s*\(/g);
  for (const [, , action] of ROUTES) {
    assert.ok(cloud.has(action), '云函数缺少 ' + action);
    assert.ok(local.has(action), '本地演示缺少 ' + action);
  }
  assert.ok(ROUTES.length >= 30, '路由数量异常：' + ROUTES.length);
});

test('页面与分包文件齐全，tabBar 与组件引用有效', () => {
  const app = JSON.parse(readFileSync(join(mp, 'app.json'), 'utf8'));
  const pages = [...app.pages];
  for (const pkg of app.subPackages || []) for (const page of pkg.pages) pages.push(pkg.root + '/' + page);
  for (const page of pages) {
    for (const ext of ['.js', '.json', '.wxml']) {
      assert.ok(existsSync(join(mp, page + ext)), '缺少页面文件：' + page + ext);
    }
    const config = JSON.parse(readFileSync(join(mp, page + '.json'), 'utf8'));
    for (const [tag, target] of Object.entries(config.usingComponents || {})) {
      const base = target.startsWith('/') ? join(mp, target.slice(1)) : resolve(mp, dirname(page), target);
      for (const ext of ['.js', '.json', '.wxml']) assert.ok(existsSync(base + ext), page + ' 组件 ' + tag + ' 缺少 ' + ext);
    }
  }
  for (const item of app.tabBar.list) {
    assert.ok(app.pages.includes(item.pagePath), 'tabBar 页面必须在主包：' + item.pagePath);
    assert.ok(existsSync(join(mp, item.iconPath)), '缺少 tabBar 图标：' + item.iconPath);
  }
});

test('WXML 里绑定的事件处理器在对应 JS 中都存在', () => {
  const app = JSON.parse(readFileSync(join(mp, 'app.json'), 'utf8'));
  const pages = [...app.pages];
  for (const pkg of app.subPackages || []) for (const page of pkg.pages) pages.push(pkg.root + '/' + page);
  const check = (base, isPage) => {
    const js = readFileSync(join(mp, base + '.js'), 'utf8');
    const wxml = readFileSync(join(mp, base + '.wxml'), 'utf8');
    for (const match of wxml.matchAll(/(?:bind|catch)[:a-z]*="([a-zA-Z_][\w]*)"/g)) {
      const handler = match[1];
      const defined = new RegExp('(^|[\\s,{])' + handler + '\\s*[(:]').test(js);
      assert.ok(defined, (isPage ? '页面' : '组件') + ' ' + base + ' 缺少处理器 ' + handler);
    }
  };
  for (const page of pages) check(page, true);
  const components = readdirSync(join(mp, 'components'));
  for (const name of components) check('components/' + name + '/index', false);
});

test('页面里用到的自定义组件都在 json 中声明过', () => {
  const app = JSON.parse(readFileSync(join(mp, 'app.json'), 'utf8'));
  const pages = [...app.pages];
  for (const pkg of app.subPackages || []) for (const page of pkg.pages) pages.push(pkg.root + '/' + page);
  const known = new Set(readdirSync(join(mp, 'components')));
  for (const page of pages) {
    const config = JSON.parse(readFileSync(join(mp, page + '.json'), 'utf8'));
    const declared = new Set(Object.keys(config.usingComponents || {}));
    const wxml = readFileSync(join(mp, page + '.wxml'), 'utf8');
    for (const match of wxml.matchAll(/<([a-z][a-z0-9]*-[a-z0-9-]+)/g)) {
      const tag = match[1];
      if (!known.has(tag)) continue;
      assert.ok(declared.has(tag), page + ' 使用了未声明的组件 <' + tag + '>');
    }
  }
});

test('云函数只通过 action 暴露能力，客户端没有硬编码密钥', () => {
  const cloud = read('cloudfunctions/api/index.js');
  assert.ok(cloud.includes('cloud.getWXContext()'), '必须从上下文取 openid');
  assert.ok(!/appsecret/i.test(cloud), '云函数里不应出现 AppSecret');
  const api = read('miniprogram/utils/api.js');
  assert.ok(!/secret/i.test(api), '小程序端不应出现任何密钥');
  const config = read('miniprogram/config.js');
  assert.ok(!/secret/i.test(config));
});

test('所有 WXML 标签闭合正常（编译期最容易踩的坑）', () => {
  const VOID = new Set(['input', 'image', 'icon', 'progress', 'slider', 'switch', 'textarea', 'import', 'include', 'wxs', 'ad', 'camera', 'canvas', 'live-player', 'live-pusher', 'open-data', 'web-view']);
  const walk = (dir, out = []) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full, out);
      else if (name.endsWith('.wxml')) out.push(full);
    }
    return out;
  };
  for (const file of walk(mp)) {
    const src = readFileSync(file, 'utf8');
    const stack = [];
    for (const match of src.matchAll(/<(\/?)([a-z][a-z0-9-]*)([^>]*?)(\/?)>/g)) {
      const [, close, tag, , selfClose] = match;
      if (selfClose === '/' || VOID.has(tag)) continue;
      if (close === '/') {
        const top = stack.pop();
        assert.equal(top, tag, file + ' 里的 </' + tag + '> 与 <' + top + '> 不匹配');
      } else stack.push(tag);
    }
    assert.deepEqual(stack, [], file + ' 有未闭合标签');
  }
});

test('分享文案不引用已废弃的楼栋字段，也不泄露送达地址', () => {
  const share = read('miniprogram/utils/share.js');
  assert.ok(!/order\.building/.test(share), '楼栋字段已不用，分享标题会变成空箭头');
  assert.ok(!/order\.room/.test(share), '送达地址不应出现在分享标题里');
});
