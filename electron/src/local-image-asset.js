/**
 * 本地图片资源：复制到 userData 子目录、electron-store 存相对路径、返回 findme-local URL。
 * 皮肤 / 小红书卡片背景 / 后续公众号背景等共用此工厂，避免再复制一套。
 */
const { dialog, app } = require('electron');
const fs = require('fs');
const path = require('path');
const { store, log } = require('./config');
const { getMainWindow } = require('./window-manager');

const DEFAULT_ALLOWED_EXT = ['.png', '.jpg', '.jpeg', '.webp'];
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;

function toFindmeLocalUrl(filePath, cacheBustToken) {
  const base64url = Buffer.from(filePath, 'utf8').toString('base64url');
  return `findme-local://x/${base64url}?v=${cacheBustToken}`;
}

/**
 * @param {object} options
 * @param {string} options.storeKey electron-store 键
 * @param {string} options.fileStem 文件名前缀，如 wallpaper → wallpaper.jpg
 * @param {string} options.dialogTitle 选图对话框标题
 * @param {string} options.logName 日志用中文名，如「皮肤」
 * @param {string} [options.subDir='skins'] 相对 userData 的子目录
 * @param {string[]} [options.allowedExt]
 * @param {number} [options.maxBytes]
 */
function createLocalImageAsset(options) {
  const storeKey = options.storeKey;
  const fileStem = options.fileStem;
  const dialogTitle = options.dialogTitle;
  const logName = options.logName || fileStem;
  const subDir = options.subDir || 'skins';
  const allowedExt = new Set(options.allowedExt || DEFAULT_ALLOWED_EXT);
  const maxBytes = options.maxBytes || DEFAULT_MAX_BYTES;
  const filePrefix = `${fileStem}.`;

  function getAssetDir() {
    const dir = path.join(app.getPath('userData'), subDir);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  function resolveStoredPath(relativePath) {
    if (!relativePath || typeof relativePath !== 'string') return null;
    const assetDir = path.resolve(getAssetDir());
    const abs = path.resolve(app.getPath('userData'), relativePath);
    const rel = path.relative(assetDir, abs);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
    return abs;
  }

  function clearAssetFiles() {
    const dir = getAssetDir();
    let entries = [];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (!name.startsWith(filePrefix)) continue;
      try {
        fs.unlinkSync(path.join(dir, name));
      } catch (error) {
        log.warn(`清除${logName}文件失败:`, error);
      }
    }
  }

  function get() {
    try {
      const relativePath = store.get(storeKey);
      const abs = resolveStoredPath(relativePath);
      if (!abs || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
        if (relativePath) store.delete(storeKey);
        return { success: true, url: null };
      }
      const stat = fs.statSync(abs);
      return { success: true, url: toFindmeLocalUrl(abs, Math.round(stat.mtimeMs)) };
    } catch (error) {
      log.error(`读取${logName}失败:`, error);
      return { success: false, code: 'io_error' };
    }
  }

  async function set() {
    const mainWindow = getMainWindow();
    try {
      const result = await dialog.showOpenDialog(mainWindow, {
        title: dialogTitle,
        properties: ['openFile'],
        filters: [
          { name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp'] },
          { name: '所有文件', extensions: ['*'] },
        ],
      });
      if (result.canceled || !result.filePaths.length) {
        return { success: true, canceled: true, ...get() };
      }

      const src = result.filePaths[0];
      const ext = path.extname(src).toLowerCase();
      if (!allowedExt.has(ext)) {
        return { success: false, code: 'invalid_type' };
      }
      if (!fs.existsSync(src) || !fs.statSync(src).isFile()) {
        return { success: false, code: 'io_error' };
      }
      if (fs.statSync(src).size > maxBytes) {
        return { success: false, code: 'too_large' };
      }

      clearAssetFiles();
      const destName = `${fileStem}${ext}`;
      const dest = path.join(getAssetDir(), destName);
      fs.copyFileSync(src, dest);
      store.set(storeKey, path.join(subDir, destName));
      return get();
    } catch (error) {
      log.error(`设置${logName}失败:`, error);
      return { success: false, code: 'io_error' };
    }
  }

  function clear() {
    try {
      clearAssetFiles();
      store.delete(storeKey);
      return { success: true, url: null };
    } catch (error) {
      log.error(`清除${logName}失败:`, error);
      return { success: false, code: 'io_error' };
    }
  }

  return { get, set, clear };
}

module.exports = {
  createLocalImageAsset,
  toFindmeLocalUrl,
};
