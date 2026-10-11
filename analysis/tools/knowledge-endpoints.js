// 提取知识库/本地资料学习页的全部端点契约
const fs = require('node:fs');
const t = fs.readFileSync('E:/data/Knowly/electron/dist/bundle.js', 'utf8');
const re = /fetch\(`\$\{[^}]+\}((?:\/[A-Za-z0-9_\-{}$.:]+)+)`[^)]{0,220}\)/g;
const seen = new Map();
let m;
while ((m = re.exec(t)) !== null) {
  const url = m[1];
  if (!/director|know|index|learn|rag|file|search|monitor|scan/i.test(url)) continue;
  if (seen.has(url)) continue;
  const start = m.index;
  seen.set(url, t.slice(start, start + Math.min(260, m[0].length + 120)).replace(/\s+/g, ' '));
}
for (const [url, ctx] of seen) {
  console.log('=== ' + url + ' ===');
  console.log(ctx.slice(0, 240));
  console.log();
}
