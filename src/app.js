/* VoxShift UI controller. */
(() => {
  const { NEUTRAL, ICONS, BUILTIN_PRESETS, CONTROLS } = window.VOX;
  const engine = new window.VoxEngine();
  const $ = (id) => document.getElementById(id);

  // Tauri desktop bridge (absent when the UI is opened in a plain browser).
  const TAURI = window.__TAURI__ || null;
  const invoke = (cmd, args) => (TAURI ? TAURI.core.invoke(cmd, args) : Promise.reject(new Error('Desktop app only')));

  // ---------- persistence ----------
  const store = {
    get(key, fallback) {
      try {
        const v = localStorage.getItem('voxshift.' + key);
        return v == null ? fallback : JSON.parse(v);
      } catch { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem('voxshift.' + key, JSON.stringify(value)); } catch {}
    },
  };

  const defaults = {
    presetId: 'normal',
    params: null,
    inputId: '',
    outputId: '',
    monitorOn: false,
    monitorId: '',
    monitorVol: 0.8,
    inputGain: 0,
    volume: 0,
    gate: -90,
    noiseSuppression: false,
    wasOn: false,
    tab: 'voice',
    systemMic: false,        // "Use in all apps": swap the Windows default mic while live
    systemMicActive: false,  // the swap is currently applied (survives crashes so we can undo it)
    prevDefaultMic: null,    // Windows endpoint id of the user's real default mic
    outputBeforeSystem: null,
    closeToTray: true,
  };
  const S = { ...defaults, ...store.get('settings', {}) };
  let customPresets = store.get('custom', []);
  const save = () => store.set('settings', S);

  const allPresets = () => [...BUILTIN_PRESETS, ...customPresets];
  const findPreset = (id) => allPresets().find((p) => p.id === id) || BUILTIN_PRESETS[0];
  const baseParams = (preset) => ({ ...NEUTRAL, ...preset.params });

  let current = findPreset(S.presetId);
  let params = S.params ? { ...baseParams(current), ...S.params } : baseParams(current);

  // ---------- helpers ----------
  const svg = (name, extra = '') =>
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" ${extra}>${ICONS[name] || ICONS.star}</svg>`;

  let toastTimer;
  function toast(msg, isError = false) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.toggle('error', isError);
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), isError ? 4200 : 2200);
  }

  function fmt(def, v) {
    if (def.key === 'bits' && v >= 16) return 'Off';
    if (def.key === 'crushRate' && v >= 48000) return 'Off';
    if (def.key === 'ringFreq' && v === 0) return 'Off';
    if (def.key === 'clones' && v === 0) return 'Off';
    if (def.key === 'highCut' && v >= 20000) return 'Off';
    if (def.key === 'gate' && v <= -90) return 'Off';
    if (def.key === 'volume' && v <= -40) return 'Mute';
    if (def.pct) return Math.round(v * (def.scale || 1) * 100) + '%';
    if (def.k) return v >= 1000 ? (v / 1000).toFixed(v >= 10000 ? 0 : 1) + ' kHz' : v + ' Hz';
    const num = Number.isInteger(def.step) ? Math.round(v) : +v.toFixed(def.step < 0.1 ? 2 : 1);
    const sign = def.signed && v > 0 ? '+' : '';
    return `${sign}${num}${def.unit ? ' ' + def.unit : ''}`;
  }

  // Builds one slider row. Returns { el, set(value) }.
  function makeSlider(def, value, onChange, onReset) {
    const el = document.createElement('div');
    el.className = 'slider';
    el.innerHTML = `
      <div class="slider-top"><label></label><span class="val"></span></div>
      <input type="range" min="${def.min}" max="${def.max}" step="${def.step}" />
      ${def.hint ? `<div class="hint"></div>` : ''}`;
    el.querySelector('label').textContent = def.label;
    if (def.hint) el.querySelector('.hint').textContent = def.hint;
    const input = el.querySelector('input');
    const val = el.querySelector('.val');
    const center = def.from ?? (def.signed ? 0 : def.min);

    function paint(v) {
      const pct = (x) => ((x - def.min) / (def.max - def.min)) * 100;
      const a = pct(Math.min(center, v));
      const b = pct(Math.max(center, v));
      input.style.setProperty('--a', a + '%');
      input.style.setProperty('--b', b + '%');
      val.textContent = fmt(def, v);
    }
    input.addEventListener('input', () => {
      const v = parseFloat(input.value);
      paint(v);
      onChange(v);
    });
    if (onReset) {
      el.querySelector('.slider-top').addEventListener('dblclick', () => onReset());
      input.addEventListener('dblclick', () => onReset());
      el.title = 'Double-click to reset';
    }
    const api = {
      el,
      set(v) { input.value = v; paint(v); },
    };
    api.set(value);
    return api;
  }

  // ---------- preset library ----------
  function presetCard(p, i) {
    const b = document.createElement('button');
    b.className = 'preset';
    b.dataset.id = p.id;
    b.innerHTML = `<span class="ico">${svg(p.icon)}</span><span class="nm"></span>`;
    b.querySelector('.nm').textContent = p.name;
    if (!p.custom && i < 9) {
      const key = document.createElement('span');
      key.className = 'key';
      key.textContent = i + 1;
      b.appendChild(key);
    }
    b.title = p.desc || p.name;
    b.addEventListener('click', () => selectPreset(p.id));
    if (p.custom) {
      const del = document.createElement('span');
      del.className = 'del';
      del.title = 'Delete voice';
      del.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>';
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        deletePreset(p.id);
      });
      b.appendChild(del);
    }
    return b;
  }

  function renderLibrary() {
    const q = $('search').value.trim().toLowerCase();
    const match = (p) => !q || p.name.toLowerCase().includes(q) || (p.desc || '').toLowerCase().includes(q);
    const bg = $('builtinGrid');
    const cg = $('customGrid');
    const builtins = BUILTIN_PRESETS.map((p, i) => (match(p) ? presetCard(p, i) : null)).filter(Boolean);
    const customs = customPresets.filter(match).map((p) => presetCard(p));
    if (!builtins.length) {
      const none = document.createElement('div');
      none.className = 'no-results';
      none.textContent = 'No matching voices';
      builtins.push(none);
    }
    bg.replaceChildren(...builtins);
    cg.replaceChildren(...customs);
    $('presetCount').textContent = BUILTIN_PRESETS.length;
    $('customCount').textContent = customPresets.length || '';
    $('customEmpty').hidden = customPresets.length > 0;
    markActive();
  }
  $('search').addEventListener('input', renderLibrary);

  function markActive() {
    document.querySelectorAll('.preset').forEach((el) => el.classList.toggle('active', el.dataset.id === current.id));
  }

  function selectPreset(id) {
    current = findPreset(id);
    params = baseParams(current);
    S.presetId = current.id;
    S.params = null;
    save();
    engine.setParams(params);
    renderNow();
    renderSliders();
    markActive();
    syncTray();
  }

  function deletePreset(id) {
    const p = customPresets.find((x) => x.id === id);
    customPresets = customPresets.filter((x) => x.id !== id);
    store.set('custom', customPresets);
    if (current.id === id) selectPreset('normal');
    renderLibrary();
    if (p) toast(`Deleted “${p.name}”`);
  }

  // ---------- now-playing header ----------
  function isModified() {
    const base = baseParams(current);
    return Object.keys(base).some((k) => Math.abs((params[k] ?? 0) - base[k]) > 1e-9);
  }

  function renderNow() {
    $('nowIcon').innerHTML = svg(current.icon);
    $('nowName').textContent = current.name;
    $('nowDesc').textContent = current.desc || 'Custom voice';
    $('modChip').hidden = !isModified();
  }

  // ---------- sliders ----------
  let sliderApis = {};
  function renderSliders() {
    const host = $('sliders');
    const base = baseParams(current);
    sliderApis = {};
    const nodes = CONTROLS.filter((c) => c.tab === S.tab).map((def) => {
      const api = makeSlider(
        def,
        params[def.key],
        (v) => {
          params[def.key] = v;
          api.el.classList.toggle('changed', Math.abs(v - base[def.key]) > 1e-9);
          engine.setParams(params);
          S.params = params;
          saveSoon();
          $('modChip').hidden = !isModified();
        },
        () => {
          params[def.key] = base[def.key];
          api.set(base[def.key]);
          api.el.classList.remove('changed');
          engine.setParams(params);
          S.params = params;
          saveSoon();
          $('modChip').hidden = !isModified();
        },
      );
      api.el.classList.toggle('changed', Math.abs(params[def.key] - base[def.key]) > 1e-9);
      sliderApis[def.key] = api;
      return api.el;
    });
    host.replaceChildren(...nodes);
    document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === S.tab));
  }

  let saveTimer;
  function saveSoon() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 300);
  }

  $('tabs').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    S.tab = b.dataset.tab;
    save();
    renderSliders();
  });

  $('btnReset').addEventListener('click', () => {
    params = baseParams(current);
    S.params = null;
    save();
    engine.setParams(params);
    renderSliders();
    renderNow();
    toast(`Reset “${current.name}”`);
  });

  // ---------- save modal ----------
  const modal = $('saveModal');
  function openSave() {
    modal.classList.add('open');
    modal.setAttribute('aria-hidden', 'false');
    const input = $('saveName');
    input.value = current.custom ? current.name : isModified() ? `My ${current.name}` : current.name + ' 2';
    setTimeout(() => { input.focus(); input.select(); }, 30);
  }
  function closeSave() {
    modal.classList.remove('open');
    modal.setAttribute('aria-hidden', 'true');
  }
  $('btnSave').addEventListener('click', openSave);
  $('btnCancelSave').addEventListener('click', closeSave);
  modal.addEventListener('mousedown', (e) => { if (e.target === modal) closeSave(); });
  $('saveForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = $('saveName').value.trim();
    if (!name) return;
    const existing = customPresets.find((p) => p.name.toLowerCase() === name.toLowerCase());
    const diff = {};
    for (const k of Object.keys(NEUTRAL)) if (params[k] !== NEUTRAL[k]) diff[k] = params[k];
    if (existing) {
      existing.params = diff;
      current = existing;
    } else {
      const p = {
        id: 'c_' + Date.now().toString(36),
        name,
        icon: current.icon,
        color: current.color,
        desc: `Custom voice · based on ${current.custom ? current.desc.replace(/^Custom voice · based on /, '') : current.name}`,
        params: diff,
        custom: true,
      };
      customPresets.push(p);
      current = p;
    }
    store.set('custom', customPresets);
    S.presetId = current.id;
    S.params = null;
    params = baseParams(current);
    save();
    closeSave();
    renderLibrary();
    renderNow();
    renderSliders();
    toast(`Saved “${name}”`);
  });

  // ---------- power ----------
  let starting = false;
  async function setPower(on) {
    if (starting) return;
    starting = true;
    const btn = $('btnPower');
    try {
      if (on) {
        $('powerLabel').textContent = 'Starting…';
        if (S.systemMic) await prepareSystemMic();
        engine.params = params;
        engine.levels = { inputGain: S.inputGain, volume: S.volume, gate: S.gate };
        await engine.start({ inputId: S.inputId, outputId: S.outputId, noiseSuppression: S.noiseSuppression });
        await engine.setMonitor(S.monitorOn, S.monitorId, S.monitorVol);
        if (S.systemMic) await enableSystemMic();
        await refreshDevices();
      } else {
        await engine.stop();
        await disableSystemMic();
      }
      S.wasOn = on;
      save();
    } catch (err) {
      console.error(err);
      await engine.stop();
      await disableSystemMic();
      S.wasOn = false;
      save();
      const msg = err && err.name === 'NotAllowedError' ? 'Microphone access was blocked.'
        : err && err.name === 'NotFoundError' ? 'No microphone found. Plug one in and try again.'
        : err && err.name === 'OverconstrainedError' ? 'Selected microphone is unavailable. Pick another one.'
        : (err && err.message) || String(err);
      toast(msg, true);
    } finally {
      starting = false;
      const live = engine.running;
      btn.classList.toggle('on', live);
      $('powerLabel').textContent = live ? 'Live' : 'Start';
      $('statusPill').classList.toggle('live', live);
      $('statusPill').querySelector('b').textContent = live ? 'Live' : 'Off';
      $('btnRecord').disabled = !live;
      updateLatency();
      syncTray();
    }
  }
  $('btnPower').addEventListener('click', () => setPower(!engine.running));

  // ---------- "use in all apps" (Windows default mic swap) ----------
  const VIRTUAL_RE = /cable|vb-audio|voicemeeter|virtual/i;

  const findCableOut = () =>
    devices.outputs.find((d) => /cable input/i.test(d.label)) || devices.outputs.find((d) => VIRTUAL_RE.test(d.label));

  // Before going live: route our output into the cable and pin a real mic as our input,
  // because "System default" will point at the cable once we swap the Windows default.
  async function prepareSystemMic() {
    if (!TAURI) throw new Error('“Use in all apps” works in the desktop app only.');
    await refreshDevices();
    const cable = findCableOut();
    if (!cable) throw new Error('Install VB-Audio Virtual Cable first (Audio setup → How it works), then restart VoxShift.');
    if (S.outputId !== cable.deviceId) {
      S.outputBeforeSystem = S.outputId;
      S.outputId = cable.deviceId;
    }
    const current = devices.inputs.find((d) => d.deviceId === S.inputId);
    if (!current || VIRTUAL_RE.test(current.label)) {
      let pick = null;
      try {
        const winMics = await invoke('list_mics');
        const realDefault = winMics.find((m) => m.is_default && !VIRTUAL_RE.test(m.name)) ||
          (S.prevDefaultMic && winMics.find((m) => m.id === S.prevDefaultMic));
        if (realDefault) pick = devices.inputs.find((d) => d.label === realDefault.name);
      } catch {}
      pick = pick || devices.inputs.find((d) => !VIRTUAL_RE.test(d.label));
      if (!pick) throw new Error('No real microphone found. Plug one in and try again.');
      S.inputId = pick.deviceId;
    }
    save();
    renderDeviceSelects();
  }

  async function enableSystemMic() {
    const mics = await invoke('list_mics');
    const cable = mics.find((m) => /cable output/i.test(m.name)) || mics.find((m) => VIRTUAL_RE.test(m.name));
    if (!cable) throw new Error('Virtual cable microphone (CABLE Output) not found.');
    const prev = await invoke('system_mic_enable', { cableId: cable.id });
    if (prev) S.prevDefaultMic = prev;
    S.systemMicActive = true;
    save();
  }

  async function disableSystemMic() {
    if (!TAURI || !S.systemMicActive) return;
    try {
      await invoke('system_mic_disable', { fallback: S.prevDefaultMic });
    } catch (err) {
      console.warn(err);
    }
    S.systemMicActive = false;
    save();
  }

  async function setSystemMic(on) {
    if (on && !TAURI) {
      toast('“Use in all apps” works in the desktop app only.', true);
      renderToggles();
      return;
    }
    S.systemMic = on;
    if (!on && S.outputBeforeSystem !== null) {
      S.outputId = S.outputBeforeSystem;
      S.outputBeforeSystem = null;
    }
    save();
    renderToggles();
    if (engine.running) {
      if (on) await setPower(true);
      else {
        await disableSystemMic();
        await engine.setOutput(S.outputId);
      }
    }
    renderDeviceSelects();
    if (on && engine.running) toast('Every app using the Default mic now hears your changed voice');
    if (!on) toast('Windows microphone restored');
  }
  $('qSystem').addEventListener('click', () => setSystemMic(!S.systemMic));
  $('tglSystem').addEventListener('change', (e) => setSystemMic(e.target.checked));

  // ---------- monitor ("hear myself") ----------
  async function setMonitorOn(on) {
    S.monitorOn = on;
    save();
    await engine.setMonitor(S.monitorOn, S.monitorId, S.monitorVol);
    renderToggles();
    syncTray();
  }
  $('qMonitor').addEventListener('click', () => setMonitorOn(!S.monitorOn));
  $('tglMonitor').addEventListener('change', (e) => setMonitorOn(e.target.checked));

  function renderToggles() {
    $('qMonitor').classList.toggle('on', S.monitorOn);
    $('tglMonitor').checked = S.monitorOn;
    $('qSystem').classList.toggle('on', S.systemMic);
    $('tglSystem').checked = S.systemMic;
    $('qSystem').classList.toggle('warn', S.systemMic && !findCableOut() && devices.outputs.length > 0);
  }

  // ---------- tray ----------
  function syncTray() {
    if (!TAURI) return;
    invoke('set_tray_state', { live: engine.running, monitor: S.monitorOn, voice: current.name }).catch(() => {});
  }

  // ---------- recording ----------
  if (TAURI) {
    engine.onRecorded = async (blob) => {
      try {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const path = await invoke('save_recording', bytes);
        toast(path ? `Saved ${path.split(/[\\/]/).pop()}` : 'Recording discarded');
      } catch (err) {
        toast('Could not save recording: ' + (err.message || err), true);
      }
    };
  }
  $('btnRecord').addEventListener('click', () => {
    const btn = $('btnRecord');
    if (engine.recorder) {
      engine.stopRecording();
      btn.classList.remove('recording');
      btn.querySelector('span').textContent = 'Record';
      if (!TAURI) toast('Recording saved');
    } else if (engine.startRecording()) {
      btn.classList.add('recording');
      btn.querySelector('span').textContent = 'Stop';
    }
  });

  // ---------- devices ----------
  let devices = { inputs: [], outputs: [] };

  async function unlockLabels() {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      s.getTracks().forEach((t) => t.stop());
    } catch {}
  }

  function fillSelect(sel, list, value, extra = []) {
    sel.replaceChildren();
    const add = (v, label) => {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = label;
      sel.appendChild(o);
    };
    for (const [v, l] of extra) add(v, l);
    list.forEach((d, i) => add(d.deviceId, d.label || `Device ${i + 1}`));
    const has = [...sel.options].some((o) => o.value === value);
    sel.value = has ? value : sel.options[0] ? sel.options[0].value : '';
    return sel.value;
  }

  function renderDeviceSelects() {
    const realInputs = S.systemMic ? devices.inputs.filter((d) => !VIRTUAL_RE.test(d.label)) : devices.inputs;
    fillSelect($('selInput'), realInputs, S.inputId, [['', 'System default']]);
    fillSelect($('quickInput'), realInputs, S.inputId, [['', 'Default microphone']]);
    fillSelect($('selOutput'), devices.outputs, S.outputId, [['', 'System default (speakers)'], ['off', 'Nowhere (monitor only)']]);
    fillSelect($('selMonitor'), devices.outputs, S.monitorId, [['', 'System default']]);
    renderCableHint();
    renderToggles();
    renderRoute();
  }

  async function refreshDevices() {
    let list = [];
    try { list = await navigator.mediaDevices.enumerateDevices(); } catch {}
    const skip = (d) => d.deviceId === 'default' || d.deviceId === 'communications';
    devices.inputs = list.filter((d) => d.kind === 'audioinput' && !skip(d));
    devices.outputs = list.filter((d) => d.kind === 'audiooutput' && !skip(d));
    renderDeviceSelects();
  }

  function renderCableHint() {
    const hint = $('cableHint');
    const cable = findCableOut();
    hint.classList.remove('warn');
    if (!cable) {
      hint.classList.add('warn');
      hint.textContent = 'No virtual cable found. Install VB-Audio Virtual Cable to use VoxShift in other apps.';
      return;
    }
    if (S.outputId === cable.deviceId) {
      hint.textContent = `Sending to ${cable.label}.`;
      return;
    }
    hint.innerHTML = '<span></span><button type="button">Use it</button>';
    hint.querySelector('span').textContent = `Virtual cable detected: ${cable.label}`;
    hint.querySelector('button').addEventListener('click', () => {
      S.outputId = cable.deviceId;
      $('selOutput').value = cable.deviceId;
      onOutputChange();
    });
  }

  function labelOf(list, id, fallback) {
    const d = list.find((x) => x.deviceId === id);
    return d ? d.label : fallback;
  }

  function renderRoute() {
    const mic = labelOf(devices.inputs, S.inputId, 'Default mic');
    const out = S.outputId === 'off' ? 'No output' : labelOf(devices.outputs, S.outputId, 'Default speakers');
    $('statusPill').title = `${short(mic)} → ${short(out)}${S.monitorOn ? ' · hearing myself' : ''}`;
  }
  const short = (s) => s.replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)\s*$/i, '');

  async function onOutputChange() {
    S.outputId = $('selOutput').value;
    save();
    await engine.setOutput(S.outputId);
    renderCableHint();
    renderRoute();
  }

  async function onInputChange(value) {
    S.inputId = value;
    save();
    renderDeviceSelects();
    if (engine.running) await setPower(true);
  }
  $('selInput').addEventListener('change', (e) => onInputChange(e.target.value));
  $('quickInput').addEventListener('change', (e) => onInputChange(e.target.value));
  $('selOutput').addEventListener('change', onOutputChange);
  $('selMonitor').addEventListener('change', async () => {
    S.monitorId = $('selMonitor').value;
    save();
    await engine.setMonitor(S.monitorOn, S.monitorId, S.monitorVol);
  });
  $('tglSuppress').addEventListener('change', async (e) => {
    S.noiseSuppression = e.target.checked;
    save();
    if (engine.running) await setPower(true);
  });
  if (navigator.mediaDevices) navigator.mediaDevices.addEventListener('devicechange', refreshDevices);

  // Level sliders in the drawer
  function renderLevelSliders() {
    const levelDefs = [
      { key: 'inputGain', label: 'Mic gain', min: -12, max: 24, step: 0.5, unit: 'dB', signed: true },
      { key: 'volume', label: 'Output volume', min: -40, max: 6, step: 0.5, unit: 'dB', signed: true },
      { key: 'gate', label: 'Noise gate', min: -90, max: -20, step: 1, unit: 'dB', hint: 'Silences quiet background noise between words.' },
    ];
    const slots = levelDefs.map((def) => {
      const api = makeSlider(def, S[def.key], (v) => {
        S[def.key] = v;
        saveSoon();
        engine.setLevels({ [def.key]: v });
      }, () => {
        S[def.key] = defaults[def.key];
        api.set(S[def.key]);
        save();
        engine.setLevels({ [def.key]: S[def.key] });
      });
      return api.el;
    });
    $('levelSlots').replaceChildren(...slots);

    const monDef = { key: 'monitorVol', label: 'Monitor volume', min: 0, max: 1, step: 0.01, pct: true };
    const mon = makeSlider(monDef, S.monitorVol, (v) => {
      S.monitorVol = v;
      saveSoon();
      engine.monitorEl.volume = v;
    });
    $('monitorVolSlot').replaceChildren(mon.el);
  }

  // ---------- desktop integration ----------
  async function initDesktop() {
    if (!TAURI) {
      $('tglTray').disabled = true;
      $('tglAutostart').disabled = true;
      return;
    }
    const win = TAURI.window.getCurrentWindow();
    $('winctl').hidden = false;
    $('winMin').addEventListener('click', () => win.minimize());
    $('winMax').addEventListener('click', () => win.toggleMaximize());
    $('winClose').addEventListener('click', () => win.close());
    $('winClose').title = S.closeToTray ? 'Close to tray' : 'Quit';

    $('tglTray').checked = S.closeToTray;
    invoke('set_close_to_tray', { enabled: S.closeToTray }).catch(() => {});
    $('tglTray').addEventListener('change', (e) => {
      S.closeToTray = e.target.checked;
      save();
      $('winClose').title = S.closeToTray ? 'Close to tray' : 'Quit';
      invoke('set_close_to_tray', { enabled: S.closeToTray }).catch(() => {});
    });

    try { $('tglAutostart').checked = await invoke('plugin:autostart|is_enabled'); } catch {}
    $('tglAutostart').addEventListener('change', async (e) => {
      try {
        await invoke(e.target.checked ? 'plugin:autostart|enable' : 'plugin:autostart|disable');
        toast(e.target.checked ? 'VoxShift will start with Windows (in the tray)' : 'Start with Windows turned off');
      } catch (err) {
        e.target.checked = !e.target.checked;
        toast('Could not change startup setting: ' + (err.message || err), true);
      }
    });

    // External links open in the default browser.
    document.addEventListener('click', (e) => {
      const a = e.target.closest('a[href^="https://"]');
      if (!a) return;
      e.preventDefault();
      invoke('plugin:opener|open_url', { url: a.href }).catch(() => {});
    });

    TAURI.event.listen('tray-toggle', () => setPower(!engine.running));
    TAURI.event.listen('tray-monitor', () => setMonitorOn(!S.monitorOn));
  }

  // ---------- drawer ----------
  function openDrawer(open) {
    $('drawer').classList.toggle('open', open);
    $('drawer').setAttribute('aria-hidden', String(!open));
    $('backdrop').classList.toggle('open', open);
    if (open) { refreshDevices(); updateLatency(); }
  }
  $('btnSettings').addEventListener('click', () => openDrawer(true));
  $('btnCloseDrawer').addEventListener('click', () => openDrawer(false));
  $('backdrop').addEventListener('click', () => openDrawer(false));


  function updateLatency() {
    const ms = engine.latencyMs;
    $('latencyInfo').textContent = engine.running
      ? `Audio running at ${engine.ctx.sampleRate / 1000} kHz · device latency ≈ ${ms} ms (+ pitch grain ≈ ${Math.round(params.win / 2)} ms)`
      : 'Audio is stopped.';
  }

  // ---------- keyboard ----------
  document.addEventListener('keydown', (e) => {
    const tag = (e.target.tagName || '').toLowerCase();
    if (e.key === 'Escape') { openDrawer(false); closeSave(); }
    const typing = ['input', 'select', 'textarea'].includes(tag) && e.target.type !== 'range';
    if (e.code === 'Space' && !typing && tag !== 'button') {
      e.preventDefault();
      setPower(!engine.running);
    }
    if (!typing && !e.ctrlKey && !e.altKey && /^[1-9]$/.test(e.key) && BUILTIN_PRESETS[+e.key - 1]) {
      selectPreset(BUILTIN_PRESETS[+e.key - 1].id);
    }
    if (e.ctrlKey && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      $('search').focus();
    }
  });

  // ---------- visualizer + meters ----------
  const canvas = $('viz');
  const c2d = canvas.getContext('2d');
  const freq = new Uint8Array(1024);
  const BARS = 72;
  const smooth = new Float32Array(BARS);
  let mIn = 0, mOut = 0;

  function resizeCanvas() {
    const r = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(r.width * dpr));
    canvas.height = Math.max(1, Math.round(r.height * dpr));
  }
  new ResizeObserver(resizeCanvas).observe(canvas);

  function draw(ts) {
    const W = canvas.width, H = canvas.height;
    const dpr = window.devicePixelRatio || 1;
    c2d.clearRect(0, 0, W, H);
    const live = engine.spectrum(freq);
    const gap = 3 * dpr;
    const bw = (W - gap * (BARS - 1)) / BARS;
    if (bw <= 1) { requestAnimationFrame(draw); return; }

    // faint guide lines
    c2d.fillStyle = '#2c2e33';
    for (const f of [0.25, 0.5, 0.75]) c2d.fillRect(0, Math.round(H * f), W, dpr);
    const grad = c2d.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(1, 'rgba(255,255,255,0.35)');

    const nyq = live ? engine.ctx.sampleRate / 2 : 24000;
    for (let i = 0; i < BARS; i++) {
      let v;
      if (live) {
        // log-spaced frequency bins 70 Hz .. 12 kHz
        const f0 = 70 * Math.pow(12000 / 70, i / BARS);
        const f1 = 70 * Math.pow(12000 / 70, (i + 1) / BARS);
        const b0 = Math.floor((f0 / nyq) * freq.length);
        const b1 = Math.max(b0 + 1, Math.floor((f1 / nyq) * freq.length));
        let m = 0;
        for (let k = b0; k < b1 && k < freq.length; k++) m = Math.max(m, freq[k]);
        v = Math.pow(m / 255, 1.6);
      } else {
        v = 0;
      }
      smooth[i] += (v - smooth[i]) * (v > smooth[i] ? 0.55 : 0.16);
      const h = Math.max(2 * dpr, smooth[i] * H);
      const x = i * (bw + gap);
      c2d.fillStyle = live ? grad : '#373a40';
      roundRect(c2d, x, H - h, bw, h, Math.min(bw / 2, 1.5 * dpr, h / 2));
    }

    // meters
    const ti = engine.meter('in');
    const to = engine.meter('out');
    mIn += (ti - mIn) * (ti > mIn ? 0.6 : 0.15);
    mOut += (to - mOut) * (to > mOut ? 0.6 : 0.15);
    $('meterIn').style.width = (mIn * 100).toFixed(1) + '%';
    $('meterOut').style.width = (mOut * 100).toFixed(1) + '%';
    $('meterIn').classList.toggle('hot', mIn > 0.95);
    $('meterOut').classList.toggle('hot', mOut > 0.95);

    requestAnimationFrame(draw);
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.fill();
  }

  // ---------- init ----------
  async function init() {
    $('tglSuppress').checked = S.noiseSuppression;
    $('btnRecord').disabled = true;
    renderLibrary();
    renderNow();
    renderSliders();
    renderLevelSliders();
    renderToggles();
    resizeCanvas();
    requestAnimationFrame(draw);
    await initDesktop();
    // A previous session ended without undoing the Windows mic swap (crash / power loss): undo it now.
    await disableSystemMic();
    await unlockLabels();
    await refreshDevices();
    syncTray();
    if (S.wasOn) setPower(true);
  }
  init();
})();
