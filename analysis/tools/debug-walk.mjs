import { readFilesystemSync } from 'file:///E:/data/Knowly/analysis/tools/node_modules/@electron/asar/lib/filesystem.js';
import path from 'node:path';

const fsAPI = readFilesystemSync('E:/soft/Knowly/resources/app.asar');
const p = 'electron/dist/0.bundle.js';
console.log('dirname:', JSON.stringify(path.dirname(p)));
console.log('basename:', JSON.stringify(path.basename(p)));
const node = fsAPI.searchNodeFromDirectory(path.dirname(p));
console.log('walked node children:', Object.keys(node.files || {}).slice(0, 5));
console.log('direct header walk:', Object.keys(fsAPI.header.files.electron.files.src.files).length, 'src files');
console.log('basename lookup:', node.files ? Object.keys(node.files).length + ' keys, has target: ' + ('0.bundle.js' in node.files) : 'no files');
