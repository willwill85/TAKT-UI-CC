#!/usr/bin/env bash
# Builds the native macOS desktop shell (WKWebView + SwiftTerm terminal) into build/TAKT-UI-CC.app
# Requires Xcode command line tools (xcode-select --install). First build downloads SwiftTerm.
set -euo pipefail
. "$(dirname "$0")/_common.sh"
[ "$(uname)" = "Darwin" ] || { fail "The desktop app is macOS only. On other systems open http://127.0.0.1:$TAKT_PORT in a browser."; exit 1; }
command -v swift >/dev/null || { fail "swift not found — install Xcode or: xcode-select --install"; exit 1; }

APP_NAME="TAKT-UI-CC"
OUT="$REPO_ROOT/build/$APP_NAME.app"
cd "$REPO_ROOT/desktop"

c_green "== swift build (release) =="
swift build -c release
BIN="$(swift build -c release --show-bin-path)/TAKTAI"
[ -x "$BIN" ] || { fail "build produced no binary"; exit 1; }

rm -rf "$OUT"
mkdir -p "$OUT/Contents/MacOS" "$OUT/Contents/Resources"
cp "$BIN" "$OUT/Contents/MacOS/TAKTAI"
cp "$REPO_ROOT/desktop/Resources/AppIcon.icns" "$OUT/Contents/Resources/AppIcon.icns"

cat >"$OUT/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleExecutable</key><string>TAKTAI</string>
    <key>CFBundleIconFile</key><string>AppIcon</string>
    <key>CFBundleIdentifier</key><string>dev.takt.takt-ui-cc</string>
    <key>CFBundleName</key><string>$APP_NAME</string>
    <key>CFBundleDisplayName</key><string>$APP_NAME</string>
    <key>CFBundlePackageType</key><string>APPL</string>
    <key>CFBundleShortVersionString</key><string>1.0.0</string>
    <key>LSMinimumSystemVersion</key><string>13.0</string>
    <key>NSHighResolutionCapable</key><true/>
    <key>TAKTRepoPath</key><string>$REPO_ROOT</string>
    <key>NSAppTransportSecurity</key>
    <dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict>
</plist>
PLIST

codesign --force --deep --sign - "$OUT" >/dev/null 2>&1 && ok "ad-hoc signed" || warn "codesign skipped"
ok "built: $OUT"
echo
echo "Install:  cp -R \"$OUT\" /Applications/   (the app remembers this checkout: $REPO_ROOT)"
echo "First launch: right-click → Open (the app is ad-hoc signed, not notarized)."
