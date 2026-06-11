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
  await sign({
    app: appPath,
    identity: '-',            // ad-hoc
    identityValidation: false, // don't look up a real cert; '-' is ad-hoc
    platform: 'darwin',
    hardenedRuntime: false,   // ad-hoc can't satisfy hardened-runtime JIT checks
    preAutoEntitlements: true,
  });
  console.log('  • signed with @electron/osx-sign (ad-hoc)');
};
