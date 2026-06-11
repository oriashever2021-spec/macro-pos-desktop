const { app, BrowserWindow, Menu, dialog, shell } = require('electron');
const path = require('path');

const APP_URL = 'https://myposcr.web.app';
// Hosts the app is allowed to navigate to in-window (the app + Firebase auth/hosting).
// Anything else (mailto:, tel:, external sites) opens in the system browser instead.
const ALLOWED_HOSTS = ['myposcr.web.app', 'myposcr.firebaseapp.com'];

let win = null;
let quitting = false; // set true once the user has confirmed they want to close

function askToClose() {
  const choice = dialog.showMessageBoxSync(win, {
    type: 'question',
    buttons: ['Cancelar', 'Cerrar sistema'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    title: 'Cerrar',
    message: '¿Cerrar el sistema de punto de venta?',
    detail: 'La aplicación se cerrará. Asegúrese de haber terminado la venta en curso.',
  });
  return choice === 1;
}

function isAllowed(url) {
  try { return ALLOWED_HOSTS.includes(new URL(url).hostname); } catch { return false; }
}

function showOfflineScreen() {
  const html =
    '<!doctype html><html lang="es"><head><meta charset="utf-8">' +
    '<style>html,body{height:100%;margin:0;font-family:-apple-system,Segoe UI,Roboto,sans-serif;' +
    'background:#a32a22;color:#fff;display:flex;align-items:center;justify-content:center}' +
    '.box{text-align:center;max-width:480px;padding:32px}h1{font-size:24px;margin:0 0 10px}' +
    'p{opacity:.9;line-height:1.5}button{margin-top:22px;font-size:18px;font-weight:700;' +
    'padding:14px 28px;border:0;border-radius:12px;background:#fff;color:#a32a22;cursor:pointer}' +
    '</style></head><body><div class="box"><h1>Sin conexión a internet</h1>' +
    '<p>No se pudo conectar con el sistema. Revise el wifi o el cable de red y vuelva a intentar.</p>' +
    '<button onclick="location.href=\'' + APP_URL + '\'">Reintentar</button>' +
    '</div></body></html>';
  win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
}

function createWindow() {
  win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#a32a22',
    autoHideMenuBar: true, // hide menu bar on Windows/Linux until Alt is pressed
    icon: path.join(__dirname, 'build', 'icon.png'),
    title: 'Macrobiótica Eccos POS',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.maximize();
  win.show();
  win.loadURL(APP_URL);

  // Open external links / non-app navigation in the system browser, never in-window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!isAllowed(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!isAllowed(url)) { e.preventDefault(); shell.openExternal(url); }
  });

  // Friendly offline screen instead of Chromium's error page.
  win.webContents.on('did-fail-load', (e, errorCode, _desc, validatedURL, isMainFrame) => {
    // -3 = aborted (e.g. redirect); ignore, and ignore data: URLs (the offline screen itself).
    if (isMainFrame && errorCode !== -3 && !String(validatedURL).startsWith('data:')) showOfflineScreen();
  });

  // Confirm before the window closes (X button, Alt+F4, Ctrl+W).
  win.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    if (askToClose()) { quitting = true; win.close(); }
  });
}

// Minimal Spanish menu — keeps reload/fullscreen reachable without exposing the full default menu.
function buildMenu() {
  const template = [];
  if (process.platform === 'darwin') {
    template.push({
      label: app.name,
      submenu: [
        { role: 'about', label: 'Acerca de' },
        { type: 'separator' },
        { role: 'hide', label: 'Ocultar' },
        { role: 'quit', label: 'Salir' },
      ],
    });
  }
  template.push({
    label: 'Ver',
    submenu: [
      { label: 'Recargar', accelerator: 'CmdOrCtrl+R', click: () => win && win.loadURL(APP_URL) },
      { label: 'Pantalla completa', accelerator: 'F11', click: () => win && win.setFullScreen(!win.isFullScreen()) },
      { type: 'separator' },
      { label: 'Herramientas de desarrollo', accelerator: 'CmdOrCtrl+Alt+I', visible: false, click: () => win && win.webContents.toggleDevTools() },
    ],
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// Auto-update (Windows installed builds only). Checks the GitHub Release for a
// newer version, asks the user before downloading and again before installing.
// Skipped in dev and on macOS (the Mac build is unpackaged + unsigned).
function setupAutoUpdate() {
  if (!app.isPackaged || process.platform !== 'win32') return;
  let autoUpdater;
  try { ({ autoUpdater } = require('electron-updater')); } catch { return; }
  autoUpdater.autoDownload = false;            // ask before downloading
  autoUpdater.autoInstallOnAppQuit = false;

  autoUpdater.on('update-available', (info) => {
    dialog.showMessageBox(win, {
      type: 'info', noLink: true, buttons: ['Descargar ahora', 'Más tarde'], defaultId: 0, cancelId: 1,
      title: 'Actualización disponible',
      message: `Hay una nueva versión disponible (${info.version}).`,
      detail: 'Puede descargarla ahora. Se instalará cuando reinicie la aplicación.',
    }).then((r) => { if (r.response === 0) autoUpdater.downloadUpdate().catch(() => {}); });
  });

  autoUpdater.on('update-downloaded', (info) => {
    dialog.showMessageBox(win, {
      type: 'info', noLink: true, buttons: ['Reiniciar e instalar', 'Al cerrar'], defaultId: 0, cancelId: 1,
      title: 'Actualización lista',
      message: `La versión ${info.version} está lista.`,
      detail: 'La aplicación se reiniciará para terminar de instalarla.',
    }).then((r) => {
      if (r.response === 0) { quitting = true; autoUpdater.quitAndInstall(); }
      else { autoUpdater.autoInstallOnAppQuit = true; } // otherwise install on next close
    });
  });

  autoUpdater.on('error', (err) => { console.error('auto-update error:', err); });

  autoUpdater.checkForUpdates().catch(() => {});
  // Re-check every 6 hours for machines left running for days.
  setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 6 * 60 * 60 * 1000);
}

// Single-instance: focus the existing window instead of opening a second copy.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });

  app.whenReady().then(() => {
    // Show the Eccos logo in the macOS Dock (the bundle icon belongs to Electron
    // when launched in unpackaged mode, so set it at runtime).
    if (process.platform === 'darwin' && app.dock) {
      try { app.dock.setIcon(path.join(__dirname, 'build', 'icon.png')); } catch {}
    }
    buildMenu();
    createWindow();
    setupAutoUpdate();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });

  // Confirm on Cmd+Q (macOS app quit) the same way as closing the window.
  app.on('before-quit', (e) => {
    if (quitting) return;
    e.preventDefault();
    if (askToClose()) { quitting = true; app.quit(); }
  });

  app.on('window-all-closed', () => app.quit());
}
