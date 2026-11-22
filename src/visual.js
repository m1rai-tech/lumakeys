(() => {
  "use strict";
  const palettes = {
    neon: ["#a85dff", "#b86bff", "#ca71fe", "#df73fe", "#ef72ef", "#f66dd6", "#fa67ba"],
    lime: ["#5cea3d", "#65ef40", "#71f34c", "#7bf757", "#8df861", "#a4f65a", "#b7fa68"],
    aurora: ["#39efb5", "#40ebda", "#4fdbff", "#65aaff", "#917aff", "#b873ff", "#ed75f2"],
    ember: ["#ffd77d", "#ffb75e", "#ff9250", "#ff704a", "#f55366", "#eb6f91", "#ffc484"],
    ice: ["#b5ffff", "#74f9fb", "#55e1ff", "#5cb6ff", "#6484fe", "#827eff", "#a6ddff"]
  };
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const rgbCache = new Map();
  function rgba(hex, opacity) {
    if (!rgbCache.has(hex)) {
      const value = Number.parseInt(hex.slice(1), 16);
      if (rgbCache.size > 64) rgbCache.clear();
      rgbCache.set(hex, [value >> 16, value >> 8 & 255, value & 255].join(","));
    }
    return "rgba(" + rgbCache.get(hex) + "," + clamp(opacity, 0, 1) + ")";
  }
  function roundedRect(c, x, y, width, height, radius) {
    const round = Math.min(radius, width / 2, height / 2);
    c.beginPath();
    c.moveTo(x + round, y);
    c.arcTo(x + width, y, x + width, y + height, round);
    c.arcTo(x + width, y + height, x, y + height, round);
    c.arcTo(x, y + height, x, y, round);
    c.arcTo(x, y, x + width, y, round);
    c.closePath();
  }

  class PianoLight {
    constructor(canvas, settings) {
      this.canvas = canvas;
      this.ctx = canvas.getContext("2d", { alpha: false });
      this.settings = settings;
      this.active = new Map();
      this.notes = [];
      this.sparks = [];
      this.impact = [];
      this.reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
      new ResizeObserver(() => this.resize()).observe(canvas);
      this.resize();
    }

    resize() {
      const rect = this.canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      this.width = rect.width;
      this.height = rect.height;
      const pixels = Math.min(window.devicePixelRatio || 1, 1.75);
      this.canvas.width = Math.round(this.width * pixels);
      this.canvas.height = Math.round(this.height * pixels);
      this.ctx.setTransform(this.canvas.width / this.width, 0, 0, this.canvas.height / this.height, 0, 0);
      this.blank = false;
      this.draw(performance.now() / 1000);
    }

    color(x) {
      if (this.settings.palette === "custom") return this.settings.customColor;
      return (palettes[this.settings.palette] || palettes.neon)[clamp(Math.floor(x * 7), 0, 6)];
    }

    strike(id, x, velocity, time) {
      const color = this.color(x);
      this.active.set(id, { x, velocity, time, color, off: null });
      this.impact.push({ x, velocity, time, color });
      if (this.settings.particles) {
        const count = Math.round(this.settings.density * (this.reduced ? .1 : .42) * (.32 + velocity * .74));
        for (let i = 0; i < count; i++) {
          const random = Math.random();
          const angle = Math.random() * Math.PI;
          const speed = 30 + random * random * 290;
          this.sparks.push({ x, time, color, dx: Math.cos(angle) * speed, dy: 38 + Math.sin(angle) * speed,
            life: .27 + random * 1.12, size: .6 + Math.random() ** 2 * 2.7 });
        }
      }
      if (this.sparks.length > 760) this.sparks.splice(0, this.sparks.length - 760);
      if (this.impact.length > 100) this.impact.shift();
      return color;
    }

    release(id, time) {
      const note = this.active.get(id);
      if (!note) return;
      note.off = time;
      this.notes.push(note);
      this.active.delete(id);
      if (this.notes.length > 140) this.notes.shift();
    }

    glow(x, y, w, h, color, strength) {
      if (strength < .005 || w < 1 || h < 1) return;
      const c = this.ctx;
      c.save();
      c.translate(x, y);
      c.scale(w, h);
      const soft = c.createRadialGradient(0, 0, 0, 0, 0, 1);
      soft.addColorStop(0, rgba(color, strength));
      soft.addColorStop(.33, rgba(color, strength * .52));
      soft.addColorStop(.69, rgba(color, strength * .13));
      soft.addColorStop(1, rgba(color, 0));
      c.fillStyle = soft;
      c.fillRect(-1, -1, 2, 2);
      c.restore();
    }

    jelly(note, time, speed, strength, bloom) {
      const c = this.ctx, rail = this.height - 1, x = note.x * this.width;
      const age = Math.max(0, time - note.time);
      const head = rail - 8 - age * speed;
      const bottom = rail - (note.off === null ? 0 : Math.max(0, time - note.off) * speed);
      const top = Math.max(-16, head), length = bottom - top;
      if (length < 1 || bottom < 0) return;
      const fade = clamp(bottom / (this.height * .14) + .06, .06, 1);
      const alpha = (.7 + note.velocity * .3) * fade;
      const width = clamp(this.width / 79, 9, 28);
      const left = x - width / 2;
      if (this.settings.atmosphere) {
        const spread = width * (1.8 + bloom * 2.5);
        const sections = Math.min(5, Math.max(1, Math.ceil(length / 125)));
        for (let i = 0; i < sections; i++) {
          this.glow(x, top + length * (i + .5) / sections, spread,
            Math.max(16, length / sections * .86 + 18), note.color, alpha * strength * (.13 + bloom * .17));
        }
      }
      const fill = c.createLinearGradient(left, 0, left + width, 0);
      fill.addColorStop(0, rgba(note.color, alpha * .65));
      fill.addColorStop(.28, rgba(note.color, alpha * .90));
      fill.addColorStop(.52, rgba("#fff8ff", alpha * .72));
      fill.addColorStop(.78, rgba(note.color, alpha * .91));
      fill.addColorStop(1, rgba(note.color, alpha * .65));
      roundedRect(c, left, top, width, length, 4.4);
      c.fillStyle = fill;
      c.fill();
      c.strokeStyle = rgba("#fff8ff", alpha * .65);
      c.lineWidth = .85;
      c.stroke();
    }

    draw(time) {
      const w = this.width, h = this.height, c = this.ctx;
      if (!w || !h) return;
      const speed = h * (this.reduced ? .37 : .73) * (1.2 - this.settings.trail * .0045);
      this.notes = this.notes.filter((note) => (time - note.off) * speed < h + 6);
      this.impact = this.impact.filter((hit) => time - hit.time < .62);
      this.sparks = this.sparks.filter((spark) => time - spark.time < spark.life);
      const idle = !this.notes.length && !this.active.size && !this.impact.length && !this.sparks.length;
      if (idle && this.blank) return;
      c.fillStyle = "#000000";
      c.fillRect(0, 0, w, h);
      this.blank = idle;
      if (idle) return;
      const strength = this.settings.glow / 100, bloom = (this.settings.bloom ?? 65) / 100;
      const rail = h - 1;
      c.globalCompositeOperation = "screen";
      for (const note of this.notes) this.jelly(note, time, speed, strength, bloom);
      for (const note of this.active.values()) {
        this.jelly(note, time, speed, strength, bloom);
        this.glow(note.x * w, rail, 40 + bloom * 38, 18 + bloom * 12, note.color, .56 * strength);
      }
      for (const hit of this.impact) {
        const elapsed = Math.max(0, time - hit.time);
        const flash = (1 - elapsed / .62) ** 2.2 * strength;
        const x = hit.x * w;
        this.glow(x, rail, (45 + bloom * 52) * (.6 + hit.velocity * .5), 30 + bloom * 28, hit.color, flash * .86);
        this.glow(x, rail - 2, 17, 11, "#fff9ff", flash * (.55 + hit.velocity * .30));
        if (this.settings.waves && !this.reduced) {
          const radius = 9 + elapsed * 124;
          c.beginPath();
          c.ellipse(x, rail, radius, radius * .18, 0, Math.PI, Math.PI * 2);
          c.strokeStyle = rgba(hit.color, flash * .61);
          c.lineWidth = .75;
          c.stroke();
        }
      }
      if (this.settings.particles) for (const spark of this.sparks) {
        const age = Math.max(0, time - spark.time);
        const fade = (1 - age / spark.life) ** 1.36;
        const x = spark.x * w + spark.dx * age * (1 - age * .18);
        const y = rail - 3 - spark.dy * age + 70 * age ** 2;
        if (y > rail || y < 0) continue;
        if (spark.size > 1.75) this.glow(x, y, spark.size * 4, spark.size * 4, spark.color, fade * strength * .73);
        c.fillStyle = rgba(spark.size > 1.75 ? "#fffaff" : spark.color, fade * .9);
        c.beginPath();
        c.arc(x, y, spark.size * .69, 0, 2 * Math.PI);
        c.fill();
      }
      c.globalCompositeOperation = "source-over";
    }
  }
  window.LumaVisual = PianoLight;
})();

