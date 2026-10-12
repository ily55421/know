#!/usr/bin/env node
/**
 * 原地替换 app.asar 中的单个文件（无需全量解包/重打包）。
 *
 * 用法: node scripts/repack-asar.cjs <asar路径> <归档内路径> <本机真实文件>
 *       REPACK_DRY=1 只做校验不落盘
 *
 * asar 布局:
 *   [u32 outerPayload=4][u32 headerBufLen][headerBuf]
 *   headerBuf = [u32 headerPayloadLen][u32 jsonLen][json 字节][补齐到 4 字节]
 *   数据基址 base = 8 + headerBufLen；entry.offset 相对 base 且为字符串。
 *
 * 关键事实（实测）：electron-builder 打包时对**内容相同**的文件做了去重，
 * 多个 entry 会指向同一段物理字节（如渲染层 woff 与 katex 字体）。
 * 因此：
 *   1) 被替换文件必须占用独占的 offset（否则其"别名"会被写坏）；
 *   2) 只有 offset 严格大于目标 offset 的 entry 需要平移 delta。
 */
const fs = require('fs');
const path = require('path');

const ALIGN = 4;
const align4 = (n) => (n + (ALIGN - 1)) & ~(ALIGN - 1);

function readHeader(fd) {
  const head8 = Buffer.alloc(8);
  fs.readSync(fd, head8, 0, 8, 0);
  const outerPayload = head8.readUInt32LE(0);
  const headerBufLen = head8.readUInt32LE(4);
  if (outerPayload !== 4) throw new Error(`意外外层次长度 ${outerPayload}（期望 4）`);
  const headerBuf = Buffer.alloc(headerBufLen);
  fs.readSync(fd, headerBuf, 0, headerBufLen, 8);
  const jsonLen = headerBuf.readUInt32LE(4);
  if (headerBufLen !== 4 + align4(4 + jsonLen)) {
    throw new Error(`header 长度不符: ${headerBufLen} != ${4 + align4(4 + jsonLen)}`);
  }
  const header = JSON.parse(headerBuf.toString('utf8', 8, 8 + jsonLen));
  return { headerBufLen, header, base: 8 + headerBufLen };
}

function walk(node, prefix, out) {
  const files = node && node.files;
  if (!files) return;
  for (const [name, entry] of Object.entries(files)) {
    const p = prefix ? `${prefix}\\${name}` : name;
    if (entry && entry.files) walk(entry, p, out);
    else if (entry) {
      out.push({
        path: p,
        entry,
        size: typeof entry.size === 'number' ? entry.size : 0,
        offset: typeof entry.offset === 'string' ? Number(entry.offset) : null,
      });
    }
  }
}

/** 覆盖性校验：按 offset 升序铺满 base..EOF（允许去重造成的重叠，不允许空洞） */
function assertCoverage(entries, base, fileSize) {
  const withOffset = entries.filter((e) => e.offset !== null).sort((a, b) => a.offset - b.offset);
  let cursor = 0;
  for (const e of withOffset) {
    if (e.offset > cursor) throw new Error(`数据区空洞: ${e.path} offset=${e.offset} > 已覆盖 ${cursor}`);
    cursor = Math.max(cursor, e.offset + e.size);
  }
  if (base + cursor !== fileSize) {
    throw new Error(`数据区未铺满: ${base + cursor} != ${fileSize}`);
  }
  return withOffset;
}

function buildHeaderBuf(header) {
  const jsonBuf = Buffer.from(JSON.stringify(header), 'utf8');
  const jsonLen = jsonBuf.length;
  const payloadLen = align4(4 + jsonLen);
  const headerBuf = Buffer.alloc(4 + payloadLen);
  headerBuf.writeUInt32LE(payloadLen, 0);
  headerBuf.writeUInt32LE(jsonLen, 4);
  jsonBuf.copy(headerBuf, 8);
  return headerBuf;
}

function copyRange(srcFd, dstFd, srcStart, dstStart, len) {
  if (len <= 0) return;
  const CH = 1 << 24;
  const buf = Buffer.alloc(Math.min(CH, len));
  let done = 0;
  while (done < len) {
    const n = Math.min(buf.length, len - done);
    fs.readSync(srcFd, buf, 0, n, srcStart + done);
    fs.writeSync(dstFd, buf, 0, n, dstStart + done);
    done += n;
  }
}

function main() {
  const [asarPath, innerPath, realFile] = process.argv.slice(2);
  if (!asarPath || !innerPath || !realFile) {
    console.error('用法: node repack-asar.cjs <asar> <归档内路径> <真实文件>');
    process.exit(2);
  }
  const key = innerPath.replace(/\//g, '\\').replace(/^\\/, '');
  const newData = fs.readFileSync(realFile);

  const srcFd = fs.openSync(asarPath, 'r');
  const srcSize = fs.fstatSync(srcFd).size;
  const { header, base } = readHeader(srcFd);
  const entries = [];
  walk(header, '', entries);
  assertCoverage(entries, base, srcSize);

  const target = entries.find((e) => e.path.toLowerCase() === key.toLowerCase());
  if (!target) {
    console.error(`归档内未找到: ${key}`);
    console.error('相近路径:', entries.filter((e) => e.path.includes(path.basename(key))).slice(0, 5).map((e) => e.path));
    fs.closeSync(srcFd);
    process.exit(3);
  }
  if (target.offset === null) {
    console.error(`目标无 offset（unpacked/link），不适用原地替换: ${key}`);
    fs.closeSync(srcFd);
    process.exit(3);
  }

  const cut = target.offset;
  const oldSize = target.size;
  const delta = newData.length - oldSize;
  const aliases = entries.filter((e) => e !== target && e.offset === cut);
  if (aliases.length) {
    console.error(`目标与 ${aliases.length} 个文件共享字节（去重别名），原地替换不安全：`);
    aliases.slice(0, 5).forEach((e) => console.error('   ', e.path));
    fs.closeSync(srcFd);
    process.exit(3);
  }

  // 平移：仅 offset 严格大于 cut 的 entry（按旧 offset 计算）
  for (const e of entries) {
    if (e.offset !== null && e.offset > cut) e.entry.offset = String(e.offset + delta);
  }
  target.entry.size = newData.length;

  const newHeaderBuf = buildHeaderBuf(header);
  const newBase = 8 + newHeaderBuf.length;

  if (process.env.REPACK_DRY === '1') {
    console.log('[dry-run] 覆盖性校验通过（无空洞、铺满 EOF）');
    console.log(`[dry-run] leaf=${entries.length} base=${base} fileSize=${srcSize}`);
    console.log(`[dry-run] ${key}: offset=${cut} size=${oldSize} → ${newData.length} (delta ${delta})`);
    console.log(`[dry-run] header ${base - 8} → ${newHeaderBuf.length}，新基址 ${newBase}`);
    fs.closeSync(srcFd);
    process.exit(0);
  }

  // 采样：验证平移后的 entry 内容不变（含跨越 cut 的头尾样本）
  const asar = require('@electron/asar');
  const after = entries.filter((e) => e.offset !== null && e.offset > cut).sort((a, b) => a.offset - b.offset);
  const samples = [...after.slice(0, 3), ...after.slice(-2), entries.find((e) => e.offset === 0)].filter(Boolean);
  const before = samples.map((e) => ({ p: e.path, buf: asar.extractFile(asarPath, e.path) }));

  const tmpPath = `${asarPath}.repack.tmp`;
  const dstFd = fs.openSync(tmpPath, 'w');
  const head8 = Buffer.alloc(8);
  head8.writeUInt32LE(4, 0);
  head8.writeUInt32LE(newHeaderBuf.length, 4);
  fs.writeSync(dstFd, head8, 0, 8, 0);
  fs.writeSync(dstFd, newHeaderBuf, 0, newHeaderBuf.length, 8);
  copyRange(srcFd, dstFd, base, newBase, cut);
  fs.writeSync(dstFd, newData, 0, newData.length, newBase + cut);
  const afterSrcStart = base + cut + oldSize;
  copyRange(srcFd, dstFd, afterSrcStart, newBase + cut + newData.length, srcSize - afterSrcStart);
  fs.closeSync(srcFd);
  fs.closeSync(dstFd);

  // 校验新归档
  const problems = [];
  try {
    const got = asar.extractFile(tmpPath, key);
    if (!got.equals(fs.readFileSync(realFile))) problems.push('目标文件内容不符');
    for (const s of before) {
      const now = asar.extractFile(tmpPath, s.p);
      if (!now.equals(s.buf)) problems.push(`平移后内容变化: ${s.p}`);
    }
    const { header: h2, base: b2 } = readHeader(fs.openSync(tmpPath, 'r'));
    const e2 = [];
    walk(h2, '', e2);
    assertCoverage(e2, b2, fs.statSync(tmpPath).size);
    if (e2.length !== entries.length) problems.push(`leaf 数变化 ${entries.length} → ${e2.length}`);
  } catch (err) {
    problems.push(`读取异常: ${err.message}`);
  }

  if (problems.length) {
    fs.unlinkSync(tmpPath);
    console.error('校验失败，已放弃（原归档未改动）:');
    problems.forEach((p) => console.error('  -', p));
    process.exit(4);
  }

  console.log(`归档内路径   : ${key}`);
  console.log(`大小         : ${oldSize} → ${newData.length} (delta ${delta > 0 ? '+' : ''}${delta})`);
  console.log(`entry/样本   : ${entries.length} leaf / 校验 ${before.length} 个平移样本`);
  console.log(`新基址/文件  : ${newBase} / ${fs.statSync(tmpPath).size}`);
  console.log('校验         : 全部通过');

  // 时间戳备份（保留最近 2 个），避免 rename 失败时把上一份好档也删掉
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const bak = `${asarPath}.${stamp}.bak`;
  fs.renameSync(asarPath, bak);
  fs.renameSync(tmpPath, asarPath);
  try {
    const dir = path.dirname(asarPath);
    const base = path.basename(asarPath);
    const baks = fs.readdirSync(dir)
      .filter((n) => n.startsWith(base + '.') && n.endsWith('.bak'))
      .sort()
      .reverse();
    baks.slice(2).forEach((n) => fs.unlinkSync(path.join(dir, n)));
  } catch { /* 清理失败不影响主流程 */ }
  console.log(`已替换 ${asarPath}（备份 ${path.basename(bak)}）`);
}

main();
