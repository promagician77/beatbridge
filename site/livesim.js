// Real-time rig: a DJM-style clock (true tempo + USB delivery jitter) feeding four bridges side
// by side, each driving a model of the Onyx FX engine (fader speed, restarts, Art-Net out).
import { ClockEstimator, NaiveEstimator } from "./lib/estimator.js";
import { Bridge } from "./lib/bridge.js";

function rng(seed = 3) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
const R = rng(9), gauss = () => { let u = 0; while (u === 0) u = R(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * R()); };

export const MODES = {
  naive: { label: "Tick-by-tick BPM → fader", est: () => new NaiveEstimator(), rephase: 0, steer: false, feedback: false },
  fader: { label: "Filtered BPM → fader, no re-phase", est: () => new ClockEstimator(), rephase: 0, steer: false, feedback: false },
  rephase: { label: "BeatBridge: re-phase every bar", est: () => new ClockEstimator(), rephase: 1, steer: false, feedback: false },
  steer: { label: "BeatBridge: steer + Art-Net feedback", est: () => new ClockEstimator(), rephase: 32, steer: true, feedback: true },
};
const CAL = [[0, 0], [255, 240]], REAL = (l) => (l / 255) * 240 * 1.005, LAT = 30;

class Lane {
  constructor(key) {
    const m = MODES[key]; this.key = key; this.m = m; this.est = m.est(); this.sent = 0; this.inSync = 0; this.samples = 0; this.err = 0; this.hist = [];
    this.onyx = { MH: { level: 0, phase: 0 }, VPL: { level: 0, phase: 0 }, restarts: [] }; this.dmxQ = [];
    const fx = [{ name: "MH", fader: "/Mx/fader/4203", beatsPerCycle: 4, curve: CAL, steer: m.steer }, { name: "VPL", fader: "/Mx/fader/4213", beatsPerCycle: 1, curve: CAL, steer: m.steer }];
    this.br = new Bridge({ latencyMs: LAT, fx, rephase: m.rephase ? { everyBars: m.rephase, actions: ["/Mx/playback/page1/3/go"] } : null }, this.est, (addr, args, info) => {
      this.sent++; if (addr.endsWith("4203")) this.onyx.MH.level = args[0].value; else if (addr.endsWith("4213")) this.onyx.VPL.level = args[0].value; else this.onyx.restarts.push(info.t + LAT);
    });
  }
  step(t, dt) {
    this.br.update(t);
    for (const k of ["MH", "VPL"]) this.onyx[k].phase += (REAL(this.onyx[k].level) / 60000) * dt;
    while (this.onyx.restarts.length && this.onyx.restarts[0] <= t) { const tr = this.onyx.restarts.shift(); for (const k of ["MH", "VPL"]) this.onyx[k].phase = ((t - tr) * REAL(this.onyx[k].level)) / 60000; }
    if (this.m.feedback) {
      if (Math.floor(t / 25) !== Math.floor((t - dt) / 25)) for (const k of ["MH", "VPL"]) this.dmxQ.push([t + 5, k, Math.round(128 + 100 * Math.sin(2 * Math.PI * this.onyx[k].phase + 0.3))]);
      while (this.dmxQ.length && this.dmxQ[0][0] <= t) { const [ta, k, v] = this.dmxQ.shift(); this.br.observe(k, ta, v); }
    }
  }
}

export class LiveRig {
  constructor() { this.reset(); }
  reset(bpm = 126, jitter = 1) {
    this.bpm = bpm; this.target = bpm; this.rampPerMs = 0; this.jitter = jitter; this.t = null; this.pos = 0; this.nextTick = 0; this.queue = []; this.anchorPos = 0;
    this.lanes = Object.fromEntries(Object.keys(MODES).map((k) => [k, new Lane(k)])); this.started = false; this.external = false;
  }
  setTempo(bpm, rampBeats = 0) { this.target = bpm; this.rampPerMs = rampBeats ? Math.abs(bpm - this.bpm) / (rampBeats * 60000 / this.bpm) : Infinity; }
  tapDownbeat(t, humanErrMs = 0) {
    const tt = t + humanErrMs; for (const l of Object.values(this.lanes)) l.est.tapDownbeat(tt);
    this.anchorPos = Math.round(this.pos);   // the musician's "1" is the nearest true beat
  }
  // external clock (Web MIDI): ticks come from the real mixer, no truth to score against
  useExternal() { this.reset(this.bpm, this.jitter); this.external = true; this.started = true; }
  extTick(t) { this.queue.push({ t, k: -1 }); }
  extStart(t) { for (const l of Object.values(this.lanes)) l.est.start(t); }
  extStop() { for (const l of Object.values(this.lanes)) l.est.stop(); }
  // advance true clock to time t (ms), delivering jittered ticks; run lanes in 2 ms steps
  advance(t) {
    if (this.t == null) { this.t = t; return; }
    if (this.external) {
      if (t - this.t > 250) this.t = t - 250;
      this.queue.sort((a, b) => a.t - b.t);
      while (this.t < t) { const t1 = Math.min(t, this.t + 2);
        while (this.queue.length && this.queue[0].t <= t1) { const q = this.queue.shift(); for (const l of Object.values(this.lanes)) l.est.tick(q.t); }
        for (const l of Object.values(this.lanes)) l.step(t1, t1 - this.t); this.t = t1; }
      return;
    }
    if (t - this.t > 250) this.t = t - 250;                       // tab was hidden: don't replay minutes
    while (this.t < t) {
      const dt = Math.min(2, t - this.t), t1 = this.t + dt;
      if (this.bpm !== this.target) { const d = this.target - this.bpm, s = Math.min(Math.abs(d), this.rampPerMs * dt); this.bpm += Math.sign(d) * s; }
      const inc = (this.bpm / 60000) * dt;
      while (this.pos + inc >= this.nextTick / 24) {
        const tt = this.t + ((this.nextTick / 24 - this.pos) / inc) * dt;
        let d = 2 + this.jitter * gauss(); if (R() < 0.005) d += 3 + 5 * R(); d = Math.max(0.2, d);
        this.queue.push({ t: tt + d, k: this.nextTick }); this.nextTick++;
      }
      this.pos += inc; this.t = t1;
      this.queue.sort((a, b) => a.t - b.t);
      while (this.queue.length && this.queue[0].t <= t1) {
        const q = this.queue.shift();
        if (!this.started && q.k === 0) { for (const l of Object.values(this.lanes)) l.est.start(q.t - 0.01); this.anchorPos = 0; this.started = true; }
        for (const l of Object.values(this.lanes)) l.est.tick(q.t);
      }
      for (const l of Object.values(this.lanes)) l.step(t1, dt);
    }
    // score: MH bar FX phase vs the true bar (anchor = the "1" the DJ marked)
    const trueBar = (this.pos - this.anchorPos) / 4, beatMs = 60000 / this.bpm;
    for (const l of Object.values(this.lanes)) {
      let e = l.onyx.MH.phase - trueBar; e -= Math.round(e); l.err = e * 4 * beatMs;
      if (this.pos > 8) { l.samples++; if (Math.abs(l.err) < 40) l.inSync++; }
      l.hist.push(l.err); if (l.hist.length > 900) l.hist.shift();
    }
  }
  truth() { const rel = this.pos - this.anchorPos; return { bpm: this.bpm, beatF: rel, barBeat: ((Math.floor(rel) % 4) + 4) % 4, barPhase: (((rel / 4) % 1) + 1) % 1 }; }
}
