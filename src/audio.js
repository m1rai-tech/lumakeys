(() => {
  "use strict";
  const dampingCurve = [[0, 1], [.44, .38], [.81, .092], [1, .0001]];
  const dampingFloor = .0001;
  function gainAt(release, time) {
    const progress = (time - release.time) / release.fade;
    if (progress >= 1) return dampingFloor;
    const index = dampingCurve.findIndex(([point]) => point > progress);
    const [leftTime, leftGain] = dampingCurve[index - 1], [rightTime, rightGain] = dampingCurve[index];
    const weight = (progress - leftTime) / (rightTime - leftTime);
    const left = Math.max(dampingFloor, release.level * leftGain);
    const right = Math.max(dampingFloor, release.level * rightGain);
    return left * (right / left) ** weight;
  }
  const bank = (rows, thresholds, peaks) => ({
    rows, thresholds, peaks, samples: new Map(), pending: new Map(), warmed: new Map()
  });
  function nearest(rows, midi) {
    let choice, smallest = Infinity;
    for (const row of rows) {
      const distance = Math.abs(row[0] - midi);
      if (distance < smallest) { choice = row; smallest = distance; }
    }
    return choice;
  }
  const layerFor = (instrument, velocity) => instrument.thresholds.findLastIndex((limit) => velocity >= limit);
  class PianoSound {
    constructor() {
      this.context = null;
      this.level = .8;
      this.ambience = .08;
      this.releaseTime = .70;
      this.instrument = "steinway";
      this.muted = false;
      this.sample = null;
      this.voices = new Set();
      this.decoder = null;
      this.banks = {
        steinway: bank(window.LumaSteinwayBank || [], [0, .46, .81], [.134, .308, .650]),
        grand: bank((window.LumaGrandBank || []).map(([root, bytes]) => [root, [bytes]]), [0], [1])
      };
    }

    wake() {
      if (!this.context) {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        if (!AudioContext) return null;
        const context = this.context = new AudioContext({ latencyHint: "interactive" });
        this.bus = context.createGain();
        this.master = context.createGain();
        this.wet = context.createGain();
        const inputTrim = context.createGain();
        inputTrim.gain.value = .46;
        const compressor = context.createDynamicsCompressor();
        compressor.threshold.value = -11;
        compressor.ratio.value = 3.5;
        compressor.knee.value = 16;
        compressor.attack.value = .005;
        compressor.release.value = .16;
        const space = context.createConvolver();
        const length = Math.floor(1.16 * context.sampleRate);
        let noise = 60224;
        space.buffer = context.createBuffer(2, length, context.sampleRate);
        for (let channel = 0; channel < 2; channel++) {
          const samples = space.buffer.getChannelData(channel);
          for (let i = 0; i < length; i++) {
            noise = (Math.imul(noise, 1664525) + 1013904223) >>> 0;
            samples[i] = (noise / 2147483648 - 1) * (1 - i / length) ** 3.6;
          }
        }
        const roomTone = context.createBiquadFilter();
        roomTone.type = "lowpass";
        roomTone.frequency.value = 4200;
        const rumble = context.createBiquadFilter();
        rumble.type = "highpass";
        rumble.frequency.value = 24;
        this.bus.connect(inputTrim);
        inputTrim.connect(rumble).connect(compressor);
        inputTrim.connect(space).connect(roomTone).connect(this.wet).connect(compressor);
        compressor.connect(this.master).connect(context.destination);
        this.update();
      }
      if (this.context.state === "suspended") void this.context.resume().catch(() => {});
      void this.loadGrand();
      return this.context;
    }

    getDecoder() {
      const OfflineAudioContext = window.OfflineAudioContext || window.webkitOfflineAudioContext;
      if (!this.decoder && OfflineAudioContext) this.decoder = new OfflineAudioContext(2, 1, 44100);
      return this.decoder || this.context;
    }

    requestRecording(instrument, row, layer) {
      if (!row) return Promise.resolve(null);
      const [root, clips] = row;
      const key = root + ":" + layer;
      if (instrument.samples.has(key)) return Promise.resolve(instrument.samples.get(key));
      if (instrument.pending.has(key)) return instrument.pending.get(key);
      const decoder = this.getDecoder();
      if (!decoder) return Promise.resolve(null);
      const request = (async () => {
        try {
          const raw = atob(clips[layer]), bytes = new Uint8Array(raw.length);
          for (let index = 0; index < raw.length; index++) bytes[index] = raw.charCodeAt(index);
          const buffer = await decoder.decodeAudioData(bytes.buffer);
          const sample = { buffer, root, layer, peak: instrument.peaks[layer] };
          instrument.samples.set(key, sample);
          return sample;
        } catch { return null; }
      })();
      instrument.pending.set(key, request);
      return request;
    }

    async loadGrand(name = this.instrument, velocity = .71) {
      const instrument = this.banks[name];
      if (!instrument || !this.getDecoder()) return 0;
      const layer = layerFor(instrument, velocity);
      if (!instrument.warmed.has(layer)) {
        const loading = (async () => {
          let count = 0;
          for (let index = 0; index < instrument.rows.length; index += 5) {
            const results = await Promise.all(instrument.rows.slice(index, index + 5)
              .map((row) => this.requestRecording(instrument, row, layer)));
            count += results.filter(Boolean).length;
          }
          return count;
        })();
        instrument.warmed.set(layer, loading);
      }
      return instrument.warmed.get(layer);
    }

    update() {
      if (!this.context) return;
      const time = this.context.currentTime;
      this.master.gain.setTargetAtTime(this.muted ? 0 : this.level, time, .023);
      this.wet.gain.setTargetAtTime(this.ambience * .51, time, .036);
    }

    decode(bytes) {
      const context = this.wake();
      if (!context) throw new Error("This browser does not support Web Audio.");
      return context.decodeAudioData(bytes.slice(0));
    }

    recording(midi, velocity, name) {
      if (name === "sample" && this.sample) return { sample: this.sample, requested: null };
      const instrument = this.banks[name] || this.banks.steinway;
      const row = nearest(instrument.rows, midi);
      const layer = layerFor(instrument, velocity);
      const requested = this.requestRecording(instrument, row, layer);
      const exact = row && instrument.samples.get(row[0] + ":" + layer);
      if (exact) return { sample: exact, requested };
      let sample = null, smallest = 8;
      for (const ready of instrument.samples.values()) {
        const distance = Math.abs(ready.root - midi) + 2.3 * Math.abs(ready.layer - layer);
        if (distance < smallest) { sample = ready; smallest = distance; }
      }
      return { sample, requested };
    }

    note(midi, velocity = .75, start, duration) {
      const context = this.context;
      if (!context) return null;
      const time = Math.max(context.currentTime, start ?? context.currentTime);
      const name = this.instrument;
      const { sample, requested } = this.recording(midi, velocity, name);
      if (sample) return this.playRecording(sample, midi, velocity, time, duration);
      let releaseAt = duration === undefined ? Infinity : time + duration;
      let releaseFade, voice, resolved = false;
      void requested.then(async (target) => {
        if (!target && name === "steinway") {
          const backup = this.recording(midi, velocity, "grand");
          target = backup.sample || await backup.requested;
        }
        const actual = Math.max(context.currentTime, time);
        const musicalRelease = releaseFade === undefined || releaseFade >= .4;
        if (target && actual - time < .24 && (releaseAt > actual || musicalRelease)) {
          voice = this.playRecording(target, midi, velocity, actual);
          if (Number.isFinite(releaseAt)) voice.stop(Math.max(actual + .023, releaseAt), releaseFade);
        }
        resolved = true;
      });
      return {
        get ended() { return resolved && (!voice || voice.ended); },
        stop(when = context.currentTime, fade) {
          if (when <= releaseAt) { releaseAt = when; releaseFade = fade; }
          voice?.stop(when, fade);
        }
      };
    }

    playRecording(recording, midi, velocity, start, duration) {
      const context = this.context;
      const source = context.createBufferSource();
      const tone = context.createBiquadFilter();
      const amp = context.createGain();
      const gate = context.createGain();
      source.buffer = recording.buffer;
      source.playbackRate.value = 2 ** ((midi - recording.root) / 12);
      tone.type = "lowpass";
      tone.frequency.value = Math.min(context.sampleRate * .45, 4100 + 14000 * velocity ** .85 + Math.max(0, midi - 72) * 95);
      tone.Q.value = .35;
      amp.gain.setValueAtTime(.0001, start);
      const strength = (.13 + .87 * velocity ** 1.28) * 1.03;
      const level = Math.min(2.8, strength / (recording.peak || 1));
      amp.gain.linearRampToValueAtTime(level, start + .003);
      source.connect(tone).connect(amp).connect(gate);
      const pan = recording.buffer.numberOfChannels === 1 ? context.createStereoPanner?.() : null;
      if (pan) {
        pan.pan.value = Math.max(-.27, Math.min(.27, (midi - 62) * .009));
        gate.connect(pan).connect(this.bus);
      } else gate.connect(this.bus);
      const natural = this.releaseTime * Math.max(.66, Math.min(1.36, 1 - (midi - 60) * .009));
      let release = null;
      const entry = {
        midi,
        start,
        ended: false,
        tailEnd: Infinity,
        stop: (when = context.currentTime, fade = natural) => {
          if (entry.ended) return;
          const musicalRelease = fade >= .4;
          const time = Math.max(when, context.currentTime, musicalRelease ? start + .021 : 0);
          const tailEnd = time <= start ? time + .002 : time + fade + .012;
          if (release && time >= release.time && tailEnd >= entry.tailEnd) return;
          let level = time <= start ? .0001 : 1;
          if (release && time >= release.time && time > start) {
            level = gainAt(release, time);
          }
          entry.tailEnd = tailEnd;
          release = { time, level, fade };
          gate.gain.cancelScheduledValues(time);
          gate.gain.setValueAtTime(Math.max(.0001, level), time);
          if (time > start) {
            for (const [point, ratio] of dampingCurve.slice(1)) {
              gate.gain.exponentialRampToValueAtTime(Math.max(dampingFloor, level * ratio), time + fade * point);
            }
          }
          try { source.stop(tailEnd); } catch {}
        }
      };
      source.onended = () => {
        entry.ended = true;
        gate.disconnect();
        pan?.disconnect();
        this.voices.delete(entry);
      };
      const live = [...this.voices].filter((voice) => voice.start <= start && voice.tailEnd > start + .09);
      // A new strike damps the previous vibration of the same key with a brief overlap.
      for (const older of live) if (older.midi === midi) {
        older.stop(start + .009, .122);
      }
      if (live.length >= 64) (live.find((voice) => voice.midi !== midi) || live[0]).stop(start, .055);
      this.voices.add(entry);
      source.start(start);
      if (duration !== undefined) entry.stop(start + duration);
      return entry;
    }
  }
  window.LumaAudio = PianoSound;
})();

