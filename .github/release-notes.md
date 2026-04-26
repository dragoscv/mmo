## MMO Companion v0.3.2

Native low-latency audio engine for the MMO web app (sub-10ms vocal autocorrect on Windows WASAPI/macOS CoreAudio/Linux ALSA).

### Downloads

- **Windows** (10/11, x64): `MMO-Companion-Setup-0.3.2.exe`
- **macOS Apple Silicon** (M1/M2/M3/M4): `MMO-Companion-0.3.2-arm64.dmg`
- **macOS Intel**: `MMO-Companion-0.3.2-x64.dmg`

### macOS install (IMPORTANT)

This build is **ad-hoc signed** but not notarized by Apple (no $99/yr Developer ID). You will see a "developer cannot be verified" warning on first launch. To bypass it, choose ONE of the following:

**Option A — right-click → Open (per-app, recommended)**
1. Open the DMG and drag MMO Companion to `/Applications`.
2. In Finder, navigate to `/Applications`.
3. **Right-click** (or Ctrl+click) `MMO Companion` → **Open**.
4. macOS will show the warning with an **Open** button; click it.
5. Future launches work normally — the bypass is remembered per-app.

**Option B — terminal one-liner**
```bash
xattr -dr com.apple.quarantine "/Applications/MMO Companion.app"
```
After this, you can launch the app from the Dock or Applications folder normally.

If you see "MMO Companion is damaged and can't be opened", run the Option B command — that error is the quarantine attribute conflicting with our ad-hoc signature.

### Windows install

Just run the installer. SmartScreen may show a "Windows protected your PC" warning since the build isn't EV-signed; click **More info** → **Run anyway**.

### What's new in 0.3.2

- macOS app bundles are now ad-hoc codesigned (fixes "is damaged" errors on Apple Silicon)
- Separate x64 + arm64 macOS DMGs (no Rosetta needed for Apple Silicon)
- Sidebar download button auto-detects your OS + architecture in the web app

### What you get

After installing, the companion runs at `http://localhost:17899`. The MMO web app (and `/live` page in particular) automatically detects it and routes audio through the native engine for the lowest possible latency. No login or token configuration is needed for the audio path — the localhost-only middleware enforces security.
