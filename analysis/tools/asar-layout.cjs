const asar = require('@electron/asar');
const files = asar.listPackage('resources/app.asar');
const top = new Map();
for (const f of files) {
  const p = f.replace(/^[\\/]/, '');
  const seg = p.split(/[\\/]/)[0];
  top.set(seg, (top.get(seg) || 0) + 1);
}
console.log('top-level entry : file count');
[...top.entries()].sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(String(v).padStart(7), k));
console.log('\ntotal files:', files.length);
// electron/dist contents
const dist = files.filter((f) => /electron[\\/]dist[\\/][^\\/]+$/.test(f));
console.log('\nelectron/dist direct children:');
dist.forEach((f) => console.log('  ', f));
// server contents
const srv = files.filter((f) => /[\\/]server[\\/]/.test(f));
console.log('\nserver files:', srv.length);
srv.slice(0, 40).forEach((f) => console.log('  ', f));
