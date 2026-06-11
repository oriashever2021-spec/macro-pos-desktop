#!/bin/bash
# Ad-hoc sign an Electron .app INSIDE-OUT, NO hardened runtime.
# Two traps to avoid on Apple Silicon with an ad-hoc (no Developer ID) signature:
#   1. `codesign --deep` mis-signs nested helpers → invalid signature → trap.
#      Fix: sign each nested binary explicitly, inside-out, app last.
#   2. `--options runtime` (hardened runtime) ENFORCES JIT restrictions, but an
#      ad-hoc signature does NOT get the `allow-jit` entitlement honored, so V8
#      traps ~0.5s in when it JITs the page. Fix: do NOT use hardened runtime —
#      then JIT is unrestricted and no entitlements are needed.
set -e
APP="$1"
# On Apple Silicon, V8's JIT needs the allow-jit entitlement PRESENT (it grants
# MAP_JIT) — this is enforced at the OS level regardless of hardened runtime, and
# IS honored for ad-hoc signatures. So we sign WITH the entitlements but WITHOUT
# `--options runtime` (hardened runtime adds restrictions an ad-hoc sig can't meet).
ENT="$(cd "$(dirname "$0")" && pwd)/build/entitlements.mac.plist"
SIGN=(codesign --force --timestamp=none --entitlements "$ENT" --sign -)

echo "Signing nested libraries/frameworks…"
find "$APP/Contents/Frameworks" -type f \( -name "*.dylib" -o -name "*.node" \) -print0 | while IFS= read -r -d '' f; do
  codesign --force --timestamp=none --sign - "$f"
done
for fw in "$APP/Contents/Frameworks/"*.framework; do
  codesign --force --timestamp=none --sign - "$fw"
done

echo "Signing helper apps…"
for h in "$APP/Contents/Frameworks/"*.app; do
  "${SIGN[@]}" "$h/Contents/MacOS/"* 2>/dev/null || true
  "${SIGN[@]}" "$h"
done

echo "Signing main app…"
"${SIGN[@]}" "$APP"

echo "Verifying…"
codesign --verify --strict --verbose=2 "$APP" 2>&1 | tail -3 || true
codesign -dv "$APP" 2>&1 | grep -iE "signature|identifier"
