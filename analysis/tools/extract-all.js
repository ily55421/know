// Self-contained ASAR extractor (offline, header-driven)
const fs = require('fs');
const path = require('path');

const ASAR = 'E:/soft/Knowly/resources/app.asar';
const OUT = 'E:/data/Knowly/analysis/extracted';

const fd = fs.openSync(ASAR, 'r');
const head = Buffer.alloc(16);
fs.readSync(fd, head, 0, 16, 0);
const headerSize = head.readUInt32LE(4);
const jsonLen = head.readUInt32LE(12);
const jb = Buffer.alloc(jsonLen);
fs.readSync(fd, jb, 0, jsonLen, 16);
const header = JSON.parse(jb.toString('utf8'));
const BASE = 8 + headerSize;
console.log('headerSize:', headerSize, 'BASE:', BASE, 'archive size:', fs.fstatSync(fd).size);

let files = 0, dirs = 0, bytes = 0, unpacked = 0, skipped = [];
const CHUNK = 8 * 1024 * 1024;
const buf = Buffer.alloc(CHUNK);

function walk(node, rel) {
  if (node.files) {
    dirs++;
    for (const [name, child] of Object.entries(node.files)) {
      if (name === '' || name === '/' ) { skipped.push(rel); continue; }
      walk(child, rel ? rel + '/' + name : name);
    }
    return;
  }
  files++;
  const dest = path.join(OUT, rel);
  if (!rel || dest === OUT) { skipped.push('FILE-AT-ROOT:' + rel); return; }
  if (node.unpacked) {
    // file lives in app.asar.unpacked next to the archive
    const src = path.join(path.dirname(ASAR), 'app.asar.unpacked', rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    unpacked++;
    return;
  }
  const off = BASE + Number(node.offset);
  const size = node.size;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const out = fs.openSync(dest, 'w');
  let written = 0;
  while (written < size) {
    const n = Math.min(CHUNK, size - written);
    fs.readSync(fd, buf, 0, n, off + written);
    fs.writeSync(out, buf, 0, n);
    written += n;
  }
  fs.closeSync(out);
  bytes += size;
}

walk(header, '');
console.log(JSON.stringify({ files, dirs, unpacked, bytes, skipped: skipped.slice(0, 5), skippedCount: skipped.length }));
