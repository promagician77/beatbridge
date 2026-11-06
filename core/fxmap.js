// Onyx FX-speed override fader: OSC level 0-255 -> FX speed (cycles per minute).
// The real curve is measured on the console (calibrate). This maps a wanted tempo to the
// nearest fader step and reports the error that step leaves.

export class SpeedCurve {
  // points: [[faderLevel 0-255, cyclesPerMinute], ...], monotone increasing
  constructor(points) {
    this.p = [...points].sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < this.p.length; i++) if (this.p[i][1] < this.p[i - 1][1]) throw new Error("speed curve must increase with fader level");
  }
  static linear(maxCpm) { return new SpeedCurve([[0, 0], [255, maxCpm]]); }
  cpmAt(level) {
    const p = this.p; if (level <= p[0][0]) return p[0][1]; if (level >= p.at(-1)[0]) return p.at(-1)[1];
    let i = 1; while (p[i][0] < level) i++;
    const [x0, y0] = p[i - 1], [x1, y1] = p[i]; return y0 + ((y1 - y0) * (level - x0)) / (x1 - x0);
  }
  // best integer level for a wanted speed
  levelFor(cpm) {
    let lo = 0, hi = 255;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (this.cpmAt(m) < cpm) lo = m; else hi = m; }
    return Math.abs(this.cpmAt(lo) - cpm) <= Math.abs(this.cpmAt(hi) - cpm) ? lo : hi;
  }
  // step size around a speed: how coarse the fader is where you're using it
  stepAt(cpm) { const l = Math.min(254, this.levelFor(cpm)); return this.cpmAt(l + 1) - this.cpmAt(l); }
}

// For an FX that should complete one cycle every `beatsPerCycle` beats at `bpm` x `mult`
export function wantedCpm(bpm, beatsPerCycle = 4, mult = 1) { return (bpm * mult) / beatsPerCycle; }

// How fast a quantised FX speed slides off the beat: ms of drift per minute, and the
// time until it is one full beat out (if never re-phased).
export function driftOf(curve, bpm, beatsPerCycle = 4, mult = 1) {
  const want = wantedCpm(bpm, beatsPerCycle, mult), level = curve.levelFor(want), got = curve.cpmAt(level);
  const relErr = (got - want) / want;                         // fraction of speed
  const beatMs = 60000 / bpm;
  return { want, level, got, relErr, driftMsPerMin: Math.abs(relErr) * 60000, minutesToOneBeat: relErr === 0 ? Infinity : beatMs / (Math.abs(relErr) * 60000) };
}

// Worst phase error (ms) if the FX is restarted on the downbeat every `everyBars` bars
export function worstErrorWithRephase(relErr, bpm, everyBars, beatsPerBar = 4) {
  const beatMs = 60000 / bpm; if (!everyBars) return Infinity;
  return Math.abs(relErr) * everyBars * beatsPerBar * beatMs;
}
