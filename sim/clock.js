// Synthetic DJM-style MIDI clock: ticks at 24 per beat following a tempo profile, plus USB
// delivery jitter (Gaussian) and occasional late bursts. Deterministic for a given seed.
export function rng(seed = 1) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
export function gauss(r) { let u = 0, v = 0; while (u === 0) u = r(); v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }

// tempo(tMs) -> bpm. Returns true tick times (ms) up to durMs, by integrating beat position.
export function trueTicks(tempo, durMs, stepMs = 0.25) {
  const out = []; let pos = 0, t = 0, next = 1 / 24;
  out.push(0);
  while (t < durMs) {
    const inc = (tempo(t) / 60000) * stepMs;
    if (pos + inc >= next) { const f = (next - pos) / inc; out.push(t + f * stepMs); next += 1 / 24; }
    pos += inc; t += stepMs;
  }
  return out;
}
// observed (received) times: true + jitter; keep order
export function observe(ticks, { jitterMs = 1, burstP = 0.005, burstMs = [3, 8], seed = 7 } = {}) {
  const r = rng(seed); const out = new Array(ticks.length); let prev = -Infinity;
  for (let i = 0; i < ticks.length; i++) {
    let t = ticks[i] + jitterMs * gauss(r);
    if (r() < burstP) t += burstMs[0] + (burstMs[1] - burstMs[0]) * r();
    if (t <= prev) t = prev + 0.01; out[i] = prev = t;
  }
  return out;
}
// true beat position (beats) at time t for the same tempo profile: from the true ticks
export function beatAt(trueT, t) {
  let lo = 0, hi = trueT.length - 1; if (t <= trueT[0]) return (t - trueT[0]) / (trueT[1] - trueT[0]) / 24;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (trueT[m] <= t) lo = m; else hi = m; }
  return (lo + (t - trueT[lo]) / (trueT[hi] - trueT[lo])) / 24;
}
