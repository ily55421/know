const fs = require('fs');
const asarPath = 'resources/app.asar';
const fd = fs.openSync(asarPath, 'r');
const fileSize = fs.fstatSync(fd).size;
const head8 = Buffer.alloc(8);
fs.readSync(fd, head8, 0, 8, 0);
const headerBufLen = head8.readUInt32LE(4);
const headerBuf = Buffer.alloc(headerBufLen);
fs.readSync(fd, headerBuf, 0, headerBufLen, 8);
const jsonLen = headerBuf.readUInt32LE(4);
const header = JSON.parse(headerBuf.toString('utf8', 8, 8 + jsonLen));
fs.closeSync(fd);
const base = 8 + headerBufLen;

const out = [];
(function walk(node, prefix) {
  const files = node && node.files;
  if (!files) return;
  for (const [name, e] of Object.entries(files)) {
    const p = prefix ? `${prefix}\\${name}` : name;
    if (e && e.files) walk(e, p);
    else if (e) out.push({ p, size: e.size, offset: e.offset, unpacked: e.unpacked, link: e.link, keys: Object.keys(e) });
  }
})(header, '');

console.log('file size:', fileSize, 'base:', base, 'dataLen:', fileSize - base);
console.log('leaf count:', out.length);

const withOff = out.filter((e) => typeof e.offset === 'string');
console.log('leaf with offset:', withOff.length);
console.log('leaf without offset:', out.length - withOff.length);
const noOff = out.filter((e) => typeof e.offset !== 'string');
noOff.slice(0, 8).forEach((e) => console.log('  noOffset:', e.p, JSON.stringify({ size: e.size, unpacked: e.unpacked, link: e.link, keys: e.keys })));

const unpacked = out.filter((e) => e.unpacked);
console.log('unpacked entries:', unpacked.length);
unpacked.slice(0, 5).forEach((e) => console.log('  unpacked:', e.p, 'offset=', e.offset, 'size=', e.size));

const sorted = withOff.map((e) => ({ ...e, o: Number(e.offset) })).sort((a, b) => a.o - b.o);
console.log('\nfirst 6 by offset:', sorted.slice(0, 6).map((e) => `${e.o}:${e.size}:${e.p}`));
let cursor = 0, gaps = 0, overlaps = 0;
for (const e of sorted) {
  if (e.o > cursor) { if (gaps < 6) console.log('GAP at', e.p, 'offset', e.o, 'cursor', cursor, 'delta', e.o - cursor); gaps += 1; cursor = e.o; }
  else if (e.o < cursor) { if (overlaps < 6) console.log('OVERLAP at', e.p, 'offset', e.o, 'cursor', cursor); overlaps += 1; }
  cursor = Math.max(cursor, e.o + (e.size || 0));
}
console.log('\ngaps:', gaps, 'overlaps:', overlaps, 'final cursor:', cursor, 'expected:', fileSize - base);

// 统计 offset 重复
const byOff = new Map();
for (const e of sorted) byOff.set(e.o, (byOff.get(e.o) || 0) + 1);
const dup = [...byOff.entries()].filter(([, c]) => c > 1);
console.log('duplicate offsets:', dup.length, dup.slice(0, 5));
