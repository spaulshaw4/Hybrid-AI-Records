# Building the Android APK

The site is already a full PWA (manifest, maskable icons, offline shell), so the
APK is a thin Trusted Web Activity wrapper around https://hybrid-ai-records.com.

## 1. Generate the package

1. Go to https://www.pwabuilder.com
2. Enter `https://hybrid-ai-records.com` and run the scan.
3. Choose **Android → Package for stores**.
   - Package ID: `com.hybridairecords.twa`
   - Keep "Signing key: create new" and **download the `.zip`** — it contains
     `app-release-signed.apk` (sideload), `app-release-bundle.aab` (Play Store),
     the signing key, and `assetlinks.json`.

## 2. Verify domain ownership

Open the downloaded `assetlinks.json` and copy the `sha256_cert_fingerprints`
value. Then set these backend secrets:

- `ANDROID_PACKAGE_NAME` = `com.hybridairecords.twa`
- `ANDROID_SHA256_FINGERPRINTS` = the fingerprint (comma-separate multiple; add
  the Play App Signing fingerprint too once the app is uploaded to Play)

The app serves them at `/.well-known/assetlinks.json`. Publish, then confirm:

```
curl https://hybrid-ai-records.com/.well-known/assetlinks.json
```

Without this, the APK still runs but shows a browser address bar at the top.

## 3. Install

- Sideload: transfer `app-release-signed.apk` to the phone and open it
  (allow "Install unknown apps" for the file manager).
- Play Store: upload `app-release-bundle.aab`.

Installed this way the launcher uses the maskable black crest icon — no white plate.
