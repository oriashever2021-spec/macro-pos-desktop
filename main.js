const { app, BrowserWindow, Menu, dialog, shell, ipcMain } = require('electron');
const { execFile, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

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

function isThermalPrinter(p) {
  return /epson|tm.?t20|thermal|recib|tirilla|facturas/i.test(`${p.name} ${p.displayName || ''}`);
}

async function thermalPrinterName(webContents, fallbackName = '') {
  try {
    const printers = await webContents.getPrintersAsync();
    const thermal = printers.find(isThermalPrinter);
    if (thermal) return thermal.name;
  } catch {}
  return fallbackName;
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
      preload: path.join(__dirname, 'preload.js'),
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

// Receipt printing with a real preview. The web app hands us the receipt HTML;
// we render it to a PDF off-screen and open that PDF in a viewer window
// (Chromium's built-in PDF viewer = visible preview + print + save), which the
// plain Electron print dialog does not offer. Returns true on success so the
// web app can fall back to its own in-app print path if anything here fails.
ipcMain.handle('eccos-print-receipt', async (_evt, payload) => {
  const html = payload && payload.html;
  const title = (payload && payload.title) || 'Factura';
  if (!html) return false;

  let renderWin = null;
  try {
    // Off-screen window to lay out the receipt, then SILENT-print it directly —
    // one click, no preview/dialog. Auto-targets the thermal printer (Epson TM)
    // so it doesn't matter what the system default is (reports still use it).
    renderWin = new BrowserWindow({
      show: false,
      width: 360, // ~80mm at 96dpi so the receipt lays out at its true width
      height: 1200,
      webPreferences: { contextIsolation: true, nodeIntegration: false },
    });
    await renderWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    await new Promise((r) => setTimeout(r, 200)); // let layout settle

    // Pick the thermal printer by name (Epson / TM-T20 / thermal). Empty string
    // falls back to the system default printer.
    const deviceName = await thermalPrinterName(renderWin.webContents);

    // Force an 80mm-wide page sized to the receipt's real height. Without an explicit
    // pageSize, silent print falls back to the printer's default (Letter) and the 80mm
    // receipt came out shrunk into a corner. 96dpi → microns: px / 96 * 25400.
    let heightMicrons = 200000; // fallback ~200mm if measuring fails
    try {
      const px = await renderWin.webContents.executeJavaScript(
        'Math.ceil(Math.max(document.body.scrollHeight, document.documentElement.scrollHeight))'
      );
      if (px > 0) heightMicrons = Math.min(1200000, Math.max(40000, Math.ceil((px / 96) * 25400) + 4000));
    } catch {}

    const ok = await new Promise((resolve) => {
      renderWin.webContents.print(
        {
          silent: true,
          deviceName,
          printBackground: true,
          margins: { marginType: 'none' },
          scaleFactor: 100,                                   // no shrink-to-fit
          pageSize: { width: 80000, height: heightMicrons },  // 80mm × content height (microns)
        },
        (success, failureReason) => { if (!success) console.error('print failed:', failureReason); resolve(success); }
      );
    });

    renderWin.destroy();
    renderWin = null;
    return ok; // false → web side falls back to its own print path
  } catch (err) {
    console.error('eccos-print-receipt failed:', err);
    try { if (renderWin) renderWin.destroy(); } catch {}
    return false;
  }
});


// Print the CURRENT app page (already styled for print). Reports go SILENTLY to
// the "office" printer (the non-thermal one) so they never depend on whatever the
// OS default happens to be — mirroring how the receipt path names the thermal
// printer. This is what makes the two buttons truly hands-off: 🧾 → thermal,
// 🖨️ → office printer, no dialog, no "Last Printer Used" drift. If no office
// printer exists on this machine (e.g. a dev box with only the Epson), we fall
// back to rendering a PDF and opening the viewer so the user can still print.
ipcMain.handle('eccos-print-page', async (_evt, opts) => {
  const title = (opts && opts.title) || 'Reporte';
  const landscape = !!(opts && opts.landscape);
  if (!win) return false;

  // Find the office printer = the OS default if it isn't the thermal one,
  // otherwise the first non-thermal printer. Auto-adapts per machine, nothing
  // hardcoded (your HP at home, her office printer at the store).
  let officeName = '';
  try {
    const printers = await win.webContents.getPrintersAsync();
    const nonThermal = printers.filter((p) => !isThermalPrinter(p));
    const sysDefault = printers.find((p) => p.isDefault);
    const office = (sysDefault && !isThermalPrinter(sysDefault)) ? sysDefault : nonThermal[0] || null;
    if (office) officeName = office.name;
  } catch {}

  // Preferred path: silent direct print to the office printer — no dialog, no drift.
  if (officeName) {
    try {
      const ok = await new Promise((resolve) => {
        win.webContents.print(
          { silent: true, deviceName: officeName, landscape, printBackground: false },
          (success, failureReason) => { if (!success) console.error('print-page failed:', failureReason); resolve(success); }
        );
      });
      if (ok) return true; // done — printed straight to the office printer
    } catch (err) { console.error('eccos-print-page silent print error:', err); }
    // fall through to the PDF viewer if the silent print didn't go
  }

  try {
    const pdf = await win.webContents.printToPDF({
      printBackground: false,      // reports print on white, like the browser default
      preferCSSPageSize: true,     // honor the injected @page { size: A4 landscape/portrait; margin }
    });
    const safeName = (String(title).replace(/[\/\\:*?"<>|]+/g, '').trim() || 'Reporte').slice(0, 90);
    const file = path.join(os.tmpdir(), `${safeName}.pdf`);
    fs.writeFileSync(file, pdf);

    const viewer = new BrowserWindow({
      width: landscape ? 1024 : 760,
      height: 860,
      title,
      parent: win || undefined,
      autoHideMenuBar: true,
      backgroundColor: '#525659',
      webPreferences: { plugins: true },
    });
    viewer.setMenuBarVisibility(false);
    await viewer.loadFile(file);
    // Bring the POS window back to the front when the viewer closes, so the
    // user doesn't get dropped behind other apps / has to click the dock icon.
    viewer.on('closed', () => {
      try { fs.unlinkSync(file); } catch {}
      try { if (win && !win.isDestroyed()) { win.show(); win.focus(); } } catch {}
    });
    return true;
  } catch (err) {
    console.error('eccos-print-page failed:', err);
    return false;
  }
});

// ── Cash-drawer kick ─────────────────────────────────────────────────────────
// A drawer opens on the ESC/POS pulse 1B 70 00 19 FA sent to the thermal printer.
// HTML printing (webContents.print) can't carry raw control codes, so this goes
// straight to the spooler as RAW bytes (Windows winspool / macOS `lp -o raw`).
// The web app invokes this ONLY on efectivo sales; card/SINPE/crédito never call it.
const DRAWER_PULSE = Buffer.from([0x1b, 0x70, 0x00, 0x19, 0xfa]);

function rawPrintWindows(deviceName, buffer, jobName) {
  const b64 = buffer.toString('base64');
  const script = `
$printerName = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(deviceName, 'utf8').toString('base64')}'))
$jobName = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(jobName, 'utf8').toString('base64')}'))
$bytes = [Convert]::FromBase64String('${b64}')
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class RawPrinter {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Ansi)]
  public class DOCINFOA {
    [MarshalAs(UnmanagedType.LPStr)] public string pDocName;
    [MarshalAs(UnmanagedType.LPStr)] public string pOutputFile;
    [MarshalAs(UnmanagedType.LPStr)] public string pDataType;
  }
  [DllImport("winspool.Drv", EntryPoint="OpenPrinterA", SetLastError=true, CharSet=CharSet.Ansi, ExactSpelling=true, CallingConvention=CallingConvention.StdCall)]
  public static extern bool OpenPrinter(string szPrinter, out IntPtr hPrinter, IntPtr pd);
  [DllImport("winspool.Drv", EntryPoint="ClosePrinter", SetLastError=true, ExactSpelling=true, CallingConvention=CallingConvention.StdCall)]
  public static extern bool ClosePrinter(IntPtr hPrinter);
  [DllImport("winspool.Drv", EntryPoint="StartDocPrinterA", SetLastError=true, CharSet=CharSet.Ansi, ExactSpelling=true, CallingConvention=CallingConvention.StdCall)]
  public static extern bool StartDocPrinter(IntPtr hPrinter, Int32 level, [In, MarshalAs(UnmanagedType.LPStruct)] DOCINFOA di);
  [DllImport("winspool.Drv", EntryPoint="EndDocPrinter", SetLastError=true, ExactSpelling=true, CallingConvention=CallingConvention.StdCall)]
  public static extern bool EndDocPrinter(IntPtr hPrinter);
  [DllImport("winspool.Drv", EntryPoint="StartPagePrinter", SetLastError=true, ExactSpelling=true, CallingConvention=CallingConvention.StdCall)]
  public static extern bool StartPagePrinter(IntPtr hPrinter);
  [DllImport("winspool.Drv", EntryPoint="EndPagePrinter", SetLastError=true, ExactSpelling=true, CallingConvention=CallingConvention.StdCall)]
  public static extern bool EndPagePrinter(IntPtr hPrinter);
  [DllImport("winspool.Drv", EntryPoint="WritePrinter", SetLastError=true, ExactSpelling=true, CallingConvention=CallingConvention.StdCall)]
  public static extern bool WritePrinter(IntPtr hPrinter, byte[] pBytes, Int32 dwCount, out Int32 dwWritten);
}
"@
$handle = [IntPtr]::Zero
if (-not [RawPrinter]::OpenPrinter($printerName, [ref]$handle, [IntPtr]::Zero)) { throw "OpenPrinter failed: $printerName" }
try {
  $doc = New-Object RawPrinter+DOCINFOA
  $doc.pDocName = $jobName
  $doc.pDataType = "RAW"
  if (-not [RawPrinter]::StartDocPrinter($handle, 1, $doc)) { throw "StartDocPrinter failed" }
  if (-not [RawPrinter]::StartPagePrinter($handle)) { throw "StartPagePrinter failed" }
  [int]$written = 0
  if (-not [RawPrinter]::WritePrinter($handle, $bytes, $bytes.Length, [ref]$written)) { throw "WritePrinter failed" }
  [RawPrinter]::EndPagePrinter($handle) | Out-Null
  [RawPrinter]::EndDocPrinter($handle) | Out-Null
} finally {
  if ($handle -ne [IntPtr]::Zero) { [RawPrinter]::ClosePrinter($handle) | Out-Null }
}
`;
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (c) => { stderr += c.toString(); });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(stderr.trim() || `PowerShell exited ${code}`))));
  });
}

function rawPrintMac(deviceName, buffer, jobName) {
  const file = path.join(os.tmpdir(), `${(jobName || 'job').replace(/[^\w.-]+/g, '_')}.bin`);
  fs.writeFileSync(file, buffer);
  return new Promise((resolve, reject) => {
    const args = ['-o', 'raw', '-t', jobName, ...(deviceName ? ['-d', deviceName] : []), file];
    const child = spawn('lp', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (c) => { stderr += c.toString(); });
    child.on('error', reject);
    child.on('close', (code) => { try { fs.unlinkSync(file); } catch {} (code === 0 ? resolve() : reject(new Error(stderr.trim() || `lp exited ${code}`))); });
  });
}

ipcMain.handle('eccos-open-drawer', async () => {
  try {
    const wc = (win && win.webContents) || null;
    const deviceName = wc ? await thermalPrinterName(wc) : '';
    if (!deviceName) { console.error('open-drawer: no thermal printer found'); return false; }
    if (process.platform === 'win32') await rawPrintWindows(deviceName, DRAWER_PULSE, 'Eccos abrir gaveta');
    else if (process.platform === 'darwin') await rawPrintMac(deviceName, DRAWER_PULSE, 'Eccos abrir gaveta');
    else return false;
    return true;
  } catch (err) {
    console.error('eccos-open-drawer failed:', err);
    return false;
  }
});

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
