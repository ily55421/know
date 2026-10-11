const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const { registerFindmeLocalPrivilegedScheme } = require('./src/local-image-protocol');

// [重建版适配] 便携化数据根：打包版（免安装 exe）一切数据落在 exe 所在目录的 data/ 下，
// 随目录整体移动；开发版仍用 %APPDATA%/KnowlyRecon。环境变量可显式覆盖。
// 必须在 requestSingleInstanceLock() 与 electron-store 初始化之前执行。
let portableRoot = null;
if (process.env.KNOWLY_USER_DATA) {
  app.setPath('userData', process.env.KNOWLY_USER_DATA);
} else if (app.isPackaged) {
  // electron-builder portable 会注入 PORTABLE_EXECUTABLE_DIR；其它打包形态回退 exe 所在目录
  portableRoot = process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(app.getPath('exe'));
  const dataRoot = path.join(portableRoot, 'data');
  app.setPath('userData', path.join(dataRoot, 'user-data'));
  fs.mkdirSync(path.join(dataRoot, 'user-data'), { recursive: true });
  // 后端数据根（server/store.js 与 device-id.js 经环境变量消费）
  process.env.KNOWLY_DATA_ROOT = process.env.KNOWLY_DATA_ROOT || path.join(dataRoot, 'backend');
  process.env.KNOWLY_SHARED_DATA_ROOT = process.env.KNOWLY_SHARED_DATA_ROOT || dataRoot;
} else {
  app.setPath('userData', path.join(app.getPath('appData'), 'KnowlyRecon'));
}

// [重建版适配] 首次便携化迁移：把开发期留在 %APPDATA%/KnowlyRecon/backend 的数据
// 搬到便携数据根（仅当便携 backend 目录为空时执行一次）。
if (app.isPackaged && process.env.KNOWLY_DATA_ROOT) {
  try {
    const legacy = path.join(app.getPath('appData'), 'KnowlyRecon', 'backend');
    const target = process.env.KNOWLY_DATA_ROOT;
    if (fs.existsSync(legacy) && !fs.existsSync(target)) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.cpSync(legacy, target, { recursive: true });
      console.log('[重建版适配] 已迁移历史数据到便携数据根:', target);
    }
  } catch (e) {
    console.warn('[重建版适配] 历史数据迁移失败（不影响启动）:', e.message);
  }
}

// 自定义协议须在 app.ready 之前注册为 privileged，否则 http(s) 页面内 img 请求可能被拦
registerFindmeLocalPrivilegedScheme();

// 导入各个功能模块
require('./src/config'); // 初始化配置和日志
const { appendLocalNoProxy } = require('./src/no-proxy-local');
Object.assign(process.env, appendLocalNoProxy());
require('./src/ipc-handlers'); // 注册IPC处理器
const { 
  handleAppReady, 
  handleAppActivate, 
  handleAppBeforeQuit, 
  handleWindowAllClosed 
} = require('./src/app-lifecycle');
const { presentMainWindow } = require('./src/window-manager');

// 单实例锁定：确保只有一个应用实例在运行
// 必须在 app.whenReady() 之前调用
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  // 如果已经有实例在运行，退出当前实例
  // 不注册任何事件监听器，直接退出
  app.quit();
  process.exit(0);
} else {
  // 监听第二个实例启动事件
  // 当用户尝试打开第二个实例时，会触发此事件
  app.on('second-instance', () => {
    // 用户再次点击桌面图标：把已有界面拉到前台，而不是重新启动一遍
    presentMainWindow('second-instance');
  });

  // 应用准备就绪时创建窗口
  app.whenReady().then(handleAppReady);

  // 关闭所有窗口时退出应用（在macOS上除外）
  app.on('window-all-closed', handleWindowAllClosed);

  // macOS应用激活事件
  app.on('activate', handleAppActivate);

  // 应用退出前清理资源
  app.on('before-quit', handleAppBeforeQuit);
} 