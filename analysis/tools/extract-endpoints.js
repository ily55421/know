// Broad extraction v3: quoted + template-literal path fragments
const fs = require('fs');
const path = require('path');
const dist = 'E:/data/Knowly/analysis/extracted/electron/dist';
const files = fs.readdirSync(dist).filter((f) => f.endsWith('.js'));

const re = /["'`](\/[a-zA-Z][a-zA-Z0-9_$\-\/\.{}]*(?:\/)?)["'`]/g;
const counts = new Map();
for (const f of files) {
  const text = fs.readFileSync(path.join(dist, f), 'utf8');
  let m;
  while ((m = re.exec(text)) !== null) {
    const ep = m[1];
    if (ep.length > 80) continue;
    if (/^\/\//.test(ep)) continue;
    // skip css / regex-ish noise
    if (/[{}]/.test(ep) === false && ep.split('/').length < 2) continue;
    counts.set(ep, (counts.get(ep) || 0) + 1);
  }
}
const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
fs.writeFileSync('E:/data/Knowly/analysis/renderer-endpoints.txt', sorted.map(([e, c]) => c + '\t' + e).join('\n'), 'utf8');
console.log('unique literals:', sorted.length);
console.log(sorted.map(([e, c]) => c + '\t' + e).join('\n'));
