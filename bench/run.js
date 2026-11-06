// Measurements behind the review page. Synthetic DJM-style clock (24 PPQN) with USB jitter.
import { writeFileSync, mkdirSync } from "node:fs";
import { ClockEstimator, NaiveEstimator, BeatAvgEstimator, PPQN } from "../core/estimator.js";
import { SpeedCurve, driftOf, worstErrorWithRephase } from "../core/fxmap.js";
import { trueTicks, observe, beatAt } from "../sim/clock.js";
import { Bridge } from "../core/bridge.js";

const EST = { naive: NaiveEstimator, beatavg: BeatAvgEstimator, bridge: ClockEstimator };
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
const rms = (a) => Math.sqrt(a.reduce((s, x) => s + x * x, 0) / a.length);
const out = {};

// A. jitter sweep at a steady 128 BPM, 5 minutes each
const curve = SpeedCurve.linear(240);
out.jitter = [];
for (const sigma of [0.25, 0.5, 1, 2, 4]) {
  const T = trueTicks(() => 128, 300000), O = observe(T, { jitterMs: sigma, seed: 11 });
  const row = { sigma };
  for (const [name, C] of Object.entries(EST)) {
    const e = new C(); const err = [], ph = []; let lvl = null, changes = 0;
    O.forEach((t, i) => {
      e.tick(t); if (i < 240) return; const s = e.state(t);
      err.push(s.bpm - 128); let d = s.beatF - beatAt(T, t); d -= Math.round(d); ph.push(Math.abs(d) * 60000 / 128);
      const l = curve.levelFor(s.bpm / 4); if (lvl != null && l !== lvl) changes++; lvl = l;
    });
    row[name] = { bpmRms: rms(err), bpmP99: pct(err.map(Math.abs), 0.99), phaseP95Ms: pct(ph, 0.95), faderChangesPerMin: changes / ((O.at(-1) - O[240]) / 60000) };
  }
  out.jitter.push(row);
}

// B. tempo step (re-measure) and pitch ride, 1 ms jitter: time series around the change
out.change = {};
for (const [label, tempo] of [["step", (t) => (t < 60000 ? 124 : 128)], ["ramp", (t) => (t < 60000 ? 124 : Math.min(128, 124 + (4 * (t - 60000)) / (16 * 60000 / 126)))]]) {
  const T = trueTicks(tempo, 80000), O = observe(T, { jitterMs: 1, seed: 5 }); const series = {}; const summ = {};
  for (const [name, C] of Object.entries(EST)) {
    const e = new C(); const pts = []; let settle = null, maxErr = 0;
    O.forEach((t) => { e.tick(t); const s = e.state(t); if (!s) return;
      if (t > 55000 && t < 72000) { pts.push([+(t / 1000).toFixed(3), +s.bpm.toFixed(3)]); }
      if (t > 60000) { const err = Math.abs(s.bpm - tempo(t)); maxErr = Math.max(maxErr, err); }
      if (t > 60000 && tempo(t) === 128) { if (Math.abs(s.bpm - 128) < 0.15) settle ??= t; else settle = null; } });
    // thin the series for the page
    series[name] = pts.filter((_, i) => i % 6 === 0);
    summ[name] = { settleS: settle != null ? +((settle - (label === "step" ? 60000 : 60000 + 16 * 60000 / 126)) / 1000).toFixed(2) : null, maxErrBpm: +maxErr.toFixed(2) };
  }
  out.change[label] = { series, summary: summ, truth: [[55, 124], [60, 124], ...(label === "step" ? [[60, 128]] : [[60 + 16 * 60 / 126, 128]]), [72, 128]] };
}

// C. 0-255 fader quantisation: how far a bar-length FX slides off the beat
out.quant = { rows: [], rephase: [] };
for (const maxCpm of [120, 240, 480]) {
  const c = SpeedCurve.linear(maxCpm);
  for (const bpc of [4, 1]) {
    const tempos = []; for (let b = 118; b <= 132.0001; b += 0.1) tempos.push(+b.toFixed(1));
    const d = tempos.map((b) => driftOf(c, b, bpc));
    const mins = d.map((x) => x.minutesToOneBeat).filter(Number.isFinite);
    out.quant.rows.push({ maxCpm, beatsPerCycle: bpc, stepCpm: maxCpm / 255, medianRelErrPct: +(100 * pct(d.map((x) => Math.abs(x.relErr)), 0.5)).toFixed(3), worstRelErrPct: +(100 * Math.max(...d.map((x) => Math.abs(x.relErr)))).toFixed(3), medianMinutesToOneBeat: +pct(mins, 0.5).toFixed(2), worstMinutesToOneBeat: +Math.min(...mins).toFixed(2), sweep: tempos.map((b, i) => [b, +(100 * d[i].relErr).toFixed(3)]) });
  }
  const worstRel = Math.max(...Array.from({ length: 141 }, (_, i) => Math.abs(driftOf(c, 118 + i * 0.1, 4).relErr)));
  out.quant.rephase.push({ maxCpm, worstRelErrPct: +(100 * worstRel).toFixed(3), ...Object.fromEntries([1, 2, 4, 8, 16].map((n) => [`every${n}`, +worstErrorWithRephase(worstRel, 128, n).toFixed(1)])) });
}

// D. 30-minute DJ set: a bar-length FX on the Onyx side, driven five ways through the real
// Bridge code. The "console" model runs the FX at the speed of the level it was sent, on a
// curve 0.5 % off the calibrated one (calibration is never perfect), and restarts the FX
// when a re-phase lands. Error = FX cycle phase vs the clock's own bar grid.
{
  const prof = (t) => { const m = t / 60000;
    if (m < 6) return 124; if (m < 6.25) return 124 + 2 * (m - 6) / 0.25; if (m < 13) return 126; if (m < 21) return 128;
    if (m < 21.5) return 128 - 3 * (m - 21) / 0.5; return 125; };
  const DUR = 30 * 60000, T = trueTicks(prof, DUR), O = observe(T, { jitterMs: 1, seed: 21 });
  const calCurve = [[0, 0], [255, 240]], realCpm = (l) => (l / 255) * 240 * 1.005, LAT = 30;
  const trueBar = (t) => beatAt(T, t) / 4;
  const strategies = {
    naive_fader: { est: () => new NaiveEstimator(), rephase: 0, steer: false },
    bridge_fader: { est: () => new ClockEstimator(), rephase: 0, steer: false },
    bridge_rephase4: { est: () => new ClockEstimator(), rephase: 4, steer: false },
    bridge_rephase1: { est: () => new ClockEstimator(), rephase: 1, steer: false },
    bridge_steer_rephase16: { est: () => new ClockEstimator(), rephase: 16, steer: true },
    bridge_steer_feedback_rephase32: { est: () => new ClockEstimator(), rephase: 32, steer: true, feedback: true },
  };
  const res = {}; const series = { t: [] };
  for (const [name, S] of Object.entries(strategies)) {
    const est = S.est(); est.start(-1);
    const onyx = { level: 0, phase: 0, pendingRestart: [] }; let sends = 0;
    const cfg = { latencyMs: LAT, fx: [{ name: "bar FX", fader: "/Mx/fader/4203", beatsPerCycle: 4, curve: calCurve, steer: S.steer }],
      rephase: S.rephase ? { everyBars: S.rephase, actions: ["/Mx/playback/page1/3/go"] } : null };
    let restarts = 0;
    const br = new Bridge(cfg, est, (addr, args, info) => { sends++; if (addr.includes("fader")) onyx.level = args[0].value; else { restarts++; onyx.pendingRestart.push(info.t + LAT); } });
    let k = 0, lastT = 0; const errs = [], dmxQ = []; series[name] = [];
    for (let t = 0; t < DUR; t += 2) {
      while (k < O.length && O[k] <= t) est.tick(O[k++]);
      br.update(t);
      onyx.phase += (realCpm(onyx.level) / 60000) * (t - lastT); lastT = t;
      while (onyx.pendingRestart.length && onyx.pendingRestart[0] <= t) { onyx.phase = (t - onyx.pendingRestart.shift()) * realCpm(onyx.level) / 60000; }
      // Art-Net from the console: pan of one fixture in the FX, 40 frames/s, arriving 5 ms later
      if (S.feedback) { if (t % 25 === 0) dmxQ.push([t + 5, Math.round(128 + 100 * Math.sin(2 * Math.PI * onyx.phase + 0.3))]); while (dmxQ.length && dmxQ[0][0] <= t) { const [ta, v] = dmxQ.shift(); br.observe("bar FX", ta, v); } }
      if (t > 10000) { let d = onyx.phase - trueBar(t); d -= Math.round(d); errs.push(Math.abs(d) * 4 * 60000 / prof(t)); }
      if (t % 10000 === 0 && t > 10000) series[name].push(+errs.at(-1).toFixed(1));
    }
    res[name] = { restarts, corrections: br.corrections || 0, inSync40msPct: +(100 * errs.filter((e) => e < 40).length / errs.length).toFixed(1), p95Ms: +pct(errs, 0.95).toFixed(1), maxMs: +errs.reduce((a, b) => Math.max(a, b), 0).toFixed(1), oscMessages: sends };
  }
  for (let t = 20000; t < DUR; t += 10000) series.t.push(+(t / 60000).toFixed(2));
  out.set = { minutes: 30, jitterMs: 1, curveMismatchPct: 0.5, latencyMs: LAT, profile: [[0, 124], [6, 124], [6.25, 126], [13, 126], [13, 128], [21, 128], [21.5, 125], [30, 125]], results: res, series };
}

mkdirSync("results", { recursive: true }); writeFileSync("results/bench.json", JSON.stringify(out));
console.log(JSON.stringify({ jitter: out.jitter.map((r) => [r.sigma, r.naive.bpmRms.toFixed(2), r.beatavg.bpmRms.toFixed(3), r.bridge.bpmRms.toFixed(3), r.naive.faderChangesPerMin.toFixed(0), r.beatavg.faderChangesPerMin.toFixed(1), r.bridge.faderChangesPerMin.toFixed(2)]), change: Object.fromEntries(Object.entries(out.change).map(([k, v]) => [k, v.summary])), quant: out.quant.rows.map((r) => [r.maxCpm, r.beatsPerCycle, r.medianRelErrPct, r.medianMinutesToOneBeat, r.worstMinutesToOneBeat]), rephase: out.quant.rephase, set: out.set.results }, null, 1));
