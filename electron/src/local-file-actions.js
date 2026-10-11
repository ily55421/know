const fs = require('fs');
const path = require('path');

/** 规范为绝对路径；非绝对路径则相对主进程 cwd 解析（与旧行为一致） */
function resolveLocalPath(rawPath) {
  if (rawPath == null || typeof rawPath !== 'string') return null;
  const trimmed = rawPath.trim();
  if (!trimmed) return null;
  const norm = path.normalize(trimmed);
  if (path.isAbsolute(norm)) return norm;
  return path.normalize(path.resolve(norm));
}

async function trashLocalItem(rawPath, trashItem) {
  const abs = resolveLocalPath(rawPath);
  if (!abs) {
    return { success: false, message: '路径无效' };
  }
  if (!fs.existsSync(abs)) {
    return { success: false, message: `文件不存在: ${abs}` };
  }
  await trashItem(abs);
  return { success: true };
}

module.exports = {
  resolveLocalPath,
  trashLocalItem,
};
