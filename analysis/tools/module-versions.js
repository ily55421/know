// Inventory exact dependency versions bundled in the asar
const fs = require('fs');
const path = require('path');
const ROOT = 'E:/data/Knowly/analysis/extracted/node_modules';

const mods = new Map();
function readPkg(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}
for (const name of fs.readdirSync(ROOT)) {
  const dir = path.join(ROOT, name);
  if (!fs.statSync(dir).isDirectory()) continue;
  if (name.startsWith('@')) {
    for (const sub of fs.readdirSync(dir)) {
      const d2 = path.join(dir, sub);
      if (!fs.statSync(d2).isDirectory()) continue;
      const pkg = readPkg(path.join(d2, 'package.json'));
      if (pkg) mods.set(name + '/' + sub, { version: pkg.version, description: (pkg.description || '').slice(0, 60) });
    }
  } else {
    const pkg = readPkg(path.join(dir, 'package.json'));
    if (pkg) mods.set(name, { version: pkg.version, description: (pkg.description || '').slice(0, 60) });
  }
}
const lines = [...mods.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  .map(([n, v]) => n + '\t' + v.version + '\t' + v.description);
fs.writeFileSync('E:/data/Knowly/analysis/bundled-node-modules.tsv', lines.join('\n'), 'utf8');
console.log('bundled modules:', mods.size);
// show the ones referenced by app package.json
const deps = ["@alicloud/mpserverless-node-sdk","@ant-design/icons","@uiw/react-md-editor","antd","axios","docx","echarts","electron-log","electron-store","electron-updater","express","i18next","katex","markdown-it","markdown-it-multimd-table","mermaid","mind-elixir","openai","qrcode.react","react-i18next","rehype-katex","remark-math"];
for (const d of deps) console.log(d.padEnd(32), mods.get(d)?.version || 'NOT-BUNDLED');
console.log('\nother notable:');
for (const [n, v] of mods) if (/^react$|^react-dom$|^jszip$|^mcp|^fastapi|^uvicorn/.test(n)) console.log(n, v.version);
