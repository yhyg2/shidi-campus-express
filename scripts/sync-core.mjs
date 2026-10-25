// 把 shared/core.js 同步到云函数与小程序两处，避免两份业务逻辑漂移。
import { readFileSync, writeFileSync } from 'node:fs';

const sources = 'shared/core.js';
const targets = ['cloudfunctions/api/lib/core.js', 'miniprogram/utils/core.js'];
const code = readFileSync(sources, 'utf8');
for (const target of targets) writeFileSync(target, code);
console.log('已同步 ' + sources + ' → ' + targets.join(', ') + '（' + (code.length / 1024).toFixed(1) + 'KB）');
