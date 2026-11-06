// Tempo and phase from a MIDI timing clock (24 ticks per quarter note), as sent by the
// Pioneer DJM-A9 over USB. The clock carries tempo only: no bar position. A downbeat
// anchor (tap, pad, or MIDI START pressed on the "1") supplies the bar.
//
// ClockEstimator: least-squares fit of tick time vs tick index over an adaptive window.
// Jitter averages out over the window; a residual monitor shrinks the window when the
// tempo really changes (DJ re-measure, pitch ride), so it settles fast without chatter.

export const PPQN = 24;
const frac = (x) => x - Math.floor(x);

export function foldBpm(bpm, lo, hi) {
  if (!lo || !hi || !(bpm > 0)) return bpm;
  let b = bpm; let n = 0;
  while (b < lo && n++ < 4) b *= 2;
  while (b > hi && n++ < 8) b /= 2;
  return b;
}

class Base {
  constructor(o = {}) { this.o = { fold: null, beatsPerBar: 4, holdBeats: 16, ...o }; this.reset(); }
  reset() { this.k = -1; this.lastT = null; this.anchorBeat = 0; this.anchored = false; this.running = true; this.ticksSeen = 0; }
  start(t) { this.reset(); this.startT = t; this.anchorOnNextTick = true; }   // MIDI START: next tick is beat 0
  stop() { this.running = false; }
  // downbeat: snap the tap to the nearest predicted beat and call it beat 1 of a bar
  tapDownbeat(t) { const s = this.state(t); if (!s) return; this.anchorBeat = Math.round(s.beatF); this.anchored = true; }
  out(bpm) { return this.o.fold ? foldBpm(bpm, this.o.fold[0], this.o.fold[1]) : bpm; }
  barInfo(beatF) {
    const rel = beatF - this.anchorBeat, bpb = this.o.beatsPerBar;
    return { beatF, beatPhase: frac(beatF), barBeat: ((Math.floor(rel) % bpb) + bpb) % bpb, barPhase: frac(rel / bpb), bar: Math.floor(rel / bpb) };
  }
}

/* naive: tempo from the last tick interval (what a quick script or many converters do) */
export class NaiveEstimator extends Base {
  tick(t) {
    this.k++; this.ticksSeen++;
    if (this.anchorOnNextTick) { this.anchorOnNextTick = false; this.anchorBeat = 0; this.anchored = true; this.k = 0; }
    if (this.lastT != null) this.per = t - this.lastT;
    this.lastT = t; this.lastK = this.k;
  }
  state(t) {
    if (this.per == null) return null;
    const beatF = (this.lastK + (t - this.lastT) / this.per) / PPQN;
    return { bpm: this.out(60000 / (PPQN * this.per)), rawBpm: 60000 / (PPQN * this.per), ...this.barInfo(beatF), locked: true };
  }
}

/* one-beat average: tempo from the last 24 tick intervals */
export class BeatAvgEstimator extends Base {
  reset() { super.reset(); this.hist = []; }
  tick(t) {
    this.k++; this.ticksSeen++;
    if (this.anchorOnNextTick) { this.anchorOnNextTick = false; this.anchorBeat = 0; this.anchored = true; this.k = 0; this.hist = []; }
    this.hist.push(t); if (this.hist.length > PPQN + 1) this.hist.shift();
    this.lastT = t; this.lastK = this.k;
  }
  get per() { const h = this.hist; return h.length > 1 ? (h.at(-1) - h[0]) / (h.length - 1) : null; }
  state(t) {
    const per = this.per; if (per == null) return null;
    const beatF = (this.lastK + (t - this.lastT) / per) / PPQN;
    return { bpm: this.out(60000 / (PPQN * per)), rawBpm: 60000 / (PPQN * per), ...this.barInfo(beatF), locked: this.hist.length > PPQN };
  }
}

/* BeatBridge estimator */
export class ClockEstimator extends Base {
  constructor(o = {}) {
    super({ windowBeats: 4, minTicks: 8, changeMs: 0.9, outlierMs: 5, ewma: 0.15, ...o });
  }
  reset() { super.reset(); this.buf = []; this.fit = null; this.ew = 0; this.sig2 = 1; this.outliers = 0; this.changes = 0; this.pend = 0; }
  refit() {
    const B = this.buf, n = B.length; if (n < 2) return;
    const k0 = B[0][0], t0 = B[0][1]; let sk = 0, st = 0, skk = 0, skt = 0;
    for (const [k, t] of B) { const x = k - k0, y = t - t0; sk += x; st += y; skk += x * x; skt += x * y; }
    const den = n * skk - sk * sk; if (den <= 0) return;
    const b = (n * skt - sk * st) / den, a = (st - b * sk) / n;
    this.fit = { k0, t0, a, b, n };
  }
  pred(k) { const f = this.fit; return f.t0 + f.a + f.b * (k - f.k0); }
  tick(t) {
    this.k++; this.ticksSeen++; this.lastT = t;
    if (this.anchorOnNextTick) { this.anchorOnNextTick = false; this.anchorBeat = 0; this.anchored = true; this.k = 0; this.buf = []; this.fit = null; }
    const k = this.k;
    if (this.fit && this.buf.length >= this.o.minTicks) {
      const r = t - this.pred(k), sig = Math.sqrt(this.sig2);
      // single isolated late/early tick (USB burst): don't let it bend the fit
      if (Math.abs(r) > Math.max(this.o.outlierMs, 6 * sig) && this.pend === 0) { this.pend = 1; this.held = [k, t]; this.outliers++; return; }
      if (this.pend) { // two in a row on the same side: a real change, keep both
        this.pend = 0; const [hk, ht] = this.held, rh = ht - this.pred(hk);
        if (Math.sign(rh) === Math.sign(r) && Math.abs(r) > Math.max(this.o.outlierMs, 6 * sig) * 0.5) { this.outliers--; this.buf = this.buf.slice(-2); this.buf.push([hk, ht]); this.changes++; this.ew = 0; }
      }
      this.ew = (1 - this.o.ewma) * this.ew + this.o.ewma * r;
      const thr = Math.max(this.o.changeMs, 4.5 * sig * Math.sqrt(this.o.ewma / (2 - this.o.ewma)));
      this.over = Math.abs(this.ew) > thr ? (this.over || 0) + 1 : 0;
      if (this.over >= 3) { // tempo really moved (3 ticks in a row past the limit): keep only recent ticks
        this.buf = this.buf.slice(-12); this.ew = 0; this.over = 0; this.changes++;
      } else this.sig2 = 0.995 * this.sig2 + 0.005 * Math.min(r * r, 25);
    }
    this.buf.push([k, t]);
    const max = this.o.windowBeats * PPQN; if (this.buf.length > max) this.buf.shift();
    this.refit();
  }
  state(t) {
    if (!this.fit || this.buf.length < 3) return null;
    const per = this.fit.b, kf = this.fit.k0 + ((t - this.fit.t0) - this.fit.a) / per;
    const holding = this.lastT != null && t - this.lastT > 3 * per;
    if (holding && (t - this.lastT) > this.o.holdBeats * PPQN * per) return null;
    return { bpm: this.out(60000 / (PPQN * per)), rawBpm: 60000 / (PPQN * per), ...this.barInfo(kf / PPQN), locked: this.buf.length >= this.o.minTicks && !holding,
      holding, jitterMs: Math.sqrt(this.sig2), window: this.buf.length };
  }
}

export const ESTIMATORS = { naive: NaiveEstimator, beatavg: BeatAvgEstimator, bridge: ClockEstimator };
