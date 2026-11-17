# VoxShift

Real-time desktop voice changer for Windows (Electron + Web Audio).

## Download

**[Download VoxShift-Setup.exe](https://github.com/raymanitis/Voice-Changer/releases/latest/download/VoxShift-Setup.exe)** (Windows 10/11, 64-bit)

Run the installer, pick a folder, and launch VoxShift from the desktop or Start menu shortcut.
The installer is not code-signed, so Windows SmartScreen may warn you: click **More info** → **Run anyway**.

- 15 ready voices: Normal, Alien, Atari, Clone, Mutation, Fast Mutation, Slow Mutation, Male, Female, Helium, Baby, Radio, Robot, Demon, Cave
- Every voice is adjustable: pitch, mutation, clones, robot ring-mod, metal resonance, bit-crusher, distortion, static, EQ, echo, reverb, wet/dry mix
- Save tweaked settings as your own voices
- Pick mic, output device and a separate "hear myself" monitor
- Noise gate, noise suppression, mic gain, output volume
- Record the changed voice to a `.webm` file

## Use it as a mic in Discord / games / OBS

1. Install a virtual audio cable, e.g. [VB-Audio Cable](https://vb-audio.com/Cable/).
2. In VoxShift → **Audio setup** → **Send voice to** → `CABLE Input`.
3. In Discord / the game, select `CABLE Output` as the microphone.
4. Enable **Hear myself** to monitor through headphones.

## Develop

```bash
npm install
npm start          # run the app
npm run dist       # build dist/VoxShift-Setup.exe
```

Releases are built by GitHub Actions: push a tag like `v1.0.1` and the workflow builds the installer and attaches it to a GitHub Release.

Source lives in `src/`: `engine.js` (audio graph + AudioWorklet DSP), `presets.js` (voices and slider definitions), `app.js` (UI).
