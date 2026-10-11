// Extract SSE reader context around qa/chat/stream consumer in bundle.js
const fs = require('fs');
const t = fs.readFileSync('E:/data/Knowly/analysis/extracted/electron/dist/bundle.js', 'utf8');

// find getReader() occurrences and print surrounding code
let idx = 0, found = 0;
while (found < 8) {
  idx = t.indexOf('getReader()', idx);
  if (idx < 0) break;
  const ctx = t.slice(Math.max(0, idx - 1200), idx + 1500);
  if (/event-stream|data:|event:|delta|content/.test(ctx)) {
    console.log('===== getReader @' + idx + ' =====');
    console.log(ctx.replace(/\\n/g, '\n'));
    found++;
  }
  idx += 10;
}
