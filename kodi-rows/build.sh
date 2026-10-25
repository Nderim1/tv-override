#!/bin/bash
# Builds kodi-rows.apk without Gradle (javac -> d8 -> aapt2 -> zipalign -> apksigner).
# Usage: bash build.sh [--install [device]]
set -euo pipefail
cd "$(dirname "$0")"
SDK="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
BT="$SDK/build-tools/$(ls "$SDK/build-tools" | sort -V | tail -1)"
JAR="$SDK/platforms/android-34/android.jar"
ADB="$SDK/platform-tools/adb"
VERSION_CODE=12
VERSION_NAME=1.11

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
[ -f kodirows.keystore ] || keytool -genkeypair -keystore kodirows.keystore -storepass android -keypass android \
  -alias kodirows -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=Kodi Rows" >/dev/null 2>&1
"$BT/apksigner" sign --v4-signing-enabled false --ks kodirows.keystore --ks-pass pass:android --key-pass pass:android \
  --out kodi-rows.apk build/aligned.apk
echo "built $(pwd)/kodi-rows.apk ($(du -h kodi-rows.apk | cut -f1 | tr -d ' '))"

if [ "${1:-}" = "--install" ]; then
  "$ADB" -s "${2:-192.168.1.101:5555}" install -r kodi-rows.apk
fi
