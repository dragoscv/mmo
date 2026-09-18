# Android TV / Leanback Support

> **Status:** Applied in `android/app/src/main/AndroidManifest.xml` (leanback +
> touchscreen `uses-feature`, `LEANBACK_LAUNCHER` intent filter,
> `android:banner="@drawable/banner"` vector). The dedicated Compose TV app
> lives in `apps/tv-android` (ADR-0004); this Capacitor shell only keeps TV
> *compatibility* so the same APK installs on Google TV.

The web app is TV-aware (see `app/src/components/video/tv-mode-probe.tsx`
and `app/src/lib/focus-nav.ts`) — D-pad navigation, scaled fonts, and
larger focus rings activate automatically when the WebView reports a
TV-like user agent (`Android.*TV`, `BRAVIA`, `AFT…`, `GoogleTV`) or
when the URL has `?tv` appended.

## What the manifest declares (reference)

`apps/native/android/app/src/main/AndroidManifest.xml` is tracked in git and
already contains everything below. Re-apply only if you regenerate the
scaffold with `npx cap add android`.

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

The banner is a vector drawable at `res/drawable/banner.xml` (320×180 dp,
brand gradient). Replace with a `320×180` PNG in `res/drawable-xhdpi/banner.png`
if Play Console rejects the vector.

### 3. Confirm the Play Console listing

In the Play Console, on the app's *Store presence* page, opt into the
*Designed for Android TV* category. Without this checkbox the app will
not appear in the TV store even when the manifest is correct.

## Sideloading for development

```powershell
# From apps/native
pnpm install
pnpm build:web         # copies web/ into dist/ (Capacitor webDir)
pnpm cap:sync android  # runs build:web first
pnpm cap:open:android  # opens Android Studio
```

Use *Run → Run 'app'* with a connected Android TV device (developer
options + ADB over network enabled).
