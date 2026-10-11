const fs = require('fs');
const os = require('os');
const path = require('path');
const { app } = require('electron');
const log = require('electron-log');

const DEVICE_ID_FILENAME = 'device_id';
const DATA_SUBDIR = 'data';
const STORE_PACKAGE_PREFIX = 'A693CA02.Knowly_';

function getSharedDataRoot() {
  // [重建版适配] 便携数据根优先（打包版由 main.js 注入 exe 所在目录的 data/）
  if (process.env.KNOWLY_SHARED_DATA_ROOT) {
    return process.env.KNOWLY_SHARED_DATA_ROOT;
  }
  if (!app.isPackaged) {
    return path.join(app.getAppPath(), 'vector_store');
  }
  if (process.platform === 'win32') {
    if (process.env.PUBLIC) {
      return path.join(process.env.PUBLIC, 'FindMe');
    }
    if (process.env.PROGRAMDATA) {
      return path.join(process.env.PROGRAMDATA, 'FindMe');
    }
    return path.join(os.homedir(), 'FindMe');
  }
  return path.join(os.homedir(), '.findmeapp');
}

function getSharedDeviceIdPath(dataRoot = getSharedDataRoot()) {
  return path.join(dataRoot, DATA_SUBDIR, DEVICE_ID_FILENAME);
}

function getLegacyDeviceIdPath(dataRoot = getSharedDataRoot()) {
  return path.join(dataRoot, DEVICE_ID_FILENAME);
}

function readTextDeviceId(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }
    const value = fs.readFileSync(filePath, 'utf8').trim();
    return value || null;
  } catch (error) {
    log.warn(`读取设备ID文件失败: ${filePath}, ${error.message}`);
    return null;
  }
}

function writeTextDeviceId(filePath, deviceId) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, `${deviceId}\n`, 'utf8');
  fs.renameSync(tmpPath, filePath);
}

function readDeviceIdFromElectronStoreFile(configPath) {
  try {
    if (!fs.existsSync(configPath)) {
      return null;
    }
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const deviceId = parsed && parsed.deviceId;
    return typeof deviceId === 'string' && deviceId.trim() ? deviceId.trim() : null;
  } catch (error) {
    log.warn(`读取历史 electron-store 设备ID失败: ${configPath}, ${error.message}`);
    return null;
  }
}

function collectHistoricalStorePaths() {
  const home = os.homedir();
  const paths = [];

  if (process.platform === 'win32') {
    const roaming = path.join(home, 'AppData', 'Roaming');
    for (const appName of ['Knowly', '找我呀', 'FindMe', 'findme']) {
      paths.push(path.join(roaming, appName, 'config.json'));
    }
    const packagesRoot = path.join(home, 'AppData', 'Local', 'Packages');
    try {
      if (fs.existsSync(packagesRoot)) {
        for (const name of fs.readdirSync(packagesRoot)) {
          if (!name.startsWith(STORE_PACKAGE_PREFIX) && !name.includes('Knowly')) {
            continue;
          }
          paths.push(
            path.join(packagesRoot, name, 'LocalCache', 'Roaming', 'Knowly', 'config.json'),
          );
          paths.push(
            path.join(packagesRoot, name, 'LocalCache', 'Roaming', '找我呀', 'config.json'),
          );
        }
      }
    } catch (error) {
      log.warn(`扫描商店版历史配置失败: ${error.message}`);
    }
  } else if (process.platform === 'darwin') {
    const appSupport = path.join(home, 'Library', 'Application Support');
    for (const appName of ['Knowly', '找我呀', 'FindMe']) {
      paths.push(path.join(appSupport, appName, 'config.json'));
    }
  }

  try {
    paths.push(path.join(app.getPath('userData'), 'config.json'));
  } catch {
    // app.ready 之前 getPath 可能失败，忽略
  }

  return paths;
}

function readDeviceIdFromStore(store) {
  const current = store && store.get('deviceId');
  if (typeof current === 'string' && current.trim()) {
    return current.trim();
  }
  for (const configPath of collectHistoricalStorePaths()) {
    const historical = readDeviceIdFromElectronStoreFile(configPath);
    if (historical) {
      return historical;
    }
  }
  return null;
}

function generateDeviceId() {
  return `device_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;
}

function persistDeviceId(store, deviceId) {
  if (store && store.get('deviceId') !== deviceId) {
    store.set('deviceId', deviceId);
  }
  const sharedPath = getSharedDeviceIdPath();
  if (readTextDeviceId(sharedPath) !== deviceId) {
    try {
      writeTextDeviceId(sharedPath, deviceId);
      log.info(`设备ID已写入数据目录: ${sharedPath}`);
    } catch (error) {
      log.error(`写入数据目录设备ID失败: ${error.message}`);
    }
  }
  const legacyPath = getLegacyDeviceIdPath();
  if (legacyPath !== sharedPath && fs.existsSync(legacyPath)) {
    try {
      fs.unlinkSync(legacyPath);
    } catch (error) {
      log.warn(`删除根目录旧 device_id 失败: ${error.message}`);
    }
  }
}

/**
 * Electron 侧获取设备 ID 的唯一入口。
 * 已有 data/device_id 则直接返回；没有则从 store 迁一次并写入文件。
 */
function resolveAndPersistDeviceId(store) {
  const existing = readTextDeviceId(getSharedDeviceIdPath());
  if (existing) {
    return existing;
  }

  const deviceId = readTextDeviceId(getLegacyDeviceIdPath())
    || readDeviceIdFromStore(store)
    || generateDeviceId();
  persistDeviceId(store, deviceId);
  return deviceId;
}

module.exports = {
  resolveAndPersistDeviceId,
  getSharedDataRoot,
};
