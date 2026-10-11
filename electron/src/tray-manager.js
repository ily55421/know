const { Tray, Menu, app, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const { log } = require('./config');
const { presentMainWindow } = require('./window-manager');

let tray = null;

const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');

function add2xRepresentation(image1x, path2x) {
  if (!fs.existsSync(path2x)) {
    return image1x;
  }
  const image2x = nativeImage.createFromPath(path2x);
  const size2x = image2x.getSize();
  if (size2x.width <= 0 || size2x.height <= 0) {
    return image1x;
  }
  image1x.addRepresentation({
    scaleFactor: 2,
    width: size2x.width,
    height: size2x.height,
    buffer: image2x.toPNG(),
  });
  return image1x;
}

function loadMacTrayIcon() {
  const path1x = path.join(PUBLIC_DIR, 'tray_app.png');
  const path2x = path.join(PUBLIC_DIR, 'tray_app@2x.png');
  if (!fs.existsSync(path1x)) {
    return null;
  }
  const image = nativeImage.createFromPath(path1x);
  if (image.isEmpty()) {
    return null;
  }
  return add2xRepresentation(image, path2x);
}

function loadWinTrayIcon() {
  const icoPath = path.join(PUBLIC_DIR, 'favicon.ico');
  if (!fs.existsSync(icoPath)) {
    return null;
  }
  const image = nativeImage.createFromPath(icoPath);
  return image.isEmpty() ? null : image;
}

function loadTrayIcon() {
  if (process.platform === 'win32') {
    return loadWinTrayIcon();
  }
  return loadMacTrayIcon();
}

function trayIconSourceLabel() {
  if (process.platform === 'win32') {
    return path.join(PUBLIC_DIR, 'favicon.ico');
  }
  return path.join(PUBLIC_DIR, 'tray_app.png (+@2x)');
}

// 添加托盘图标，允许用户从托盘中恢复窗口或退出应用
function createTray() {
  const trayIcon = loadTrayIcon();
  if (!trayIcon || trayIcon.isEmpty()) {
    log.error(`托盘图标加载失败: ${trayIconSourceLabel()}`);
    return null;
  }

  log.info(`使用托盘图标: ${trayIconSourceLabel()}`);

  try {
    tray = new Tray(trayIcon);
    setupTray(tray);
    return tray;
  } catch (error) {
    log.error(`创建托盘图标失败: ${error.message}`);
    return null;
  }
}

// 设置托盘图标菜单和行为
function setupTray(trayInstance) {
  const contextMenu = Menu.buildFromTemplate([
    {
      label: '显示窗口',
      click: () => {
        presentMainWindow('tray-menu');
      },
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        app.isQuitting = true;
        destroyTray();
        app.quit();
      },
    },
  ]);

  trayInstance.setToolTip('Knowly');
  trayInstance.setContextMenu(contextMenu);

  trayInstance.on('click', () => {
    presentMainWindow('tray-click');
  });
}

function getTray() {
  return tray;
}

function destroyTray() {
  if (tray) {
    tray.destroy();
    tray = null;
  }
}

module.exports = {
  createTray,
  getTray,
  destroyTray,
};
