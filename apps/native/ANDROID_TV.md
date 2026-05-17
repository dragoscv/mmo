# Android TV / Leanback Support

The web app is TV-aware (see `app/src/components/video/tv-mode-probe.tsx`
and `app/src/lib/focus-nav.ts`) — D-pad navigation, scaled fonts, and
larger focus rings activate automatically when the WebView reports a
TV-like user agent (`Android.*TV`, `BRAVIA`, `AFT…`, `GoogleTV`) or
when the URL has `?tv` appended.

## To ship as an Android TV app

After running `npx cap add android` (from `apps/native/`), edit
`apps/native/android/app/src/main/AndroidManifest.xml`:

### 1. Declare TV compatibility

Inside `<manifest>`, add:

```xml
<uses-feature android:name="android.software.leanback" android:required="false" />
<uses-feature android:name="android.hardware.touchscreen" android:required="false" />
```

### 2. Add the Leanback launcher intent + banner

Inside the `MainActivity` `<activity>` block, add a second
`<intent-filter>` next to the existing `LAUNCHER` one:

```xml
<intent-filter>
    <action android:name="android.intent.action.MAIN" />
    <category android:name="android.intent.category.LEANBACK_LAUNCHER" />
</intent-filter>
```

Also add the banner attribute on the `<application>` element:

```xml
<application
    ...
    android:banner="@drawable/banner"
    android:isGame="false">
```

Drop a `320×180` PNG into `apps/native/android/app/src/main/res/drawable-xhdpi/banner.png`.

### 3. Confirm the Play Console listing

In the Play Console, on the app's *Store presence* page, opt into the
*Designed for Android TV* category. Without this checkbox the app will
not appear in the TV store even when the manifest is correct.

## Sideloading for development

```powershell
# From apps/native
pnpm install
pnpm build           # builds the web bundle into dist/
npx cap sync android
npx cap open android # opens Android Studio
```

Use *Run → Run 'app'* with a connected Android TV device (developer
options + ADB over network enabled).
