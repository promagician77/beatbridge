// Measure the Onyx FX-speed fader curve from Onyx's own Art-Net output.
// For each fader level: set it over OSC, let the FX settle, record the chosen DMX channel
// (e.g. a moving head's pan in a circle FX), and time the cycle.
import { periodOf } from "./artnet.js";

export async function calibrate({ setLevel, readChannel, levels = [16, 32, 48, 64, 96, 128, 160, 192, 224, 255], settleMs = 1500, measureMs = 12000, sleep, now }) {
  const points = [];
  for (const lvl of levels) {
    await setLevel(lvl); await sleep(settleMs);
    const trace = []; const end = now() + measureMs;
    while (now() < end) { const v = readChannel(); if (v != null) trace.push([now(), v]); await sleep(10); }
    const per = periodOf(trace);
    points.push({ level: lvl, periodMs: per, cpm: per ? 60000 / per : null, samples: trace.length });
  }
  return points;
}
