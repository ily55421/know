const ZOOM_PERCENT_STEP = 10;
const MIN_ZOOM_PERCENT = 50;
const MAX_ZOOM_PERCENT = 300;

function clampZoomPercent(percent) {
  return Math.min(MAX_ZOOM_PERCENT, Math.max(MIN_ZOOM_PERCENT, percent));
}

function getCurrentZoomPercent(webContents) {
  return Math.round(webContents.getZoomFactor() * 100);
}

function getPageZoomState(webContents) {
  if (!webContents || webContents.isDestroyed()) {
    return { success: false, message: '窗口不可用' };
  }

  const level = webContents.getZoomLevel();
  return {
    success: true,
    level,
    percent: getCurrentZoomPercent(webContents),
  };
}

function notifyPageZoomChanged(webContents, state) {
  if (!webContents || webContents.isDestroyed() || !state.success) {
    return;
  }
  webContents.send('page-zoom-changed', state);
}

function setPageZoom(webContents, action) {
  if (!webContents || webContents.isDestroyed()) {
    return { success: false, message: '窗口不可用' };
  }

  const currentPercent = getCurrentZoomPercent(webContents);
  let nextPercent = currentPercent;
  if (action === 'in') {
    nextPercent = currentPercent + ZOOM_PERCENT_STEP;
  } else if (action === 'out') {
    nextPercent = currentPercent - ZOOM_PERCENT_STEP;
  } else if (action === 'reset') {
    nextPercent = 100;
  } else {
    return { success: false, message: '缩放操作无效' };
  }

  webContents.setZoomFactor(clampZoomPercent(nextPercent) / 100);
  const state = getPageZoomState(webContents);
  notifyPageZoomChanged(webContents, state);
  return state;
}

function getShortcutAction(input) {
  if (!input || input.type !== 'keyDown') {
    return null;
  }

  const hasCommandModifier = process.platform === 'darwin'
    ? input.meta
    : input.control;
  if (!hasCommandModifier || input.alt) {
    return null;
  }

  const key = String(input.key || '').toLowerCase();
  const code = String(input.code || '');
  if (key === '+' || key === '=' || code === 'NumpadAdd') {
    return 'in';
  }
  if (key === '-' || code === 'NumpadSubtract') {
    return 'out';
  }
  if (key === '0' || code === 'Numpad0') {
    return 'reset';
  }
  return null;
}

function installPageZoomShortcuts(browserWindow) {
  if (!browserWindow || !browserWindow.webContents) {
    return;
  }

  browserWindow.webContents.on('before-input-event', (event, input) => {
    const action = getShortcutAction(input);
    if (!action) {
      return;
    }
    event.preventDefault();
    setPageZoom(browserWindow.webContents, action);
  });
}

module.exports = {
  getPageZoomState,
  installPageZoomShortcuts,
  setPageZoom,
};
