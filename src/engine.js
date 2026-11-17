/* VoxShift audio engine.
 * Signal flow:
 *   mic -> input gain -> [vox worklet: gate, pitch shift, mutation, clones, ring mod, comb, crusher, noise]
 *       -> low cut -> high cut -> brightness shelf -> drive -> wet
 *   wet -> master, wet -> echo -> master, wet -> reverb -> master, dry -> master
 *   master -> limiter -> speakers / chosen output device (+ monitor + recorder stream)
 */

// Runs inside the AudioWorkletGlobalScope. Serialised to a Blob URL so it loads from file:// too.
function voxWorkletMain() {
  const TAU = Math.PI * 2;
  const CLONE_OFFSETS = [1, -1, 2, -2, 3, -3];

  class VoxProcessor extends AudioWorkletProcessor {
    constructor(options) {
      super();
      this.N = 1 << 16;
      this.mask = this.N - 1;
      this.buf = new Float32Array(this.N);
      this.w = 0;
      this.p = {
        pitch: 0, mutDepth: 0, mutRate: 1, mutRandom: 0,
        clones: 0, cloneSpread: 15,
        ringFreq: 0, ringMix: 0,
        combMs: 6, combFb: 0,
        bits: 16, crushRate: 48000,
        noise: 0, gate: -90, win: 40,
      };
      this.phases = new Float64Array(7);
      for (let i = 0; i < 7; i++) this.phases[i] = (i * 0.37) % 1;
      this.lfoPhase = 0;
      this.rnd = 0; this.rndTarget = 0; this.rndTimer = 0;
      this.ringPhase = 0;
      this.comb = new Float32Array(8192); this.cw = 0;
      this.hold = 0; this.holdVal = 0;
      this.env = 0; this.gateGain = 1;
      this.envRel = Math.exp(-1 / (0.15 * sampleRate));
      this.gAtk = 1 - Math.exp(-1 / (0.002 * sampleRate));
      this.gRel = 1 - Math.exp(-1 / (0.09 * sampleRate));
      if (options && options.processorOptions) Object.assign(this.p, options.processorOptions);
      this.port.onmessage = (e) => Object.assign(this.p, e.data);
    }

    read(delay) {
      const pos = this.w - delay;
      const i = Math.floor(pos);
      const f = pos - i;
      const a = this.buf[i & this.mask];
      const b = this.buf[(i + 1) & this.mask];
      return a + (b - a) * f;
    }

    // Two-tap overlapping delay-line pitch shifter with sin^2 crossfade.
    voice(idx, ratio, W, base) {
      let ph = this.phases[idx] + (1 - ratio) / W;
      ph -= Math.floor(ph);
      this.phases[idx] = ph;
      let ph2 = ph + 0.5;
      if (ph2 >= 1) ph2 -= 1;
      const s = Math.sin(Math.PI * ph);
      const g1 = s * s;
      return this.read(base + ph * W) * g1 + this.read(base + ph2 * W) * (1 - g1);
    }

    process(inputs, outputs) {
      const out = outputs[0];
      if (!out || !out[0]) return true;
      const o = out[0];
      const n = o.length;
      const inp = inputs[0] && inputs[0][0];
      const p = this.p;
      const sr = sampleRate;

      // Per-block modulation (LFO / random wander).
      const rate = Math.max(0.01, p.mutRate);
      this.lfoPhase = (this.lfoPhase + (rate * n) / sr) % 1;
      this.rndTimer -= n;
      if (this.rndTimer <= 0) {
        this.rndTarget = Math.random() * 2 - 1;
        this.rndTimer = sr / rate;
      }
      this.rnd += (this.rndTarget - this.rnd) * (1 - Math.exp((-TAU * rate * 1.2 * n) / sr));
      const lfo = Math.sin(TAU * this.lfoPhase) * (1 - p.mutRandom) + this.rnd * p.mutRandom;
      const semis = p.pitch + lfo * p.mutDepth;
      const ratio = Math.pow(2, semis / 12);
      const clones = Math.min(6, Math.max(0, Math.round(p.clones)));
      const bypassPitch = p.pitch === 0 && p.mutDepth === 0 && clones === 0;
      const W = Math.max(256, Math.min(8000, (p.win / 1000) * sr));

      const cloneRatios = [];
      for (let c = 0; c < clones; c++) {
        cloneRatios.push(ratio * Math.pow(2, (CLONE_OFFSETS[c] * p.cloneSpread) / 1200));
      }
      const cloneNorm = 1 / (1 + clones * 0.45);

      const gateOn = p.gate > -89;
      const gateThr = Math.pow(10, p.gate / 20);
      const ringOn = p.ringMix > 0 && p.ringFreq > 0;
      const ringInc = p.ringFreq / sr;
      const combOn = p.combFb > 0;
      const combD = Math.max(1, Math.min(8000, Math.round((p.combMs / 1000) * sr)));
      const crushOn = p.crushRate < sr - 1;
      const crushStep = sr / Math.max(500, p.crushRate);
      const bitsOn = p.bits < 16;
      const q = Math.pow(2, Math.max(1, p.bits) - 1);

      for (let k = 0; k < n; k++) {
        let x = inp ? inp[k] : 0;

        // Noise gate
        const ax = x < 0 ? -x : x;
        this.env = ax > this.env ? ax : this.env * this.envRel;
        const gTarget = !gateOn || this.env > gateThr ? 1 : 0;
        this.gateGain += (gTarget - this.gateGain) * (gTarget > this.gateGain ? this.gAtk : this.gRel);
        x *= this.gateGain;

        this.buf[this.w] = x;

        let y;
        if (bypassPitch) {
          y = x;
        } else {
          y = this.voice(0, ratio, W, 2) * 1.15;
          if (clones) {
            let cs = 0;
            for (let c = 0; c < clones; c++) {
              cs += this.voice(c + 1, cloneRatios[c], W, 2 + (c + 1) * 0.013 * sr);
            }
            y = (y + cs * 0.85) * cloneNorm * 1.25;
          }
        }

        if (ringOn) {
          this.ringPhase += ringInc;
          if (this.ringPhase >= 1) this.ringPhase -= 1;
          y = y * (1 - p.ringMix) + y * Math.sin(TAU * this.ringPhase) * p.ringMix * 1.6;
        }

        if (combOn) {
          const v = y + p.combFb * this.comb[(this.cw - combD) & 8191];
          this.comb[this.cw] = v;
          this.cw = (this.cw + 1) & 8191;
          y = v * (1 - p.combFb * 0.8);
        }

        if (crushOn) {
          this.hold += 1;
          if (this.hold >= crushStep) {
            this.hold -= crushStep;
            this.holdVal = y;
          }
          y = this.holdVal;
        }
        if (bitsOn) y = Math.round(y * q) / q;

        if (p.noise > 0) y += (Math.random() * 2 - 1) * p.noise * (0.35 + 0.65 * this.gateGain);

        o[k] = y;
        this.w = (this.w + 1) & this.mask;
      }
      for (let ch = 1; ch < out.length; ch++) out[ch].set(o);
      return true;
    }
  }

  registerProcessor('vox-processor', VoxProcessor);
}

const WORKLET_KEYS = [
  'pitch', 'mutDepth', 'mutRate', 'mutRandom', 'clones', 'cloneSpread',
  'ringFreq', 'ringMix', 'combMs', 'combFb', 'bits', 'crushRate', 'noise', 'win',
];

class VoxEngine {
  constructor() {
    this.ctx = null;
    this.running = false;
    this.params = {};
    this.levels = { inputGain: 0, volume: 0, gate: -90 };
    this.monitorEl = new Audio();
    this.monitorEl.autoplay = false;
    this._revSize = null;
    this._drive = null;
  }

  async start({ inputId, outputId, noiseSuppression }) {
    if (this.running) await this.stop();
    const ctx = new AudioContext({ latencyHint: 'interactive' });
    this.ctx = ctx;
    const src = `(${voxWorkletMain.toString()})();`;
    const url = URL.createObjectURL(new Blob([src], { type: 'application/javascript' }));
    await ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);

    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: inputId ? { exact: inputId } : undefined,
        echoCancellation: false,
        autoGainControl: false,
        noiseSuppression: !!noiseSuppression,
        channelCount: 1,
        latency: 0,
      },
    });

    const g = (v = 1) => { const n = ctx.createGain(); n.gain.value = v; return n; };
    const bq = (type, f, extra = {}) => {
      const n = ctx.createBiquadFilter();
      n.type = type; n.frequency.value = f; Object.assign(n, extra);
      return n;
    };

    const N = (this.nodes = {});
    N.src = ctx.createMediaStreamSource(this.stream);
    N.inGain = g(1);
    N.inAnalyser = ctx.createAnalyser();
    N.inAnalyser.fftSize = 1024;
    N.vox = new AudioWorkletNode(ctx, 'vox-processor', {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
      channelCount: 1, channelCountMode: 'explicit',
    });
    N.hp = bq('highpass', 20); N.hp.Q.value = 0.707;
    N.lp = bq('lowpass', 20000); N.lp.Q.value = 0.707;
    N.shelf = bq('highshelf', 2800);
    N.shaper = ctx.createWaveShaper(); N.shaper.oversample = '2x';
    N.wet = g(1);
    N.dry = g(0);
    N.echoDelay = ctx.createDelay(2);
    N.echoFb = g(0);
    N.echoOut = g(0);
    N.rev = ctx.createConvolver();
    N.revOut = g(0);
    N.master = g(1);
    N.limiter = ctx.createDynamicsCompressor();
    N.limiter.threshold.value = -2;
    N.limiter.knee.value = 0;
    N.limiter.ratio.value = 20;
    N.limiter.attack.value = 0.002;
    N.limiter.release.value = 0.12;
    N.outAnalyser = ctx.createAnalyser();
    N.outAnalyser.fftSize = 2048;
    N.outAnalyser.smoothingTimeConstant = 0.78;
    N.streamOut = ctx.createMediaStreamDestination();

    N.src.connect(N.inGain);
    N.inGain.connect(N.inAnalyser);
    N.inGain.connect(N.vox);
    N.inGain.connect(N.dry);
    N.vox.connect(N.hp).connect(N.lp).connect(N.shelf).connect(N.shaper).connect(N.wet);
    N.wet.connect(N.master);
    N.wet.connect(N.echoDelay);
    N.echoDelay.connect(N.echoFb).connect(N.echoDelay);
    N.echoDelay.connect(N.echoOut).connect(N.master);
    N.wet.connect(N.rev).connect(N.revOut).connect(N.master);
    N.dry.connect(N.master);
    N.master.connect(N.limiter);
    N.limiter.connect(N.outAnalyser);
    N.limiter.connect(ctx.destination);
    N.limiter.connect(N.streamOut);

    this.running = true;
    this._revSize = null;
    this._drive = null;
    this.setParams(this.params);
    this.setLevels(this.levels);
    await this.setOutput(outputId);
    this.monitorEl.srcObject = N.streamOut.stream;
    if (ctx.state === 'suspended') await ctx.resume();
  }

  async stop() {
    this.running = false;
    this.stopRecording();
    try { this.monitorEl.pause(); } catch {}
    this.monitorEl.srcObject = null;
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    this.stream = null;
    if (this.ctx) {
      try { await this.ctx.close(); } catch {}
    }
    this.ctx = null;
    this.nodes = null;
  }

  async setOutput(outputId) {
    if (!this.ctx || typeof this.ctx.setSinkId !== 'function') return;
    try {
      if (outputId === 'off') await this.ctx.setSinkId({ type: 'none' });
      else await this.ctx.setSinkId(outputId || '');
    } catch (err) {
      console.warn('setSinkId failed', err);
    }
  }

  async setMonitor(on, deviceId, volume) {
    const el = this.monitorEl;
    el.volume = Math.max(0, Math.min(1, volume));
    try {
      if (typeof el.setSinkId === 'function') await el.setSinkId(deviceId || '');
    } catch (err) {
      console.warn('monitor setSinkId failed', err);
    }
    if (on && this.running) el.play().catch(() => {});
    else el.pause();
  }

  setParams(p) {
    this.params = { ...p };
    if (!this.running || !this.nodes) return;
    const N = this.nodes;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const set = (param, v) => param.setTargetAtTime(v, t, 0.025);
    const nyq = ctx.sampleRate / 2 - 200;

    const msg = {};
    for (const k of WORKLET_KEYS) if (k in p) msg[k] = p[k];
    if ('crushRate' in msg) msg.crushRate = Math.min(msg.crushRate, ctx.sampleRate);
    N.vox.port.postMessage(msg);

    set(N.hp.frequency, Math.min(p.lowCut ?? 20, nyq));
    set(N.lp.frequency, Math.min(p.highCut ?? 20000, nyq));
    set(N.shelf.gain, p.tone ?? 0);
    if (this._drive !== p.drive) {
      this._drive = p.drive;
      N.shaper.curve = p.drive > 0 ? makeDriveCurve(p.drive) : null;
    }
    const mix = p.mix ?? 1;
    set(N.wet.gain, mix * (1 - (p.drive || 0) * 0.35));
    set(N.dry.gain, 1 - mix);
    set(N.echoDelay.delayTime, (p.echoTime ?? 250) / 1000);
    set(N.echoFb.gain, p.echoFb ?? 0);
    set(N.echoOut.gain, p.echoMix ?? 0);
    set(N.revOut.gain, (p.reverbMix ?? 0) * 1.4);
    const size = p.reverbSize ?? 2;
    if (this._revSize !== size) {
      this._revSize = size;
      N.rev.buffer = makeImpulse(ctx, size);
    }
  }

  setLevels(l) {
    this.levels = { ...this.levels, ...l };
    if (!this.running || !this.nodes) return;
    const t = this.ctx.currentTime;
    const dB = (v) => Math.pow(10, v / 20);
    this.nodes.inGain.gain.setTargetAtTime(dB(this.levels.inputGain), t, 0.03);
    this.nodes.master.gain.setTargetAtTime(this.levels.volume <= -60 ? 0 : dB(this.levels.volume), t, 0.03);
    this.nodes.vox.port.postMessage({ gate: this.levels.gate });
  }

  // RMS level in 0..1 of input / output.
  meter(which) {
    if (!this.running || !this.nodes) return 0;
    const an = which === 'in' ? this.nodes.inAnalyser : this.nodes.outAnalyser;
    const buf = (this._mbuf ||= new Float32Array(2048));
    const view = buf.subarray(0, an.fftSize);
    an.getFloatTimeDomainData(view);
    let s = 0;
    for (let i = 0; i < view.length; i++) s += view[i] * view[i];
    const rms = Math.sqrt(s / view.length);
    const db = 20 * Math.log10(rms + 1e-9);
    return Math.max(0, Math.min(1, (db + 60) / 60));
  }

  spectrum(arr) {
    if (!this.running || !this.nodes) return false;
    this.nodes.outAnalyser.getByteFrequencyData(arr);
    return true;
  }

  startRecording() {
    if (!this.running || this.recorder) return false;
    const type = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm';
    this.chunks = [];
    this.recorder = new MediaRecorder(this.nodes.streamOut.stream, { mimeType: type });
    this.recorder.ondataavailable = (e) => e.data.size && this.chunks.push(e.data);
    this.recorder.onstop = () => {
      const blob = new Blob(this.chunks, { type });
      const a = document.createElement('a');
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      a.href = URL.createObjectURL(blob);
      a.download = `voxshift-${stamp}.webm`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    };
    this.recorder.start();
    return true;
  }

  stopRecording() {
    if (this.recorder && this.recorder.state !== 'inactive') this.recorder.stop();
    this.recorder = null;
  }

  get latencyMs() {
    if (!this.ctx) return 0;
    const base = (this.ctx.baseLatency || 0) + (this.ctx.outputLatency || 0);
    return Math.round(base * 1000);
  }
}

function makeDriveCurve(amount) {
  const k = amount * 60;
  const n = 2048;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i * 2) / n - 1;
    curve[i] = ((1 + k) * x) / (1 + k * Math.abs(x));
  }
  return curve;
}

function makeImpulse(ctx, seconds) {
  const rate = ctx.sampleRate;
  const len = Math.max(1, Math.floor(rate * seconds));
  const buf = ctx.createBuffer(2, len, rate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) {
      const t = i / len;
      d[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, 3.2) * (i < rate * 0.01 ? i / (rate * 0.01) : 1);
    }
  }
  return buf;
}

window.VoxEngine = VoxEngine;
