'use strict';

const { app, BrowserWindow } = require('electron');

const adminUrl = process.env.BRIDGE_E2E_ADMIN_URL;
if (!adminUrl) throw new Error('BRIDGE_E2E_ADMIN_URL is required');

app.enableSandbox();

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    show: false,
    width: 1024,
    height: 768,
    webPreferences: {
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  try {
    await window.loadURL(adminUrl);
  } catch (error) {
    console.error(error);
  }
});

app.on('window-all-closed', () => {
  app.quit();
});
