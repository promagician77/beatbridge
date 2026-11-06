import { test } from "node:test";
import assert from "node:assert/strict";
import { ClockEstimator, NaiveEstimator, foldBpm, PPQN } from "../core/estimator.js";
import { SpeedCurve, driftOf, worstErrorWithRephase } from "../core/fxmap.js";
import { encode, decode } from "../core/osc.js";
import { buildArtDmx, parseArtDmx, periodOf } from "../core/artnet.js";
import { Bridge } from "../core/bridge.js";
import { calibrate } from "../core/calibrate.js";
import { trueTicks, observe, beatAt } from "../sim/clock.js";
import { analyzeTicks } from "../cli/beatbridge.js";

const run = (est, ticks) => { for (const t of ticks) est.tick(t); return est.state(ticks.at(-1)); };

test("bridge estimator: 128 BPM through 1 ms jitter reads within 0.05 BPM; naive reads far off", () => {
  const O = observe(trueTicks(() => 128, 60000), { jitterMs: 1 });
  const e = new ClockEstimator(), n = new NaiveEstimator(); let worst = 0, worstN = 0;
  O.forEach((t, i) => { e.tick(t); n.tick(t); if (i > 200) { worst = Math.max(worst, Math.abs(e.state(t).bpm - 128)); worstN = Math.max(worstN, Math.abs(n.state(t).bpm - 128)); } });
  assert.ok(worst < 0.1, `worst ${worst}`); assert.ok(worstN > 10, `naive worst ${worstN}`);
});
test("tempo step 124 -> 128 settles within 1.5 s", () => {
  const tempo = (t) => (t < 30000 ? 124 : 128), O = observe(trueTicks(tempo, 45000), { jitterMs: 1 });
  const e = new ClockEstimator(); let settled = null;
  for (const t of O) { e.tick(t); const s = e.state(t); if (t > 30000 && s) { if (Math.abs(s.bpm - 128) < 0.15) settled ??= t; else if (t < 40000) settled = null; } }
  assert.ok(settled != null && settled - 30000 < 1500, `settled after ${settled - 30000} ms`);
});
test("MIDI START anchors the bar: the first clock after START is beat 1", () => {
  const e = new ClockEstimator(); const per = 60000 / (128 * PPQN);
  e.start(0); for (let k = 0; k < 24 * 9; k++) e.tick(10 + k * per);
  const s = e.state(10 + 24 * 8 * per + 0.1); assert.equal(s.barBeat, 0); assert.ok(s.beatPhase < 0.01 || s.beatPhase > 0.99);
});
test("downbeat tap snaps to the nearest beat", () => {
  const e = new ClockEstimator(); const per = 60000 / (120 * PPQN); for (let k = 0; k < 240; k++) e.tick(k * per);
  e.tapDownbeat(5 * 500 + 60);       // 60 ms late on beat 5
  const s = e.state(9 * 500 + 1); assert.equal(s.barBeat, 0);
});
test("BPM folding into a range", () => { assert.equal(foldBpm(65, 90, 180), 130); assert.equal(foldBpm(190, 90, 180), 95); assert.equal(foldBpm(128, 90, 180), 128); });
test("OSC bytes for /Mx/fader/4203 = 128 (int32)", () => {
  const b = encode("/Mx/fader/4203", [{ type: "i", value: 128 }]);
  const hex = Buffer.from(b).toString("hex");
  assert.equal(hex, Buffer.from("/Mx/fader/4203\0\0").toString("hex") + Buffer.from(",i\0\0").toString("hex") + "00000080");
  assert.deepEqual(decode(b), { address: "/Mx/fader/4203", args: [{ type: "i", value: 128 }] });
});
test("Art-Net ArtDmx round trip and period detection", () => {
  const p = parseArtDmx(buildArtDmx(3, Uint8Array.from([1, 2, 3]), 9)); assert.equal(p.universe, 3); assert.deepEqual([...p.data.slice(0, 3)], [1, 2, 3]);
  const tr = []; for (let t = 0; t < 10000; t += 25) tr.push([t, Math.round(128 + 100 * Math.sin((2 * Math.PI * t) / 1234))]);
  assert.ok(Math.abs(periodOf(tr) - 1234) < 1234 * 0.01);
});
test("speed curve: nearest level and drift", () => {
  const c = SpeedCurve.linear(240); assert.equal(c.levelFor(32), 34); assert.ok(Math.abs(c.cpmAt(34) - 32) < 0.1);
  const d = driftOf(c, 126, 4); assert.ok(d.minutesToOneBeat < 10 && d.minutesToOneBeat > 0, `${d.minutesToOneBeat}`);
  assert.equal(worstErrorWithRephase(0.001, 120, 4), 0.001 * 16 * 500);
});
test("bridge: fader sent only on level change; re-phase on the first bar after lock, then every 4th bar, early by the latency", () => {
  const per = 60000 / (128 * PPQN), msgs = [];
  const e = new ClockEstimator(); e.start(0);
  const b = new Bridge({ latencyMs: 30, fx: [{ name: "x", fader: "/f", beatsPerCycle: 4, curve: [[0, 0], [255, 240]] }], rephase: { everyBars: 4, actions: ["/go"] } }, e, (a, args, info) => msgs.push({ a, info }));
  let k = 0; for (let t = 0; t < 60000; t += 1) { while (k * per + 5 <= t) e.tick(5 + per * k++); b.update(t); }
  const faders = msgs.filter((m) => m.a === "/f"), go = msgs.filter((m) => m.a === "/go");
  assert.equal(faders.length, 1); assert.ok(go.length >= 7);
  for (const g of go) { const early = g.info.due - g.info.t; assert.ok(early > 28.9 && early <= 30.001, `early ${early}`); }
  const barMs = 4 * 60000 / 128; const bars = go.map((g) => (g.info.due - 5) / barMs);
  bars.forEach((x) => assert.ok(Math.abs(x - Math.round(x)) < 0.002, `not on a bar: ${x}`));
  bars.slice(1).forEach((x) => assert.equal(Math.round(x) % 4, 0));   // first re-phase on lock, then every 4th bar
});
test("calibration recovers a hidden curve from a simulated Art-Net trace", async () => {
  let clock = 0, level = 0, phase = 0; const hidden = (l) => 2 + 238 * (l / 255) ** 2;
  const sleep = async (ms) => { const steps = Math.round(ms / 10); for (let i = 0; i < steps; i++) { phase += (hidden(level) / 60000) * 10; clock += 10; } };
  const pts = await calibrate({ setLevel: async (l) => { level = l; }, readChannel: () => Math.round(128 + 100 * Math.sin(2 * Math.PI * phase)), levels: [96, 160, 255], settleMs: 500, measureMs: 8000, sleep, now: () => clock });
  for (const p of pts) assert.ok(Math.abs(p.cpm - hidden(p.level)) / hidden(p.level) < 0.02, `level ${p.level}: ${p.cpm} vs ${hidden(p.level)}`);
});
test("log analysis reports the jitter it was given", () => {
  const O = observe(trueTicks(() => 126, 60000), { jitterMs: 1.5, burstP: 0 });
  const r = analyzeTicks(O.map((t) => ({ t, status: 0xf8 })));
  assert.ok(Math.abs(r.jitterRmsMs - 1.5) < 0.25, `jitter ${r.jitterRmsMs}`); assert.ok(Math.abs(r.meanBpm - 126) < 0.05);
});
