const fs = require('fs');
const s = fs.readFileSync('electron/dist/bundle.js', 'utf8');
const start = 6866000;
const end = 6870500;
console.log(s.slice(start, end));
