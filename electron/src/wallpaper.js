const { createLocalImageAsset } = require('./local-image-asset');

const wallpaper = createLocalImageAsset({
  storeKey: 'wallpaperRelativePath',
  fileStem: 'wallpaper',
  dialogTitle: '选择皮肤图片',
  logName: '皮肤',
});

module.exports = {
  getWallpaper: () => wallpaper.get(),
  setWallpaper: () => wallpaper.set(),
  clearWallpaper: () => wallpaper.clear(),
};
