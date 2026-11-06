// Clock log analysis (shared by the CLI and the browser analyzer)
import { ClockEstimator, NaiveEstimator, BeatAvgEstimator, PPQN } from "./estimator.js";

export function analyzeTicks(rows) {
  const ticks = rows.filter((r) => r.status === 0xf8).map((r) => r.t);
  if (ticks.length < 100) return { ticks: ticks.length, error: "need at least 100 clock ticks" };
  const d = ticks.slice(1).map((t, i) => t - ticks[i]);
  const mean = d.reduce((a, b) => a + b, 0) / d.length;
  // jitter = residual of each tick against a straight line fitted to the 2 beats around it
  const res = [];
  for (let i = 24; i < ticks.length - 24; i++) {
    let sx = 0, sy = 0, sxx = 0, sxy = 0; const n = 49;
    for (let j = -24; j <= 24; j++) { const y = ticks[i + j] - ticks[i]; sx += j; sy += y; sxx += j * j; sxy += j * y; }
    const b = (n * sxy - sx * sy) / (n * sxx - sx * sx), a = (sy - b * sx) / n;
    res.push(-a);   // residual of the centre tick (x = 0, y = 0) against the line
  }
  const sd = Math.sqrt(res.reduce((a, b) => a + b * b, 0) / res.length);
  const sorted = res.map(Math.abs).sort((a, b) => a - b);
  const ests = { naive: new NaiveEstimator(), beatavg: new BeatAvgEstimator(), bridge: new ClockEstimator() }, bpm = {};
  for (const [k, e] of Object.entries(ests)) {
    const v = []; for (const t of ticks) { e.tick(t); const s = e.state(t); if (s && e.ticksSeen > 96) v.push(s.bpm); }
    const m = v.reduce((a, b) => a + b, 0) / v.length; bpm[k] = { mean: m, sd: Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / v.length), min: Math.min(...v), max: Math.max(...v) };
  }
  const starts = rows.filter((r) => r.status === 0xfa).length, stops = rows.filter((r) => r.status === 0xfc).length;
  const other = {}; for (const r of rows) if (r.status < 0xf0) { const k = `${(r.status >> 4).toString(16)}x ch${(r.status & 15) + 1} ${r.d1}`; other[k] = (other[k] || 0) + 1; }
  return { residuals: res, ticks: ticks.length, seconds: (ticks.at(-1) - ticks[0]) / 1000, meanBpm: 60000 / (PPQN * mean), jitterRmsMs: sd, jitterP99Ms: sorted[Math.floor(sorted.length * 0.99)], maxGapMs: Math.max(...d), bpm, starts, stops, otherMessages: other };
}
