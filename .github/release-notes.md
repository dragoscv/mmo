## MMO Companion v0.3.3

Native low-latency audio engine for the MMO web app (sub-10ms vocal autocorrect on Windows WASAPI / macOS CoreAudio).

### Fixes in this release

- **macOS: window not appearing after first launch** — replaced the `show: false` + `ready-to-show` pattern with `show: true` + `center: true` so the window is always visible on launch. Added `did-fail-load` logging and a visible error dialog if the UI bundle ever fails to load.
- **macOS: clicking dock / tray after first launch did nothing** — the `second-instance` and `activate` handlers now force `show()` + `focus()` + `moveTop()` instead of only handling the minimized case.
- **macOS: Apple Silicon "is damaged" errors** — fully resolved in v0.3.2 with ad-hoc codesigning; carried forward.
- Server start no longer blocks UI rendering (made non-awaiting).

### Downloads

- **Windows** (10/11, x64): `MMO-Companion-Setup-0.3.3.exe`
- **macOS Apple Silicon** (M1/M2/M3/M4): `MMO-Companion-0.3.3-arm64.dmg`
- **macOS Intel**: `MMO-Companion-0.3.3-x64.dmg`

### macOS install (still required, build is unsigned)

This build is **ad-hoc signed** but not notarized by Apple. On first launch you will see a "developer cannot be verified" warning. Bypass:

**Option A — right-click → Open**
1. Open the DMG, drag the app to `/Applications`.
2. **Right-click** `MMO Companion` in `/Applications` → **Open**.
3. Click **Open** on the warning dialog. Future launches work normally.

**Option B — Terminal one-liner**
```bash
xattr -dr com.apple.quarantine "/Applications/MMO Companion.app"
```
Then launch normally.

If the window still does NOT appear after launch (should be fixed in 0.3.3), check Console.app for `[main]` log lines — they will point to the exact failure.

### Windows install

Run the installer. SmartScreen may show "Windows protected your PC" since the build is not EV-signed; click **More info** → **Run anyway**.
