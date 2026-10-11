#!/usr/bin/env node
'use strict';

/**
 * 版本发布脚本（重建版）。
 *
 * 用法：
 *   node scripts/release.mjs patch            # 3.13.2-recon.1 -> 3.13.2-recon.2
 *   node scripts/release.mjs minor            # 3.13.2-recon.1 -> 3.13.3-recon.1（跟随上游）
 *   node scripts/release.mjs --set X.Y.Z-recon.N
 *   node scripts/release.mjs patch --dry-run
 *
 * 动作：更新 package.json 版本 → 在 CHANGELOG.md 顶部插入新版本小节 → git commit → git tag v<版本>。
 * 版本方案：<上游版本>-recon.<n>；上游基线升级时用 --set 提升主版本。
 */

const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const PKG = path.join(ROOT, 'package.json');
const CHANGELOG = path.join(ROOT, 'CHANGELOG.md');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const rest = args.filter((a) => !a.startsWith('--'));
const mode = rest[0];

const RECON_RE = /^(\d+)\.(\d+)\.(\d+)-recon\.(\d+)$/;

function parseVersion(v) {
  const m = RECON_RE.exec(v);
  if (!m) throw new Error(`当前版本不符合 <上游>-recon.<n> 方案: ${v}`);
  return { major: +m[1], minor: +m[2], patch: +m[3], recon: +m[4] };
}

function bump(cur, mode) {
  if (mode === 'patch') return `${cur.major}.${cur.minor}.${cur.patch}-recon.${cur.recon + 1}`;
  if (mode === 'minor') return `${cur.major}.${cur.minor}.${cur.patch + 1}-recon.1`;
  if (mode === 'major') return `${cur.major + 1}.0.0-recon.1`;
  throw new Error('mode 必须是 patch|minor|major，或使用 --set X.Y.Z-recon.N');
}

const pkg = JSON.parse(fs.readFileSync(PKG, 'utf8'));
const cur = parseVersion(pkg.version);
let next;
if (mode === '--set') {
  const idx = args.indexOf('--set');
  next = args[idx + 1];
  if (!RECON_RE.test(next)) throw new Error(`--set 版本须符合 X.Y.Z-recon.N: ${next}`);
} else {
  next = bump(cur, mode);
}

console.log(`版本: ${pkg.version} -> ${next}${dryRun ? '（dry-run）' : ''}`);
if (dryRun) process.exit(0);

// 1) package.json
pkg.version = next;
fs.writeFileSync(PKG, JSON.stringify(pkg, null, 2) + '\n', 'utf8');

// 2) CHANGELOG 模板
const today = new Date().toISOString().split('T')[0];
let changelog = fs.readFileSync(CHANGELOG, 'utf8');
const heading = '# Changelog（重建版）';
const section = `${heading}

## [${next}] — ${today}

### 变更
- （发布前填写）

### 验证
- npm test 通过
`;
if (!changelog.includes(`## [${next}]`)) {
  changelog = changelog.replace(heading, section);
  fs.writeFileSync(CHANGELOG, changelog, 'utf8');
}

// 3) git commit + tag
const git = (cmd) => execSync(cmd, { cwd: ROOT, encoding: 'utf8' }).trim();
git('git add package.json CHANGELOG.md');
git(`git commit -m "release: ${next}"`);
git(`git tag -a v${next} -m "release ${next}"`);
console.log(`已提交并打标签 v${next}`);
console.log('提醒：请把本次变更内容补进 CHANGELOG.md 对应小节，然后 git commit --amend。');
