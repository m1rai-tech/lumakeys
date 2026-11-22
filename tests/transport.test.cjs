const assert = require("node:assert/strict");
const test = require("node:test");
global.window = {};
require("../src/transport.js");
const { MidiTransport } = window.LumaTransport;
delete global.window;

function audioRig() {
  const ticks = new Set();
  const strikes = [];
  const context = {
    currentTime: 0, destination: {},
    createConstantSource() {
      const pulse = {
        offset: { value: -1 }, connect() {}, disconnect() { ticks.delete(pulse); },
        start() {}, stop(time) { pulse.end = time; ticks.add(pulse); }
      };
      return pulse;
    }
  };
  function advance(to) {
    let pulse;
    while ((pulse = [...ticks].filter((item) => item.onended && item.end <= to).sort((a, b) => a.end - b.end)[0])) {
      context.currentTime = pulse.end;
      pulse.onended();
    }
    context.currentTime = to;
  }
  const sound = {
    context,
    note(note, velocity, start, duration) {
      const voice = { stops: [], stop(...args) { voice.stops.push(args); } };
      strikes.push({ note, velocity, start, duration, voice });
      return voice;
    }
  };
  return { sound, strikes, ticks, advance };
}

test("native audio clock schedules a hidden song through a long rest without animation frames", () => {
  const rig = audioRig();
  const notes = [0, .5, 1.4, 5, 41, 42, 65].map((time, index) => ({ time, note: 61 + index, duration: .4, velocity: .8 }));
  let hidden = false;
  let completed = false;
  const player = new MidiTransport({ track: { notes, duration: 65.4, longestNote: .4 },
    sound: rig.sound, from: 0, rate: 1, hidden: () => hidden,
    onFinish: () => { completed = true; } });
  player.start();
  rig.advance(.6);
  hidden = true;
  player.refresh();
  rig.advance(66);
  assert.deepEqual(rig.strikes.map((item) => item.note), notes.map((note) => note.note));
  assert.ok(rig.strikes.every((item, index) => Math.abs(item.start - notes[index].time - .10) < 1e-9));
  assert.ok(rig.strikes.every((item) => !item.voice.stops.length), "Finishing naturally keeps the final piano tail.");
  assert.equal(player.position, 65.4);
  assert.equal(completed, true);
  assert.equal(rig.ticks.size, 0);
});

test("seek restores held notes at the new speed, and pause cancels already queued voices", () => {
  const rig = audioRig();
  const notes = [{ time: 1, note: 60, duration: 5, velocity: .7 }, { time: 5, note: 72, duration: 1, velocity: .9 }];
  const player = new MidiTransport({ track: { notes, duration: 6, longestNote: 5 }, sound: rig.sound,
    from: 4.5, rate: 2, hidden: () => true,
    onFinish: () => assert.fail("A paused track must not finish.") });
  player.start();
  assert.equal(rig.strikes.length, 2);
  assert.ok(Math.abs(rig.strikes[0].duration - .75) < 1e-8);
  assert.ok(Math.abs(rig.strikes[1].start - .35) < 1e-8);
  rig.advance(.19);
  player.stop();
  assert.ok(rig.strikes.every((item) => item.voice.stops.length === 1));
  assert.equal(rig.ticks.size, 0);
  rig.advance(5);
  assert.equal(rig.strikes.length, 2);
});

