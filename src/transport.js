(() => {
  "use strict";
  function lowerBound(items, time) {
    let low = 0, high = items.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (items[middle].time < time) low = middle + 1;
      else high = middle;
    }
    return low;
  }

  class MidiTransport {
    constructor({ track, sound, from, rate, time, hidden, onFinish }) {
      this.track = track;
      this.sound = sound;
      this.context = sound.context;
      this.clock = this.context ? () => this.context.currentTime : time;
      this.hidden = hidden;
      this.onFinish = onFinish;
      this.from = from;
      this.rate = rate;
      this.origin = this.clock() + .10;
      this.cursor = lowerBound(track.notes, from);
      this.events = [];
      this.running = false;
    }

    get position() {
      return Math.min(this.track.duration, this.from + Math.max(0, this.clock() - this.origin) * this.rate);
    }

    start() {
      this.running = true;
      for (let index = this.cursor - 1; index >= 0; index--) {
        const note = this.track.notes[index];
        if (note.time + this.track.longestNote <= this.from) break;
        const remaining = (note.time + note.duration - this.from) / this.rate;
        if (remaining > .035) this.queue(note, this.origin, remaining, index);
      }
      this.tick();
    }

    queue(item, start, duration, index) {
      const voice = this.sound.note(item.note, item.velocity, start, duration);
      this.events.push({ item, start, end: start + duration, id: "play:" + index, voice, lit: false });
    }

    refresh() {
      if (!this.running) return;
      const time = this.clock();
      this.events = this.events.filter((event) => event.lit || event.end + 2.4 > time);
      if (this.position >= this.track.duration) {
        this.stop(true);
        this.onFinish(this);
        return;
      }
      const horizon = time + (this.hidden() ? 11 : 1.15);
      const notes = this.track.notes;
      while (this.cursor < notes.length) {
        const note = notes[this.cursor];
        const start = this.origin + (note.time - this.from) / this.rate;
        if (start > horizon) break;
        const end = start + note.duration / this.rate;
        const audibleStart = Math.max(start, time);
        if (end > audibleStart) this.queue(note, audibleStart, end - audibleStart, this.cursor);
        this.cursor++;
      }
    }

    tick() {
      this.refresh();
      if (!this.running) return;
      if (this.context?.createConstantSource) {
        // The audio renderer ends this silent source even when visual frames are paused.
        const pulse = this.context.createConstantSource();
        this.pulse = pulse;
        pulse.offset.value = 0;
        pulse.connect(this.context.destination);
        pulse.onended = () => {
          pulse.disconnect();
          if (this.pulse !== pulse) return;
          this.pulse = null;
          this.tick();
        };
        const time = this.context.currentTime;
        pulse.start(time);
        pulse.stop(time + .26);
      } else {
        this.timer = setTimeout(() => this.tick(), 200);
      }
    }

    stop(completed = false) {
      this.running = false;
      clearTimeout(this.timer);
      if (this.pulse) {
        const pulse = this.pulse;
        this.pulse = null;
        pulse.onended = null;
        try { pulse.stop(); } catch {}
        pulse.disconnect();
      }
      if (!completed) {
        const time = this.clock();
        for (const event of this.events) event.voice?.stop(time, .105);
      }
    }
  }
  window.LumaTransport = { MidiTransport, lowerBound };
})();


