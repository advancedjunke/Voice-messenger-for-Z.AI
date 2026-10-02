const { app, BrowserWindow, session } = require('electron');
const path = require('path');
const fs = require('fs');

// 1. Single Instance Lock (prevents multiple windows from opening)
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
  process.exit(0);
}

let mainWindow = null;

const http = require('http');
const CLOUD_URL = 'https://f2f9c29f9c574a2c-217-199-233-97.serveousercontent.com';

function checkLocalServer(callback) {
  const req = http.get('http://localhost:3001/health', (res) => {
    callback(res.statusCode === 200);
  });
  req.on('error', () => callback(false));
  req.setTimeout(250, () => {
    req.destroy();
    callback(false);
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 750,
    minWidth: 850,
    minHeight: 600,
    title: 'Voice Messenger',
    icon: path.join(__dirname, '../assets/icon.png'),
    backgroundColor: '#0b0f19',
    show: false, // Prevents window flickering while page is loading
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  // Automatically grant microphone permissions for WebRTC calls
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    if (permission === 'media') {
      return callback(true);
    }
    callback(true);
  });

  // Smooth appearance once content is parsed — no flickering!
  mainWindow.once('ready-to-show', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });

  // Load the local UI directly from disk with resolved server query
  const localHtmlPath = path.join(__dirname, '../client/dist/index.html');
  if (fs.existsSync(localHtmlPath)) {
    checkLocalServer((isLocalRunning) => {
      const serverTarget = isLocalRunning ? 'http://localhost:3001' : CLOUD_URL;
      console.log('✅ Resolved server target:', serverTarget);
      if (mainWindow) {
        mainWindow.loadFile(localHtmlPath, { query: { server: serverTarget } });
      }
    });
  } else {
    // Development fallback
    mainWindow.loadURL('http://localhost:5173');
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// When another instance is launched, focus the existing window instead of creating a new one
app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
