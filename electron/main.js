const { app } = require('electron');
const path = require('path');
const { registerFindmeLocalPrivilegedScheme } = require('./src/local-image-protocol');

// [重建版适配] userData 隔离：重建版使用 %APPDATA%/KnowlyRecon，
// 避免与已安装的原版 Knowly（%APPDATA%/Knowly）争用单实例锁与 electron-store。
// 必须在 requestSingleInstanceLock() 与 electron-store 初始化之前执行。
// 原版历史 deviceId 迁移行为不受影响（device-id.js 会显式扫描 Roaming/Knowly 的历史配置）。
if (process.env.KNOWLY_USER_DATA) {
  app.setPath('userData', process.env.KNOWLY_USER_DATA);
} else {
  app.setPath('userData', path.join(app.getPath('appData'), 'KnowlyRecon'));
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