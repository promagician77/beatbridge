// BeatBridge runtime: turns the estimator's tempo and bar phase into Onyx OSC messages.
//  - FX-speed override faders: integer 0-255 level from the calibrated speed curve, sent
//    only when the level actually changes (no OSC chatter from clock jitter).
//  - Re-phase: on every Nth downbeat, fire the configured OSC actions (for example release
//    and go on the FX cue) `latencyMs` early, so the restart lands on the "1".
//  - Steer (optional): between re-phases, nudge the fader one step up or down to keep the
//    FX's predicted phase on the bar. A 0-255 fader can't hit most tempos exactly; steering
//    averages two neighbouring steps instead of letting the FX drift.
//  - Feedback (optional): watch one fixture of the FX in Onyx's Art-Net output. Each time
//    its channel crosses mid-range, the bridge learns where the FX really is and corrects
//    its prediction, so steering stays locked even if the speed curve is slightly off.
import { SpeedCurve, wantedCpm } from "./fxmap.js";

export class Bridge {
  constructor(cfg, est, send) {
    this.cfg = { latencyMs: 0, ...cfg }; this.est = est; this.send = send;
    this.fx = (cfg.fx || []).map((f) => ({ beatsPerCycle: 4, mult: 1, steer: false, ...f, curve: Array.isArray(f.curve) ? new SpeedCurve(f.curve) : SpeedCurve.linear(f.curve?.maxCpm || 240), level: null, pending: null, phase: null, lastT: null, lastSend: -1e9 }));
    this.lastRephaseBar = null; this.sent = 0; this.log = [];
  }
  // feed one DMX value of the FX's reference channel (from Art-Net), time-stamped on arrival
  observe(name, t, v) {
    const f = this.fx.find((x) => x.name === name); if (!f) return;
    const fb = (f.fb ||= { hi: v, lo: v, armed: false, lastV: v, lastT: t, phiC: null });
    fb.hi = Math.max(v, fb.hi - 0.002 * (fb.hi - fb.lo)); fb.lo = Math.min(v, fb.lo + 0.002 * (fb.hi - fb.lo));
    const mid = (fb.hi + fb.lo) / 2, hyst = 0.1 * (fb.hi - fb.lo);
    if (f.fbHoldUntil != null && t < f.fbHoldUntil) { fb.armed = false; fb.lastV = v; fb.lastT = t; return; }
    if (v < mid - hyst) fb.armed = true;
    if (fb.armed && fb.lastV < mid && v >= mid && f.phase != null && f.level != null) {
      fb.armed = false;
      const tc = fb.lastT + ((mid - fb.lastV) / (v - fb.lastV || 1)) * (t - fb.lastT), rate = f.curve.cpmAt(f.level) / 60000;
      const pred = f.phase - (f.lastT - tc) * rate;                       // predicted phase at the crossing
      if (fb.phiC == null || f.needOffset) { fb.phiC = pred - Math.floor(pred); f.needOffset = false; }
      else { const truth = Math.round(pred - fb.phiC) + fb.phiC; f.phase += truth - pred; this.corrections = (this.corrections || 0) + 1; }
    }
    fb.lastV = v; fb.lastT = t;
  }
  setMult(name, mult) { for (const f of this.fx) if (!name || f.name === name) f.mult = mult; }
  update(t) {
    const s = this.est.state(t); if (!s) return null;
    for (const f of this.fx) {
      const want = wantedCpm(s.bpm, f.beatsPerCycle, f.mult);
      if (f.phase != null && f.level != null) f.phase += (f.curve.cpmAt(f.level) / 60000) * (t - f.lastT);
      f.lastT = t;
      if (f.steer && f.phase != null && this.est.anchored && s.locked) {
        const target = (s.beatF - this.est.anchorBeat) * f.mult / f.beatsPerCycle; let e = f.phase - target; e -= Math.round(e);
        const lvl = f.curve.levelFor(want * (1 - 2 * e));
        if (lvl !== f.level && t - f.lastSend >= (this.cfg.steerMinMs ?? 250)) { f.level = lvl; f.lastSend = t; this.emit(t, f.fader, [{ type: this.cfg.faderType || "i", value: lvl }], "steer"); }
        continue;
      }
      let lvl = f.curve.levelFor(want);
      // hysteresis: move only if the new level is clearly better (by a tenth of a step)
      if (f.level != null && lvl !== f.level) { const step = Math.abs(f.curve.cpmAt(lvl) - f.curve.cpmAt(f.level)) / Math.abs(lvl - f.level);
        if (Math.abs(want - f.curve.cpmAt(lvl)) > Math.abs(want - f.curve.cpmAt(f.level)) - 0.1 * step) lvl = f.level; }
      if (lvl !== f.level) {
        // require the new level twice in a row (two updates) before sending: no flicker on a boundary
        if (f.pending === lvl) { f.level = lvl; f.pending = null; this.emit(t, f.fader, [{ type: this.cfg.faderType || "i", value: lvl }], "fader"); }
        else f.pending = lvl;
      } else f.pending = null;
    }
    const rp = this.cfg.rephase;
    if (rp && rp.everyBars > 0 && this.est.anchored && s.locked) {
      const beatsPerBar = this.est.o.beatsPerBar, beatMs = 60000 / s.rawBpm;
      const rel = s.beatF - this.est.anchorBeat, nextBar = Math.ceil(rel / beatsPerBar - 1e-9);
      const target = this.lastRephaseBar == null ? nextBar : Math.ceil(nextBar / rp.everyBars) * rp.everyBars;   // first: the next bar; then every Nth
      const tBar = t + (target * beatsPerBar - rel) * beatMs;
      if (tBar - this.cfg.latencyMs <= t && this.lastRephaseBar !== target) {
        this.lastRephaseBar = target;
        for (const a of rp.actions) this.emit(t, a.address || a, a.args || [], "rephase", tBar);
        for (const f of this.fx) { f.phase = (t - tBar) * (f.level != null ? f.curve.cpmAt(f.level) : 0) / 60000; f.needOffset = true; f.fbHoldUntil = tBar + 150; if (f.fb) f.fb.armed = false; } // FX restarts at tBar; ignore the jump
      }
    }
    return s;
  }
  emit(t, address, args, kind, due) { this.sent++; this.send(address, args, { t, kind, due }); }
}
