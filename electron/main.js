const { app } = require('electron');
const path = require('path');
const fs = require('fs');
// [重建版适配] 注意：local-image-protocol 会 require ./src/config（config.js 在加载时用
// app.getPath('userData') 写 process.env.KNOWLY_DATA_ROOT），因此它必须在便携化 setPath 之后加载，
// 否则 config.js 会先用默认 userData（appdata）写死错误的数据根。故此处延后 require。

// [重建版适配] 便携化数据根：打包版（免安装 exe）一切数据落在 exe 所在目录的 data/ 下，
// 随目录整体移动；开发版仍用 %APPDATA%/KnowlyRecon。环境变量可显式覆盖。
// 必须在 requestSingleInstanceLock()、electron-store 初始化以及任何 require('./src/config')
// 的模块（如 local-image-protocol）之前执行。
let portableRoot = null;
// [重建版适配] 开发/打包判据：不能用 app.isPackaged —— 项目根的 Knowly.exe 是重命名的
// electron.exe，isPackaged 对它返回 false。改为判断 exe 是否位于 node_modules 内。
const isDevElectron = /node_modules[\\/]electron[\\/]/i.test(process.execPath);
if (process.env.KNOWLY_USER_DATA) {
  app.setPath('userData', process.env.KNOWLY_USER_DATA);
} else if (!isDevElectron) {
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

// [重建版适配] 首次便携化迁移：把开发期留在 %APPDATA%/KnowlyRecon/backend-data 的用户数据
// 搬到便携数据根（sessions 按会话 id 合并去重；config 的模型配置优先补齐；apps 应用数据整体复制）。
if (!isDevElectron && process.env.KNOWLY_DATA_ROOT) {
  try {
    const legacy = path.join(app.getPath('appData'), 'KnowlyRecon', 'backend-data');
    const target = process.env.KNOWLY_DATA_ROOT;
    if (fs.existsSync(legacy)) {
      fs.mkdirSync(target, { recursive: true });
      for (const f of fs.readdirSync(legacy)) {
        if (!f.endsWith('.json')) continue;
        const src = path.join(legacy, f);
        const dest = path.join(target, f);
        if (!fs.existsSync(dest)) {
          fs.copyFileSync(src, dest);
          continue;
        }
        // config.json：模型配置是用户关键数据，逐键补齐（便携根已有值优先）
        if (f === 'config.json') {
          try {
            const legacyCfg = JSON.parse(fs.readFileSync(src, 'utf8'));
            const targetCfg = JSON.parse(fs.readFileSync(dest, 'utf8'));
            delete legacyCfg.marker;
            const merged = { ...legacyCfg, ...targetCfg };
            if (!targetCfg.api_key && legacyCfg.api_key) {
              fs.writeFileSync(dest, JSON.stringify(merged, null, 2));
              console.log('[重建版适配] 已补齐便携数据根的模型配置');
            }
          } catch { /* 配置损坏时跳过 */ }
        }
      }
      // apps 应用数据目录
      const legacyApps = path.join(legacy, 'apps');
      const targetApps = path.join(target, 'apps');
      if (fs.existsSync(legacyApps) && !fs.existsSync(targetApps)) {
        fs.cpSync(legacyApps, targetApps, { recursive: true });
        console.log('[重建版适配] 已迁移应用数据目录');
      }
      console.log('[重建版适配] 便携数据根检查完成:', target);
    }
  } catch (e) {
    console.warn('[重建版适配] 历史数据迁移失败（不影响启动）:', e.message);
  }
}

// 自定义协议须在 app.ready 之前注册为 privileged，否则 http(s) 页面内 img 请求可能被拦
// （延后到便携化 setPath 之后加载，见文件顶部说明）
const { registerFindmeLocalPrivilegedScheme } = require('./src/local-image-protocol');
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