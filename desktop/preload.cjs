// -*- coding: utf-8 -*-
// 预加载脚本：只向页面暴露最小、显式的能力面。

'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const api = {
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
  getEnv: function () { return ipcRenderer.invoke('memora:env'); },
  openDevTools: function () { return ipcRenderer.invoke('memora:open-devtools'); },
  restartBackend: function () { return ipcRenderer.invoke('memora:restart-backend'); },
  retryBackend: function () { return ipcRenderer.invoke('memora:restart-backend'); },
  openLogs: function () { return ipcRenderer.invoke('memora:open-logs'); },
  openDataDir: function () { return ipcRenderer.invoke('memora:open-data'); },
  copyMcpConfig: function () { return ipcRenderer.invoke('memora:copy-mcp'); },
};

contextBridge.exposeInMainWorld('memora', api);
