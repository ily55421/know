// 找渲染层保存消息的调用与载荷
const fs = require('node:fs');
const t = fs.readFileSync('E:/data/Knowly/electron/dist/bundle.js', 'utf8');

let idx = 0;
let shown = 0;
while (shown < 6) {
  idx = t.indexOf('/messages', idx);
  if (idx < 0) break;
  const seg = t.slice(Math.max(0, idx - 700), idx + 260).replace(/\n/g, ' ');
  if (/method/.test(seg) && /POST|PUT/.test(seg)) {
    console.log('=== @' + idx + ' ===');
    console.log(JSON.stringify(seg).slice(0, 900));
    console.log();
    shown += 1;
  }
  idx += 9;
}
