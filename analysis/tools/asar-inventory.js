// REA Stage 1: ASAR inventory + selective extraction (app-owned files only)
const asar = require('@electron/asar');
const fs = require('fs');
const path = require('path');

const ASAR = 'E:/soft/Knowly/resources/app.asar';
const OUT_ROOT = 'E:/data/Knowly/analysis/extracted';
const INVENTORY = 'E:/data/Knowly/analysis/asar-inventory.txt';
const APP_FILES = 'E:/data/Knowly/analysis/asar-app-files.txt';

const rawListing = asar.listPackage(ASAR);
const listing = rawListing.map((p) => p.replace(/\\/g, '/'));
fs.writeFileSync(INVENTORY, listing.join('\n'), 'utf8');

// top-level distribution
const topLevel = {};
for (const p of listing) {
  const top = p.replace(/^\//, '').split('/')[0];
  topLevel[top] = (topLevel[top] || 0) + 1;
}
console.log('total entries:', listing.length);
console.log('top-level:', JSON.stringify(topLevel, null, 2));

// app-owned = everything not under node_modules/ (raw separator form is required for extractFile)
const isNodeModules = (raw) => /^\\?node_modules(\\|$)/.test(raw) || /^\/?node_modules(\/|$)/.test(raw);
const appOwned = rawListing.filter((raw) => !isNodeModules(raw));
fs.writeFileSync(APP_FILES, appOwned.map((p) => p.replace(/\\/g, '/')).join('\n'), 'utf8');
console.log('app-owned entries:', appOwned.length);

// extract app-owned files
let extracted = 0, failed = [];
for (const raw of appOwned) {
  const relPath = raw.replace(/^\//, '').replace(/\\/g, '/');
  const dest = path.join(OUT_ROOT, relPath);
  try {
    const buf = asar.extractFile(ASAR, raw);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, buf);
    extracted++;
  } catch (e) {
    try {
      const st = asar.statFile(ASAR, raw);
      if (!st.isFile && !st.size) continue; // directory entry
    } catch (_) {}
    failed.push(relPath + ' :: ' + e.message);
  }
}
console.log('extracted files:', extracted);
if (failed.length) console.log('failed (' + failed.length + '):', failed.slice(0, 10).join('\n'));
