// 枚举 bundle 中所有 /apps 相关 fetch 的调用形态
const fs = require('node:fs');
const t = fs.readFileSync('E:/data/Knowly/electron/dist/bundle.js', 'utf8');
const re = /fetch\((?:`[^`]*?|"[^"]*?")\/apps[^`")]*(?:`|")[^)]{0,220}\)/g;
let m;
const seen = new Set();
while ((m = re.exec(t)) !== null) {
  const s = m[0].replace(/\s+/g, ' ');
  if (!seen.has(s)) {
    seen.add(s);
    console.log('FETCH:', s.slice(0, 240));
  }
}
// 列表项渲染字段（app item）
const i = t.indexOf('/apps/import');
const seg = t.slice(i - 200, i + 9000);
const fields = [...new Set([...seg.matchAll(/\b(?:[a-z]\w*)\.(app_id|name|entry|created_at|source_path|entry_file|id)\b/g)].map((x) => x[1]))];
console.log('item 字段引用:', [...new Set(fields)].join(','));
