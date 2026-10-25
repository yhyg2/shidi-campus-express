// 展示层格式化：所有文案在 JS 里算好，WXML 不做逻辑。
const STATUS = {
  waiting_assignment: { text: '待接单', tone: 'progress', step: 1 },
  assigned: { text: '待取件', tone: 'progress', step: 2 },
  picked_up: { text: '配送中', tone: 'progress', step: 3 },
  delivered: { text: '待确认', tone: 'progress', step: 4 },
  completed: { text: '已完成', tone: 'done', step: 5 },
  cancelled: { text: '已取消', tone: 'dead', step: 0 }
};
const FLOW = ['提交委托', '代取接单', '送达楼下', '确认完成'];

function statusOf(status) { return STATUS[status] || { text: status || '未知', tone: 'dead', step: 0 }; }
function money(cents) { return ((Number(cents) || 0) / 100).toFixed(2); }
function pad(n) { return n < 10 ? '0' + n : '' + n; }

function time(value) {
  if (!value) return '';
  const date = new Date(value);
  if (isNaN(date.getTime())) return '';
  return pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes());
}

function relative(value) {
  if (!value) return '';
  const diff = Date.now() - new Date(value).getTime();
  if (isNaN(diff)) return '';
  if (diff < 60e3) return '刚刚';
  if (diff < 3600e3) return Math.floor(diff / 60e3) + ' 分钟前';
  if (diff < 86400e3) return Math.floor(diff / 3600e3) + ' 小时前';
  return time(value);
}

function date(value) {
  const target = new Date(value);
  if (isNaN(target.getTime())) return '';
  return target.getFullYear() + '-' + pad(target.getMonth() + 1) + '-' + pad(target.getDate());
}

function order(order) {
  if (!order) return null;
  const meta = statusOf(order.status);
  const flow = FLOW.map((label, index) => ({
    label,
    index,
    done: meta.step > FLOW.length || meta.step > index + 1,
    current: meta.step === index + 1 && meta.step <= FLOW.length
  }));
  return Object.assign({}, order, {
    amount: money(order.totalCents),
    statusText: meta.text,
    statusTone: meta.tone,
    createText: time(order.createdAt),
    createRelative: relative(order.createdAt),
    parcelText: order.parcelCount + ' 件' + (order.sizeLabel ? ' · ' + order.sizeLabel : ''),
    subText: [order.campusName, order.parcelCount + ' 件', order.sizeLabel].filter(Boolean).join(' · '),
    destination: order.destination || [order.building, order.room].filter(Boolean).join(' · '),
    routeText: (order.stationName || '驿站') + ' → ' + (order.destination || [order.building, order.room].filter(Boolean).join(' · ') || '送达位置'),
    priceLines: (order.priceLines || []).map(item => Object.assign({}, item, { amount: money(item.cents) })),
    flow,
    timeline: (order.timeline || []).map(item => Object.assign({}, item, { timeText: time(item.at) })),
    photoFileIds: order.photoFileIds || []
  });
}

function list(orders) { return (orders || []).map(order); }

module.exports = { STATUS, FLOW, statusOf, money, time, relative, date, order, list };
