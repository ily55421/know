// 列出 asar 内 electron/src 文件
const asar = require('@electron/asar');
const files = asar.listPackage('resources/app.asar')
  .map((p) => p.replace(/\\/g, '/'))
  .filter((p) => p.startsWith('electron/src/'));
console.log('asar 内 electron/src 文件数:', files.length);
console.log(files.slice(0, 40).join('\n'));
