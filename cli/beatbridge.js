#!/usr/bin/env node
// BeatBridge: DJM-A9 MIDI clock -> Onyx (OSC). See README for the Onyx side.
//   ports                              list MIDI inputs
//   log --in DJM --out clock.csv       record every MIDI message with timestamps
//   analyze clock.csv                  jitter and tempo report from a log
//   run --config bridge.json           live: clock in, FX-speed faders and re-phase out
//   calibrate --config bridge.json     measure the FX-speed fader curve from Onyx's Art-Net
//   simulate --config bridge.json      no hardware: DJM-like clock through the same pipeline
//   emulate-onyx / monitor-osc         test helpers
import dgram from "node:dgram";
import { readFileSync, writeFileSync, createWriteStream } from "node:fs";
import { performance } from "node:perf_hooks";
import { ClockEstimator, NaiveEstimator, BeatAvgEstimator, PPQN } from "../core/estimator.js";
import { Bridge } from "../core/bridge.js";
import { encode, decode } from "../core/osc.js";
import { buildArtDmx, parseArtDmx } from "../core/artnet.js";
import { calibrate } from "../core/calibrate.js";
import { analyzeTicks } from "../core/analyze.js";
export { analyzeTicks };
import { trueTicks, observe } from "../sim/clock.js";

const argv = process.argv.slice(2), cmd = argv[0];
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i > 0 ? argv[i + 1] : d; };
const flag = (k) => argv.includes(`--${k}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => performance.now();
const loadCfg = () => JSON.parse(readFileSync(opt("config", "bridge.json"), "utf8"));

async function midiLib() {
  try { return (await import("@julusian/midi")).default; }
  catch (e) { console.error("MIDI library not available (npm install @julusian/midi). " + e.message); process.exit(2); }
}
async function newInput() {
  const midi = await midiLib();
  try { return new midi.Input(); }
  catch (e) { console.error("No MIDI system available here (" + e.message + "). Connect the DJM-A9 over USB (install Pioneer DJ's DJM-A9 driver software first if your system needs it); on Linux the ALSA sequencer must be present."); process.exit(2); }
}
async function openIn(match) {
  const inp = await newInput(); const n = inp.getPortCount(); let idx = -1;
  for (let i = 0; i < n; i++) if (inp.getPortName(i).toLowerCase().includes(String(match).toLowerCase())) { idx = i; break; }
  if (idx < 0) { console.error(`No MIDI input matching "${match}". Ports: ${[...Array(n)].map((_, i) => inp.getPortName(i)).join(", ") || "none"}`); process.exit(2); }
  inp.ignoreTypes(true, false, true);           // keep timing clock, drop sysex and active sensing
  inp.openPort(idx); console.error(`listening: ${inp.getPortName(idx)}`); return inp;
}
function oscSender(host, port) {
  const sock = dgram.createSocket("udp4");
  return { send: (address, args = []) => sock.send(encode(address, args), port, host), close: () => sock.close() };
}

async function main() {
  if (cmd === "ports") {
    const inp = await newInput();
    for (let i = 0; i < inp.getPortCount(); i++) console.log(`${i}: ${inp.getPortName(i)}`); return;
  }
  if (cmd === "log") {
    const inp = await openIn(opt("in", "DJM")); const out = createWriteStream(opt("out", "clock.csv"));
    out.write("t_ms,driver_dt_s,status,d1,d2\n"); const secs = +opt("seconds", 120); let n = 0;
    inp.on("message", (dt, m) => { out.write(`${now().toFixed(3)},${dt.toFixed(6)},${m[0]},${m[1] ?? ""},${m[2] ?? ""}\n`); if (m[0] === 0xf8) n++; });
    await sleep(secs * 1000); inp.closePort(); out.end(); console.error(`${n} clock ticks in ${secs} s`); return;
  }
  if (cmd === "analyze") return analyze(argv[1] || "clock.csv");
  if (cmd === "run") return run(loadCfg());
  if (cmd === "simulate") return simulate(loadCfg());
  if (cmd === "calibrate") return calib(loadCfg());
  if (cmd === "emulate-onyx") return emulateOnyx();
  if (cmd === "monitor-osc") {
    const s = dgram.createSocket("udp4"); s.on("message", (b) => { const m = decode(b); console.log(`${now().toFixed(1)} ${m.address} ${m.args.map((a) => a.value).join(" ")}`); });
    s.bind(+opt("port", 9000)); return;
  }
  console.log(readFileSync(new URL(import.meta.url)).toString().split("\n").slice(1, 10).join("\n"));
}

function analyze(file) {
  const rows = readFileSync(file, "utf8").trim().split("\n").slice(1).map((l) => { const [t, dt, st, d1, d2] = l.split(","); return { t: +t, dt: +dt, status: +st, d1: +d1, d2: +d2 }; });
  const { residuals, ...r } = analyzeTicks(rows); void residuals; console.log(JSON.stringify(r, null, 1)); return r;
}

function wireBridge(cfg, est) {
  const osc = oscSender(cfg.osc.host, cfg.osc.port);
  const bridge = new Bridge(cfg, est, (address, args, info) => { osc.send(address, args); if (flag("verbose")) console.log(`${info.kind} ${address} ${args.map((a) => a.value).join(" ")}`); });
  return { osc, bridge };
}

async function run(cfg) {
  const est = new ClockEstimator({ fold: cfg.foldBpm || null }); const { bridge } = wireBridge(cfg, est);
  const inp = await openIn(cfg.midiIn || "DJM");
  inp.on("message", (dt, m) => {
    const t = now();
    if (m[0] === 0xf8) est.tick(t); else if (m[0] === 0xfa) { est.start(t); console.log("MIDI START: next clock is the downbeat"); } else if (m[0] === 0xfc) est.stop();
    else if (cfg.downbeat?.note != null && (m[0] & 0xf0) === 0x90 && m[1] === cfg.downbeat.note && m[2] > 0) { est.tapDownbeat(t); console.log("downbeat (MIDI note)"); }
  });
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true); process.stdin.on("data", (b) => {
      const k = b.toString(); if (k === "q" || k === "\u0003") process.exit(0);
      if (k === " ") { est.tapDownbeat(now()); console.log("downbeat (key)"); }
      if (k === "1") bridge.setMult(null, 0.5); if (k === "2") bridge.setMult(null, 1); if (k === "3") bridge.setMult(null, 2);
    });
  }
  let last = 0;
  setInterval(() => { const s = bridge.update(now()); if (s && now() - last > 1000) { last = now(); process.stdout.write(`\r${s.bpm.toFixed(2)} BPM  bar beat ${s.barBeat + 1}  ${s.locked ? "locked" : s.holding ? "HOLD" : "..."}  jitter ${s.jitterMs.toFixed(2)} ms  sent ${bridge.sent}   `); } }, 1);
}

async function simulate(cfg) {
  const bpm = +opt("bpm", 126), jit = +opt("jitter", 1), secs = +opt("seconds", 20);
  const T = observe(trueTicks(() => bpm, secs * 1000), { jitterMs: jit });
  const est = new ClockEstimator({ fold: cfg.foldBpm || null }); const { osc, bridge } = wireBridge(cfg, est);
  const t0 = now(); let i = 0, tapped = false;
  await new Promise((done) => {
    const iv = setInterval(() => {
      const t = now() - t0;
      while (i < T.length && T[i] <= t) est.tick(T[i++]);
      if (!tapped && i > 96) { est.tapDownbeat(T[i - 1]); tapped = true; }
      bridge.update(t);
      if (i >= T.length) { clearInterval(iv); done(); }
    }, 1);
  });
  const s = est.state(now() - t0); console.log(JSON.stringify({ bpmIn: bpm, jitterMs: jit, bpmOut: s && +s.bpm.toFixed(3), oscSent: bridge.sent }));
  osc.close();
}

async function calib(cfg) {
  const c = cfg.calibrate; const osc = oscSender(cfg.osc.host, cfg.osc.port);
  const sock = dgram.createSocket({ type: "udp4", reuseAddr: true }); let latest = null;
  sock.on("message", (b) => { const p = parseArtDmx(b); if (p && p.universe === c.universe) { const hi = p.data[c.channel - 1], lo = c.fineChannel ? p.data[c.fineChannel - 1] : 0; latest = hi + lo / 256; } });
  await new Promise((r) => sock.bind(c.artnetPort || 6454, r));
  const levels = c.levels || undefined;
  const pts = await calibrate({ setLevel: (l) => osc.send(c.fader, [{ type: cfg.faderType || "i", value: l }]), readChannel: () => latest, levels, settleMs: c.settleMs ?? 1500, measureMs: c.measureMs ?? 12000, sleep, now });
  console.log(JSON.stringify(pts, null, 1));
  const curve = [[0, 0], ...pts.filter((p) => p.cpm).map((p) => [p.level, +p.cpm.toFixed(4)])];
  writeFileSync(opt("out", "curve.json"), JSON.stringify(curve)); console.error(`wrote ${opt("out", "curve.json")}`);
  sock.close(); osc.close();
}

// Test stand-in for Onyx: an FX whose speed follows an OSC fader through a hidden curve,
// output as Art-Net (pan channel 1 on universe 0) at 40 Hz.
async function emulateOnyx() {
  const oscPort = +opt("osc-port", 9000), anHost = opt("artnet-host", "127.0.0.1"), anPort = +opt("artnet-port", 6454), shape = opt("curve", "quadratic");
  const hidden = { linear: (l) => (l / 255) * 240, quadratic: (l) => 2 + 238 * (l / 255) ** 2 }[shape];
  const s = dgram.createSocket("udp4"), out = dgram.createSocket("udp4"); let level = 0, phase = 0, last = now(), seq = 0;
  s.on("message", (b) => { const m = decode(b); if (m.address === opt("fader", "/Mx/fader/4203")) level = m.args[0].value; });
  s.bind(oscPort);
  setInterval(() => { const t = now(); phase += (hidden(level) / 60000) * (t - last); last = t;
    const pan = Math.round(128 + 100 * Math.sin(2 * Math.PI * phase)); out.send(buildArtDmx(0, Uint8Array.from([pan, 0, 0, 0])), anPort, anHost); seq++; }, 25);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
