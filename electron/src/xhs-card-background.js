const { createLocalImageAsset } = require('./local-image-asset');

const xhsCardBackground = createLocalImageAsset({
  storeKey: 'xhsCardBackgroundRelativePath',
  fileStem: 'xhs-card-bg',
  dialogTitle: '选择卡片背景图片',
  logName: '小红书卡片背景',
});

module.exports = {
  getXhsCardBackground: () => xhsCardBackground.get(),
  setXhsCardBackground: () => xhsCardBackground.set(),
  clearXhsCardBackground: () => xhsCardBackground.clear(),
};
