const { app, dialog, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const { log, appState, API_BASE_URL } = require('./config');
const { createMainWindowOnStartup, presentMainWindow, sendToRendererWhenReady } = require('./window-manager');
const { startPythonServer, stopPythonServer, isPythonServerRunning } = require('./python-server');
const { createTray } = require('./tray-manager');
const { checkAndUploadStatistics, stopStatisticsUploadScheduler, startQuotaSyncScheduler, stopQuotaSyncScheduler } = require('./cloud-services');
const { startDefaultSkillsSync } = require('./default-skills-sync');
const { startSoftwareDefaultLlmModelsSync } = require('./llm-models-sync');
const { startProxyServer, stopProxyServer } = require('./api-proxy-handler');
const { registerFindmeLocalImageProtocol } = require('./local-image-protocol');

let schedulerNotificationTimer = null;
let quitConfirmed = false;
let cleanupDone = false;

function focusWindowAndOpenSession(payload) {
  presentMainWindow('notification-click');
  sendToRendererWhenReady('open-chat-session', payload);
}

function notifyRendererSchedulerTaskFinished(payload) {
  sendToRendererWhenReady('scheduler-task-finished', payload);
}

async function consumeSessionNotifications(endpoint, fallbackTitle, fallbackBody) {
  const response = await fetch(`${API_BASE_URL}${endpoint}`);
  const result = await response.json();
  if (!result?.success || !Array.isArray(result.data)) return;

  result.data.forEach((item) => {
    if (!item?.sessionId) return;

    const payload = { sessionId: item.sessionId, taskId: item.taskId || item.jobId };
    notifyRendererSchedulerTaskFinished(payload);

    if (Notification.isSupported()) {
      const notification = new Notification({
        title: item.title || fallbackTitle,
        body: item.body || fallbackBody,
      });
      notification.on('click', () => {
        focusWindowAndOpenSession(payload);
      });
      notification.show();
    }
  });
}

function startSchedulerNotificationPolling() {
  if (schedulerNotificationTimer) return;

  const poll = async () => {
    if (!isPythonServerRunning()) return;

    try {
      await consumeSessionNotifications(
        '/scheduler/notifications?limit=10',
        '定时任务',
        '定时任务已完成',
      );
    } catch (error) {
      log.debug(`轮询定时任务通知失败: ${error.message}`);
    }

    try {
      await consumeSessionNotifications(
        '/remote-control/notifications?limit=10',
        '手机远程',
        '远程任务已完成',
      );
    } catch (error) {
      log.debug(`轮询远程控制通知失败: ${error.message}`);
    }
  };

  schedulerNotificationTimer = setInterval(poll, 15000);
  setTimeout(poll, 3000);
}

function stopSchedulerNotificationPolling() {
  if (schedulerNotificationTimer) {
    clearInterval(schedulerNotificationTimer);
    schedulerNotificationTimer = null;
  }
}

async function hasEnabledSchedulerTasks() {
  try {
    if (!isPythonServerRunning()) return false;
    const response = await fetch(`${API_BASE_URL}/scheduler/enabled-count`);
    const result = await response.json();
    return Boolean(result?.success && result.data?.count > 0);
  } catch (error) {
    log.warn(`检测启用定时任务失败，按无任务处理: ${error.message}`);
    return false;
  }
}

// 应用就绪时的处理
async function handleAppReady() {
  try {
    const appStartTime = Date.now();
    log.info(`[${new Date().toISOString()}] 应用启动开始...`);

    registerFindmeLocalImageProtocol();

    // 禁用同源策略
    app.commandLine.appendSwitch('disable-web-security');
    app.commandLine.appendSwitch('disable-features', 'OutOfBlinkCors');
    app.commandLine.appendSwitch('disable-site-isolation-trials');

    // 在macOS上设置应用不在dock中显示时保持运行
    if (process.platform === 'darwin') {
      try {
        const iconPath = path.join(__dirname, '..', '..', 'public', 'app.png');
        if (fs.existsSync(iconPath)) {
          app.dock.setIcon(iconPath);
          log.info(`[${new Date().toISOString()}] 设置了Dock图标: ${iconPath}`);
        } else {
          log.warn(`[${new Date().toISOString()}] Dock图标文件不存在: ${iconPath}`);
        }
      } catch (error) {
        log.error(`[${new Date().toISOString()}] 设置Dock图标失败: ${error.message}`);
      }
    }

    // 创建托盘图标
    try {
      const tray = createTray();
      if (!tray) {
        log.warn(`[${new Date().toISOString()}] 创建托盘图标失败，将继续启动应用`);
      }
    } catch (trayError) {
      log.error(`[${new Date().toISOString()}] 创建托盘时出错: ${trayError.message}`);
    }

    // 启动 API 代理服务器（在 Python 之前启动）
    try {
      log.info(`[${new Date().toISOString()}] 启动 API 代理服务器...`);
      await startProxyServer();
      const elapsedAfterProxy = ((Date.now() - appStartTime) / 1000).toFixed(2);
      log.info(`[${new Date().toISOString()}] [+${elapsedAfterProxy}s] API 代理服务器已启动`);
    } catch (error) {
      log.error(`[${new Date().toISOString()}] API 代理服务器启动失败: ${error.message}`);
      // API 代理服务器启动失败不阻止应用启动，但会记录警告
      log.warn('API 代理服务未启动，外部 API 调用可能失败');
    }

    // 启动Python后端
    await handlePythonServerStart(appStartTime);

    // 最后创建窗口，确保所有后端服务都已就绪
    log.info(`[${new Date().toISOString()}] 创建主窗口...`);
    createMainWindowOnStartup();
    const elapsedAfterCreateWindow = ((Date.now() - appStartTime) / 1000).toFixed(2);
    log.info(`[${new Date().toISOString()}] [+${elapsedAfterCreateWindow}s] 主窗口已创建`);
  } catch (error) {
    log.error(`[${new Date().toISOString()}] 应用启动过程中出现意外错误:`, error);
    dialog.showErrorBox('启动失败', `应用启动过程中出现意外错误: ${error.message}`);
    app.quit();
    return;
  }


  // [重建版适配] 遥测门（默认关闭）：统计上报/配额同步/云端技能与模型同步/自动更新
  // 均指向原厂云端（EMAS bspapp.com、OSS 更新源）。重建版默认不外呼任何云服务；
  // 如需恢复原版云端行为，设置环境变量 KNOWLY_ENABLE_TELEMETRY=1。
  // 说明：统计与公告在未打包环境本就被原代码跳过；RUM 前端监控由渲染层 isDevMode 守卫跳过；
  // 自动更新器有 isPackaged 守卫（且其更新源会以原版安装包覆盖重建版，必须保持关闭）。
  const telemetryEnabled = process.env.KNOWLY_ENABLE_TELEMETRY === '1';
  if (telemetryEnabled) {
    // 上传用户统计数据
    checkAndUploadStatistics();
    // 同步配额快照到云端（启动同步一次 + 每小时定时）
    startQuotaSyncScheduler();
    // 冷启动后延迟同步云端默认技能（内网失败静默跳过，不阻塞启动）
    startDefaultSkillsSync();
    // 冷启动后延迟同步云端软件默认模型列表（成功则立即刷新 UI）
    startSoftwareDefaultLlmModelsSync();
  } else {
    log.info('[重建版适配] 遥测/云同步已按默认策略关闭（KNOWLY_ENABLE_TELEMETRY=1 可开启）');
  }
  startSchedulerNotificationPolling();

  // 延迟初始化自动更新，避免干扰窗口加载
  // [重建版适配] 更新器也归入遥测门：其更新源是原厂 OSS，便携重建版绝不检查/安装原厂更新
  if (telemetryEnabled) {
    setTimeout(() => {
      try {
        const { initAutoUpdater } = require('./auto-updater');
        initAutoUpdater();
        log.info(`[${new Date().toISOString()}] 自动更新已初始化`);
      } catch (error) {
        log.error(`[${new Date().toISOString()}] 初始化自动更新失败: ${error.message}`);
      }
    }, 5000);
  }
}

// 处理Python服务器启动
async function handlePythonServerStart(appStartTime) {
  let startPythonSuccess = true;
  try {
    log.info(`[${new Date().toISOString()}] 开始启动Python后端...`);
    const pythonStartTime = Date.now();
    const serverUrl = await startPythonServer();
    const elapsedPythonStart = ((Date.now() - pythonStartTime) / 1000).toFixed(2);
    log.info(`[${new Date().toISOString()}] [+${elapsedPythonStart}s] Python后端启动完成: ${serverUrl}`);

    // 更新应用状态
    appState.pythonServerRunning = true;
    appState.serverUrl = serverUrl;

    // 通知渲染进程Python服务器已启动
    sendToRendererWhenReady('python-ready', serverUrl);
  } catch (error) {
    log.error(`[${new Date().toISOString()}] 应用启动失败:`, error);
    appState.pythonServerRunning = false;
    startPythonSuccess = false;

    // 显示启动失败对话框并允许重试
    startPythonSuccess = await handlePythonStartupError(error);
  }

  return startPythonSuccess;
}

// 处理Python启动错误
async function handlePythonStartupError(error) {
  const startupResult = await dialog.showMessageBox({
    type: 'error',
    title: 'Python服务启动失败',
    message: '启动Python服务失败',
    detail: `错误信息: ${error.message}\n\n应用需要Python服务才能正常工作。`,
    buttons: ['重试', '退出应用'],
    defaultId: 0
  });

  if (startupResult.response === 0) {
    // 用户选择重试
    log.info('用户选择重试启动Python服务');

    try {
      const serverUrl = await startPythonServer();
      appState.pythonServerRunning = true;
      appState.serverUrl = serverUrl;
      sendToRendererWhenReady('python-ready', serverUrl);
      log.info(`重试启动Python服务成功: ${serverUrl}`);
      return true;
    } catch (retryError) {
      log.error(`重试启动Python服务失败:`, retryError);
      return await handleFinalRetry(retryError);
    }
  } else {
    log.info('用户选择退出应用');
    app.quit();
    return false;
  }
}

// 处理最终重试
async function handleFinalRetry(retryError) {
  const retryResult = await dialog.showMessageBox({
    type: 'error',
    title: '重试失败',
    message: '重试启动Python服务仍然失败',
    detail: `错误信息: ${retryError.message}\n\n是否继续尝试?`,
    buttons: ['再次重试', '退出应用'],
    defaultId: 0
  });

  if (retryResult.response === 0) {
    try {
      const serverUrl = await startPythonServer();
      appState.pythonServerRunning = true;
      appState.serverUrl = serverUrl;
      sendToRendererWhenReady('python-ready', serverUrl);
      log.info(`再次重试启动Python服务成功: ${serverUrl}`);
      return true;
    } catch (finalError) {
      log.error(`最终启动Python服务失败:`, finalError);
      dialog.showErrorBox(
        '无法启动应用',
        `多次尝试启动Python服务均失败，应用将退出。\n\n错误信息: ${finalError.message}`
      );
      app.quit();
      return false;
    }
  } else {
    log.info('用户选择退出应用');
    app.quit();
    return false;
  }
}

// 应用激活时的处理（macOS特有）
async function handleAppActivate() {
  presentMainWindow('app-activate');

  // 检查Python服务器状态，如果未运行则尝试启动
  // 注意：窗口只是隐藏再显示，Python服务一直在运行，不需要重复发送ready事件
  if (!isPythonServerRunning()) {
    log.info(`[${new Date().toISOString()}] Python服务器未运行，尝试启动`);
    try {
      const url = await startPythonServer();
      appState.pythonServerRunning = true;
      appState.serverUrl = url;
      sendToRendererWhenReady('python-ready', url);
    } catch (error) {
      log.error(`[${new Date().toISOString()}] 启动Python服务器失败:`, error);
      sendToRendererWhenReady('python-error', `启动Python服务器失败: ${error.message}`);
    }
  } else {
    log.debug(`[${new Date().toISOString()}] 窗口激活，Python服务器已在运行`);
    // Python服务一直在运行，前端已经初始化过了，不需要重复发送ready事件
  }
}

function cleanupBeforeQuit() {
  if (cleanupDone) return;
  cleanupDone = true;
  app.isQuitting = true;
  appState.pythonServerRunning = false;
  stopSchedulerNotificationPolling();
  stopStatisticsUploadScheduler();
  stopQuotaSyncScheduler();
  stopPythonServer();

  // 停止 API 代理服务器
  stopProxyServer();

  // 销毁托盘图标，确保应用能够正常退出
  const { destroyTray } = require('./tray-manager');
  destroyTray();
}

// 应用退出前的清理
async function handleAppBeforeQuit(event) {
  if (quitConfirmed) {
    cleanupBeforeQuit();
    return;
  }

  event.preventDefault();
  app.isQuitting = false;

  const shouldWarn = await hasEnabledSchedulerTasks();
  if (shouldWarn) {
    const result = await dialog.showMessageBox({
      type: 'warning',
      title: '退出提醒',
      message: '退出后定时任务将不会执行',
      detail: '关闭窗口会收进托盘并继续运行；完全退出应用后，启用中的定时任务会跳过，直到下次打开应用。',
      buttons: ['取消退出', '仍然退出'],
      defaultId: 0,
      cancelId: 0,
    });
    if (result.response !== 1) {
      return;
    }
  }

  quitConfirmed = true;
  cleanupBeforeQuit();
  app.quit();
}

// 所有窗口关闭时的处理
function handleWindowAllClosed() {
  if (process.platform !== 'darwin') {
    app.quit();
  }
}

module.exports = {
  handleAppReady,
  handleAppActivate,
  handleAppBeforeQuit,
  handleWindowAllClosed
};
