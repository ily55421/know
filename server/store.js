'use strict';

/**
 * 后端持久化（JSON 文件）。
 * 数据根目录沿用原版开发模式约定：`<项目>/vector_store/data`（见 electron/src/device-id.js 的
 * getSharedDataRoot()：未打包时数据根 = app.getAppPath() + '/vector_store'）。
 * 原版为 Python 服务内部存储，此处以等价 JSON 文件承载，字段名尽量对齐原版接口。
 */

const fs = require('node:fs');
const path = require('node:path');

const PROJECT_ROOT = path.resolve(__dirname, '..');
// [重建版适配] 默认持久区与 Electron 主进程对齐：%APPDATA%/KnowlyRecon/backend-data
// （config.js 会以 KNOWLY_DATA_ROOT 传同值给后端子进程；此处兜底覆盖独立运行 npm run server 的场景）。
// 旧版把数据放在项目内 vector_store/data，首次运行会自动迁移（见 migrateLegacyData）。
const APP_DATA_ROOT = process.env.APPDATA
  ? path.join(process.env.APPDATA, 'KnowlyRecon')
  : path.join(require('node:os').homedir(), '.knowly-recon');
const LEGACY_DATA_ROOT = path.join(PROJECT_ROOT, 'vector_store', 'data');

const caches = new Map();

// 惰性解析：测试可在 require 之后再注入 KNOWLY_DATA_ROOT
function dataRootPath() {
  return process.env.KNOWLY_DATA_ROOT ? path.resolve(process.env.KNOWLY_DATA_ROOT) : path.join(APP_DATA_ROOT, 'backend-data');
}

/** 一次性迁移：把旧的项目内 vector_store/data 下的 JSON 拷贝到新持久区（不覆盖新数据）。 */
function migrateLegacyData() {
  try {
    if (!fs.existsSync(LEGACY_DATA_ROOT)) return;
    const root = dataRootPath();
    fs.mkdirSync(root, { recursive: true });
    let moved = 0;
    for (const name of fs.readdirSync(LEGACY_DATA_ROOT)) {
      if (!name.endsWith('.json')) continue; // device_id 等非 JSON 不迁（由 device-id 机制自管）
      const src = path.join(LEGACY_DATA_ROOT, name);
      const dest = path.join(root, name);
      if (!fs.existsSync(dest)) {
        fs.copyFileSync(src, dest);
        moved += 1;
      }
    }
    if (moved > 0) console.log(`INFO:     已从旧数据目录迁移 ${moved} 个文件到持久区: ${root}`);
  } catch (error) {
    console.error('ERROR:    旧数据迁移失败（不影响启动）:', error.message);
  }
}

function filePath(name) {
  return path.join(dataRootPath(), name.endsWith('.json') ? name : `${name}.json`);
}

function load(name, fallback) {
  const key = filePath(name);
  if (caches.has(key)) return caches.get(key);
  let value = fallback;
  try {
    value = JSON.parse(fs.readFileSync(key, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.error(`[store] 读取 ${key} 失败: ${error.message}`);
    }
  }
  caches.set(key, value);
  return value;
}

function save(name, value) {
  const target = filePath(name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, target);
  caches.set(target, value);
  return value;
}

function update(name, fallback, mutate) {
  const current = load(name, fallback);
  const next = mutate(current);
  save(name, next ?? current);
  return next ?? current;
}

function dataRoot() {
  migrateLegacyData();
  fs.mkdirSync(dataRootPath(), { recursive: true });
  return dataRootPath();
}

module.exports = { dataRoot, load, save, update, filePath, dataRootPath };
