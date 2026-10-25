import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const files = [];
function walk(dir) {
  for (const item of readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git'].includes(item.name)) continue;
    const path = join(dir, item.name);
    if (item.isDirectory()) walk(path); else files.push(path);
  }
}
walk(root);
for (const path of files) {
  if (/\.(js|mjs)$/.test(path)) {
    const check = spawnSync(process.execPath, ['--check', path], { encoding: 'utf8' });
    if (check.status !== 0) { process.stderr.write(check.stderr); process.exit(1); }
  }
  if (path.endsWith('.json')) JSON.parse(readFileSync(path, 'utf8'));
}
const result = spawnSync(process.execPath, ['--test', 'tests/consistency.test.mjs'], { cwd: root, stdio: 'inherit' });
process.exit(result.status ?? 1);
