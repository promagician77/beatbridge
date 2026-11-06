import { LiveRig, MODES } from "./livesim.js";
import { createStage } from "./stage.js";
import { analyzeTicks } from "./lib/analyze.js";
import { ClockEstimator } from "./lib/estimator.js";

const $ = (s, e = document) => e.querySelector(s), $$ = (s, e = document) => [...e.querySelectorAll(s)];
const RENDER = {}; let CUR = null;
const COL = { naive: "#E5544B", fader: "#B48EF0", rephase: "#FFB547", steer: "#3FD08A" };

function tabs() {
  const b = $$("nav.tabs button");
  const show = (id) => { b.forEach((x) => x.setAttribute("aria-selected", x.dataset.tab === id)); $$("section.tab").forEach((s) => s.classList.toggle("on", s.id === "s-" + id)); CUR = id; try { history.replaceState(null, "", "#" + id); } catch (e) {} requestAnimationFrame(() => RENDER[id] && RENDER[id]()); };
  b.forEach((x) => x.addEventListener("click", () => show(x.dataset.tab)));
  const h = location.hash.slice(1); show(b.some((x) => x.dataset.tab === h) ? h : "rig");
  let t; window.addEventListener("resize", () => { clearTimeout(t); t = setTimeout(() => CUR !== "rig" && RENDER[CUR] && RENDER[CUR](), 150); });
}

/* ---------------- live rig ---------------- */
const rig = new LiveRig(); let stage, sel = "steer", source = "sim";
const ui = { mhfx: "fan", vplfx: "chase" };
function scoreTable() {
  $("#score tbody").innerHTML = Object.entries(MODES).map(([k, m]) => `<tr data-k="${k}" class="${k === sel ? "pick" : ""}"><td><i style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${COL[k]};margin-right:7px"></i>${m.label}</td><td class="n" data-c="in">—</td><td class="n" data-c="now">—</td><td class="n" data-c="osc">—</td></tr>`).join("");
  $$("#score tbody tr").forEach((tr) => tr.addEventListener("click", () => { sel = tr.dataset.k; $$("#score tbody tr").forEach((x) => x.classList.toggle("pick", x === tr)); }));
}
function dots(el, n) { el.innerHTML = [0, 1, 2, 3].map((i) => `<i class="${i === n ? "on" : ""}"></i>`).join(""); }
function strip() {
  const c = $("#strip"), ctx = c.getContext("2d"), w = (c.width = c.clientWidth * 2), h = (c.height = 140); ctx.clearRect(0, 0, w, h);
  const H = rig.lanes[sel].hist, mid = h / 2, sc = h / 2 / 250;
  ctx.fillStyle = "rgba(63,208,138,0.12)"; ctx.fillRect(0, mid - 40 * sc, w, 80 * sc);
  ctx.strokeStyle = "#2E3442"; ctx.beginPath(); ctx.moveTo(0, mid); ctx.lineTo(w, mid); ctx.stroke();
  ctx.strokeStyle = COL[sel]; ctx.lineWidth = 2.5; ctx.beginPath();
  H.forEach((e, i) => { const x = (i / 900) * w, y = mid - Math.max(-250, Math.min(250, e)) * sc; i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }); ctx.stroke();
  ctx.fillStyle = "#8B94A6"; ctx.font = "20px JBM, monospace"; ctx.fillText("±250 ms · green band ±40 ms · last 15 s", 10, 24);
}
let t0 = null, lastUi = 0;
function frame(now) {
  if (rig.t != null && now - rig.t > 500) { if (source === "sim") rig.reset(rig.target, rig.jitter); else rig.useExternal(); t0 = now; } // tab was hidden: start fresh
  rig.advance(now);
  if (CUR === "rig") {
    const L = rig.lanes[sel], fxPh = (v) => ((v % 1) + 1) % 1, s = L.est.state(now);
    const mh = fxPh(L.onyx.MH.phase), vpl = fxPh(L.onyx.VPL.phase), fxBeat = Math.floor(mh * 4) % 4;
    stage.draw({ mh, vpl, vplBar: mh, mhFx: ui.mhfx, vplFx: ui.vplfx, barBeat: fxBeat });
    if (now - lastUi > 80) {
      lastUi = now; const tr = rig.truth();
      $("#h-bpm").textContent = s ? `${s.bpm.toFixed(2)} BPM` : "—";
      $("#h-src").textContent = source === "sim" ? `simulated DJM-A9 · true ${tr.bpm.toFixed(2)}` : "your DJM-A9 (Web MIDI)";
      $("#h-mode").textContent = MODES[sel].label;
      const e = L.err; const he = $("#h-err");
      if (source === "sim") { he.textContent = `${e >= 0 ? "+" : "−"}${Math.abs(e).toFixed(0)} ms vs bar`; he.style.color = Math.abs(e) < 40 ? "#3FD08A" : Math.abs(e) < 100 ? "#FFB547" : "#E5544B"; dots($("#dots-true"), tr.barBeat); }
      else { he.textContent = s && s.jitterMs != null ? `jitter ${s.jitterMs.toFixed(2)} ms` : "waiting for clock"; he.style.color = "#ECEFF4"; dots($("#dots-true"), s ? s.barBeat : -1); }
      dots($("#dots-fx"), fxBeat);
      for (const [k, l] of Object.entries(rig.lanes)) {
        const row = $(`#score tr[data-k="${k}"]`); if (!row) continue;
        row.querySelector('[data-c="in"]').textContent = source === "sim" && l.samples ? `${((100 * l.inSync) / l.samples).toFixed(1)} %` : "—";
        row.querySelector('[data-c="now"]').textContent = source === "sim" ? `${l.err.toFixed(0)} ms` : "—";
        const mins = Math.max(0.05, (now - (t0 ?? now)) / 60000); row.querySelector('[data-c="osc"]').textContent = (l.sent / mins).toFixed(0);
      }
      strip();
    }
  }
  requestAnimationFrame(frame);
}
function initRig() {
  stage = createStage($("#stage")); scoreTable(); t0 = performance.now();
  $$("[data-tempo]").forEach((b) => b.addEventListener("click", () => rig.setTempo(Math.max(70, Math.min(180, rig.target + +b.dataset.tempo)), 0)));
  let up = false; $("[data-ramp]").addEventListener("click", () => { up = !up; rig.setTempo(rig.target + (up ? 3 : -3), 16); });
  const jit = $("#jit"); jit.addEventListener("input", () => { rig.jitter = +jit.value; $("#jitv").textContent = `${(+jit.value).toFixed(2)} ms`; });
  const tap = () => rig.tapDownbeat(performance.now()); $("#tap").addEventListener("click", tap);
  window.addEventListener("keydown", (e) => { if (e.code === "Space" && CUR === "rig" && !["INPUT", "SELECT", "BUTTON"].includes(document.activeElement.tagName)) { e.preventDefault(); tap(); } });
  $("#reset").addEventListener("click", () => { if (source === "sim") rig.reset(126, +jit.value); else rig.useExternal(); t0 = performance.now(); });
  $("#mhfx").addEventListener("change", (e) => (ui.mhfx = e.target.value)); $("#vplfx").addEventListener("change", (e) => (ui.vplfx = e.target.value));
  $$("#src button").forEach((b) => b.addEventListener("click", () => setSource(b.dataset.v)));
  requestAnimationFrame(frame);
}
function setSource(v) {
  if (v === "midi" && !midi.input) { location.hash = "midi"; $$("nav.tabs button").find((b) => b.dataset.tab === "midi").click(); $("#midi-status").textContent = "Connect your DJM-A9 here first, then press “Drive the live rig from this input”."; return; }
  source = v; $$("#src button").forEach((b) => b.setAttribute("aria-pressed", b.dataset.v === v));
  if (v === "sim") rig.reset(126, +$("#jit").value); else rig.useExternal(); t0 = performance.now();
}

/* ---------------- Web MIDI analyzer ---------------- */
const midi = { access: null, input: null, ticks: [], rows: [], other: new Map(), est: new ClockEstimator() };
async function initMidi() {
  $("#midi-connect").addEventListener("click", async () => {
    if (!navigator.requestMIDIAccess) { $("#midi-status").textContent = "This browser has no Web MIDI. Use Chrome or Edge on a desktop computer."; return; }
    try { midi.access = await navigator.requestMIDIAccess({ sysex: false }); } catch (e) { $("#midi-status").textContent = `MIDI access was refused (${e.message}).`; return; }
    const fill = () => { const ins = [...midi.access.inputs.values()]; const s = $("#midi-in"); s.innerHTML = ins.length ? ins.map((i) => `<option value="${i.id}">${i.name}</option>`).join("") : "<option>no MIDI inputs found</option>"; s.disabled = !ins.length;
      const djm = ins.find((i) => /djm/i.test(i.name)); if (djm) s.value = djm.id; if (ins.length) pick(s.value); };
    midi.access.onstatechange = fill; fill(); $("#midi-in").addEventListener("change", (e) => pick(e.target.value));
  });
  $("#midi-dl").addEventListener("click", () => {
    const csv = "t_ms,driver_dt_s,status,d1,d2\n" + midi.rows.map((r) => `${r.t.toFixed(3)},,${r.status},${r.d1 ?? ""},${r.d2 ?? ""}`).join("\n");
    const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" })); a.download = "djm-a9-clock.csv"; a.click();
  });
  $("#midi-rig").addEventListener("click", () => { $$("nav.tabs button").find((b) => b.dataset.tab === "rig").click(); setSource("midi"); });
  setInterval(midiStats, 700);
}
function pick(id) {
  if (midi.input) midi.input.onmidimessage = null;
  midi.input = midi.access.inputs.get(id); midi.ticks = []; midi.rows = []; midi.other.clear(); midi.est = new ClockEstimator();
  $("#midi-status").textContent = `Listening to ${midi.input.name}. Play a track: the DJM sends clock from its BPM counter.`;
  midi.input.onmidimessage = (e) => {
    const [st, d1, d2] = e.data, t = e.timeStamp; if (midi.rows.length < 400000) midi.rows.push({ t, status: st, d1, d2 });
    if (st === 0xf8) { midi.ticks.push(t); if (midi.ticks.length > 4000) midi.ticks.shift(); midi.est.tick(t); if (source === "midi") rig.extTick(t); }
    else if (st === 0xfa) { midi.est.start(t); if (source === "midi") rig.extStart(t); bump("START (0xFA)", ""); }
    else if (st === 0xfc) { midi.est.stop(); if (source === "midi") rig.extStop(); bump("STOP (0xFC)", ""); }
    else if (st < 0xf0) { const type = { 8: "Note off", 9: "Note on", 11: "CC", 14: "Pitch bend" }[st >> 4] || `0x${(st >> 4).toString(16)}`; bump(`${type} ch${(st & 15) + 1} #${d1}`, d2); }
  };
  $("#midi-dl").disabled = false; $("#midi-rig").disabled = false;
}
function bump(k, v) { const o = midi.other.get(k) || { n: 0, v: "" }; o.n++; o.v = v; midi.other.set(k, o); }
function midiStats() {
  if (!midi.input) return;
  $("#midi-msgs tbody").innerHTML = [...midi.other.entries()].map(([k, o]) => `<tr><td>${k}</td><td class="n">${o.n}</td><td>${o.v}</td></tr>`).join("") || `<tr><td colspan="3" class="note">No buttons or START/STOP yet.</td></tr>`;
  if (midi.ticks.length < 120) { $("#midi-tiles").innerHTML = `<div class="tile"><b>${midi.ticks.length}</b><span>clock ticks so far</span></div>`; return; }
  const r = analyzeTicks(midi.ticks.map((t) => ({ t, status: 0xf8 }))), s = midi.est.state(performance.now());
  $("#midi-tiles").innerHTML = [[s ? s.bpm.toFixed(2) : "—", "BPM (BeatBridge)"], [`${r.bpm.naive.min.toFixed(0)}–${r.bpm.naive.max.toFixed(0)}`, "BPM tick by tick (range)"], [`${r.jitterRmsMs.toFixed(2)} ms`, "jitter RMS"], [`${r.jitterP99Ms.toFixed(2)} ms`, "jitter 99th pct"], [`${r.maxGapMs.toFixed(1)} ms`, "longest gap"], [r.ticks, "ticks analysed"]].map(([b, t]) => `<div class="tile"><b>${b}</b><span>${t}</span></div>`).join("");
  const c = $("#hist"), ctx = c.getContext("2d"), w = (c.width = c.clientWidth * 2), h = (c.height = 340); ctx.clearRect(0, 0, w, h);
  const bins = new Array(41).fill(0); for (const x of r.residuals) { const i = Math.round(x / 0.25) + 20; if (i >= 0 && i < 41) bins[i]++; }
  const mx = Math.max(...bins); ctx.fillStyle = "#46DCFF"; bins.forEach((v, i) => { const bh = (v / mx) * (h - 50); ctx.fillRect((i / 41) * w + 2, h - 30 - bh, w / 41 - 4, bh); });
  ctx.fillStyle = "#8B94A6"; ctx.font = "20px JBM, monospace"; ctx.fillText("−5 ms", 4, h - 6); ctx.fillText("0", w / 2 - 6, h - 6); ctx.fillText("+5 ms", w - 70, h - 6);
  $("#hist-note").textContent = `${r.residuals.length} ticks. Jitter is each tick's distance from a straight line through the 2 beats around it. Large values are USB or driver delays; BeatBridge averages them out.`;
}

/* ---------------- measured ---------------- */
async function measured() {
  const j = async (p) => (await fetch(p)).json(); const [B, E] = await Promise.all([j("data/bench.json"), j("data/e2e.json")]);
  const set = (k, v) => $$(`[data-n="${k}"]`).forEach((e) => (e.textContent = v));
  const S = B.set.results, J1 = B.jitter.find((r) => r.sigma === 1);
  set("steer-in", `${S.bridge_steer_feedback_rephase32.inSync40msPct} %`); set("fader-in", `${S.bridge_fader.inSync40msPct} %`);
  set("bpm-err", `${J1.bridge.bpmRms.toFixed(3)} BPM`); set("bpm-naive", `${J1.naive.bpmRms.toFixed(1)} BPM`);
  set("chatter", J1.bridge.faderChangesPerMin.toFixed(0)); set("chatter-naive", Math.round(J1.naive.faderChangesPerMin).toLocaleString());
  const NAMES = { naive_fader: ["Tick-by-tick BPM → fader", "#E5544B"], bridge_fader: ["Filtered BPM → fader", "#B48EF0"], bridge_rephase4: ["Re-phase every 4 bars", "#FFB547"], bridge_rephase1: ["Re-phase every bar", "#F6D365"], bridge_steer_rephase16: ["Steer, no feedback (+ re-phase /16)", "#7D8BA6"], bridge_steer_feedback_rephase32: ["Steer + Art-Net feedback (+ re-phase /32)", "#3FD08A"] };
  $("#set-tb").innerHTML = `<tr><th>Strategy</th><th class="n">p95</th><th class="n">max</th><th class="n">restarts</th><th class="n">OSC msgs</th></tr>` + Object.entries(S).map(([k, r]) => `<tr><td>${NAMES[k][0]}</td><td class="n">${r.p95Ms} ms</td><td class="n">${r.maxMs} ms</td><td class="n">${r.restarts}</td><td class="n">${r.oscMessages.toLocaleString()}</td></tr>`).join("");
  RENDER.measured = () => {
    barChart($("#ch-set"), { rows: Object.entries(S).map(([k, r]) => ({ label: NAMES[k][0], v: r.inSync40msPct, color: NAMES[k][1], text: `${r.inSync40msPct} %` })), labelW: 270, marginR: 64, rowH: 34, max: 100, ticks: 4, fmt: (v) => v + "%" });
    const ser = B.set.series, keys = ["bridge_fader", "bridge_rephase4", "bridge_steer_feedback_rephase32"];
    $("#lg-err").innerHTML = keys.map((k) => `<span><i style="background:${NAMES[k][1]}"></i>${NAMES[k][0]}</span>`).join("");
    lineChart($("#ch-err"), { height: 260, xDomain: [0, 30], yDomain: [0, 1000], yTicks: 5, xLabel: "minutes", yLabel: "|phase error| (ms)", refLines: [{ y: 40, label: "40 ms" }], series: keys.map((k) => ({ name: NAMES[k][0], color: NAMES[k][1], x: ser.t, y: ser[k], width: k.includes("steer") ? 2.6 : 1.6 })), xFmtTip: (v) => `${v} min`, yFmtTip: (v) => `${v} ms` });
    const sig = B.jitter.map((r) => r.sigma);
    lineChart($("#ch-jit"), { height: 240, xDomain: [0, 4.2], yDomain: [0, 2], yTicks: 4, xLabel: "USB jitter, RMS (ms)", yLabel: "tempo error, RMS (BPM)", series: [
      { name: "tick-by-tick", color: "#E5544B", x: sig, y: B.jitter.map((r) => Math.min(2, r.naive.bpmRms)) }, { name: "1-beat average", color: "#FFB547", x: sig, y: B.jitter.map((r) => r.beatavg.bpmRms) }, { name: "BeatBridge", color: "#3FD08A", x: sig, y: B.jitter.map((r) => r.bridge.bpmRms), width: 2.6 }], xFmtTip: (v) => `${v} ms`, yFmtTip: (v) => `${v.toFixed(3)} BPM` });
    const st = B.change.step.series;
    lineChart($("#ch-step"), { height: 240, xDomain: [55, 72], yDomain: [120, 132], yTicks: 6, xLabel: "seconds", yLabel: "BPM read", series: [
      { name: "tick-by-tick", color: "#E5544B", x: st.naive.map((p) => p[0]), y: st.naive.map((p) => (p[1] > 132 || p[1] < 120 ? null : p[1])), width: 1 },
      { name: "1-beat average", color: "#FFB547", x: st.beatavg.map((p) => p[0]), y: st.beatavg.map((p) => p[1]), width: 1.4 },
      { name: "BeatBridge", color: "#3FD08A", x: st.bridge.map((p) => p[0]), y: st.bridge.map((p) => p[1]), width: 2.6 },
      { name: "true", color: "#8B94A6", x: [55, 60, 60, 72], y: [124, 124, 128, 128], width: 1.2, hover: false }], xFmtTip: (v) => `${v} s`, yFmtTip: (v) => `${v.toFixed(2)}` });
    const q = B.quant.rows.find((r) => r.maxCpm === 240 && r.beatsPerCycle === 4);
    lineChart($("#ch-quant"), { height: 220, xDomain: [118, 132], yDomain: [-2, 2], yTicks: 4, xLabel: "BPM", yLabel: "FX speed error (%)", series: [{ name: "error", color: "#FFB547", x: q.sweep.map((p) => p[0]), y: q.sweep.map((p) => p[1]), width: 1.8 }], xFmtTip: (v) => `${v} BPM`, yFmtTip: (v) => `${v.toFixed(2)} %` });
  };
  $("#jit-tb").innerHTML = `<tr><th>Jitter</th><th class="n">Tick-by-tick</th><th class="n">1-beat avg</th><th class="n">BeatBridge</th><th class="n">Fader updates/min (TbT / avg / BB)</th></tr>` + B.jitter.map((r) => `<tr><td>${r.sigma} ms</td><td class="n">${r.naive.bpmRms > 100 ? ">100" : r.naive.bpmRms.toFixed(2)}</td><td class="n">${r.beatavg.bpmRms.toFixed(3)}</td><td class="n">${r.bridge.bpmRms.toFixed(3)}</td><td class="n">${Math.round(r.naive.faderChangesPerMin)} / ${r.beatavg.faderChangesPerMin.toFixed(0)} / ${r.bridge.faderChangesPerMin.toFixed(0)}</td></tr>`).join("");
  const cs = B.change; $("#step-note").textContent = `BeatBridge settles within 0.15 BPM ${cs.step.summary.bridge.settleS} s after a 4 BPM jump, and ${cs.ramp.summary.bridge.settleS} s after a 16-beat pitch ride ends. The 1-beat average never holds 0.15 BPM at this jitter: it keeps wandering.`;
  $("#quant-tb").innerHTML = `<tr><th>Full scale</th><th class="n">Step</th><th class="n">Median err</th><th class="n">1 beat off</th><th class="n">Worst, re-phase /1 · /4</th></tr>` + [120, 240, 480].map((m) => { const r = B.quant.rows.find((x) => x.maxCpm === m && x.beatsPerCycle === 4), p = B.quant.rephase.find((x) => x.maxCpm === m); return `<tr><td>${m} c/min</td><td class="n">${r.stepCpm.toFixed(2)}</td><td class="n">${r.medianRelErrPct} %</td><td class="n">${r.medianMinutesToOneBeat} min</td><td class="n">${p.every1} · ${p.every4} ms</td></tr>`; }).join("");
  const c = E.calibration, s = E.simulate;
  $("#e2e-tb").innerHTML = `<tr><th>Calibration level</th><th class="n">Measured</th><th class="n">Hidden</th><th class="n">Error</th></tr>` + c.map((p) => `<tr><td>${p.level}</td><td class="n">${p.measuredCpm}</td><td class="n">${p.hiddenCpm}</td><td class="n">${p.errPct > 0 ? "+" : ""}${p.errPct} %</td></tr>`).join("") +
    `<tr><th colspan="4" style="padding-top:12px">Simulate, 126 BPM, 16 s</th></tr><tr><td>OSC received / sent</td><td class="n" colspan="3">${s.received} / ${s.oscSent} (int32 args)</td></tr><tr><td>Re-phase interval</td><td class="n" colspan="3">${s.rephaseIntervalMeanMs} ms vs bar ${s.barMs} ms (±${s.rephaseIntervalJitterMs} ms)</td></tr>`;
  RENDER[CUR] && RENDER[CUR]();
}

/* ---------------- plan ---------------- */
function chain() {
  const s = $("#chain"); const box = (x, y, w, h, t, sub, cls = "") => `<rect class="bx ${cls}" x="${x}" y="${y}" width="${w}" height="${h}" rx="8"/><text x="${x + 14}" y="${y + 26}">${t}</text>${sub.map((l, i) => `<text class="s" x="${x + 14}" y="${y + 46 + i * 16}">${l}</text>`).join("")}`;
  const ln = (d, cls = "") => `<path class="ln ${cls}" d="${d}" marker-end="url(#ar)"/>`;
  s.innerHTML = `<defs><marker id="ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#8B94A6"/></marker></defs>` +
    box(10, 100, 200, 96, "Pioneer DJM-A9", ["AUTO/TAP BPM 70–180", "MIDI clock 24 PPQN (USB)", "START/STOP button"]) +
    box(300, 20, 250, 80, "Onyx Beat Provider", ["Midi Clock source", "Quantum 4 · Track"], "k") +
    box(300, 190, 250, 96, "BeatBridge", ["tempo + bar from the clock", "OSC → FX-speed faders", "re-phase · steer"], "k") +
    box(650, 10, 200, 62, "Chase cuelists", ["MH position · intensity"]) + box(650, 86, 200, 62, "DyLOS", ["VPL pixel content"], "c") +
    box(650, 190, 200, 96, "FX engine", ["Override: FX speed", "fader /Mx/fader/…", "release/go on the 1"]) +
    box(920, 40, 170, 80, "Moving heads", ["pan/tilt · intensity"]) + box(920, 170, 170, 80, "SGM VPL bars", ["16/32/64 px · RGB"], "c") +
    ln("M210 130 C 250 130, 260 60, 300 60", "k") + ln("M210 165 C 250 165, 260 238, 300 238", "k") + ln("M550 52 L 650 40") + ln("M550 70 L 650 112", "c") + ln("M550 238 L 650 238") +
    ln("M850 40 L 920 70") + ln("M850 112 L 920 200", "c") + ln("M850 225 L 920 95") + ln("M850 250 L 920 215", "c") +
    `<path class="ln d c" d="M760 286 C 760 326, 430 326, 430 287" marker-end="url(#ar)"/><text class="s" x="480" y="306">Art-Net back (feedback, calibrate)</text>`;
}

async function main() {
  tabs(); initRig(); await initMidi(); chain();
  try { $("#cfg").textContent = await (await fetch("data/bridge.example.json")).text(); } catch (e) {}
  await measured(); document.body.dataset.ready = "1";
}
main().catch((e) => { console.error(e); document.body.insertAdjacentHTML("afterbegin", `<p style="padding:10px;background:#5a1d1d;color:#fff">Failed to start: ${e.message}. Serve this folder over HTTP.</p>`); });
