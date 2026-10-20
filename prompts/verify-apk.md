# Prompt: add or update an APK in the catalog

APKs in `apks/` get installed on other people's TVs, so each one is checked against the official release
before it enters `apps.toml`.

## Steps

1. Get the official source from the project's own README / site (not an APK mirror, blog or store listing).
2. Inspect the file (never run it):
   ```bash
   BT=$(ls -d ~/Library/Android/sdk/build-tools/* | sort -V | tail -1)
   shasum -a 256 file.apk
   $BT/aapt2 dump badging file.apk | grep -E "^package:|native-code|targetSdk|leanback"
   $BT/apksigner verify --print-certs file.apk | grep -E "DN|SHA-256"
   ```
3. Compare the sha256 and size with the official release asset (GitHub's releases API lists a `digest` per
   asset: `https://api.github.com/repos/<owner>/<repo>/releases`). They must match exactly.
4. Compare package name and signer with the version already in the catalog / on TVs. A change in either means
   it installs as a separate app (owner signs in again) and needs an explanation from the official project
   (e.g. SmartTube changed both after its 2025 key compromise). No explanation → do not add it.
5. Check the CPU: `native-code` must include the TV's ABI (`ro.product.cpu.abi`, often `armeabi-v7a`).
   Prefer the universal APK so one file works on every TV.
6. Copy to `apks/<Name>_<version>_<variant>.apk` and update `apps.toml`: `file`, `version`, `sha256`, `origin`
   (release URL), and `replaces` if the package name changed. Remove the old APK file.
7. Install on one TV with `./tvctl install <tv> <app-id> --force`, check it starts, then roll out with `apply`.
