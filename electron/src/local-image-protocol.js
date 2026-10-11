/**
 * 对话区 Markdown 本地图片：通过自定义协议由浏览器直接请求 URL，
 * 主进程映射到本地文件（不走 base64 内联）。
 */
const { protocol } = require('electron');
const path = require('path');
const fs = require('fs');
const { log } = require('./config');

const ALLOWED_IMAGE_EXT = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.gif',
  '.bmp',
  '.tif',
  '.tiff',
  '.ico',
  '.svg',
]);

/** 防止协议被滥用读超大文件 */
const MAX_FILE_BYTES = 80 * 1024 * 1024;

/**
 * 必须在 app.ready 之前调用
 */
function registerFindmeLocalPrivilegedScheme() {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'findme-local',
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        bypassCSP: true,
      },
    },
  ]);
}

/**
 * URL：findme-local://x/<base64url(utf8 绝对路径)>
 * host 固定为 x，路径段为无 padding 的 base64url
 */
function registerFindmeLocalImageProtocol() {
  protocol.registerFileProtocol('findme-local', (request, callback) => {
    try {
      const parsed = new URL(request.url);
      const b64 = (parsed.pathname || '').replace(/^\//, '');
      if (!b64) {
        callback({ error: -6 });
        return;
      }
      let filePath;
      try {
        filePath = Buffer.from(b64, 'base64url').toString('utf8');
      } catch {
        callback({ error: -6 });
        return;
      }
      const normalized = path.normalize(filePath.trim());
      if (!fs.existsSync(normalized)) {
        callback({ error: -6 });
        return;
      }
      const stat = fs.statSync(normalized);
      if (!stat.isFile()) {
        callback({ error: -6 });
        return;
      }
      if (stat.size > MAX_FILE_BYTES) {
        callback({ error: -6 });
        return;
      }
      const ext = path.extname(normalized).toLowerCase();
      if (!ALLOWED_IMAGE_EXT.has(ext)) {
        callback({ error: -6 });
        return;
      }
      callback({ path: normalized });
    } catch (e) {
      log.error('findme-local 协议处理失败:', e);
      callback({ error: -2 });
    }
  });
}

module.exports = {
  registerFindmeLocalPrivilegedScheme,
  registerFindmeLocalImageProtocol,
};
