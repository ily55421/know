// 挖 /directories 消费字段 + /search 结果字段 + /index-progress 字段
const fs = require('node:fs');
const t = fs.readFileSync('E:/data/Knowly/electron/dist/bundle.js', 'utf8');

function show(label, needle, before = 700, after = 500, count = 2) {
  let i = 0, n = 0;
  while (n < count) {
    i = t.indexOf(needle, i);
    if (i < 0) break;
    console.log('=== ' + label + ' @' + i + ' ===');
    console.log(t.slice(Math.max(0, i - before), i + after).replace(/\n/g, ' '));
    console.log();
    i += needle.length; n += 1;
  }
}

show('/directories 响应消费', 'if(n.success&&n.directories)', 200, 900, 1);
show('/search 结果消费', 'r.success&&r.results', 600, 700, 1);
show('index-progress 消费', '/index-progress', 200, 700, 1);
show('search 结果渲染', 'indexed_folder', 500, 600, 2);
