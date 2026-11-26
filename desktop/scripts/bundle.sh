#!/usr/bin/env bash
# Builds desktop/target/BrickMotion.app: the release binary, libbmffi beside it, ad-hoc signed.
set -euo pipefail
cd "$(dirname "$0")/.."

cargo build -p brickmotion --release
# The still helper the Render Queue runs (movies run this app with --render-editor-movie).
cmake --build ../native/build-rust --target bmexport

app=target/BrickMotion.app
lib=../native/build-rust/bmffi
rm -rf "$app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Frameworks" "$app/Contents/Resources" "$app/Contents/Helpers"
cp target/release/brickmotion "$app/Contents/MacOS/brickmotion"
cp "$lib/libbmffi.dylib" "$app/Contents/Frameworks/libbmffi.dylib"
cp ../native/build-rust/render/bmexport "$app/Contents/Helpers/bmexport"
cp scripts/Info.plist "$app/Contents/Info.plist"
if [ -d "../public/sounds/snaps" ]; then
    cp -R "../public/sounds/snaps" "$app/Contents/Resources/SnapSounds"
fi
if [ -f "../public/data/suggest/habits.json" ]; then
    mkdir -p "$app/Contents/Resources/Suggest"
    cp "../public/data/suggest/habits.json" "$app/Contents/Resources/Suggest/habits.json"
fi

bin="$app/Contents/MacOS/brickmotion"
# Load libbmffi from the bundle, never from the build tree.
install_name_tool -add_rpath @executable_path/../Frameworks "$bin"
install_name_tool -delete_rpath "$(cd "$lib" && pwd)" "$bin"

codesign --force --sign - "$app/Contents/Frameworks/libbmffi.dylib"
codesign --force --sign - "$app/Contents/Helpers/bmexport"
codesign --force --sign - "$app"
echo "$app"
