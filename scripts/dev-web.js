'use strict';

/**
 * 开发模式静态服务：127.0.0.1:13099 → electron/dist。
 *
 * 原版开发流程里由 webpack devServer 提供该端口（window-manager.js 开发分支）；
 * 重建版没有前端构建链，改用静态服务直接托管随仓库交付的构建产物，
 * 使 electron/main.js 的开发分支原样可用（含 SPA 路由回退到 index.html）。
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

// [重建版适配] 端口迁移：默认 23099（原版 webpack devServer 为 13099），与 window-manager 开发分支对齐
const PORT = Number(process.env.WEB_PORT || process.env.KNOWLY_WEB_PORT) || 23099;
const DIST = path.resolve(__dirname, '..', 'electron', 'dist');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.eot': 'application/vnd.ms-fontobject',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
};

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  let rel = urlPath === '/' ? '/index.html' : urlPath;
  let file = path.join(DIST, rel);
  if (!file.startsWith(DIST)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    file = path.join(DIST, 'index.html'); // SPA 回退
  }
  const ext = path.extname(file).toLowerCase();
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Access-Control-Allow-Origin': '*',
  });
  fs.createReadStream(file).pipe(res);
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`[dev-web] 端口 ${PORT} 已被占用（原版开发服务可能在运行）`);
    process.exit(1);
  }
  console.error('[dev-web] 启动失败:', error);
  process.exit(1);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[dev-web] 渲染层静态服务已启动: http://127.0.0.1:${PORT} → ${DIST}`);
});
