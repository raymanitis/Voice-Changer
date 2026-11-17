# Changelog

## 2.2.1

### Fixed
- Setting up the virtual microphone no longer leaves your speakers and microphone switched to the virtual cable. VoxShift puts your normal Windows sound devices back right after the driver installs.

## 2.2.0

### New
- **One-click virtual microphone**: no more manual downloads. Turning on **Use in all apps** sets everything up: VoxShift downloads the official VB-Audio Virtual Cable driver from vb-audio.com, checks it is genuinely signed by VB-Audio, and installs it. Windows asks for permission once.
- After setup, VoxShift switches on **Use in all apps** and starts your voice automatically.
- Audio setup shows a **Set up** button when the virtual microphone is missing.

## 2.1.0

### New
- **Updates inside the app**: VoxShift checks for new versions on launch and every few hours. When one is out, an **Update** button appears in the title bar.
- **One-click update**: downloads the new version, checks it is intact, installs it and restarts VoxShift. Your voices and settings are kept.
- **What's new** window with the full changelog (Audio setup → About).
- Option to turn off automatic update checks.

## 2.0.0

### New
- Rebuilt as a native Tauri app. The installer is now about 1 MB instead of 78 MB, and the app uses less memory.
- **Use in all apps**: while VoxShift is live, your Windows default microphone becomes the changed voice, so Discord, games and browsers hear it. Your real mic comes back when you stop or quit.
- **Hear myself** button and a microphone picker on the main screen.
- Runs in the system tray: closing the window keeps the voice changer working. The tray icon (bottom right) opens the app, turns the voice on or off, toggles Hear myself, or quits.
- **Start with Windows** option (starts hidden in the tray).
- Recordings are saved through a normal Save dialog.

### Note
- Version 1.0.0 is a separate app. Uninstall it from Windows Settings → Apps before using 2.x.

## 1.0.0

- First release: 15 voices (Alien, Atari, Clone, Mutation, Fast/Slow Mutation, Male, Female, Helium, Baby, Radio, Robot, Demon, Cave and Normal), adjustable effects, saved custom voices, device selection, monitoring and recording.
