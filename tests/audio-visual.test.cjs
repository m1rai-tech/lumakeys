const assert = require("node:assert/strict");
const test = require("node:test");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

function load(context, names) {
  for (const name of names) {
    const source = fs.readFileSync(path.join(__dirname, "..", name), "utf8");
    vm.runInContext(source, context, { filename: name });
  }
}

function parameter() {
  return { value: 1, setTargetAtTime() {}, setValueAtTime() {}, linearRampToValueAtTime() {},
    cancelScheduledValues() {}, exponentialRampToValueAtTime() {} };
}
function audioNode() {
  return { gain: parameter(), frequency: parameter(), Q: parameter(), threshold: parameter(),
    ratio: parameter(), knee: parameter(), attack: parameter(), release: parameter(),
    playbackRate: parameter(), connect(node) { return node; }, disconnect() {} };
}

test("same-key repeats overlap briefly, with headroom and independent chord voices", async () => {
  const played = [];
  class Context {
    constructor() {
      this.currentTime = 1;
      this.sampleRate = 44100;
      this.state = "running";
      this.destination = audioNode();
      this.gains = [];
    }
    createGain() { const node = audioNode(); this.gains.push(node); return node; }
    createBiquadFilter() { return audioNode(); }
    createStereoPanner() { return { ...audioNode(), pan: parameter() }; }
    createDynamicsCompressor() { return audioNode(); }
    createConvolver() { return audioNode(); }
    createBuffer(_, size) { return { getChannelData: () => new Float32Array(size) }; }
    createBufferSource() {
      const strikes = played;
      return { ...audioNode(), stops: [],
        start(time) { this.startTime = time; strikes.push(this); },
        stop(time) { this.stops.push(time); }
      };
    }
    async decodeAudioData(bytes) {
      assert.ok(bytes.byteLength > 7000);
      return { numberOfChannels: 1, duration: 10, size: bytes.byteLength };
    }
  }
  const sandbox = vm.createContext({ atob, window: { AudioContext: Context, OfflineAudioContext: Context } });
  load(sandbox, ["assets/piano/yamaha-c5.js", "assets/piano/steinway-b.js", "src/audio.js"]);
  const player = new sandbox.window.LumaAudio();
  assert.equal(await player.loadGrand(), 31);
  player.wake();
  assert.equal(player.context.gains[3].gain.value, .46);
  const first = player.note(60, .71);
  first.stop();
  const initialTail = played[0].stops.at(-1);
  player.context.currentTime = 1.05;
  player.note(67, .71);
  assert.equal(played[0].stops.at(-1), initialTail, "A different chord note leaves C's release intact.");
  player.context.currentTime = 1.08;
  player.note(60, .71);
  assert.ok(played[0].stops.at(-1) - 1.08 < .16);
  assert.equal(played[1].stops.length, 0);
  assert.notEqual(played[2], played[0]);
  const future = player.note(72, .71, 8, .5);
  assert.equal(future.start, 8);
  player.note(72, .71, 1.1);
  assert.ok(future.tailEnd > 8.5, "A queued future hit is not an active voice.");
});

test("canvas base stays black and note bodies stay attached until release", () => {
  const rectangles = [], paths = [];
  const gradient = { addColorStop() {} };
  const canvasContext = new Proxy({}, {
    get(object, key) {
      if (key === "createLinearGradient" || key === "createRadialGradient") return () => gradient;
      if (key === "fillRect") return (...rect) => rectangles.push({ rect, fill: object.fillStyle });
      if (key === "moveTo") return (x, y) => paths.push({ x, y });
      if (key === "fillText") return () => assert.fail("There should be no text on the canvas.");
      return object[key] ?? (() => {});
    }
  });
  const canvas = { getContext: () => canvasContext, getBoundingClientRect: () => ({ width: 1000, height: 500 }) };
  const sandbox = vm.createContext({ window: { devicePixelRatio: 1 }, performance: { now: () => 0 },
    matchMedia: () => ({ matches: false }), ResizeObserver: class { observe() {} } });
  load(sandbox, ["src/visual.js"]);
  const visual = new sandbox.window.LumaVisual(canvas, { palette: "neon", glow: 88, bloom: 65, density: 50,
    trail: 68, particles: false, waves: false, atmosphere: false });
  assert.equal(rectangles[0].fill, "#000000");
  assert.equal(paths.length, 0);
  visual.strike("k", .5, .8, 1);
  visual.draw(1.08);
  const start = paths.at(-1).y;
  visual.draw(1.21);
  assert.ok(paths.at(-1).y < start - 30);
  visual.release("k", 1.24);
  const lifted = visual.notes[0];
  assert.equal(lifted.off, 1.24);
  assert.equal(visual.active.size, 0);
  visual.draw(3);
  assert.equal(visual.notes.length, 0);
  assert.equal(rectangles.at(-1).fill, "#000000");
});

