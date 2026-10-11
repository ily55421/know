const { contextBridge, ipcRenderer, webUtils } = require('electron');

const listen = (channel, callback) => {
  const listener = (event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

// 向渲染进程公开API
contextBridge.exposeInMainWorld('electronAPI', {
  // 文件夹操作
  selectDirectory: () => ipcRenderer.invoke('select-directory'),
  selectFiles: (options) => ipcRenderer.invoke('select-files', options),
  listFilesInDirectory: (directory, extensions) => ipcRenderer.invoke('list-files-in-directory', directory, extensions),
  // 选择 HTML 应用来源：kind 为 file | directory
  selectAppSource: (kind) => ipcRenderer.invoke('select-app-source', kind),
  /** Electron 32+ 拖放文件取本地路径（替代已移除的 File.path） */
  getPathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file) || '';
    } catch {
      return '';
    }
  },

  // 配置操作
  saveConfig: (config) => ipcRenderer.invoke('save-config', config),
  getConfig: () => ipcRenderer.invoke('get-config'),

  // 用户反馈
  submitFeedback: (data) => ipcRenderer.invoke('submit-feedback', data),

  // 公告功能
  getAnnouncements: () => ipcRenderer.invoke('get-announcements'),

  // 邀请码验证
  verifyInviteCode: (inviteCode) => ipcRenderer.invoke('verify-invite-code', inviteCode),

  // 云函数调用
  callCloudFunction: (functionName, params) => ipcRenderer.invoke('call-cloud-function', functionName, params),

  // 事件监听
  onPythonReady: (callback) => {
    return listen('python-ready', callback);
  },
  onPythonError: (callback) => {
    return listen('python-error', callback);
  },
  onPythonPreparing: (callback) => {
    return listen('python-preparing', callback);
  },
  onOpenChatSession: (callback) => {
    return listen('open-chat-session', callback);
  },
  onSchedulerTaskFinished: (callback) => {
    return listen('scheduler-task-finished', callback);
  },
  onLlmModelsUpdated: (callback) => {
    return listen('llm-models-updated', callback);
  },

  // 自动更新相关
  checkForUpdates: (isManualCheck = true) => ipcRenderer.invoke('check-for-updates', isManualCheck),
  installUpdate: () => ipcRenderer.invoke('install-update'),


  onUpdateAvailable: (callback) => {
    return listen('update-available', callback);
  },
  onUpdateDownloaded: (callback) => {
    return listen('update-downloaded', callback);
  },
  onUpdateNotAvailable: (callback) => {
    return listen('update-not-available', callback);
  },
  onUpdateError: (callback) => {
    return listen('update-error', callback);
  },
  onDownloadProgress: (callback) => {
    return listen('download-progress', callback);
  },

  // 应用信息
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  getIsStoreVersion: () => ipcRenderer.invoke('get-is-store-version'),
  getDeviceId: () => ipcRenderer.invoke('get-device-id'),
  getIsDevMode: () => ipcRenderer.invoke('get-is-dev-mode'),
  getOpenAtLogin: () => ipcRenderer.invoke('get-open-at-login'),
  setOpenAtLogin: (enabled) => ipcRenderer.invoke('set-open-at-login', enabled),
  syncQuotaToCloud: () => ipcRenderer.invoke('sync-quota-to-cloud'),
  getPageZoom: () => ipcRenderer.invoke('get-page-zoom'),
  setPageZoom: (action) => ipcRenderer.invoke('set-page-zoom', action),
  onPageZoomChanged: (callback) => {
    return listen('page-zoom-changed', callback);
  },

  // 外部链接
  openExternalUrl: (url) => ipcRenderer.invoke('open-external-url', url),

  // 与 Electron shell 同名：openPath、showItemInFolder（主进程内实现）
  openPath: (fullPath) => ipcRenderer.invoke('shell-open-path', fullPath),
  showItemInFolder: (fullPath) => ipcRenderer.invoke('shell-show-item-in-folder', fullPath),
  trashItem: (fullPath) => ipcRenderer.invoke('shell-trash-item', fullPath),

  /** macOS Quick Look（qlmanage）；非 mac 由主进程返回不支持 */
  previewFile: (fullPath) => ipcRenderer.invoke('preview-file', fullPath),

  // 在系统终端中打开并执行命令（支持 sudo/交互）
  openExternalTerminal: (options) => ipcRenderer.invoke('open-external-terminal', options),

  // 软件诊断
  exportLogs: () => ipcRenderer.invoke('export-logs'),
  runNetworkDiagnostics: () => ipcRenderer.invoke('run-network-diagnostics'),

  // 剪贴板操作
  clipboardWriteText: (text) => ipcRenderer.invoke('clipboard-write-text', text),
  clipboardWriteHTML: (html, text) => ipcRenderer.invoke('clipboard-write-html', html, text),
  clipboardWriteImage: (dataUrl) => ipcRenderer.invoke('clipboard-write-image', dataUrl),

  // 专用图片导出（小红书图文等）：隐藏窗口 HTML 截图 + 写文件
  captureHtmlToPng: (payload) => ipcRenderer.invoke('capture-html-to-png', payload),
  pickImageExportTarget: (payload) => ipcRenderer.invoke('pick-image-export-target', payload),
  exportImageFiles: (payload) => ipcRenderer.invoke('export-image-files', payload),
  saveImageResult: (payload) => ipcRenderer.invoke('save-image-result', payload),

  // 会员数据备份与恢复
  getDeviceTransferExportPath: () => ipcRenderer.invoke('get-device-transfer-export-path'),
  selectDeviceTransferImportPackage: () => ipcRenderer.invoke('select-device-transfer-import-package'),

  // 离线模型包
  getOfflinePackExportPath: () => ipcRenderer.invoke('get-offline-pack-export-path'),
  selectOfflinePackImportPackage: () => ipcRenderer.invoke('select-offline-pack-import-package'),

  getWallpaper: () => ipcRenderer.invoke('get-wallpaper'),
  setWallpaper: () => ipcRenderer.invoke('set-wallpaper'),
  clearWallpaper: () => ipcRenderer.invoke('clear-wallpaper'),

  getXhsCardBackground: () => ipcRenderer.invoke('get-xhs-card-background'),
  setXhsCardBackground: () => ipcRenderer.invoke('set-xhs-card-background'),
  clearXhsCardBackground: () => ipcRenderer.invoke('clear-xhs-card-background'),
});
