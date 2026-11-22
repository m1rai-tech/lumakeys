(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const { MidiTransport, lowerBound } = window.LumaTransport;
  const all = (query) => [...document.querySelectorAll(query)];
  const now = () => performance.now() / 1000;
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const touchVelocity = { soft: .32, balanced: .71, strong: .96 };
  const defaults = {
    palette: "neon", customColor: "#fa66cf", glow: 88, bloom: 65, density: 72, trail: 68,
    particles: true, waves: true, atmosphere: true, volume: 80, reverb: 8, release: 72, midiInput: "all",
    mute: false, sustain: false, instrument: "steinway", touch: "balanced", soundBank: 2, labels: "both", notation: "letters", labelsByNote: {}, keys: null, octave: 0
  };
  const effects = ["palette", "customColor", "glow", "bloom", "density", "trail", "particles", "waves", "atmosphere"];
  const naturalPitches = [0, 2, 4, 5, 7, 9, 11];
  const computerLayout = "1234567890qwertyuiopasdfghjklzxcvbnm";
  const firstKey = 36, lastKey = 96;
  const defaultBindings = Object.fromEntries([...computerLayout].flatMap((letter, index) => {
    const noteClass = naturalPitches[index % 7];
    const note = firstKey + Math.floor(index / 7) * 12 + noteClass;
    const key = /[0-9]/.test(letter) ? "Digit" + letter : "Key" + letter.toUpperCase();
    const natural = [[note, key]];
    if ([0, 2, 5, 7, 9].includes(noteClass)) natural.push([note + 1, "Shift+" + key]);
    return natural;
  }));
  function preferences() {
    try {
      const saved = localStorage.getItem("luma-keys-stage-v2");
      if (saved) {
        const previous = JSON.parse(saved);
        if (!previous.soundBank && previous.instrument === "grand") previous.instrument = "steinway";
        return { ...defaults, ...previous, soundBank: defaults.soundBank };
      }
      const legacy = JSON.parse(localStorage.getItem("luma-keys-v1") || "{}");
      const legacyAudio = typeof legacy.instrument === "string" && legacy.instrument.startsWith("local:") ? legacy.instrument : "steinway";
      const values = { ...defaults };
      for (const key of ["volume", "reverb", "mute", "labels", "notation", "labelsByNote"]) {
        if (legacy[key] !== undefined) values[key] = legacy[key];
      }
      return { ...values, instrument: legacyAudio };
    } catch { return { ...defaults }; }
  }
  const prefs = preferences();
  const sound = new window.LumaAudio(), visual = new window.LumaVisual($("visualizer"), prefs);
  const demo = { ...window.LumaMidi.demo(), id: "demo", name: "Aurora", demo: true };
  const tracks = new Map([["demo", demo]]), samples = new Map();
  const keys = new Map(), held = new Map(), stepInputs = new Map();
  const midiSustain = new Set(), sustained = new Set();
  const viewport = matchMedia("(max-width: 720px)"), black = new Set([1,3,6,8,10]);
  const letters = ["C","C♯","D","D♯","E","F","F♯","G","G♯","A","A♯","B"];
  const solfege = ["Do","Do♯","Re","Re♯","Mi","Fa","Fa♯","Sol","Sol♯","La","La♯","Ti"];
  const store = openStorage();
  const quiet = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9h4l5-4v14l-5-4H4V9Zm12 1 5 5m0-5-5 5"/></svg>';
  const pause = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 5h3v14H7zm7 0h3v14h-3z"/></svg>';
  const play = $("play").innerHTML, speaker = $("mute").innerHTML;
  let mode = "free", track = demo, position = 0, step = 0, sequence = 0, lastNote = null, toastTimer;
  let playback = null, midiAccess = null, audioLoadId = 0, keyIndex = new Map(), isSeeking = false, spacePedal = false;

  function save() {
    try { localStorage.setItem("luma-keys-stage-v2", JSON.stringify(prefs)); } catch {}
  }
  function notify(message) {
    const toast = $("toast");
    toast.textContent = message;
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast.hidden = true; }, 3600);
  }
  function openStorage() {
    return new Promise((resolve) => {
      let request;
      try { request = indexedDB.open("luma-keys-media", 1); } catch { resolve(null); return; }
      request.onupgradeneeded = () => {
        request.result.createObjectStore("tracks", { keyPath: "id" });
        request.result.createObjectStore("samples", { keyPath: "id" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = request.onblocked = () => resolve(null);
    });
  }
  async function media(name, operation, value) {
    const database = await store;
    if (!database) return null;
    return new Promise((resolve) => {
      try {
        const tx = database.transaction(name, operation === "getAll" ? "readonly" : "readwrite");
        const bucket = tx.objectStore(name);
        const request = operation === "getAll" ? bucket.getAll() : bucket.put(value);
        tx.oncomplete = () => resolve(request.result ?? true);
        tx.onerror = tx.onabort = () => resolve(null);
      } catch { resolve(null); }
    });
  }
  const binding = (note) => (prefs.keys ?? defaultBindings)[note] || "";
  const pitchName = (midi, notation = prefs.notation) => (notation === "solfege" ? solfege : letters)[midi % 12] + (Math.floor(midi / 12) - 1);
  const noteName = (midi) => prefs.labelsByNote[midi] || pitchName(midi);
  function codeName(binding) {
    const [modifier, key] = binding.startsWith("Shift+") ? binding.split("+") : ["", binding];
    const symbols = { Comma: ",", Period: ".", Slash: "/", Minus: "−", Equal: "=", Semicolon: ";", Quote: "'", Backquote: String.fromCharCode(96), Backslash: String.fromCharCode(92), IntlBackslash: String.fromCharCode(92) };
    const printable = symbols[key] ?? key.replace(/^(Key|Digit|Numpad)/, "").toLowerCase();
    return modifier ? "⇧" + printable : printable;
  }
  function bindingFromEvent(event) {
    return (event.shiftKey ? "Shift+" : "") + event.code;
  }

  function rebuildKeyboard() {
    const shift = prefs.octave * 12;
    const from = (viewport.matches ? 48 : firstKey) + shift, to = (viewport.matches ? 84 : lastKey) + shift;
    const notes = Array.from({ length: to - from + 1 }, (_, i) => from + i);
    const naturals = notes.filter((note) => !black.has(note % 12)).length;
    let white = 0;
    const fragment = document.createDocumentFragment();
    keys.clear();
    keyIndex = new Map(Object.entries(prefs.keys ?? defaultBindings).filter((entry) => entry[1]).map(([key, code]) => [code, +key + shift]));
    for (const note of notes) {
      const dark = black.has(note % 12), code = binding(note - shift);
      const tile = document.createElement("button");
      tile.type = "button"; tile.tabIndex = -1; tile.dataset.note = note;
      tile.className = "piano-key " + (dark ? "black" : "white") + (code ? " bound" : "");
      const name = noteName(note);
      const label = dark || viewport.matches ? (prefs.labelsByNote[note] || name.replace(/(-?\d+)$/, "")) : name;
      tile.setAttribute("aria-label", name + (code ? ", " + codeName(code).replace("⇧", "Shift + ") : ""));
      tile.title = name + (code ? " · " + codeName(code) : "");
      const x = (dark ? white : white + .5) / naturals;
      if (dark) {
        const width = 62 / naturals;
        tile.style.width = width + "%";
        tile.style.left = x * 100 - width / 2 + "%";
      } else white++;
      for (const [kind, content] of [["notes", label], ["computer", code ? codeName(code) : " "]]) {
        if (prefs.labels !== "both" && prefs.labels !== kind) continue;
        const span = document.createElement("span");
        span.className = kind === "notes" ? "key-note" : "key-bind";
        if (kind === "computer" && content.startsWith("⇧")) {
          const shiftIcon = document.createElement("span");
          shiftIcon.className = "key-shift";
          shiftIcon.textContent = "⇧";
          span.append(shiftIcon, content.slice(1));
        } else span.textContent = content;
        if (kind === "computer") span.setAttribute("aria-hidden", "true");
        tile.append(span);
      }
      keys.set(note, { tile, x });
      fragment.append(tile);
    }
    $("keyboard").replaceChildren(fragment);
    $("octaveValue").textContent = prefs.octave > 0 ? "+" + prefs.octave : prefs.octave;
    $("octDown").disabled = prefs.octave <= -2;
    $("octUp").disabled = prefs.octave >= 2;
    for (const entry of held.values()) paintKey(entry.note);
  }
  function octave(delta) {
    const target = clamp(prefs.octave + delta, -2, 2);
    if (prefs.octave === target) return;
    clearHands(); prefs.octave = target; rebuildKeyboard(); save();
  }
  function paintKey(note) {
    const key = keys.get(note);
    if (!key) return;
    const entry = [...held.values()].find((item) => item.note === note);
    key.tile.classList.toggle("active", Boolean(entry));
    if (entry) key.tile.style.setProperty("--key-color", entry.color);
  }
  function readout() {
    const active = [...new Set([...held.values()].map((entry) => entry.note))];
    const text = active.length ? active.map(noteName).join(" · ") : lastNote !== null ? noteName(lastNote) : "Ready to play";
    $("noteReadout").replaceChildren(document.createElement("i"), text);
  }
  function lightOn(id, note, velocity, kind, voice = null, channel = null) {
    if (held.has(id)) noteOff(id);
    const x = keys.get(note)?.x ?? (note < keys.keys().next().value ? .012 : .988);
    const color = visual.strike(id, x, velocity, now());
    held.set(id, { note, voice, color, kind, channel });
    paintKey(note);
    lastNote = note;
    readout();
  }
  function pedalDown(channel = null) {
    return prefs.sustain || spacePedal || midiSustain.has(channel);
  }
  function releaseDampers(force) {
    for (const entry of sustained) {
      if (entry.voice.ended) sustained.delete(entry);
      else if (force?.(entry) || !pedalDown(entry.channel)) {
        sustained.delete(entry);
        entry.voice.stop(undefined, .62);
      }
    }
  }
  function syncPedal() {
    const button = $("sustain");
    button.setAttribute("aria-pressed", prefs.sustain);
    button.classList.toggle("pedal-down", pedalDown() || midiSustain.size > 0);
    releaseDampers();
  }
  function noteOff(id, force = false) {
    const entry = held.get(id);
    if (!entry) return;
    if (entry.voice) {
      if (!force && pedalDown(entry.channel) && !entry.voice.ended) {
        sustained.add(entry);
        releaseDampers();
      }
      else entry.voice.stop(undefined, force ? .20 : undefined);
    }
    held.delete(id);
    visual.release(id, now());
    paintKey(entry.note);
    readout();
  }
  function releaseInput(id) {
    for (const note of stepInputs.get(id) || []) noteOff(note);
    stepInputs.delete(id);
    noteOff(id);
  }
  function releaseKind(kind) {
    for (const [id, item] of held) if (item.kind === kind) noteOff(id, true);
    releaseDampers((entry) => entry.kind === kind);
    if (kind === "step") stepInputs.clear();
  }
  function clearHands() {
    releaseKind("hands");
    releaseKind("step");
    midiSustain.clear();
    spacePedal = false;
    syncPedal();
  }
  function releaseComputerInputs() {
    const isComputer = (id) => id.startsWith("key:") || id.startsWith("pointer:");
    for (const id of held.keys()) if (isComputer(id)) releaseInput(id);
    for (const id of stepInputs.keys()) if (isComputer(id)) releaseInput(id);
    spacePedal = false;
    syncPedal();
  }
  function manual(id, note, velocity, channel = null) {
    sound.wake();
    prepareSample();
    releaseInput(id);
    if (mode === "step") {
      stopPlayback();
      stepForward(id, velocity, channel);
    } else if (note !== undefined) {
      lightOn(id, note, velocity, "hands", sound.note(note, velocity), channel);
    }
  }
  function stepForward(input, velocity, channel) {
    if (step >= track.groups.length) { step = 0; position = 0; }
    const group = track.groups[step++];
    const voices = [];
    for (const item of group.notes) {
      const id = "step:" + ++sequence;
      const power = clamp(item.velocity * (.38 + velocity * .82), .04, 1);
      lightOn(id, item.note, power, "step", sound.note(item.note, power), channel);
      voices.push(id);
    }
    stepInputs.set(input, voices);
    position = step === track.groups.length ? track.duration : group.time;
    renderTransport();
  }
  function startPlayback() {
    if (playback) { stopPlayback(); return; }
    sound.wake();
    void prepareSample();
    if (position >= track.duration - .002) position = 0;
    releaseKind("step");
    playback = new MidiTransport({
      track, sound, from: position, rate: +$("speed").value, time: now,
      hidden: () => document.hidden,
      onFinish(state) {
        if (playback !== state) return;
        position = track.duration;
        playback = null;
        releaseKind("playback");
        step = track.groups.length;
        renderTransport();
      }
    });
    playback.start();
    renderTransport();
  }
  function stopPlayback() {
    if (!playback) return;
    position = playback.position;
    playback.stop();
    playback = null;
    releaseKind("playback");
    step = lowerBound(track.groups, position);
    renderTransport();
  }
  function paintPlayback() {
    if (!playback) return;
    const time = playback.clock();
    position = playback.position;
    for (const event of playback.events) {
      if (event.start <= time && time < event.end && !event.lit) {
        lightOn(event.id, event.item.note, event.item.velocity, "playback");
        event.lit = true;
      } else if (event.lit && time >= event.end) {
        noteOff(event.id);
        event.lit = false;
      }
    }
    renderTransport();
  }
  function seek(time) {
    const wasPlaying = Boolean(playback);
    stopPlayback(); releaseKind("step");
    position = clamp(time, 0, track.duration);
    step = lowerBound(track.groups, position);
    if (wasPlaying && position < track.duration) startPlayback();
    else renderTransport();
  }
  function durationLabel(seconds) {
    const secs = Math.max(0, Math.floor(seconds));
    return Math.floor(secs / 60) + ":" + String(secs % 60).padStart(2, "0");
  }
  function fill(input) {
    input.style.setProperty("--fill", (input.value - input.min) / (input.max - input.min) * 100 + "%");
  }
  function renderTransport() {
    const running = Boolean(playback), control = $("play"), seekBar = $("seek");
    $("togglePlayer").classList.toggle("playing", running);
    const label = running ? "Pause MIDI" : "Play MIDI";
    if (control.getAttribute("aria-label") !== label) {
      control.innerHTML = running ? pause : play;
      control.setAttribute("aria-label", label);
      control.title = label + " (Shift + Space)";
    }
    const time = durationLabel(position), total = durationLabel(track.duration);
    if ($("currentTime").textContent !== time) $("currentTime").textContent = time;
    if ($("duration").textContent !== total) $("duration").textContent = total;
    if (!isSeeking) seekBar.value = Math.round(position / track.duration * 1000);
    fill(seekBar);
  }
  function selectTrack(id) {
    if (!tracks.has(id)) return;
    stopPlayback(); releaseKind("step");
    track = tracks.get(id); position = 0; step = 0;
    $("trackName").textContent = track.name;
    $("trackType").textContent = track.demo ? "Demo · MIDI" : track.notes.length + (track.notes.length === 1 ? " note" : " notes") + " · MIDI";
    $("trackSelect").value = track.id;
    renderTransport();
  }
  function refreshTracks() {
    const select = $("trackSelect");
    select.replaceChildren(...[...tracks.values()].map((entry) => new Option(entry.name, entry.id)));
    select.value = track.id;
  }
  function setMode(next) {
    mode = next;
    for (const button of all("[data-mode]")) button.setAttribute("aria-pressed", button.dataset.mode === mode);
    if (mode === "step") stopPlayback();
    clearHands();
  }

  function refreshPalette() {
    for (const button of all("[data-palette]")) button.setAttribute("aria-pressed", button.dataset.palette === prefs.palette);
    $("customColor").value = prefs.customColor;
    $("customColor").parentElement.classList.toggle("selected", prefs.palette === "custom");
    $("customColor").parentElement.style.setProperty("--custom", prefs.customColor);
  }
  function refreshSound() {
    sound.level = prefs.volume / 100;
    sound.ambience = prefs.reverb / 100;
    sound.releaseTime = .12 + prefs.release * .008;
    sound.muted = prefs.mute;
    sound.instrument = prefs.instrument.startsWith("local:") ? (sound.sample ? "sample" : "steinway") : prefs.instrument;
    sound.update();
    const label = prefs.mute ? "Unmute" : "Mute", button = $("mute");
    button.innerHTML = prefs.mute ? quiet : speaker;
    button.title = label;
    button.setAttribute("aria-label", label);
    button.setAttribute("aria-pressed", prefs.mute);
  }
  function refreshControls() {
    for (const id of ["glow", "bloom", "density", "trail", "volume", "reverb", "release"]) {
      $(id).value = prefs[id];
      $(id + "Value").textContent = $(id).value + "%";
      fill($(id));
    }
    for (const id of ["particles", "waves", "atmosphere"]) $(id).checked = prefs[id];
    for (const id of ["labels", "notation", "touch"]) $(id).value = prefs[id];
    refreshPalette(); refreshSound();
  }
  function currentSample() {
    return prefs.instrument.startsWith("local:") ? samples.get(prefs.instrument.slice(6)) : null;
  }
  function refreshSamples() {
    const control = $("instrument");
    for (const option of [...control.options]) if (option.value.startsWith("local:")) option.remove();
    for (const entry of samples.values()) control.add(new Option(entry.name, "local:" + entry.id));
    control.value = prefs.instrument;
    if (!control.value) control.value = "steinway";
    const entry = currentSample();
    $("sampleRootField").hidden = !entry;
    if (entry) $("sampleRoot").value = entry.root;
    $("sampleStatus").textContent = entry ? entry.name : samples.size ? "Available samples: " + samples.size : "";
  }
  async function prepareSample() {
    const entry = currentSample();
    if (!entry || sound.sample?.id === entry.id || entry.loading || entry.failed) return;
    entry.loading = true;
    const loadId = audioLoadId;
    try {
      entry.decoded ??= await sound.decode(entry.bytes);
      if (loadId !== audioLoadId) return;
      sound.sample = { id: entry.id, buffer: entry.decoded, root: entry.root };
      refreshSound();
    } catch {
      entry.failed = true;
      if (loadId === audioLoadId) $("sampleStatus").textContent = "This browser could not decode the sample.";
    } finally {
      entry.loading = false;
      if (loadId !== audioLoadId && currentSample()?.id === entry.id) void prepareSample();
    }
  }
  function chooseInstrument(name, activate = true) {
    audioLoadId++;
    prefs.instrument = name;
    sound.sample = null;
    refreshSamples(); refreshSound(); save();
    if (activate) {
      sound.wake();
      void sound.loadGrand(sound.instrument, touchVelocity[prefs.touch]).catch(() => {});
      void prepareSample();
    }
  }
  const newId = () => globalThis.crypto?.randomUUID?.() || Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
  async function importMidi(files) {
    if (!files.length) return;
    let selected = null, errorText = "";
    for (const file of files) {
      try {
        if (file.size > 16 * 1024 * 1024) throw new Error("The maximum MIDI file size is 16 MB.");
        const bytes = await file.arrayBuffer(), id = newId(), name = file.name.replace(/\.midi?$/i, "");
        tracks.set(id, { ...window.LumaMidi.readMidi(bytes), id, name });
        selected = id;
        void media("tracks", "put", { id, name, bytes });
      } catch (error) { errorText ||= file.name + " — " + error.message; }
    }
    if (selected) {
      refreshTracks(); selectTrack(selected); setMode("step"); showOverlay("player");
    }
    notify(errorText || "MIDI loaded. Press any key to play.");
  }
  async function importSamples(files) {
    if (!files.length) return;
    let selected = null, errorText = "";
    $("sampleStatus").textContent = "Loading…";
    for (const file of files) {
      try {
        if (file.size > 20 * 1024 * 1024) throw new Error("The maximum sample file size is 20 MB.");
        const bytes = await file.arrayBuffer(), decoded = await sound.decode(bytes);
        const entry = { id: newId(), name: file.name.replace(/\.[^.]+$/, ""), bytes, root: 60 };
        void media("samples", "put", entry);
        samples.set(entry.id, { ...entry, decoded });
        selected = entry.id;
      } catch (error) { errorText ||= file.name + " — " + (error.message || "could not read the audio."); }
    }
    if (selected) chooseInstrument("local:" + selected);
    else $("sampleStatus").textContent = "Could not load the audio.";
    if (errorText) notify(errorText);
  }
  async function restoreMedia() {
    const [storedTracks, storedSamples] = await Promise.all([media("tracks", "getAll"), media("samples", "getAll")]);
    for (const entry of storedTracks || []) {
      try { tracks.set(entry.id, { ...window.LumaMidi.readMidi(entry.bytes), id: entry.id, name: entry.name }); } catch {}
    }
    for (const entry of storedSamples || []) if (!samples.has(entry.id)) samples.set(entry.id, entry);
    refreshTracks(); refreshSamples();
    const entry = currentSample();
    if (entry && window.OfflineAudioContext) {
      try {
        entry.decoded ??= await new OfflineAudioContext(1, 1, 44100).decodeAudioData(entry.bytes.slice(0));
        if (entry === currentSample()) void prepareSample();
      } catch {}
    }
  }
  const overlayButtons = { settings: "openSettings", player: "togglePlayer" };
  function showOverlay(id, open = true) {
    $(id).hidden = !open;
    $(overlayButtons[id]).setAttribute("aria-expanded", open);
    if (open && viewport.matches) {
      const other = id === "settings" ? "player" : "settings";
      $(other).hidden = true;
      $(overlayButtons[other]).setAttribute("aria-expanded", "false");
    }
  }
  function present(clean) {
    document.body.classList.toggle("clean", clean);
    $(clean ? "restoreUi" : "hideUi").focus({ preventScroll: true });
  }
  async function fullScreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else if (document.documentElement.requestFullscreen) await document.documentElement.requestFullscreen();
      else present(true);
    } catch { present(true); }
  }
  function setTab(id, focus = false) {
    for (const tab of all("[role=tab]")) {
      const active = tab.id === id;
      tab.setAttribute("aria-selected", active);
      tab.tabIndex = active ? 0 : -1;
      $(tab.getAttribute("aria-controls")).hidden = !active;
      if (active && focus) tab.focus();
    }
  }
  function buildBindings(reset = false) {
    const parent = $("bindingList"), shift = prefs.octave * 12;
    const header = document.createElement("div");
    header.className = "binding-row";
    for (const title of ["Note", "Label", "Key"]) {
      const span = document.createElement("span");
      span.textContent = title;
      header.append(span);
    }
    parent.replaceChildren(header);
    for (let base = firstKey; base <= lastKey; base++) {
      const note = base + shift, title = pitchName(note);
      const row = document.createElement("div"), pitch = document.createElement("span");
      const name = document.createElement("input"), code = document.createElement("input");
      row.className = "binding-row"; pitch.textContent = title;
      name.type = "text"; name.maxLength = 12; name.value = reset ? "" : prefs.labelsByNote[note] || "";
      name.placeholder = title; name.dataset.label = note; name.setAttribute("aria-label", "Label " + title);
      code.type = "text"; code.readOnly = true; code.placeholder = "—"; code.dataset.base = base;
      code.dataset.code = reset ? defaultBindings[base] || "" : binding(base);
      code.value = codeName(code.dataset.code);
      code.setAttribute("aria-label", "Key for " + title);
      code.addEventListener("keydown", (event) => {
        if (["Tab", "Escape", "Shift", "Control", "Alt", "Meta"].includes(event.key)) return;
        event.preventDefault(); event.stopPropagation();
        const next = ["Backspace", "Delete"].includes(event.key) ? "" : bindingFromEvent(event);
        if (next && !/^(?:Shift\+)?(Key[A-Z]|Digit[0-9]|Numpad[0-9]|Comma|Period|Slash|Minus|Equal|Semicolon|Quote|Backquote|Backslash|IntlBackslash)$/.test(next)) return;
        for (const other of parent.querySelectorAll("[data-code]")) {
          if (next && other !== code && other.dataset.code === next) { other.dataset.code = ""; other.value = ""; }
        }
        code.dataset.code = next; code.value = codeName(next);
      });
      row.append(pitch, name, code);
      parent.append(row);
    }
  }
  function saveBindings() {
    const labels = { ...prefs.labelsByNote };
    for (const field of $("bindingList").querySelectorAll("[data-label]")) {
      if (field.value.trim()) labels[field.dataset.label] = field.value.trim();
      else delete labels[field.dataset.label];
    }
    prefs.labelsByNote = labels;
    prefs.keys = Object.fromEntries([...$("bindingList").querySelectorAll("[data-base]")].filter((field) => field.dataset.code).map((field) => [field.dataset.base, field.dataset.code]));
    clearHands(); rebuildKeyboard(); readout(); save(); $("labelDialog").close();
  }
  function silenceMidi(matches, inputMatches) {
    for (const [id, entry] of held) if (entry.channel && matches(entry.channel)) noteOff(id, true);
    for (const input of stepInputs.keys()) if (inputMatches(input)) stepInputs.delete(input);
    for (const channel of midiSustain) if (matches(channel)) midiSustain.delete(channel);
    releaseDampers((entry) => entry.channel && matches(entry.channel));
    syncPedal();
  }
  function midiMessage(event, input) {
    if (event.data.length < 3) return;
    const [status, note, velocity] = event.data;
    const command = status & 0xf0, channel = input.id + ":" + (status & 15), id = "midi:" + channel + ":" + note;
    if (command === 0x90 && velocity > 0) {
      $("midiActivity").textContent = pitchName(note) + " · " + velocity + "/127";
      manual(id, note, velocity / 127, channel);
    } else if (command === 0x80 || command === 0x90) {
      releaseInput(id);
    } else if (command === 0xb0 && note === 64) {
      if (velocity >= 64) midiSustain.add(channel);
      else midiSustain.delete(channel);
      syncPedal();
    } else if (command === 0xb0 && note === 121) {
      midiSustain.delete(channel);
      syncPedal();
    } else if (command === 0xb0 && (note === 120 || note === 123)) {
      silenceMidi((value) => value === channel, (value) => value.startsWith("midi:" + channel + ":"));
    }
  }
  function midiDevices(event) {
    if (event?.port?.type === "output") return;
    if (event?.port?.state === "disconnected") {
      const prefix = event.port.id + ":";
      silenceMidi((value) => value.startsWith(prefix), (value) => value.startsWith("midi:" + prefix));
      $("midiActivity").textContent = "";
    }
    const devices = [...midiAccess.inputs.values()].filter((input) => input.state === "connected");
    const select = $("midiInput");
    select.replaceChildren(new Option("All connected inputs", "all"),
      ...devices.map((input) => new Option(input.name || "MIDI", input.id)));
    const chosen = devices.some((input) => input.id === prefs.midiInput) ? prefs.midiInput : "all";
    select.value = chosen;
    select.disabled = devices.length < 2;
    for (const input of devices) {
      input.onmidimessage = chosen === "all" || chosen === input.id ? (message) => midiMessage(message, input) : null;
    }
    $("deviceStatus").textContent = devices.length ? devices.map((input) => input.name || "MIDI").join(", ") : "No MIDI inputs found.";
  }
  async function connectMidi() {
    sound.wake(); void prepareSample();
    const status = $("deviceStatus"), button = $("connectMidi");
    if (window.isSecureContext === false) {
      status.textContent = "Open this site over HTTPS or on localhost to connect a MIDI controller.";
      return;
    }
    if (!navigator.requestMIDIAccess) {
      status.textContent = "This browser does not support Web MIDI.";
      return;
    }
    button.disabled = true;
    try {
      midiAccess ??= await navigator.requestMIDIAccess({ sysex: false });
      midiAccess.onstatechange = midiDevices;
      midiDevices();
      button.textContent = "Refresh MIDI inputs";
    } catch {
      status.textContent = "MIDI access was denied. Check the site's permissions in your browser.";
    } finally {
      button.disabled = false;
    }
  }
  function keyboardInput(event) {
    if ($("labelDialog").open || event.metaKey || event.ctrlKey || event.altKey || event.isComposing) return;
    if (event.code === "Escape") {
      if (!document.fullscreenElement && !event.repeat) {
        const clean = document.body.classList.contains("clean");
        const shown = Object.keys(overlayButtons).filter((id) => !$(id).hidden);
        if (shown.length && !clean) {
          for (const id of shown) showOverlay(id, false);
          $(overlayButtons[shown[0]]).focus();
        } else present(!clean);
      }
      return;
    }
    if (event.target instanceof HTMLElement && (event.target.matches("input:not([type=range]):not([type=checkbox]), select, textarea") || event.target.isContentEditable)) return;
    if (event.code === "Space") {
      if (!event.shiftKey && event.target.matches?.("input[type=checkbox]:focus-visible")) return;
      event.preventDefault();
      if (!event.repeat) {
        if (event.shiftKey) startPlayback();
        else { spacePedal = true; syncPedal(); }
      }
      return;
    }
    if (event.code === "BracketLeft" || event.code === "BracketRight") {
      event.preventDefault();
      if (!event.repeat) octave(event.code === "BracketLeft" ? -1 : 1);
      return;
    }
    const note = keyIndex.get(bindingFromEvent(event));
    if (note === undefined && !(mode === "step" && event.key.length === 1 && event.code !== "Space")) return;
    event.preventDefault();
    if (!event.repeat) manual("key:" + event.code, note, touchVelocity[prefs.touch] ?? .71);
  }

  for (const button of all("[data-import-midi]")) button.addEventListener("click", () => $("midiFile").click());
  for (const [id, handler] of [["midiFile", importMidi], ["sampleFile", importSamples]]) {
    $(id).addEventListener("change", (event) => { void handler([...event.target.files]); event.target.value = ""; });
  }
  $("importSample").addEventListener("click", () => { sound.wake(); $("sampleFile").click(); });
  $("screen").addEventListener("dragover", (event) => {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault(); event.dataTransfer.dropEffect = "copy";
    $("screen").classList.add("dragging");
  });
  $("screen").addEventListener("dragleave", (event) => {
    if (!$("screen").contains(event.relatedTarget)) $("screen").classList.remove("dragging");
  });
  $("screen").addEventListener("drop", (event) => {
    event.preventDefault(); $("screen").classList.remove("dragging");
    void importMidi([...event.dataTransfer.files]);
  });
  window.addEventListener("dragover", (event) => {
    if (event.dataTransfer.types.includes("Files")) event.preventDefault();
  });
  window.addEventListener("drop", (event) => {
    if (event.dataTransfer.types.includes("Files")) event.preventDefault();
  });
  for (const [id, button] of Object.entries(overlayButtons)) {
    $(button).addEventListener("click", () => showOverlay(id, $(id).hidden));
  }
  for (const [control, panel] of [["closeSettings", "settings"], ["closePlayer", "player"]]) {
    $(control).addEventListener("click", () => {
      showOverlay(panel, false);
      $(overlayButtons[panel]).focus();
    });
  }
  $("hideUi").addEventListener("click", () => present(true));
  $("restoreUi").addEventListener("click", () => present(false));
  $("fullscreen").addEventListener("click", fullScreen);
  $("play").addEventListener("click", (event) => { startPlayback(); if (event.detail) $("play").blur(); });
  $("restart").addEventListener("click", () => seek(0));
  $("trackSelect").addEventListener("change", (event) => { selectTrack(event.target.value); event.target.blur(); });
  $("seek").addEventListener("pointerdown", () => { isSeeking = true; });
  for (const event of ["pointerup", "pointercancel", "change", "blur"]) $("seek").addEventListener(event, () => { isSeeking = false; });
  $("seek").addEventListener("input", (event) => seek(+event.target.value / 1000 * track.duration));
  $("speed").addEventListener("change", (event) => {
    if (playback) { stopPlayback(); startPlayback(); }
    event.target.blur();
  });
  $("sustain").addEventListener("click", (event) => {
    prefs.sustain = !prefs.sustain;
    syncPedal();
    save();
    if (event.detail) $("sustain").blur();
  });
  $("mute").addEventListener("click", () => { prefs.mute = !prefs.mute; refreshSound(); save(); });
  $("octDown").addEventListener("click", () => octave(-1));
  $("octUp").addEventListener("click", () => octave(1));
  for (const button of all("[data-mode]")) button.addEventListener("click", () => setMode(button.dataset.mode));
  for (const tab of all("[role=tab]")) {
    tab.addEventListener("click", () => setTab(tab.id));
    tab.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      const tabs = all("[role=tab]"), index = tabs.indexOf(tab);
      const next = { Home: 0, End: tabs.length - 1, ArrowLeft: (index + tabs.length - 1) % tabs.length, ArrowRight: (index + 1) % tabs.length };
      event.preventDefault(); setTab(tabs[next[event.key]].id, true);
    });
  }
  for (const button of all("[data-palette]")) button.addEventListener("click", () => { prefs.palette = button.dataset.palette; refreshPalette(); save(); });
  $("customColor").addEventListener("input", (event) => { prefs.palette = "custom"; prefs.customColor = event.target.value; refreshPalette(); save(); });
  $("resetEffects").addEventListener("click", () => { for (const id of effects) prefs[id] = defaults[id]; refreshControls(); save(); });
  for (const id of ["glow", "bloom", "density", "trail", "volume", "reverb", "release"]) {
    $(id).addEventListener("input", (event) => {
      prefs[id] = +event.target.value;
      $(id + "Value").textContent = prefs[id] + "%";
      fill(event.target);
      if (["volume", "reverb", "release"].includes(id)) refreshSound();
      save();
    });
  }
  for (const id of ["particles", "waves", "atmosphere"]) $(id).addEventListener("change", (event) => { prefs[id] = event.target.checked; save(); });
  for (const id of ["labels", "notation"]) $(id).addEventListener("change", (event) => { prefs[id] = event.target.value; rebuildKeyboard(); readout(); save(); });
  $("instrument").addEventListener("change", (event) => chooseInstrument(event.target.value));
  $("resetSound").addEventListener("click", () => {
    for (const id of ["volume", "reverb", "release", "touch"]) prefs[id] = defaults[id];
    refreshControls();
    chooseInstrument(defaults.instrument);
  });
  $("touch").addEventListener("change", (event) => {
    prefs.touch = event.target.value;
    void sound.loadGrand(sound.instrument, touchVelocity[prefs.touch]).catch(() => {});
    save();
  });
  $("sampleRoot").addEventListener("change", (event) => {
    const entry = currentSample();
    if (!entry) return;
    entry.root = +event.target.value;
    if (sound.sample) sound.sample.root = entry.root;
    void media("samples", "put", { id: entry.id, name: entry.name, bytes: entry.bytes, root: entry.root });
  });
  for (let note = 24; note <= 96; note++) $("sampleRoot").add(new Option(pitchName(note, "letters"), note));
  $("editLabels").addEventListener("click", () => { clearHands(); buildBindings(); $("labelDialog").showModal(); });
  $("resetLabels").addEventListener("click", () => buildBindings(true));
  $("saveLabels").addEventListener("click", saveBindings);
  $("labelDialog").querySelector("form").addEventListener("submit", (event) => {
    if (event.submitter?.value !== "cancel" || document.activeElement instanceof HTMLInputElement) event.preventDefault();
  });
  $("connectMidi").addEventListener("click", connectMidi);
  $("midiInput").addEventListener("change", (event) => {
    if (!midiAccess) return;
    silenceMidi(() => true, (id) => id.startsWith("midi:"));
    prefs.midiInput = event.target.value;
    midiDevices();
    save();
  });

  const pointers = new Map(), board = $("keyboard");
  board.addEventListener("pointerdown", (event) => {
    const tile = event.target.closest(".piano-key");
    if (!tile || (event.pointerType === "mouse" && event.button !== 0)) return;
    event.preventDefault();
    document.activeElement.blur?.();
    const note = +tile.dataset.note;
    pointers.set(event.pointerId, note);
    board.setPointerCapture(event.pointerId);
    manual("pointer:" + event.pointerId, note, touchVelocity[prefs.touch] ?? .71);
  });
  board.addEventListener("pointermove", (event) => {
    if (!pointers.has(event.pointerId) || mode === "step") return;
    const tile = document.elementFromPoint(event.clientX, event.clientY)?.closest(".piano-key");
    const next = tile ? +tile.dataset.note : null;
    if (next === pointers.get(event.pointerId)) return;
    pointers.set(event.pointerId, next);
    releaseInput("pointer:" + event.pointerId);
    if (next !== null) manual("pointer:" + event.pointerId, next, (touchVelocity[prefs.touch] ?? .71) * .90);
  });
  for (const event of ["pointerup", "pointercancel", "lostpointercapture"]) {
    board.addEventListener(event, (data) => { pointers.delete(data.pointerId); releaseInput("pointer:" + data.pointerId); });
  }
  window.addEventListener("keydown", keyboardInput);
  window.addEventListener("keyup", (event) => {
    if (event.code === "Space" && spacePedal) { spacePedal = false; syncPedal(); }
    releaseInput("key:" + event.code);
  });
  window.addEventListener("blur", releaseComputerInputs);
  viewport.addEventListener("change", rebuildKeyboard);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      releaseComputerInputs();
      releaseKind("playback");
      if (playback) for (const event of playback.events) event.lit = false;
    }
    playback?.refresh();
  });
  document.addEventListener("pointerdown", () => { void prepareSample(); });
  refreshControls(); rebuildKeyboard(); refreshTracks(); refreshSamples(); renderTransport(); syncPedal();
  void restoreMedia();
  void sound.loadGrand(sound.instrument, touchVelocity[prefs.touch]).catch(() => {});
  function frame(timestamp) {
    if (!document.hidden) {
      paintPlayback();
      visual.draw(timestamp / 1000);
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})();





