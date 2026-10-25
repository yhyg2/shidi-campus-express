// 把 WXSS 转成浏览器可读的 CSS，用于生成静态设计预览（不是小程序渲染结果）。
// 375px 宽机型上 1rpx = 0.5px，所以直接除以 2。
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const files = [
  'miniprogram/app.wxss',
  'miniprogram/pages/home/home.wxss',
  'miniprogram/pages/create/create.wxss',
  'miniprogram/pages/detail/detail.wxss',
  'miniprogram/pages/orders/orders.wxss',
  'miniprogram/pages/notice/notice.wxss',
  'miniprogram/pages/join/join.wxss',
  'miniprogram/pages/profile/profile.wxss',
  'miniprogram/packageAdmin/admin/admin.wxss',
  'miniprogram/packageRunner/runner/runner.wxss',
  'miniprogram/packageRunner/hall/hall.wxss',
  'miniprogram/components/order-card/index.wxss',
  'miniprogram/components/status-flow/index.wxss',
  'miniprogram/components/empty-state/index.wxss',
  'miniprogram/components/campus-picker/index.wxss'
].filter(existsSync);

let css = files.map(file => readFileSync(file, 'utf8')).join('\n');
css = css.replace(/(-?\d*\.?\d+)rpx/g, (_, n) => (Number(n) / 2) + 'px');
css = css.replace(/(^|[}\s])page\s*\{/g, '$1\n.screen {');
writeFileSync('preview/design-v3.css', css);
console.log('已生成 preview/design-v3.css：' + files.length + ' 个 WXSS，' + (css.length / 1024).toFixed(1) + 'KB');
