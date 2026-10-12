#!/usr/bin/env node
/**
 * 校验 app.asar 中的源码目录与工作区是否一致（发布前完整性检查）。
 * 覆盖 electron/ server/ public/ package.json —— 即 electron-builder files 白名单。
 */
const fs = require('fs');
const path = require('path');
const asar = require('@electron/asar');

const asarPath = process.argv[2] || 'resources/app.asar';
const roots = ['electron', 'server', 'public', 'package.json'];

function listLocal(root) {
  const out = [];
  const abs = path.resolve(root);
  if (!fs.existsSync(abs)) return out;
  const st = fs.statSync(abs);
  if (st.isFile()) return [{ rel: root, abs }];
  (function walk(dir) {
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      const s = fs.statSync(p);
      if (s.isDirectory()) walk(p);
      else out.push({ rel: path.relative(process.cwd(), p), abs: p });
    }
  })(abs);
  return out;
}

const local = roots.flatMap(listLocal);
let same = 0;
const missing = [];
const diff = [];

for (const f of local) {
  const inner = f.rel.replace(/\//g, '\\');
  let buf;
  try {
    buf = asar.extractFile(asarPath, inner);
  } catch {
    missing.push(f.rel);
    continue;
  }
  const disk = fs.readFileSync(f.abs);
  if (disk.equals(buf)) same += 1;
  else diff.push(`${f.rel} (disk ${disk.length}B vs asar ${buf.length}B)`);
}

console.log(`比对文件: ${local.length}  一致: ${same}  缺失: ${missing.length}  不一致: ${diff.length}`);
if (missing.length) {
  console.log('\n[缺失] asar 中没有：');
  missing.slice(0, 40).forEach((m) => console.log('  -', m));
  if (missing.length > 40) console.log(`  … 另 ${missing.length - 40} 个`);
}
if (diff.length) {
  console.log('\n[不一致]：');
  diff.slice(0, 40).forEach((m) => console.log('  -', m));
  if (diff.length > 40) console.log(`  … 另 ${diff.length - 40} 个`);
}
process.exit(missing.length || diff.length ? 1 : 0);
