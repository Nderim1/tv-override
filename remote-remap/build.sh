#!/bin/bash
# Builds remote-remap.apk without Gradle (javac -> d8 -> aapt2 -> zipalign -> apksigner).
# Usage: bash build.sh [--install [device]]
set -euo pipefail
cd "$(dirname "$0")"
SDK="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
BT="$SDK/build-tools/$(ls "$SDK/build-tools" | sort -V | tail -1)"
JAR="$SDK/platforms/android-34/android.jar"
ADB="$SDK/platform-tools/adb"
VERSION_CODE=3
VERSION_NAME=2.0

rm -rf build && mkdir -p build/gen build/classes build/dex

"$BT/aapt2" compile --dir res -o build/res.zip
"$BT/aapt2" link -o build/unsigned.apk -I "$JAR" --manifest AndroidManifest.xml \
  --java build/gen --min-sdk-version 26 --target-sdk-version 31 \
  --version-code $VERSION_CODE --version-name $VERSION_NAME build/res.zip

javac -source 11 -target 11 -Xlint:-options -classpath "$JAR" -d build/classes \
  $(find src build/gen -name '*.java')
"$BT/d8" --release --lib "$JAR" --min-api 26 --output build/dex $(find build/classes -name '*.class')
(cd build/dex && zip -q -u ../unsigned.apk classes.dex)

"$BT/zipalign" -f -p 4 build/unsigned.apk build/aligned.apk
# Local signing key, kept so future builds install as updates (standard debug-key passwords).
[ -f remap.keystore ] || keytool -genkeypair -keystore remap.keystore -storepass android -keypass android \
  -alias remap -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=Remote Remap" >/dev/null 2>&1
"$BT/apksigner" sign --v4-signing-enabled false --ks remap.keystore --ks-pass pass:android --key-pass pass:android \
  --out remote-remap.apk build/aligned.apk
echo "built $(pwd)/remote-remap.apk ($(du -h remote-remap.apk | cut -f1 | tr -d ' '))"

if [ "${1:-}" = "--install" ]; then
  "$ADB" -s "${2:-192.168.1.101:5555}" install -r remote-remap.apk
fi
