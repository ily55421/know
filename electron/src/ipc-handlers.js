const { ipcMain, dialog, app, shell, session, clipboard, nativeImage, BrowserWindow } = require('electron');
const { store, log } = require('./config');
const { getMainWindow } = require('./window-manager');
const { 
  submitUserFeedback, 
  getAnnouncements, 
  verifyInviteCode,
  callCloudFunction,
  syncQuotaToCloud
} = require('./cloud-services');
const { checkForUpdates, installUpdate, isStoreVersion } = require('./auto-updater');
const { runNetworkDiagnostics } = require('./network-diagnostics');
const { getPageZoomState, setPageZoom } = require('./page-zoom');
const { resolveLocalPath, trashLocalItem } = require('./local-file-actions');
const { resolveAndPersistDeviceId } = require('./device-id');
const wallpaper = require('./wallpaper');
const xhsCardBackground = require('./xhs-card-background');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync, spawn } = require('child_process');

/** shell.openPath 在不同 Electron 版本下可能为 string 或 { error } */
function shellOpenPathErrorMessage(result) {
  if (result == null) return '';
  if (typeof result === 'string') return result;
  if (typeof result === 'object' && result.error != null) return String(result.error);
  return '';
}

// shell.openPath
ipcMain.handle('shell-open-path', async (event, rawPath) => {
  try {
    const abs = resolveLocalPath(rawPath);
    if (!abs) {
      return { success: false, message: '路径无效' };
    }
    if (!fs.existsSync(abs)) {
      return { success: false, message: `文件不存在: ${abs}` };
    }
    const errMsg = shellOpenPathErrorMessage(await shell.openPath(abs));
    if (errMsg.trim()) {
      return { success: false, message: errMsg };
    }
    return { success: true };
  } catch (error) {
    log.error('shell-open-path 失败:', error);
    return { success: false, message: error.message || '打开失败' };
  }
});

// shell.showItemInFolder（文件）；目录时用 shell.openPath 打开该文件夹
ipcMain.handle('shell-show-item-in-folder', async (event, rawPath) => {
  try {
    const abs = resolveLocalPath(rawPath);
    if (!abs) {
      return { success: false, message: '路径无效' };
    }
    if (!fs.existsSync(abs)) {
      return { success: false, message: `文件不存在: ${abs}` };
    }
    const stat = fs.statSync(abs);
    if (stat.isFile()) {
      shell.showItemInFolder(abs);
      return { success: true };
    }
    if (stat.isDirectory()) {
      const errMsg = shellOpenPathErrorMessage(await shell.openPath(abs));
      if (errMsg.trim()) {
        return { success: false, message: errMsg };
      }
      return { success: true };
    }
    return { success: false, message: '不是文件或文件夹' };
  } catch (error) {
    log.error('shell-show-item-in-folder 失败:', error);
    return { success: false, message: error.message || '打开失败' };
  }
});

// shell.trashItem：移入系统回收站/废纸篓
ipcMain.handle('shell-trash-item', async (event, rawPath) => {
  try {
    return await trashLocalItem(rawPath, (abs) => shell.trashItem(abs));
  } catch (error) {
    log.error('shell-trash-item 失败:', error);
    return { success: false, message: error.message || '移入回收站失败' };
  }
});

/** macOS Quick Look：`qlmanage -p`（与旧 Python /preview-file 等价；Electron shell 无此 API） */
ipcMain.handle('preview-file', async (event, rawPath) => {
  if (process.platform !== 'darwin') {
    return { success: false, message: '当前平台不支持系统 Quick Look 预览' };
  }
  try {
    const abs = resolveLocalPath(rawPath);
    if (!abs) {
      return { success: false, message: '路径无效' };
    }
    if (!fs.existsSync(abs)) {
      return { success: false, message: `文件不存在: ${abs}` };
    }
    if (!fs.statSync(abs).isFile()) {
      return { success: false, message: '路径不是文件' };
    }
    const child = spawn('qlmanage', ['-p', abs], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    return { success: true };
  } catch (error) {
    log.error('preview-file 失败:', error);
    return { success: false, message: error.message || '预览失败' };
  }
});

function normalizeExtension(ext) {
  return String(ext || '').replace(/^\./, '').toLowerCase();
}

function isJunkFileName(name) {
  const base = String(name || '');
  if (!base || base.startsWith('._')) return true;
  return /^(?:\.DS_Store|Thumbs\.db|desktop\.ini|\.gitkeep|\.keep)$/i.test(base);
}

function listFilesInDirectory(directory, extensions) {
  const absDir = path.resolve(directory);
  if (!fs.existsSync(absDir) || !fs.statSync(absDir).isDirectory()) {
    return [];
  }
  const extSet = Array.isArray(extensions) && extensions.length > 0
    ? new Set(extensions.map(normalizeExtension))
    : null;
  const results = [];

  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (isJunkFileName(entry.name)) continue;
      if (extSet) {
        const ext = normalizeExtension(path.extname(entry.name));
        if (!extSet.has(ext)) continue;
      }
      results.push(fullPath);
    }
  };

  walk(absDir);
  return results.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}

// 选择目录的IPC处理（任务模式指定操作范围、DirectoryManager添加目录等）
// 支持多选，返回路径数组；单选时取第一个
ipcMain.handle('select-directory', async () => {
  const mainWindow = getMainWindow();
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'multiSelections'],
    title: '选择目录'
  });
  if (!result.canceled && result.filePaths.length > 0) {
    return result.filePaths;
  }
  return [];
});

// options: { extensions?: string[], multiple?: boolean }
ipcMain.handle('select-files', async (_event, options = {}) => {
  const mainWindow = getMainWindow();
  const multiple = options.multiple !== false;
  const dialogOptions = {
    properties: multiple ? ['openFile', 'multiSelections'] : ['openFile'],
    title: '选择文件',
  };
  if (Array.isArray(options.extensions) && options.extensions.length > 0) {
    dialogOptions.filters = [
      { name: '匹配的文件', extensions: options.extensions.map(normalizeExtension) },
      { name: '所有文件', extensions: ['*'] },
    ];
  }
  const result = await dialog.showOpenDialog(mainWindow, dialogOptions);
  if (!result.canceled) {
    return result.filePaths;
  }
  return [];
});

// 递归列出目录下匹配扩展名的文件
ipcMain.handle('list-files-in-directory', async (_event, directory, extensions) => {
  try {
    return listFilesInDirectory(directory, extensions);
  } catch (error) {
    log.error('list-files-in-directory 失败:', error);
    return [];
  }
});

// 选择 HTML 应用来源：file=单个 HTML 文件，directory=文件夹（Windows/Linux 不能在同一对话框混选）
ipcMain.handle('select-app-source', async (event, kind) => {
  const mainWindow = getMainWindow();
  const pickDirectory = kind === 'directory';
  const options = {
    properties: pickDirectory ? ['openDirectory'] : ['openFile'],
    title: pickDirectory ? '选择应用文件夹' : '选择 HTML 文件',
  };
  if (!pickDirectory) {
    options.filters = [
      { name: 'HTML 文件', extensions: ['html', 'htm'] },
      { name: '所有文件', extensions: ['*'] },
    ];
  }
  const result = await dialog.showOpenDialog(mainWindow, options);
  if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
    return { canceled: true };
  }
  const picked = result.filePaths[0];
  try {
    const stat = fs.existsSync(picked) ? fs.statSync(picked) : null;
    if (!stat) return { canceled: true };
    return {
      canceled: false,
      path: picked,
      kind: stat.isDirectory() ? 'directory' : 'file',
    };
  } catch (e) {
    return { canceled: true };
  }
});

// 保存配置的IPC处理
ipcMain.handle('save-config', async (event, config) => {
  store.set('config', config);
  return true;
});

// 获取配置的IPC处理
// 注意：目录相关配置现在由 Python 后端的 /directories API 管理
ipcMain.handle('get-config', async () => {
  return store.get('config') || {};
});

// 提交用户反馈的IPC处理
ipcMain.handle('submit-feedback', async (event, payload) => {
  const data = payload || {};
  return await submitUserFeedback({
    ...data,
    contact: data.contact || data.email || '',
  });
});

// 获取公告的IPC处理
ipcMain.handle('get-announcements', async (event) => {
  return await getAnnouncements();
});

// 验证邀请码的IPC处理
ipcMain.handle('verify-invite-code', async (event, inviteCode) => {
  return await verifyInviteCode(inviteCode);
});

// 调用云函数的IPC处理
// [重建版适配] 遥测门关闭（默认）时对会员类云调用返回本地模拟成功：
// 渲染层知识库页等启动序列为 syncMembershipFromCloud() → check-membership → 拉目录列表，
// 原厂云端不可达会让该调用抛错并中断后续初始化（表现为目录列表永远为空）。
ipcMain.handle('call-cloud-function', async (event, functionName, params) => {
  if (process.env.KNOWLY_ENABLE_TELEMETRY !== '1' && /membership|quota/i.test(String(functionName || ''))) {
    return {
      success: true,
      data: {
        synced: false,
        mode: 'local-reconstruction',
        membership: { level: 'flagship', level_name: '旗舰版（重建版）', is_expired: false, is_permanent: true },
      },
      message: '重建版本地会员（未连接云端）',
    };
  }
  return await callCloudFunction(functionName, params);
});

// IPC处理程序 - 手动检查更新
ipcMain.handle('check-for-updates', async (event, isManualCheck = true) => {
  return await checkForUpdates(isManualCheck);
});

// IPC处理程序 - 安装更新
ipcMain.handle('install-update', async () => {
  return await installUpdate();
});



// 获取应用版本的IPC处理
ipcMain.handle('get-app-version', async () => {
  return app.getVersion();
});

ipcMain.handle('get-is-store-version', async () => isStoreVersion);

// 获取设备ID的IPC处理
ipcMain.handle('get-device-id', async () => {
  return resolveAndPersistDeviceId(store);
});

// 页面缩放：对应浏览器 Cmd/Ctrl +、Cmd/Ctrl -、Cmd/Ctrl 0
ipcMain.handle('get-page-zoom', async (event) => {
  return getPageZoomState(event.sender || getMainWindow()?.webContents);
});

ipcMain.handle('set-page-zoom', async (event, action) => {
  return setPageZoom(event.sender || getMainWindow()?.webContents, action);
});

// 打开外部链接的IPC处理
ipcMain.handle('open-external-url', async (event, url) => {
  try {
    await shell.openExternal(url);
    return { success: true };
  } catch (error) {
    console.error('打开外部链接失败:', error);
    return { success: false, error: error.message };
  }
});

// 在系统默认终端中打开并执行命令（支持 sudo/交互，类似 Cursor 的独立终端）
// 参数: { command?: string, cwd?: string }，无 command 时只打开终端
ipcMain.handle('open-external-terminal', async (event, options = {}) => {
  const { command = '', cwd } = options;
  const platform = process.platform;
  const { spawn } = require('child_process');
  try {
    if (platform === 'darwin') {
      // 直接在 Terminal 中执行用户可读的命令，而不是通过临时脚本
      const parts = [];
      if (cwd) {
        // 在 shell 中安全地 cd 到工作目录（用单引号包裹路径）
        const safeCwd = cwd.replace(/'/g, `'\\''`);
        parts.push(`cd '${safeCwd}'`);
      }
      if (command) {
        parts.push(command);
      }
      const fullCommand = parts.join(' && ');
      const scriptCommand = fullCommand || '';
      const escaped = scriptCommand.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      const appleScript = scriptCommand
        ? `tell application "Terminal" to do script "${escaped}"`
        : 'tell application "Terminal" to do script ""';
      execFileSync('osascript', ['-e', appleScript]);
      return { success: true };
    }
    if (platform === 'win32') {
      // 直接在新 cmd 窗口执行用户可读的命令，不通过临时 bat
      const parts = [];
      if (cwd) parts.push(`cd /d "${cwd.replace(/"/g, '""')}"`);
      if (command) parts.push(command.trim());
      const fullCmd = parts.join(' && ') || '';
      spawn('cmd', ['/c', 'start', 'cmd', '/k', fullCmd], { detached: true, stdio: 'ignore' });
      return { success: true };
    }
    if (platform === 'linux') {
      const lines = [];
      if (cwd) lines.push(`cd ${JSON.stringify(cwd)}`);
      if (command) lines.push(command);
      lines.push('exec bash');
      const tmpPath = path.join(os.tmpdir(), `findme-term-${Date.now()}.sh`);
      fs.writeFileSync(tmpPath, lines.join('\n'), { mode: 0o700 });
      const termCmd = process.env.XDG_CURRENT_DESKTOP?.toLowerCase().includes('gnome')
        ? 'gnome-terminal'
        : 'x-terminal-emulator';
      spawn(termCmd, ['--', 'bash', tmpPath], { detached: true, stdio: 'ignore' });
      return { success: true };
    }
    return { success: false, error: '不支持的操作系统' };
  } catch (err) {
    log.error('打开系统终端失败:', err);
    return { success: false, error: err.message };
  }
});

// 获取是否为开发环境的IPC处理
ipcMain.handle('get-is-dev-mode', async () => {
  // 通过判断是否打包来确定环境
  // app.isPackaged 为 false 表示开发环境，为 true 表示生产环境
  const isDev = !app.isPackaged;
  return isDev;
});

// 获取开机启动状态
ipcMain.handle('get-open-at-login', async () => {
  try {
    const settings = app.getLoginItemSettings();
    return {
      success: true,
      enabled: Boolean(settings.openAtLogin),
    };
  } catch (error) {
    log.error('读取开机启动状态失败:', error);
    return {
      success: false,
      enabled: false,
      message: error.message || '读取开机启动状态失败',
    };
  }
});

// 设置开机启动状态
ipcMain.handle('set-open-at-login', async (event, enabled) => {
  try {
    app.setLoginItemSettings({
      openAtLogin: Boolean(enabled),
    });
    const settings = app.getLoginItemSettings();
    return {
      success: true,
      enabled: Boolean(settings.openAtLogin),
    };
  } catch (error) {
    log.error('设置开机启动状态失败:', error);
    return {
      success: false,
      enabled: Boolean(enabled),
      message: error.message || '设置开机启动状态失败',
    };
  }
});

// 下单前同步配额快照到云端（升级折抵读 quota_records）
ipcMain.handle('sync-quota-to-cloud', async () => {
  try {
    await syncQuotaToCloud();
    return { success: true };
  } catch (error) {
    log.error('sync-quota-to-cloud 失败:', error.message);
    return { success: false, message: error.message };
  }
});

// 导出日志文件的IPC处理
ipcMain.handle('export-logs', async () => {
  const mainWindow = getMainWindow();
  
  try {
    // 获取日志文件路径
    const logPath = log.transports.file.getFile().path;
    
    // 检查日志文件是否存在
    if (!fs.existsSync(logPath)) {
      return { 
        success: false, 
        message: '日志文件不存在' 
      };
    }
    
    // 显示保存对话框
    const result = await dialog.showSaveDialog(mainWindow, {
      title: '导出日志文件',
      defaultPath: `findme-log-${new Date().toISOString().split('T')[0]}.log`,
      filters: [
        { name: '日志文件', extensions: ['log'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    });
    
    if (result.canceled || !result.filePath) {
      return { 
        success: false, 
        message: '用户取消了操作' 
      };
    }
    
    // 复制日志文件到选择的位置
    fs.copyFileSync(logPath, result.filePath);
    
    log.info(`日志文件已导出到: ${result.filePath}`);
    
    return { 
      success: true, 
      message: '日志文件导出成功',
      path: result.filePath
    };
  } catch (error) {
    log.error('导出日志文件失败:', error);
    return { 
      success: false, 
      message: `导出失败: ${error.message}` 
    };
  }
});

// 网络诊断的IPC处理
ipcMain.handle('run-network-diagnostics', async () => {
  // 传入 session 以检测系统代理
  return await runNetworkDiagnostics(log, session.defaultSession);
});

// 剪贴板操作 - 写入纯文本
ipcMain.handle('clipboard-write-text', async (event, text) => {
  try {
    clipboard.writeText(text);
    return { success: true };
  } catch (error) {
    log.error('写入剪贴板文本失败:', error);
    return { success: false, error: error.message };
  }
});

// 剪贴板操作 - 写入 HTML（同时提供纯文本作为回退）
ipcMain.handle('clipboard-write-html', async (event, html, text) => {
  try {
    // Electron 的 writeHTML 在 macOS 上需要同时提供纯文本
    clipboard.write({
      text: text || '',
      html: html
    });
    return { success: true };
  } catch (error) {
    log.error('写入剪贴板 HTML 失败:', error);
    // 如果 HTML 写入失败，回退到纯文本
    try {
      clipboard.writeText(text || '');
      return { success: true, fallback: true };
    } catch (fallbackError) {
      return { success: false, error: fallbackError.message };
    }
  }
});

// 剪贴板操作 - 写入图片
ipcMain.handle('clipboard-write-image', async (event, dataUrl) => {
  try {
    // 将 dataUrl 转换为 NativeImage
    const image = nativeImage.createFromDataURL(dataUrl);
    if (image.isEmpty()) {
      return { success: false, error: '无法从 dataUrl 创建图片' };
    }
    clipboard.writeImage(image);
    return { success: true };
  } catch (error) {
    log.error('写入剪贴板图片失败:', error);
    return { success: false, error: error.message };
  }
});

const UNSAFE_FILENAME_CHARS = /[\\/:*?"<>|]/g;

function sanitizeExportFileName(name) {
  const base = String(name || 'export.jpg').replace(UNSAFE_FILENAME_CHARS, '_').trim();
  const cleaned = base.replace(/^\.+/, '') || 'export.jpg';
  return cleaned.slice(0, 180);
}

function dataUrlToBuffer(dataUrl) {
  const text = String(dataUrl || '');
  const match = text.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) {
    throw new Error('invalid dataUrl');
  }
  return Buffer.from(match[2], 'base64');
}

const EXPORT_JPEG_QUALITY = 95;
const EXPORT_IMAGE_FILTERS = [
  { name: 'JPEG', extensions: ['jpg', 'jpeg'] },
  { name: 'PNG', extensions: ['png'] },
  { name: 'WebP', extensions: ['webp'] },
  { name: '所有文件', extensions: ['*'] },
];

/** 串行截图队列：避免并发抢窗 */
let htmlCaptureQueue = Promise.resolve();

/**
 * 统一输出为配置的目标尺寸。
 * 截图阶段已按目标比例限定画布，这里只处理 DPI 等导致的实际像素差异。
 */
function toExportJpegDataUrl(image, width, height) {
  const size = image.getSize();
  if (size.width < 1 || size.height < 1) return null;
  const sized = (size.width === width && size.height === height)
    ? image
    : image.resize({ width, height, quality: 'best' });
  return `data:image/jpeg;base64,${sized.toJPEG(EXPORT_JPEG_QUALITY).toString('base64')}`;
}

/**
 * 隐藏窗口 HTML 截图 → 逻辑像素 JPEG（3:4 → 1080×1440，其它比例同理）。
 * offscreen：避免 Windows 高分屏把窗口裁矮；截图时明确限定目标矩形。
 */
async function captureHtmlDocumentToJpeg(payload) {
  const width = Math.max(1, Math.round(Number(payload.width) || 1));
  const height = Math.max(1, Math.round(Number(payload.height) || 1));
  const html = String(payload.html || '');
  const css = String(payload.css || '').replace(/<\/style/gi, '<\\/style');
  const doc = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
html,body{margin:0;padding:0;width:${width}px;height:${height}px;overflow:hidden;background:#fff;}
</style><style>${css}</style></head><body>${html}</body></html>`;

  const tmpFile = path.join(os.tmpdir(), `knowly-xhs-capture-${process.pid}-${Date.now()}.html`);
  let captureWindow = null;
  try {
    fs.writeFileSync(tmpFile, doc, 'utf8');
    captureWindow = new BrowserWindow({
      show: false,
      width,
      height,
      useContentSize: true,
      frame: false,
      skipTaskbar: true,
      enableLargerThanScreen: true,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
        offscreen: true,
      },
    });
    try {
      captureWindow.webContents.setZoomFactor(1);
      captureWindow.webContents.setFrameRate(30);
    } catch {
      // ignore
    }
    captureWindow.setContentSize(width, height);

    await captureWindow.loadFile(tmpFile);
    await captureWindow.webContents.executeJavaScript(`
      (async () => {
        if (document.fonts && document.fonts.ready) {
          await document.fonts.ready;
        }
        const bgUrls = new Set();
        for (const el of Array.from(document.querySelectorAll('*'))) {
          const bg = window.getComputedStyle(el).backgroundImage || '';
          const matches = bg.matchAll(/url\\(["']?([^"')]+)["']?\\)/g);
          for (const match of matches) {
            if (match[1] && match[1] !== 'none') bgUrls.add(match[1]);
          }
        }
        await Promise.all(Array.from(bgUrls).map((src) => new Promise((resolve) => {
          const img = new Image();
          img.onload = () => resolve();
          img.onerror = () => resolve();
          img.src = src;
        })));
        await new Promise((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(resolve));
        });
      })()
    `);

    const image = await captureWindow.webContents.capturePage(
      { x: 0, y: 0, width, height },
      { stayHidden: true },
    );
    if (!image || image.isEmpty()) {
      return { success: false, error: 'empty capture' };
    }
    const dataUrl = toExportJpegDataUrl(image, width, height);
    if (!dataUrl) {
      return { success: false, error: 'capture encode failed' };
    }
    return { success: true, dataUrl };
  } finally {
    if (captureWindow && !captureWindow.isDestroyed()) {
      captureWindow.destroy();
    }
    try {
      fs.unlinkSync(tmpFile);
    } catch {
      // ignore
    }
  }
}

ipcMain.handle('capture-html-to-png', async (_event, payload = {}) => {
  const run = () => captureHtmlDocumentToJpeg(payload);
  const resultPromise = htmlCaptureQueue.then(run, run);
  htmlCaptureQueue = resultPromise.then(
    () => undefined,
    () => undefined,
  );
  try {
    return await resultPromise;
  } catch (error) {
    log.error('HTML 截图失败:', error);
    return { success: false, error: error.message };
  }
});

/**
 * 先选导出目标（目录 / 另存为），再开始截图，避免长时间无反馈后才弹框。
 * payload: { mode?: 'directory' | 'saveAs', defaultName?: string }
 */
ipcMain.handle('pick-image-export-target', async (_event, payload = {}) => {
  const mainWindow = getMainWindow();
  const mode = payload.mode === 'saveAs' ? 'saveAs' : 'directory';
  try {
    if (mode === 'saveAs') {
      const defaultName = sanitizeExportFileName(payload.defaultName || 'export.jpg');
      const result = await dialog.showSaveDialog(mainWindow, {
        title: '导出图片',
        defaultPath: defaultName,
        filters: EXPORT_IMAGE_FILTERS,
      });
      if (result.canceled || !result.filePath) {
        return { canceled: true };
      }
      return {
        success: true,
        filePath: result.filePath,
        directory: path.dirname(result.filePath),
      };
    }

    const dirResult = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory', 'createDirectory'],
      title: '选择导出目录',
    });
    if (dirResult.canceled || !dirResult.filePaths.length) {
      return { canceled: true };
    }
    return { success: true, directory: dirResult.filePaths[0] };
  } catch (error) {
    log.error('选择导出目标失败:', error);
    return { success: false, error: error.message };
  }
});

/**
 * 专用图片导出：只接收明确文件列表，不暴露通用写文件。
 * payload: {
 *   files: [{ fileName, dataUrl }],
 *   mode?: 'directory' | 'saveAs',
 *   directory?: string,
 *   filePath?: string,
 * }
 */
ipcMain.handle('export-image-files', async (_event, payload = {}) => {
  const mainWindow = getMainWindow();
  const files = Array.isArray(payload.files) ? payload.files : [];
  if (!files.length) {
    return { success: false, error: 'no files' };
  }

  const mode = payload.mode === 'saveAs' ? 'saveAs' : 'directory';

  try {
    if (mode === 'saveAs') {
      const first = files[0];
      const defaultName = sanitizeExportFileName(first.fileName || 'export.jpg');
      let targetPath = typeof payload.filePath === 'string' ? payload.filePath.trim() : '';
      if (!targetPath) {
        const result = await dialog.showSaveDialog(mainWindow, {
          title: '导出图片',
          defaultPath: defaultName,
          filters: EXPORT_IMAGE_FILTERS,
        });
        if (result.canceled || !result.filePath) {
          return { canceled: true };
        }
        targetPath = result.filePath;
      }
      const written = [];
      const failed = [];
      try {
        fs.writeFileSync(targetPath, dataUrlToBuffer(first.dataUrl));
        written.push(targetPath);
      } catch (error) {
        failed.push({ fileName: defaultName, error: error.message });
      }
      return {
        success: failed.length === 0,
        directory: path.dirname(targetPath),
        written,
        failed,
      };
    }

    let directory = typeof payload.directory === 'string' ? payload.directory.trim() : '';
    if (!directory) {
      const dirResult = await dialog.showOpenDialog(mainWindow, {
        properties: ['openDirectory', 'createDirectory'],
        title: '选择导出目录',
      });
      if (dirResult.canceled || !dirResult.filePaths.length) {
        return { canceled: true };
      }
      directory = dirResult.filePaths[0];
    }
    const written = [];
    const failed = [];
    for (const item of files) {
      const fileName = sanitizeExportFileName(item.fileName || 'export.jpg');
      const target = path.join(directory, fileName);
      try {
        fs.writeFileSync(target, dataUrlToBuffer(item.dataUrl));
        written.push(target);
      } catch (error) {
        failed.push({ fileName, error: error.message });
      }
    }
    return {
      success: failed.length === 0 && written.length > 0,
      directory,
      written,
      failed,
    };
  } catch (error) {
    log.error('导出图片失败:', error);
    return { success: false, error: error.message };
  }
});

/** 图片去水印等本地处理结果另存为；只允许复制受支持的图片文件。 */
ipcMain.handle('save-image-result', async (_event, payload = {}) => {
  const mainWindow = getMainWindow();
  try {
    const sourcePath = resolveLocalPath(payload.sourcePath);
    if (!sourcePath || !fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) {
      return { success: false, error: '处理结果不存在，请重新处理' };
    }
    if (!/\.(jpe?g|png|webp)$/i.test(sourcePath)) {
      return { success: false, error: '不支持的图片格式' };
    }

    const defaultName = sanitizeExportFileName(payload.defaultName || path.basename(sourcePath));
    let initialDirectory = '';
    if (typeof payload.sourceDirectory === 'string' && payload.sourceDirectory.trim()) {
      const resolved = resolveLocalPath(payload.sourceDirectory);
      if (resolved) {
        initialDirectory = fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()
          ? resolved
          : path.dirname(resolved);
      }
    }
    const result = await dialog.showSaveDialog(mainWindow, {
      title: '保存图片',
      defaultPath: initialDirectory ? path.join(initialDirectory, defaultName) : defaultName,
      filters: EXPORT_IMAGE_FILTERS,
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    fs.copyFileSync(sourcePath, result.filePath);
    return {
      success: true,
      path: result.filePath,
      directory: path.dirname(result.filePath),
    };
  } catch (error) {
    log.error('保存处理图片失败:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('get-device-transfer-export-path', async () => {
  try {
    const downloads = app.getPath('downloads');
    fs.mkdirSync(downloads, { recursive: true });
    const now = new Date();
    const twoDigits = value => String(value).padStart(2, '0');
    const timestamp = `${now.getFullYear()}${twoDigits(now.getMonth() + 1)}${twoDigits(now.getDate())}-${twoDigits(now.getHours())}${twoDigits(now.getMinutes())}`;
    const baseName = `Knowly会员数据备份-${timestamp}`;
    let filePath = path.join(downloads, `${baseName}.backup`);
    let suffix = 2;
    while (fs.existsSync(filePath)) {
      filePath = path.join(downloads, `${baseName}-${suffix}.backup`);
      suffix += 1;
    }
    return { success: true, path: filePath };
  } catch (error) {
    log.error('生成会员数据备份路径失败:', error);
    return { success: false, message: error.message };
  }
});

ipcMain.handle('get-wallpaper', async () => wallpaper.getWallpaper());
ipcMain.handle('set-wallpaper', async () => wallpaper.setWallpaper());
ipcMain.handle('clear-wallpaper', async () => wallpaper.clearWallpaper());

ipcMain.handle('get-xhs-card-background', async () => xhsCardBackground.getXhsCardBackground());
ipcMain.handle('set-xhs-card-background', async () => xhsCardBackground.setXhsCardBackground());
ipcMain.handle('clear-xhs-card-background', async () => xhsCardBackground.clearXhsCardBackground());

ipcMain.handle('select-device-transfer-import-package', async () => {
  const mainWindow = getMainWindow();
  try {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择 Knowly 会员数据备份包',
      filters: [
        { name: 'Knowly 备份包', extensions: ['backup'] },
        { name: '所有文件', extensions: ['*'] },
      ],
      properties: ['openFile']
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { success: false, message: '用户取消了操作' };
    }
    return { success: true, path: result.filePaths[0] };
  } catch (error) {
    log.error('选择会员数据备份包失败:', error);
    return { success: false, message: error.message };
  }
});

ipcMain.handle('get-offline-pack-export-path', async () => {
  const mainWindow = getMainWindow();
  try {
    const downloads = app.getPath('downloads');
    fs.mkdirSync(downloads, { recursive: true });
    const now = new Date();
    const twoDigits = value => String(value).padStart(2, '0');
    const timestamp = `${now.getFullYear()}${twoDigits(now.getMonth() + 1)}${twoDigits(now.getDate())}-${twoDigits(now.getHours())}${twoDigits(now.getMinutes())}`;
    const defaultPath = path.join(downloads, `Knowly离线模型包-${timestamp}.zip`);
    const result = await dialog.showSaveDialog(mainWindow, {
      title: '导出离线模型包',
      defaultPath,
      filters: [
        { name: '离线模型包', extensions: ['zip'] },
        { name: '所有文件', extensions: ['*'] },
      ],
    });
    if (result.canceled || !result.filePath) {
      return { success: false, cancelled: true };
    }
    return { success: true, path: result.filePath };
  } catch (error) {
    log.error('选择离线模型包导出路径失败:', error);
    return { success: false, message: error.message };
  }
});

ipcMain.handle('select-offline-pack-import-package', async () => {
  const mainWindow = getMainWindow();
  try {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择 Knowly 离线模型包',
      filters: [
        { name: '离线模型包', extensions: ['zip'] },
        { name: '所有文件', extensions: ['*'] },
      ],
      properties: ['openFile'],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { success: false, cancelled: true };
    }
    return { success: true, path: result.filePaths[0] };
  } catch (error) {
    log.error('选择离线模型包失败:', error);
    return { success: false, message: error.message };
  }
});

module.exports = {
  // 这个模块通过直接注册ipcMain处理器来工作
  // 不需要导出任何函数
};
