const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('voxshift', {
  isDesktop: true,
  platform: process.platform,
});
