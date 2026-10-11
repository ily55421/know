const { BrowserWindow, app, session, dialog, Menu, clipboard, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const { log, appState } = require('./config');
const { installPageZoomShortcuts } = require('./page-zoom');

let mainWindow = null;
// 启动闸门：Python/代理就绪前不允许建窗，避免托盘点击或二次启动抢先建出一个「孤儿窗」
let windowCreationAllowed = false;
// 启动期收到的唤起意图，启动完成建窗后补一次前置
let pendingPresent = false;

// 将主窗口收进托盘。macOS 的全屏切换是异步的，其他平台可在退出全屏后直接隐藏。
function hideWindowToTray(window) {
  if (!window || window.isDestroyed()) return;

  const wasFullScreen = window.isFullScreen();
  log.info(`主窗口收进托盘: platform=${process.platform}, fullScreen=${wasFullScreen}, maximized=${window.isMaximized()}`);

  if (!wasFullScreen) {
    window.hide();
    return;
  }

  if (process.platform === 'darwin') {
    window.once('leave-full-screen', () => {
      if (!window.isDestroyed()) {
        window.hide();
      }
    });
    window.setFullScreen(false);
    return;
  }

  // Windows 会在 leave-full-screen 事件之后继续恢复窗口可见状态，
  // 因此必须等 setFullScreen(false) 返回后再隐藏。
  window.setFullScreen(false);
  window.hide();
}

/**
 * 将右键菜单关联的图片写入系统剪贴板（与 ipc clipboard-write-image 能力对齐）
 */
async function copyImageToClipboardFromSrcUrl(srcURL) {
  if (!srcURL || typeof srcURL !== 'string') {
    return { ok: false, error: '无效地址' };
  }
  try {
    if (srcURL.startsWith('data:')) {
      const image = nativeImage.createFromDataURL(srcURL);
      if (image.isEmpty()) {
        return { ok: false, error: '无法解析图片' };
      }
      clipboard.writeImage(image);
      return { ok: true };
    }

    if (srcURL.startsWith('findme-local://')) {
      const parsed = new URL(srcURL);
      const b64 = (parsed.pathname || '').replace(/^\//, '');
      if (!b64) {
        return { ok: false, error: '无效地址' };
      }
      const filePath = Buffer.from(b64, 'base64url').toString('utf8');
      const normalized = path.normalize(filePath.trim());
      if (!fs.existsSync(normalized) || !fs.statSync(normalized).isFile()) {
        return { ok: false, error: '文件不存在' };
      }
      const image = nativeImage.createFromPath(normalized);
      if (image.isEmpty()) {
        return { ok: false, error: '无法读取图片' };
      }
      clipboard.writeImage(image);
      return { ok: true };
    }

    if (srcURL.startsWith('file://')) {
      let filePath;
      try {
        const u = new URL(srcURL);
        filePath = decodeURIComponent(u.pathname.replace(/\+/g, ' '));
        if (/^\/[A-Za-z]:\//.test(filePath)) {
          filePath = filePath.slice(1);
        }
      } catch {
        return { ok: false, error: '无效文件地址' };
      }
      if (!fs.existsSync(filePath)) {
        return { ok: false, error: '文件不存在' };
      }
      const image = nativeImage.createFromPath(filePath);
      if (image.isEmpty()) {
        return { ok: false, error: '无法读取图片' };
      }
      clipboard.writeImage(image);
      return { ok: true };
    }

    if (/^https?:\/\//i.test(srcURL)) {
      const res = await fetch(srcURL);
      if (!res.ok) {
        return { ok: false, error: `下载失败 ${res.status}` };
      }
      const buf = Buffer.from(await res.arrayBuffer());
      const image = nativeImage.createFromBuffer(buf);
      if (image.isEmpty()) {
        return { ok: false, error: '无法解析图片' };
      }
      clipboard.writeImage(image);
      return { ok: true };
    }

    return { ok: false, error: '不支持的图片地址' };
  } catch (e) {
    log.error('复制图片到剪贴板失败:', e);
    return { ok: false, error: e.message };
  }
}

// 创建主窗口
function createWindow() {
  // 单例兜底：已有存活主窗时绝不再建第二扇
  if (mainWindow && !mainWindow.isDestroyed()) {
    log.info('主窗口已存在，跳过重复创建');
    return mainWindow;
  }

  // 禁用安全策略
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Access-Control-Allow-Origin': ['*'],
        'Access-Control-Allow-Methods': ['*'],
        'Access-Control-Allow-Headers': ['*']
      }
    });
  });
  
  // 确定窗口图标
  let iconPath = null;
  if (process.platform === 'darwin') {
    const pngIcon = path.join(__dirname, '..', '..', 'public', 'app.png');
    if (fs.existsSync(pngIcon)) {
      iconPath = pngIcon;
    }
  } else if (process.platform === 'win32') {
    const icoIcon = path.join(__dirname, '..', '..', 'public', 'favicon.ico');
    if (fs.existsSync(icoIcon)) {
      iconPath = icoIcon;
    }
  } else {
    const pngIcon = path.join(__dirname, '..', '..', 'public', 'app.png');
    if (fs.existsSync(pngIcon)) {
      iconPath = pngIcon;
    }
  }
  
  // 创建窗口配置
  const windowOptions = {
    width: 1200,
    height: 800,
    minWidth: 725,
    // minHeight: 600,
    autoHideMenuBar: true, // 自动隐藏菜单栏，按Alt键可显示
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, '..', 'preload.js'),
      webSecurity: false // 禁用网页安全策略
    }
  };
  
  // 如果图标存在，添加到窗口配置
  if (iconPath) {
    windowOptions.icon = iconPath;
    log.info(`设置窗口图标: ${iconPath}`);
  } else {
    log.warn('找不到合适的窗口图标');
  }
  
  const win = new BrowserWindow(windowOptions);
  mainWindow = win;
  installPageZoomShortcuts(win);

  // 在 macOS 上也隐藏菜单栏
  if (process.platform === 'darwin') {
    Menu.setApplicationMenu(null);
  }

  // 右键菜单：为输入框/选中文本提供复制粘贴等原生菜单；图片上提供「复制」
  win.webContents.on('context-menu', (event, params) => {
    const { isEditable, selectionText, mediaType, srcURL } = params || {};
    const hasSelection = Boolean(selectionText && selectionText.trim().length > 0);
    const isImage = mediaType === 'image' && Boolean(srcURL);

    const template = [];

    if (isImage) {
      const imageLabel = hasSelection ? '复制图片' : '复制';
      template.push({
        label: imageLabel,
        click: async () => {
          const result = await copyImageToClipboardFromSrcUrl(srcURL);
          if (!result.ok) {
            log.warn('右键复制图片失败:', result.error);
          }
        }
      });
      template.push({ type: 'separator' });
    }

    if (isEditable) {
      template.push(
        { label: '剪切', click: () => win.webContents.cut() },
        { label: '复制', click: () => win.webContents.copy() },
        { label: '粘贴', click: () => win.webContents.paste() },
        { type: 'separator' },
        { label: '全选', click: () => win.webContents.selectAll() }
      );
    } else if (hasSelection) {
      template.push(
        { label: '复制', click: () => win.webContents.copy() },
        { label: '全选', click: () => win.webContents.selectAll() }
      );
    } else {
      template.push({ label: '全选', click: () => win.webContents.selectAll() });
    }

    if (template.length === 0) return;
    event.preventDefault();
    Menu.buildFromTemplate(template).popup({ window: win });
  });

  // 加载React应用
  if (app.isPackaged) {
    // 生产环境：加载打包好的React页面
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  } else {
    // 开发环境：加载React开发服务器
    try {
      // [重建版适配] 端口迁移：原版 devServer 为 13099，重建版默认 23099（scripts/dev-web.js）
      const devPort = Number(process.env.KNOWLY_WEB_PORT) || 23099;
      win.loadURL(`http://localhost:${devPort}`);
      log.info('从开发服务器加载应用');
      
      // 开发环境下打开开发者工具
      win.webContents.openDevTools();
    } catch (error) {
      log.warn('无法从开发服务器加载，尝试加载构建文件', error);
      const distPath = path.join(__dirname, '..', 'dist', 'index.html');
      if (fs.existsSync(distPath)) {
        win.loadFile(distPath);
        log.info('从构建目录加载应用');
      } else {
        log.error('找不到应用页面，请先运行npm run build:react');
        dialog.showErrorBox(
          '启动失败', 
          '找不到应用页面，请先运行npm run build:react构建React应用'
        );
        app.quit();
      }
    }
  }

  // 窗口关闭时不退出应用，而是隐藏窗口。这里必须收 win 自己，不能收全局指针，
  // 否则出现多窗时会「关 A 却藏 B」
  win.on('close', (event) => {
    // 如果不是应用退出过程中，则阻止窗口关闭
    if (!app.isQuitting) {
      event.preventDefault();
      hideWindowToTray(win);
      return false;
    }
  });

  // 窗口关闭时清理资源
  win.on('closed', () => {
    if (mainWindow === win) {
      mainWindow = null;
    }
  });

  // 监听页面加载完成事件，处理刷新情况
  // 注意：这里使用on而不是once，确保每次刷新都能触发
  win.webContents.on('did-finish-load', () => {
    log.info('页面加载完成，检查Python服务状态');
    // 检查Python服务是否在运行，如果在运行则发送ready事件
    const { isPythonServerRunning } = require('./python-server');
    if (isPythonServerRunning()) {
      const { API_BASE_URL } = require('./config');
      log.info(`Python服务已运行，发送python-ready事件: ${API_BASE_URL}`);
      win.webContents.send('python-ready', API_BASE_URL);
    }
  });
  
  return win;
}

/**
 * 唯一的唤起入口：托盘点击、二次启动（桌面图标）、macOS activate、通知点击都走这里。
 * 启动未完成时只记录意图，不建窗，等启动流程创建主窗后补一次前置。
 */
function presentMainWindow(reason = 'unknown') {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }
    mainWindow.show();
    mainWindow.focus();
    // Windows 下 show + focus 不一定能把窗抬到最前，用一次置顶翻转补强
    if (process.platform === 'win32') {
      mainWindow.setAlwaysOnTop(true);
      mainWindow.setAlwaysOnTop(false);
    }
    log.info(`唤起主窗口: reason=${reason}`);
    return mainWindow;
  }

  if (!windowCreationAllowed) {
    pendingPresent = true;
    log.info(`应用仍在启动中，暂存唤起意图: reason=${reason}`);
    return null;
  }

  log.info(`主窗口不存在，重新创建: reason=${reason}`);
  return createWindow();
}

/**
 * 启动流程就绪后调用：打开闸门并创建唯一主窗口，
 * 若启动期间用户点过托盘/桌面图标，创建后立即前置一次。
 */
function createMainWindowOnStartup() {
  windowCreationAllowed = true;
  const win = createWindow();
  if (pendingPresent) {
    pendingPresent = false;
    presentMainWindow('startup-pending');
  }
  return win;
}

// 发送事件到渲染进程
function sendToRenderer(event, data) {
  const win = getMainWindow();
  if (win) {
    win.webContents.send(event, data);
  }
}

// 确保窗口加载完成后发送事件
function sendToRendererWhenReady(event, data) {
  const win = getMainWindow();
  if (!win) return;

  // 如果窗口还在加载中，等待加载完成后发送
  if (win.webContents.isLoading()) {
    win.webContents.once('did-finish-load', () => {
      if (!win.isDestroyed()) {
        win.webContents.send(event, data);
      }
    });
  } else {
    // 窗口已经加载完成，立即发送
    win.webContents.send(event, data);
  }
}

// 获取主窗口
function getMainWindow() {
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
}

module.exports = {
  createMainWindowOnStartup,
  presentMainWindow,
  sendToRenderer,
  sendToRendererWhenReady,
  getMainWindow
};
