// Sign the packed macOS app with Electron's OWN signer (@electron/osx-sign),
// ad-hoc. A hand-rolled `codesign` loop verifies fine but breaks V8's JIT at
// runtime (SIGTRAP). @electron/osx-sign knows Electron's nested layout +
// entitlements and produces a working ad-hoc signature. No-op on Windows.
const path = require('path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const { sign } = require('@electron/osx-sign');
  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, `${appName}.app`);
  const entitlements = path.join(__dirname, 'build', 'entitlements.mac.plist');
  // Ad-hoc sign WITH hardened runtime + explicit entitlements. The entitlements
  // (disable-library-validation + allow-jit/unsigned-exec-memory) are what let the
  // ad-hoc, no-Team-ID Electron Framework load on Apple Silicon (otherwise dyld
  // rejects it: "different Team IDs") WITHOUT breaking V8's JIT. preAutoEntitlements
  // off so OUR plist is used, not an auto-generated one that omits the key entitlement.
  await sign({
    app: appPath,
    identity: '-',             // ad-hoc
    identityValidation: false, // don't look up a real cert; '-' is ad-hoc
    platform: 'darwin',
    preAutoEntitlements: false,
    optionsForFile: () => ({ hardenedRuntime: true, entitlements }),
  });
  console.log('  • signed ad-hoc with disable-library-validation entitlements');
};
