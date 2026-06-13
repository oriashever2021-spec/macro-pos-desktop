const { contextBridge, ipcRenderer } = require('electron');

// Minimal, safe bridge exposed to the web app (myposcr.web.app) running inside
// the desktop wrapper. The web app feature-detects `window.eccosPrint`: when it
// exists (this desktop build) it hands the receipt HTML to the main process,
// which renders a PDF and opens it in a real preview window (Chromium's PDF
// viewer = preview + print + save). In any plain browser, or an older desktop
// build without this preload, `window.eccosPrint` is undefined and the web app
// falls back to its built-in print path — so nothing breaks either way.
contextBridge.exposeInMainWorld('eccosPrint', {
  isDesktop: true,
  // Returns a promise that resolves true if the PDF preview window opened, or
  // false if it failed (so the web app can fall back to its own print path).
  printReceipt: (html, title) => ipcRenderer.invoke('eccos-print-receipt', { html, title }),
});
