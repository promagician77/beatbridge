// End to end over real UDP sockets on this machine:
//  1) calibrate: BeatBridge drives an emulated console's FX-speed fader over OSC and times the
//     FX from its Art-Net output; compared with the emulator's hidden curve.
//  2) simulate: a DJM-like clock through the live pipeline; OSC captured and checked.
import { spawn } from "node:child_process";
import dgram from "node:dgram";
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { decode } from "../core/osc.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = {};
const hidden = (l) => 2 + 238 * (l / 255) ** 2;
const cfg = { midiIn: "none", osc: { host: "127.0.0.1", port: 9100 }, faderType: "i", latencyMs: 30,
  fx: [{ name: "MH sweep", fader: "/Mx/fader/4203", beatsPerCycle: 4, curve: [[0, 0], [255, 240]] }],
  rephase: { everyBars: 1, actions: ["/Mx/playback/page1/3/go"] },
  calibrate: { fader: "/Mx/fader/4203", universe: 0, channel: 1, artnetPort: 6455, levels: [96, 128, 160, 192, 255], settleMs: 1000, measureMs: 6000 } };
mkdirSync("results", { recursive: true }); writeFileSync("results/e2e_config.json", JSON.stringify(cfg));

// 1) calibration against the emulator
const emu = spawn(process.execPath, ["cli/beatbridge.js", "emulate-onyx", "--osc-port", "9100", "--artnet-port", "6455", "--curve", "quadratic"], { stdio: "ignore" });
await sleep(500);
const cal = spawn(process.execPath, ["cli/beatbridge.js", "calibrate", "--config", "results/e2e_config.json", "--out", "results/curve_e2e.json"], { stdio: ["ignore", "pipe", "inherit"] });
let txt = ""; cal.stdout.on("data", (d) => (txt += d)); await new Promise((r) => cal.on("close", r)); emu.kill();
const pts = JSON.parse(txt);
out.calibration = pts.map((p) => ({ level: p.level, measuredCpm: +p.cpm.toFixed(3), hiddenCpm: +hidden(p.level).toFixed(3), errPct: +(100 * (p.cpm - hidden(p.level)) / hidden(p.level)).toFixed(2), samples: p.samples }));

// 2) simulate -> OSC receiver
const rx = dgram.createSocket("udp4"); const got = [];
rx.on("message", (b) => got.push({ t: performance.now() + performance.timeOrigin, m: decode(b) }));
await new Promise((r) => rx.bind(9200, r));
const cfg2 = { ...cfg, osc: { host: "127.0.0.1", port: 9200 } }; writeFileSync("results/e2e_config2.json", JSON.stringify(cfg2));
const t0 = performance.now() + performance.timeOrigin;
const sim = spawn(process.execPath, ["cli/beatbridge.js", "simulate", "--config", "results/e2e_config2.json", "--bpm", "126", "--jitter", "1", "--seconds", "16"], { stdio: ["ignore", "pipe", "inherit"] });
let st = ""; sim.stdout.on("data", (d) => (st += d)); await new Promise((r) => sim.on("close", r)); rx.close();
const summary = JSON.parse(st.trim().split("\n").at(-1));
const faders = got.filter((g) => g.m.address === "/Mx/fader/4203"), gos = got.filter((g) => g.m.address === "/Mx/playback/page1/3/go");
const gaps = gos.slice(1).map((g, i) => g.t - gos[i].t); const barMs = 4 * 60000 / 126;
out.simulate = { ...summary, received: got.length, faderMessages: faders.length, faderValues: [...new Set(faders.map((f) => f.m.args[0].value))], argType: faders[0]?.m.args[0].type,
  rephaseMessages: gos.length, rephaseIntervalMeanMs: +(gaps.reduce((a, b) => a + b, 0) / gaps.length).toFixed(2), barMs: +barMs.toFixed(2),
  rephaseIntervalJitterMs: +Math.sqrt(gaps.reduce((a, b) => a + (b - barMs) ** 2, 0) / gaps.length).toFixed(2) };
writeFileSync("results/e2e.json", JSON.stringify(out, null, 1)); console.log(JSON.stringify(out, null, 1));
