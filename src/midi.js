(() => {
  "use strict";
  function readMidi(buffer) {
    const view = new DataView(buffer);
    let pos = 0, limit = view.byteLength;
    const need = (count) => {
      if (pos + count > limit) throw new Error("The MIDI file is incomplete or corrupted.");
    };
    const u8 = () => { need(1); return view.getUint8(pos++); };
    const u16 = () => { need(2); const value = view.getUint16(pos); pos += 2; return value; };
    const u32 = () => { need(4); const value = view.getUint32(pos); pos += 4; return value; };
    const text = (size) => { need(size); const value = new Uint8Array(buffer, pos, size); pos += size; return value; };
    const tag = () => String.fromCharCode(...text(4));
    function variable() {
      let value = 0;
      for (let index = 0; index < 4; index++) {
        const next = u8();
        value = value * 128 + (next & 127);
        if (next < 128) return value;
      }
      throw new Error("Invalid MIDI event length.");
    }
    if (tag() !== "MThd") throw new Error("Choose a standard .mid or .midi file.");
    const headerLength = u32(), headerEnd = pos + headerLength;
    if (headerLength < 6 || headerEnd > limit) throw new Error("Invalid MIDI header.");
    const format = u16(), trackCount = u16(), division = u16();
    if (format > 2 || !division || !trackCount || trackCount > 512) throw new Error("Unsupported MIDI format.");
    pos = headerEnd;
    const tracks = [];
    while (tracks.length < trackCount) {
      const type = tag(), size = u32(), end = pos + size;
      need(size);
      if (type !== "MTrk") { pos = end; continue; }
      limit = end;
      let tick = 0, status = 0, eventCount = 0;
      const events = [], tempos = [];
      while (pos < end) {
        if (++eventCount > 750000) throw new Error("The track contains too many MIDI events.");
        tick += variable();
        const first = u8();
        if (first === 0xff) {
          const kind = u8(), bytes = text(variable());
          if (kind === 0x51 && bytes.length === 3) {
            const tempo = bytes[0] * 65536 + bytes[1] * 256 + bytes[2];
            if (tempo) tempos.push({ tick, tempo });
          }
          if (kind === 0x2f) break;
          continue;
        }
        if (first === 0xf0 || first === 0xf7) {
          text(variable());
          status = 0;
          continue;
        }
        const running = first < 0x80;
        if (!running) status = first;
        if (status < 0x80 || status > 0xef) throw new Error("Unsupported MIDI event.");
        const type = status & 0xf0, channel = status & 15;
        const a = running ? first : u8();
        const b = (type === 0xc0 || type === 0xd0) ? 0 : u8();
        if (a > 127 || b > 127) throw new Error("Invalid MIDI note data.");
        if (type === 0x80 || type === 0x90 || (type === 0xb0 && [64, 120, 121, 123].includes(a))) {
          events.push({ tick, type, channel, a, b });
        }
      }
      limit = view.byteLength;
      pos = end;
      tracks.push({ events, tempos, end: tick });
    }

    function clock(tempos) {
      if (division & 0x8000) {
        const frames = 256 - (division >> 8), subframes = division & 255;
        if (![24, 25, 29, 30].includes(frames) || !subframes) throw new Error("Invalid SMPTE frame rate.");
        return (tick) => tick / ((frames === 29 ? 30000 / 1001 : frames) * subframes);
      }
      const points = [{ tick: 0, time: 0, tempo: 500000 }];
      for (const point of tempos.sort((a, b) => a.tick - b.tick)) {
        const last = points.at(-1);
        const time = last.time + (point.tick - last.tick) * last.tempo / (division * 1000000);
        points.push({ ...point, time });
      }
      return (tick) => {
        let left = 0, right = points.length;
        while (left + 1 < right) {
          const mid = (left + right) >> 1;
          if (points[mid].tick <= tick) left = mid;
          else right = mid;
        }
        const point = points[left];
        return point.time + (tick - point.tick) * point.tempo / (division * 1000000);
      };
    }
    const parts = format === 2 ? tracks : [{
      tempos: tracks.flatMap((track) => track.tempos),
      events: tracks.flatMap((track) => track.events).sort((a, b) => a.tick - b.tick),
      end: Math.max(...tracks.map((track) => track.end))
    }];
    let offset = 0;
    const notes = [];
    for (const part of parts) {
      const toSeconds = clock(part.tempos);
      const channels = Array.from({ length: 16 }, () => ({ down: new Map(), held: [], sustain: false }));
      function close(note, end) {
        notes.push({ note: note.note, velocity: note.velocity, time: offset + toSeconds(note.tick), duration: Math.max(.035, toSeconds(end) - toSeconds(note.tick)) });
      }
      for (const { tick, type, channel, a, b } of part.events) {
        if (channel === 9) continue;
        const state = channels[channel];
        if (type === 0xb0) {
          if (a === 64 || a === 121 || a === 120) {
            state.sustain = a === 64 && b >= 64;
            if (!state.sustain) {
              for (const note of state.held) close(note, tick);
              state.held = [];
            }
          }
          if (a === 120 || a === 123) {
            for (const keys of state.down.values()) {
              for (const note of keys) {
                if (state.sustain) state.held.push(note);
                else close(note, tick);
              }
            }
            state.down.clear();
          }
        } else if (type === 0x90 && b > 0) {
          if (!state.down.has(a)) state.down.set(a, []);
          state.down.get(a).push({ tick, note: a, velocity: b / 127 });
        } else {
          const active = state.down.get(a);
          const note = active?.shift();
          if (active && !active.length) state.down.delete(a);
          if (note && state.sustain) state.held.push(note);
          else if (note) close(note, tick);
        }
      }
      for (const state of channels) {
        for (const note of state.held) close(note, part.end);
        for (const keys of state.down.values()) for (const note of keys) close(note, part.end);
      }
      offset += toSeconds(part.end);
    }
    if (!notes.length) throw new Error("This file contains no playable notes.");
    return makeTrack(notes);
  }

  function makeTrack(notes) {
    notes.sort((a, b) => a.time - b.time || a.note - b.note);
    const unique = [];
    for (const note of notes) {
      const previous = unique.at(-1);
      if (previous?.time === note.time && previous.note === note.note) {
        previous.duration = Math.max(previous.duration, note.duration);
        previous.velocity = Math.max(previous.velocity, note.velocity);
      } else unique.push(note);
    }
    notes = unique;
    const groups = [];
    let duration = 0, longestNote = 0;
    for (const note of notes) {
      const group = groups.at(-1);
      if (group && Math.abs(group.time - note.time) < .000001) group.notes.push(note);
      else groups.push({ time: note.time, notes: [note] });
      duration = Math.max(duration, note.time + note.duration);
      longestNote = Math.max(longestNote, note.duration);
    }
    return { notes, groups, duration, longestNote };
  }

  function demo() {
    const chords = [[45, 52, 60, 64, 69], [41, 48, 57, 60, 64], [48, 55, 60, 64, 67], [43, 50, 59, 62, 67],
      [45, 52, 60, 64, 69], [41, 48, 57, 60, 65], [50, 57, 60, 65, 69], [43, 50, 59, 62, 67]];
    const phrases = [[76, 81, 84, 81], [76, 77, 81, 84], [79, 76, 72, 76], [74, 79, 83, 79],
      [81, 84, 88, 84], [81, 77, 76, 72], [77, 81, 86, 84], [83, 79, 74, 79]];
    const notes = [];
    const add = (note, time, duration, velocity) => notes.push({ note, time, duration, velocity });
    const eighth = .287;
    for (let bar = 0; bar < 16; bar++) {
      const chord = chords[bar % 8];
      const phrase = phrases[bar % 8];
      const start = bar * 8 * eighth;
      add(chord[0], start, 7.8 * eighth, .62);
      [1, 2, 3, 4, 2, 3, 4, 2].forEach((key, index) => add(chord[key], start + index * eighth, 2.4 * eighth, .44 + (index % 3) * .033));
      const melody = bar < 8 ? phrase : [phrase[0], phrase[2], phrase[1], phrase[3]];
      melody.forEach((note, index) => add(note, start + index * 2 * eighth, (index === 3 ? 2.6 : 1.8) * eighth, .68 + index * .035));
    }
    const end = 16 * 8 * eighth;
    [45, 57, 60, 64, 69, 76].forEach((note) => add(note, end, 2.6, .57));
    return makeTrack(notes);
  }
  window.LumaMidi = { readMidi, demo };
})();

