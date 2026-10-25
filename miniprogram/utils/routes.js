// 路径 → 云函数 action 的映射表。
// 页面继续用 REST 风格的路径调用，数据源切换（云开发 / 本地演示 / http）由 api.js 处理，
// 页面代码不需要知道背后是云函数还是本地存储。
const ROUTES = [
  ['POST', /^\/images\/urls$/, 'image.urls'],
  ['GET', /^\/config$/, 'config.get'],
  ['GET', /^\/me$/, 'me.get'],
  ['PATCH', /^\/me$/, 'me.update'],
  ['POST', /^\/me\/campus$/, 'me.campus'],

  ['POST', /^\/quotes$/, 'order.quote'],
  ['POST', /^\/orders$/, 'order.create'],
  ['GET', /^\/orders$/, 'order.list'],
  ['GET', /^\/orders\/([\w-]+)$/, 'order.get', ['id']],
  ['POST', /^\/orders\/([\w-]+)\/cancel$/, 'order.cancel', ['id']],
  ['POST', /^\/orders\/([\w-]+)\/confirm$/, 'order.confirm', ['id']],
  ['POST', /^\/orders\/([\w-]+)\/review$/, 'order.review', ['id']],
  ['POST', /^\/orders\/([\w-]+)\/complaint$/, 'order.complaint', ['id']],
  ['POST', /^\/orders\/([\w-]+)\/claim$/, 'runner.claim', ['id']],
  ['POST', /^\/orders\/([\w-]+)\/progress$/, 'runner.progress', ['id']],
  ['GET', /^\/share\/orders\/([\w-]+)$/, 'order.share', ids => ({ token: ids[0] })],

  ['GET', /^\/runner\/hall$/, 'runner.hall'],
  ['GET', /^\/runner\/orders$/, 'runner.orders'],
  ['POST', /^\/runner\/availability$/, 'runner.availability'],
  ['POST', /^\/runner\/apply$/, 'runner.apply'],

  ['POST', /^\/member\/join$/, 'member.join'],
  ['POST', /^\/admin\/bootstrap$/, 'admin.bootstrap'],

  ['GET', /^\/admin\/overview$/, 'admin.overview'],
  ['GET', /^\/admin\/orders$/, 'admin.orders'],
  ['GET', /^\/admin\/orders\/([\w-]+)\/candidates$/, 'admin.order.candidates', ['id']],
  ['POST', /^\/admin\/orders\/([\w-]+)\/assign$/, 'admin.order.assign', ['id']],
  ['POST', /^\/admin\/orders\/([\w-]+)\/cancel$/, 'admin.order.cancel', ['id']],
  ['GET', /^\/admin\/runners$/, 'admin.runners'],
  ['POST', /^\/admin\/runners\/invite$/, 'admin.runner.invite'],
  ['POST', /^\/admin\/runners\/([\w-]+)\/review$/, 'admin.runner.review', ['id']],
  ['GET', /^\/admin\/pricing$/, 'admin.pricing.get'],
  ['POST', /^\/admin\/pricing$/, 'admin.pricing.save'],
  ['GET', /^\/admin\/notices$/, 'admin.notice.list'],
  ['POST', /^\/admin\/notices$/, 'admin.notice.save'],
  ['DELETE', /^\/admin\/notices\/([\w-]+)$/, 'admin.notice.remove', ['id']],
  ['GET', /^\/admin\/members$/, 'admin.members'],
  ['POST', /^\/admin\/members\/invite$/, 'admin.member.invite'],
  ['POST', /^\/admin\/members\/([\w-]+)\/remove$/, 'admin.member.remove', ['id']],
  ['GET', /^\/admin\/settings$/, 'admin.settings.get'],
  ['POST', /^\/admin\/settings$/, 'admin.settings.save'],
  ['GET', /^\/admin\/export$/, 'admin.export'],
  ['GET', /^\/admin\/complaints$/, 'admin.complaints'],
  ['POST', /^\/admin\/complaints\/([\w-]+)\/resolve$/, 'admin.complaint.resolve', ['id']],
  ['GET', /^\/admin\/logs$/, 'admin.logs']
];

/** 匹配路径；返回 { action, params } 或 null。 */
function match(method, path) {
  const [pathname, query = ''] = String(path || '').split('?');
  const queryParams = {};
  for (const pair of query.split('&').filter(Boolean)) {
    const [key, value = ''] = pair.split('=');
    if (key === 'filter') queryParams.filter = decodeURIComponent(value);
  }
  for (const [routeMethod, pattern, action, names] of ROUTES) {
    if (routeMethod !== method) continue;
    const result = pattern.exec(pathname);
    if (!result) continue;
    let params = Object.assign({}, queryParams);
    if (typeof names === 'function') params = Object.assign(params, names(result.slice(1)));
    else if (Array.isArray(names)) names.forEach((name, index) => { params[name] = result[index + 1]; });
    return { action, params };
  }
  return null;
}

module.exports = { ROUTES, match };
