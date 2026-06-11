# Macrobiótica Eccos POS — Desktop wrapper

Thin Electron shell around the live web app at <https://myposcr.web.app>.
Because it loads the live URL, all POS features/data update automatically when
the web app is deployed — you only rebuild this installer if the wrapper itself
(window behavior, icon) changes.

## Release a new Windows installer

1. Bump `version` in `package.json`.
2. Tag and push:
   ```bash
   git tag v1.0.1
   git push origin v1.0.1
   ```
3. GitHub Actions builds the `.exe` on a Windows runner and publishes a
   **Release** with the installer attached. Download link lives under the repo's
   **Releases** page. (Manual builds: run the workflow from the **Actions** tab —
   the `.exe` is uploaded as a workflow artifact.)

Installer is **unsigned**: Windows shows a one-time SmartScreen warning →
"Más información" → "Ejecutar de todas formas".

## Run locally

```bash
npm install
npm start
```

## macOS note

A packaged `.dmg` does **not** run on macOS 26 without a paid Apple Developer ID
(ad-hoc re-signing loses the `linker-signed` trust that macOS 26 requires for JIT).
On the developer's Mac the app runs via a local launcher that invokes the dev
Electron binary directly. The store runs Windows, so the `.exe` is the real target.
