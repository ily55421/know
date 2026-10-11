const { autoUpdater } = require('electron-updater');
const { app, dialog } = require('electron');
const { log, isStoreVersion } = require('./config');

const STORE_UPDATE_MESSAGE = 'Microsoft Store 版本请通过 Microsoft Store 更新';
const { sendToRenderer } = require('./window-manager');

// 配置自动更新日志
autoUpdater.logger = log;
autoUpdater.logger.transports.file.level = 'info';

// 检查更新函数
function checkForUpdates(isManualCheck = false) {
  if (isStoreVersion) {
    log.info('Microsoft Store 版本跳过自更新检查');
    return Promise.reject(new Error(STORE_UPDATE_MESSAGE));
  }

  if (process.env.NODE_ENV === 'development') {
    log.info('开发环境下不检查更新');
    return Promise.reject(new Error('开发环境下不检查更新'));
  }

  log.info('检查更新...', isManualCheck ? '(用户主动检查)' : '(自动检查)');
  
  // 清除之前的监听器，避免重复注册
  autoUpdater.removeAllListeners();
  
  autoUpdater.on('checking-for-update', () => {
    log.info('正在检查更新...');
  });
  
  autoUpdater.on('update-available', (info) => {
    log.info('发现新版本:', info);
    
    // 创建可序列化的信息对象
    const serializableInfo = {
      version: info.version,
      files: info.files ? info.files.map(file => ({
        url: file.url,
        sha512: file.sha512,
        size: file.size
      })) : [],
      path: info.path,
      sha512: info.sha512,
      releaseDate: info.releaseDate,
      releaseName: info.releaseName,
      releaseNotes: info.releaseNotes,
      isManualCheck
    };
    
    sendToRenderer('update-available', serializableInfo);
    log.info('开始静默下载更新...');
  });
  
  autoUpdater.on('update-not-available', (info) => {
    log.info('当前已是最新版本');
    if (isManualCheck) {
      // 创建可序列化的信息对象
      const serializableInfo = {
        version: info.version || app.getVersion(),
        releaseDate: info.releaseDate,
        releaseName: info.releaseName
      };
      sendToRenderer('update-not-available', serializableInfo);
    }
  });
  
  autoUpdater.on('error', (err) => {
    log.error('更新错误:', err);
    // 只在手动检查时通知前端，避免自动检查失败干扰用户
    if (isManualCheck) {
      const errorInfo = {
        message: err.message || '更新过程中出现错误',
        stack: err.stack,
        code: err.code
      };
      sendToRenderer('update-error', errorInfo);
    }
  });
  
  autoUpdater.on('download-progress', (progressObj) => {
    let logMsg = `下载速度: ${progressObj.bytesPerSecond} - 已下载 ${progressObj.percent}% (${progressObj.transferred}/${progressObj.total})`;
    log.info(logMsg);
    // 只在手动检查时发送下载进度
    if (isManualCheck) {
      // 创建可序列化的进度对象
      const serializableProgress = {
        bytesPerSecond: progressObj.bytesPerSecond,
        percent: progressObj.percent,
        transferred: progressObj.transferred,
        total: progressObj.total
      };
      sendToRenderer('download-progress', serializableProgress);
    }
  });
  
  autoUpdater.on('update-downloaded', (info) => {
    log.info('更新已下载:', info);
    // 创建可序列化的信息对象
    const serializableInfo = {
      version: info.version,
      files: info.files ? info.files.map(file => ({
        url: file.url,
        sha512: file.sha512,
        size: file.size
      })) : [],
      path: info.path,
      sha512: info.sha512,
      releaseDate: info.releaseDate,
      releaseName: info.releaseName,
      releaseNotes: info.releaseNotes,
      isManualCheck
    };
    sendToRenderer('update-downloaded', serializableInfo);
    log.info('更新已就绪，等待用户选择安装时机');
  });
  
  // 开始检查更新，返回可序列化的结果
  return autoUpdater.checkForUpdatesAndNotify()
    .then(result => {
      // 如果有结果，确保返回可序列化的对象
      if (result && result.updateInfo) {
        return {
          updateInfo: {
            version: result.updateInfo.version,
            releaseDate: result.updateInfo.releaseDate,
            releaseName: result.updateInfo.releaseName,
            releaseNotes: result.updateInfo.releaseNotes
          },
          downloadPromise: result.downloadPromise ? 'pending' : null,
          cancellationToken: result.cancellationToken ? 'available' : null
        };
      }
      return { success: true, message: '检查更新完成' };
    })
    .catch(err => {
      log.error('自动更新检查失败:', err);
      // 返回可序列化的错误对象
      const serializableError = new Error(err.message || '更新检查失败');
      serializableError.code = err.code;
      throw serializableError;
    });
}

// 手动触发安装更新
function installUpdate() {
  if (isStoreVersion) {
    return Promise.reject(new Error(STORE_UPDATE_MESSAGE));
  }

  log.info('用户选择安装更新');
  
  // 设置退出标志，确保应用能够正常退出
  app.isQuitting = true;
  
  // 销毁托盘图标，防止托盘阻止应用退出
  const { destroyTray } = require('./tray-manager');
  destroyTray();
  
  // 静默安装更新（沿用已有安装目录，不弹安装向导），安装完成后自动重启
  autoUpdater.quitAndInstall(true, true);
}

// 初始化自动更新
function initAutoUpdater() {
  if (isStoreVersion) {
    log.info('Microsoft Store 版本不启用自更新');
    return;
  }

  // 在应用就绪后自动检查更新
  if (app.isPackaged) {
    checkForUpdates(false).catch(err => {
      log.error('初始更新检查失败:', err);
    });
  }
}

module.exports = {
  checkForUpdates,
  initAutoUpdater,
  installUpdate,
  isStoreVersion,
}; 