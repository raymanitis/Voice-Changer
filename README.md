# VoxShift

Real-time voice changer for Windows. Native [Tauri](https://tauri.app) app (Rust + WebView2), about 1 MB to download.

## Download

**[Download VoxShift-Setup.exe](https://github.com/raymanitis/Voice-Changer/releases/latest/download/VoxShift-Setup.exe)** (Windows 10/11, 64-bit)

Run the installer and launch VoxShift from the Start menu or desktop.
The installer is not code-signed, so Windows SmartScreen may warn you: click **More info** → **Run anyway**.

## Features

- 15 ready voices: Normal, Alien, Atari, Clone, Mutation, Fast Mutation, Slow Mutation, Male, Female, Helium, Baby, Radio, Robot, Demon, Cave
- Every voice is adjustable: pitch, mutation, clones, robot ring-mod, metal resonance, bit-crusher, distortion, static, EQ, echo, reverb, wet/dry mix
- Save tweaked settings as your own voices
- **Use in all apps**: replaces your Windows default microphone with the changed voice while VoxShift is live, and puts your real mic back when you stop or quit
- **Hear myself** button to monitor the changed voice in your headphones
- Microphone picker right on the main screen
- Runs in the system tray: closing the window keeps the voice changer working; open it again from the tray icon (bottom right). Tray menu: open, turn voice on/off, hear myself, quit
- Optional **Start with Windows** (starts hidden in the tray)
- Noise gate, noise suppression, mic gain, output volume
- Record the changed voice to a `.webm` file
- Built-in updates: VoxShift checks GitHub for new versions, shows an **Update** button with the changelog, and installs the new version in one click

## Use it in Discord, games, OBS and browsers

VoxShift sends its audio through a virtual microphone (the free VB-Audio Virtual Cable driver), which Windows treats as a normal mic.

1. Turn on **Use in all apps**. The first time, VoxShift downloads the official driver from vb-audio.com, checks its signature and installs it. Windows asks for permission once.
2. Pick your real microphone and press **Start**.
3. Apps using the **Default** microphone now hear your changed voice. For apps that have a specific mic selected, choose **CABLE Output** there.

VB-CABLE is donationware by [VB-Audio Software](https://vb-audio.com/Cable/).

## Develop

Needs Node.js, Rust (stable, MSVC) and the WebView2 runtime (built into Windows 10/11).

```bash
npm install
npm run dev        # run the app
npm run build      # build src-tauri/target/release/bundle/nsis/VoxShift_<version>_x64-setup.exe
```

- `src/` – UI and audio engine (`engine.js`: Web Audio graph + AudioWorklet DSP, `presets.js`: voices and sliders, `app.js`: UI)
- `src-tauri/` – Rust shell: tray, window, microphone permission, recording save dialog, autostart
- `src-tauri/src/winaudio.rs` – Windows default-microphone switching

Releases are built by GitHub Actions: bump the version in `package.json`, `src-tauri/tauri.conf.json` and `src-tauri/Cargo.toml`, then push a tag like `v2.0.1`. The workflow builds the installer and attaches it to a GitHub Release as `VoxShift-Setup.exe`.
