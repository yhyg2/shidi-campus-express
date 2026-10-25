// 可复现的公开发布检查；无法代替人工判断与真实部署审查。
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const issues = [];
let checked = 0;
const rules = [
  ['deployment app identifier', /wx[a-f0-9]{16}/i],
  ['cloud environment identifier', /(?:cloud1|cloud2)-[a-z0-9-]{8,}/i],
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['access credential', /(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|AKID[A-Za-z0-9]{28,}|sk-[A-Za-z0-9_-]{32,})/],
  ['personal absolute path', /(?:[A-Z]:\\(?:Users|微信)|\/(?:Users|home)\/[a-zA-Z0-9._-]+\/)/],
  ['personal email', /[A-Z0-9._%+-]+@(?!users\.noreply\.github\.com\b|example\.(?:com|invalid)\b)[A-Z0-9.-]+\.[A-Z]{2,}/i],
  ['phone-like data', /(?<!\d)1[3-9]\d{9}(?!\d)/],
  ['unexpected coauthor metadata', /Co-Authored-By:/i]
];
function walk(dir) {
  for (const item of readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git'].includes(item.name)) continue;
    const path = join(dir, item.name);
    const name = relative(root, path);
    if (item.isSymbolicLink()) { issues.push(name + ': symbolic link'); continue; }
    if (item.isDirectory()) { walk(path); continue; }
    if (item.name === 'project.private.config.json' || /^\.env(?:\.|$)/.test(item.name) || /\.(pem|key|p12|pfx|zip|csv)$/.test(item.name)) issues.push(name + ': private or exported file');
    if (!/\.(?:js|mjs|json|md|wxml|wxss|html|css|yml|yaml)$/.test(item.name)) continue;
    checked++;
    if (item.name === 'package-lock.json' || name === join('scripts', 'release-check.mjs')) continue;
    const text = readFileSync(path, 'utf8');
    for (const [label, pattern] of rules) if (pattern.test(text)) issues.push(name + ': ' + label);
  }
}
walk(root);
const project = JSON.parse(readFileSync(join(root, 'project.config.json'), 'utf8'));
if (project.appid !== 'touristappid') issues.push('project.config.json: use the public placeholder before publishing');
const config = readFileSync(join(root, 'miniprogram/config.js'), 'utf8');
if (!/CLOUD_ENV:\s*''/.test(config)) issues.push('miniprogram/config.js: remove the deployment environment before publishing');
if (issues.length) { console.error(issues.join('\n')); process.exit(1); }
console.log('Public release checks passed: ' + checked + ' text files. Review images and staged changes separately.');
