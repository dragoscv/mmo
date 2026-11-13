# Gig lock and the checklist before a set

MixAI Decks 1.7 (tracker WP19-60). A mode the DJ switches on before a set: while it is on, nothing in the app
changes or interrupts by itself, and a checklist says whether the computer is ready.

Where: the **GIG** chip in the status bar (bottom, left of PRACTICE), the command palette item **Gig lock**
(Ctrl/Cmd+K), and the hotkey **Ctrl+Shift+G** (Cmd+Shift+G on macOS).

Code: `apps/mixai/src/gig/` (rule and classification: `gig-core.ts`; state and the gate: `gig-store.ts`; checklist
run: `gig-checks.ts`; shell sync, hotkey, close request: `gig-runtime.ts`; UI: `GigChip.tsx`, `GigPopover.tsx`,
`GigCloseDialog.tsx`), `apps/mixai/src/bridge/gig.ts`, `apps/mixai/src-tauri/src/gig.rs`.

## What the lock covers

| While locked | What happens | What the DJ sees |
|---|---|---|
| Opening Settings, by any way in (title bar gear, Ctrl+, , command palette, the Library's "Open settings" buttons, the status-bar items that open a settings tab, the profile menu's "Manage", the first-run tour) | Settings stay closed. Settings that were open when the lock went on are closed. | The controls look locked but keep the keyboard focus; pressing one says "Settings are locked for the set. Unlock from the Gig chip..." in the status line above the status bar and to screen readers. |
| Changing settings: import, reset of a tab, switching a settings profile (also from the title bar menu), undo | Nothing is applied. | The profile menu says "Profiles are locked for the set...". |
| Changing a setting through another door: the command palette's deck count, theme mode and surface, the shortcuts overlay's rebind and "Reset all", the skin try's "Keep", the skin editor's and the layout editor's Save | Nothing is applied; each door says the same sentence as the Settings modal. On lock a running skin try ends at once (back to the saved skin, not by its own 30 s timer) and an open skin editor or layout editor closes the way its own Cancel does (the unsaved preview is dropped, nothing is saved). | "Settings are locked for the set. Unlock: Gig chip or Ctrl+Shift+G." in the status line. |
| Cloud profile sync (`lib/cloud-sync.ts`): pull, apply and push | Nothing is pulled, applied or uploaded. | "Cloud sync waits for the unlock" in the popover. |
| Automatic layout switch when a controller connects (USB MIDI or Bluetooth MIDI) | The layout stays. | "N controllers connected, layout kept" in the popover. |
| Plugin notifications (`ctx.notify` toasts) | Dropped, not queued (no replays hours later). | "N notifications hidden" in the popover and in the chip's accessible name; the texts of the last 5 are readable under **Held**, while locked and after the unlock until the next lock (in memory only, never stored). |
| Closing the main window (title bar X, Alt+F4, taskbar, a close message from another program) | The app asks first. | "Close MixAI Decks?" with **Keep playing** (focused, also Esc) and **Close anyway**. While a recording runs the text says the recording will be stopped; "Close anyway" stops it (the WAV is finalised) and then closes. |
| Sleep | The computer and the display are kept awake (Windows). | "Keep awake: on" in the popover. |

One function decides all of it: every gate calls `gigGate(action)` / `gigAllows(action)` (`gig-store.ts`), which
asks `decide` in `gig-core.ts`. `src/gig/contract.test.ts` fails when a gate stops asking.

### What is held back, and what happens to it at unlock

- **Cloud sync**: **what the DJ changed on this computer wins over the account's older copy.** An upload the lock
  refused, whose local profile really differs from the one this app last agreed with the account, writes the debt
  down (`localStorage["mixai-cloud-push-held"]` = the account's user id; cleared after a successful upload, or by
  a pull that was really applied; the marker of another account is ignored). While that marker stands — at the
  unlock, at the next start (locked or not), at the next sign-in — a pulled profile is **not** applied over the
  local state: the local profile is uploaded instead. Without the marker the order from before the lock stands:
  a held pull first (the app started or signed in while locked), then a held push only when that pull changed
  nothing here (nothing stored in the account yet, the account could not be reached, or the blob is not a
  profile); a change that was made while locked and never uploaded goes out after the usual 4 s delay. The MIDI
  mapping lives in the engine and nowhere on disk, so an owed upload in a fresh process takes that one part from
  the account copy first (`applyEngineOnly`) and uploads nothing while the account is unreachable. The known
  weaknesses of the sync itself (tracker WP19-55) are unchanged.
- **Controller layout**: nothing. A controller that connected during the lock does not switch the layout later.
- **Plugin notifications**: gone, and never replayed. Their number and the texts of the last 5 are kept for the
  popover (memory only).
- **Settings changes**: nothing was applied, so there is nothing to replay.

## What the lock does NOT cover

- **The decks, the mixer, the library, loading tracks, recording, the set tracklist.** The lock is not a "hands off"
  mode.
- **Layout hotkeys (Alt+1..8), the layout menu, stage mode (Ctrl+Shift+S), booth mode.** These are things the DJ
  does on purpose during a set. The lock stops what happens by itself, or by a slip into Settings.
- **The phone remote (Connect).** "Lock phones" in Connect is a separate switch and is not touched: DJs use the
  phone remote during a set.
- **Updates.** MixAI Decks has no updater (no updater plugin; `createUpdaterArtifacts` is false), so nothing can
  update or restart the app by itself and there is nothing to lock. Operating-system updates and restarts are
  outside the app: pause them in the system before a set.
- **Notifications of the operating system or of other programs.** Use the system's "do not disturb".
- **Pop-out windows** (a panel in its own window): they follow the lock (their Settings entry points are locked
  too), but closing one never asks.
- The lock is **not** part of the settings file, of a settings profile or of the cloud profile. It is stored on
  this computer only (`localStorage["mixai-gig"]`).

## Locking and unlocking

- **Lock**: one action. "Lock for the set" in the popover, or Ctrl+Shift+G. Locking is allowed with warnings or
  problems in the checklist: the popover lists what is not ok, the DJ decides.
- **Unlock**: two steps, so it never happens by accident.
  - Popover: **Unlock**, then **Confirm unlock** within 5 seconds (and not sooner than 0.6 s: a double click is
    one step). After "Unlock" the same button reads "Keep locked". The second step checks the state again.
  - Hotkey: Ctrl+Shift+G once says "press again within 5 seconds to unlock"; a second press unlocks. Holding the
    key down is one press.
  - Command palette: "Gig lock" opens the popover; it never unlocks by itself.
- **Always reachable**: while locked the chip is never hidden by the status-bar fit. While off it may be, on a
  narrow window; the palette item and the hotkey remain, and the chip comes back for as long as its popover is
  open (the popover is anchored to it).
- **Never stuck**: if the stored value cannot be read (corrupt, cleared), the app starts unlocked.

### A crash, a reload or a restart during a set

The lock is stored the moment it goes on. After a crash, a page reload or a restart the app comes back **locked**,
asks the system to keep awake again, and the shell asks before closing again. This is also true after a deliberate
"Close anyway": the next start is locked until the DJ unlocks. A lock whose stored time is more than **12 hours**
old is dropped at start (yesterday's set is over), and an app that comes back locked says so once ("Still locked
for the set, since 21:05") in the status line and on the chip. What does not survive a page reload: the counters
of what was held back and the texts of the hidden notifications (both are in memory for the popover only). An
upload the lock refused is **not** lost: it is written down (`mixai-cloud-push-held`) and wins at the next start.

## The checklist

"Checklist" tab of the popover. Opening the popover asks the instant checks once; **Run checks** asks them again
and measures dropouts for 10 seconds (progress shown, **Cancel** stops it; closing the popover cancels too).
Nothing is measured while the popover is closed. Each row shows its state by icon **and** word (OK / Warning /
Problem / Unknown), one sentence, and for a warning or a problem what to do. The time of the last run is shown.

The popover is 400 px wide and has three tabs so that it fits the minimum window (960 x 600) without scrolling,
in touch mode too. Measured on the dev app with, for every check, the reason whose row is tallest and the
longest values its sentence can carry: the Checklist tab is at most 549 px high (Romanian, touch mode), the
Lock tab at most 509 px (locked, unlock armed, three kinds of held things). In a window lower than the minimum,
or at a large zoom, the popover keeps to the room it has and scrolls inside.

| Check | OK | Warning | Problem | Unknown |
|---|---|---|---|---|
| **Audio** | Engine running; device, sample rate and buffer shown. Says so when the opened device is the system default while other outputs exist. | A requested setting fell back (the device refused the buffer size or the sample rate); sample rate below 44.1 kHz; buffer above 25 ms. | The engine did not start; the chosen output device was not found (the system default plays instead). | Browser preview. |
| **Power** | On mains (battery percent shown when there is one). | On battery. | On battery below 20 %. | The system did not say; app shell without the command. |
| **Disk** | Room for at least 120 minutes of recording on the volume of the recording folder — never more than **one** WAV file can hold (4 GiB: 3 h 06 at 48 kHz, 1 h 33 at 96 kHz). | Room for 30 to 120 minutes; the folder is on a network drive (free space is not asked for); or the disk is roomy but one file is short of a 120-minute set (at 96 kHz). | Room for less than 30 minutes. | Folder missing, error, app shell without the command. |
| **Dropouts** (10 s) | No audio buffer was late; peak load under 70 %. | No late buffer, peak load 70 to 99 %. | At least one late buffer in the window, or peak load 100 % or more. | Not measured yet, cancelled, engine restarted during the window. |
| **Library** | Server online and paired; number of tracks. Says so when the server is another computer (the set then depends on the network). | Online but not paired; online but no tracks. | The server does not answer. | Browser preview. |
| **Controller** (information only) | A Bluetooth MIDI controller is connected. | never | never | None connected; or MIDI inputs are present (the row names the first one: a listed port is not proof of a connected, mapped controller). |

### Assumptions and thresholds

- **Disk.** The recorder writes 32-bit float stereo WAV at the engine's sample rate
  (`crates/mixai-core/src/recorder.rs`): `sample rate x 2 channels x 4 bytes` per second, so 23.04 MB per minute
  and about 1.38 GB per hour at 48 kHz (twice that at 96 kHz). A test reads the recorder's source and fails when
  the format changes. The folder that is measured: the folder of the recording that runs now; else the folder of
  the last recording made on this computer (remembered in `localStorage["mixai-gig-recdir"]`); else the user's
  Documents folder. The save dialog itself does not tell the app where it will open, so before a first
  recording the check can be looking at another drive than the one the DJ will pick.
- **One recording file has a ceiling.** A classic WAV file keeps its two length fields in 32 bits, so **one
  recording file holds at most 4 GiB** — 3 h 06 min at 48 kHz, 1 h 33 min at 96 kHz — whatever the disk has free.
  The Disk row says so ("one recording file holds at most …") instead of promising the disk's room, and warns when
  that ceiling is under a 120-minute set. A longer set needs a new recording started before the ceiling. (The
  recorder itself has no limit of its own: see the tracker follow-up row.)
- **Dropouts.** The engine counts audio callbacks that overran their buffer period since it started and has no
  reset, so the check takes the counter at the start and at the end of the 10 s window. The load is the highest
  "callback time / buffer period" among the engine's snapshots of the window (about 30 a second), with the status
  bar's own levels (70 % and 100 %, `shell/status-math.ts`). It measures whatever is going on: with the decks
  stopped that is the idle engine only, and the result says so ("a full mix costs more"). For a meaningful
  number, play two decks with key lock and an effect while it runs.
- **Power.** 20 % is a round number, not a measurement of any battery. On battery is a warning at any level
  because laptops also slow the processor down on battery.
- **Audio.** 25 ms is where cueing by ear starts to feel late; typical DJ buffers are 5 to 12 ms. The engine's
  fallback notes are English log sentences: the check sorts them (device missing / buffer / sample rate / other)
  and shows a translated sentence, never the note itself.
- **Library on another computer** is decided from the text of the configured address only (`127.x.x.x`,
  `localhost`, `::1` = this computer); nothing is resolved or probed.
- **Controller.** A listed MIDI input is not proof that it is the controller or that it is mapped; the row is
  information, never a warning. HID controllers are not listed.

## Keep awake, per system

| System | Behaviour |
|---|---|
| Windows | A power request of the process (`PowerCreateRequest` + `PowerSetRequest`, display and system), visible in `powercfg /requests` as "MixAI Decks: gig lock is on". Not `SetThreadExecutionState`: that one belongs to a thread and ends with it. Released on unlock, when the app exits normally, and by Windows when the process ends in any other way. Locking twice holds one request. |
| macOS, Linux | Not implemented: the popover says "not available on this system". Use the system's own setting (or `caffeinate` / an inhibitor) for the set. |
| An app shell older than 1.7 | "not available in this app shell". The lock and every gate still work. |

Keep awake does not stop a sleep the user asks for (closing the lid, the power button) and does not override a
critical battery shutdown.

## Power and disk, per system

`gig_system_status` (Rust, `src-tauri/src/gig.rs`). The folder argument must be an absolute path of an existing
folder; anything else is an error value in the answer, never a failed command. Paths longer than 4096 characters
and paths with a NUL are refused before the system is asked. Network paths (`\\server\share`, `\\?\UNC\...`,
mapped network drives) are reported as "network" **without** asking for their free space: a dead share can block
for a long time. The query runs off the command threads and is given 3 seconds.

| | Windows | Linux | macOS |
|---|---|---|---|
| Power source, percent, charging | `GetSystemPowerStatus` | `/sys/class/power_supply` | unknown (not read this round) |
| Free / total bytes | `GetDiskFreeSpaceExW` on the folder (the space this user may write) | `statvfs` | `statvfs` |

## The close confirmation, technically

The shell decides (`gig.rs`): while locked it holds a close request of the main window back and emits
`gig://close-request`; the page shows the question and answers `gig_close_seen`; "Close anyway" calls
`gig_close_window`. If the page never acknowledges a question (it is hung or dead), the next close request after
1.5 seconds closes the window: a broken page can never trap it. The webview does not listen to Tauri's own
`tauri://close-requested`: Tauri keeps a page's event listeners until the window is destroyed, so after a page
reload a stale listener would refuse every close with nobody left to answer. No new permission is needed.

Not covered: ending the process (Task Manager, shutdown of the system, a crash). Nothing can ask then.

## Limits

- The lock is a guard against accidents, not a security feature: anyone at the keyboard can unlock in two steps.
- Settings changed through a plugin's own panel, or by editing files on disk, are not seen by the lock.
- The manual "Save to cloud" / "Load from cloud" buttons live in Settings, which is closed while locked; loading
  a profile is refused by the same gate even if it were reached.
- A pop-out window has its own page: it follows the stored lock through the storage event, but it does not show
  the gig chip.
- The checklist does not test the audio path by sound (no test tone), the headphone cue, or the controller's
  mapping.
- **macOS**: Cmd+Q, Quit in the menu and Quit in the Dock's menu close the app **without** asking; only the
  window's close button and Cmd+W reach the question (the popover says this on macOS). Tracked as a follow-up.
- The recorder stops writing a file at 4 GiB (the WAV length fields are 32 bits): a longer recording needs a new
  file. The Disk row states the ceiling; the recorder itself is tracked as a follow-up.
- The recording store is not re-read from the engine after a page reload, so the title bar's REC button can show
  "not recording" while the engine records. "Close anyway" does not trust it (it asks the engine); the display
  is tracked as a follow-up.

## What was NOT tested

See the tracker row WP19-60 for the state after the release build. The frontend was exercised live twice on a
development app on the third instance (`'@aux'`): first on a shell without the `gig_*` commands ("not available in
this app shell" for keep awake, power and disk), then on a shell that has them (scripts `live/n1-system.mjs`,
`n2-awake.mjs`, `n3-close.mjs`, `n4-restore.mjs` in `.copilot-tmp/decks-ui/r7/gig60/`, all green):

- **On a real shell with the commands**: keep awake visible in `powercfg /requests` (exactly one DISPLAY + one
  SYSTEM entry with the reason "MixAI Decks: gig lock is on" while locked, none while unlocked, none after two
  more lock/unlock rounds), power and disk numbers against the system's own, ten path cases and a dead UNC share
  through the real command, and six real close requests from Windows while locked (same process id throughout,
  one question, the focus on "Keep playing").
- **"Close anyway" during a real recording** (measured 2026-11-14 on `'@aux'`, script `live/n5-close-anyway.mjs`):
  a recording was started through `start_recording` to a file on the laptop's temp folder and the page's own
  recording flag was deliberately left unset - the exact state the original defect lived in (after a page reload
  the REC button says "not recording" while the engine writes). A real close request from Windows was held, the
  question said that a recording runs and that closing saves the file, "Close anyway" was pressed and the window
  went. The file on the laptop: **5 267 524 bytes, RIFF size 5 267 516 (= file - 8), data size 5 267 456
  (= file - 44), 48 kHz / 32-bit / stereo, 13.72 s** - a writer killed before the stop would have left 0 in both
  length fields. The instance was closed on purpose and its supervisor restarted it (new pid, same tree).
- **Closing while unlocked** was not pressed live (it ends the app). The rule is unit-tested in Rust **and in
  TypeScript** (`closeAnyway` in `gig-core.test.ts`).
- **A page that does not answer** (the 1.5 s way out of the close question) is unit-tested as a rule only; no
  hung page was produced.
- **macOS and Linux**: the platform part of `gig.rs` (free space through `statvfs`, the Linux battery reader,
  the "no keep awake" answer) was type-checked for `x86_64-unknown-linux-gnu`, `aarch64-unknown-linux-gnu` and
  `x86_64-apple-darwin` (library and its tests, warnings as errors) but **never run** there; the pure parts
  (path rules, mapping of the Linux battery files) are unit-tested on Windows. The CI matrix runs the unit
  tests on all three systems.
- A computer **on battery**, a **full disk**, a **network recording folder**, a **late audio buffer**: these
  rows were produced by unit tests of the classification and, for the layout, by rows put into the checklist
  for a measurement. The development laptop was on mains with a free disk and no dropouts.
- A real controller connecting during a lock (the connect event was simulated), a real plugin raising a
  notification (the store call was made directly), a real cloud profile (the two calls were replaced by
  stand-ins in the live test, so the stored profile of the test account was never touched).
- A pop-out window following the lock: the storage event was sent to the main page by hand; no pop-out window
  was opened.
- Sleep itself: that the laptop stays awake for hours with the lid open was not waited for.
- Screen readers: accessible names and live regions were read from the browser's accessibility tree, not heard
  in NVDA or VoiceOver.
