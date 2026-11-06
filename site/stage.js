// Canvas stage: six moving heads on a truss and eight SGM VPL-style pixel bars (16 pixels each)
// on the back wall. Driven by FX phases from the selected lane, not by the true clock, so drift
// and jitter show up exactly as they would on the rig.
export function createStage(canvas) {
  const ctx = canvas.getContext("2d"); let W = 0, H = 0, dpr = 1;
  const fit = () => { dpr = Math.min(2, window.devicePixelRatio || 1); W = canvas.clientWidth; H = canvas.clientHeight; canvas.width = W * dpr; canvas.height = H * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0); };
  fit(); new ResizeObserver(fit).observe(canvas);

  function draw(st) {
    // st: { mh: cyclePhase (0..1 per bar), vpl: cyclePhase per beat, mhFx, vplFx, beatFlash, err }
    ctx.globalCompositeOperation = "source-over";
    const g = ctx.createLinearGradient(0, 0, 0, H); g.addColorStop(0, "#05060A"); g.addColorStop(1, "#0B0D13"); ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    const floorY = H * 0.9, trussY = H * 0.1;
    ctx.fillStyle = "#11141B"; ctx.fillRect(0, floorY, W, H - floorY);
    // back wall VPL bars
    const nb = 8, bw = Math.max(6, W * 0.012), top = H * 0.28, bot = H * 0.78, ph = (bot - top) / 16;
    ctx.globalCompositeOperation = "lighter";
    for (let b = 0; b < nb; b++) {
      const x = W * (0.12 + (0.76 * b) / (nb - 1)) - bw / 2;
      for (let p = 0; p < 16; p++) {
        let v = 0; const pos = 15 - p;               // pixel 0 at the bottom
        if (st.vplFx === "chase") { const head = st.vpl * 18 - 1; v = Math.exp(-((pos - head) ** 2) / 3); }
        else if (st.vplFx === "wipe") { const head = ((st.vplBar + b / nb) % 1) * 16; v = pos <= head ? 0.9 : 0.04; }
        else { const hit = st.barBeat === 1 || st.barBeat === 3; v = hit ? Math.max(0, 1 - st.vpl * 2.4) : 0.03; }
        const y = top + p * ph;
        ctx.fillStyle = `rgba(70,220,255,${0.08 + 0.92 * v})`; ctx.fillRect(x, y + 1, bw, ph - 2);
        if (v > 0.25) { ctx.fillStyle = `rgba(70,220,255,${0.12 * v})`; ctx.fillRect(x - bw, y - ph * 0.4, bw * 3, ph * 1.8); }
      }
    }
    // truss
    ctx.globalCompositeOperation = "source-over"; ctx.fillStyle = "#2A2F3A"; ctx.fillRect(W * 0.06, trussY - 6, W * 0.88, 8);
    ctx.globalCompositeOperation = "lighter";
    const n = 6;
    for (let i = 0; i < n; i++) {
      const x = W * (0.16 + (0.68 * i) / (n - 1)), spread = (i - (n - 1) / 2) / ((n - 1) / 2);
      let ang, len = floorY - trussY, depth = 1;
      if (st.mhFx === "fan") { ang = 0.42 * Math.sin(2 * Math.PI * st.mh) * spread + 0.08 * spread; }
      else if (st.mhFx === "circle") { const a = 2 * Math.PI * (st.mh + i / n); ang = 0.3 * Math.sin(a); depth = 0.82 + 0.18 * Math.cos(a); }
      else { ang = 0.12 * spread; depth = 0.62 + 0.38 * Math.abs(Math.cos(Math.PI * st.mh * 2)); }
      const ex = x + Math.tan(ang) * len * depth, ey = trussY + len * depth, w0 = 3, w1 = 34 + 26 * depth;
      const dx = ex - x, dy = ey - trussY, L = Math.hypot(dx, dy), nx = -dy / L, ny = dx / L;
      const gr = ctx.createLinearGradient(x, trussY, ex, ey); gr.addColorStop(0, "rgba(255,226,170,0.55)"); gr.addColorStop(1, "rgba(255,190,110,0.02)");
      ctx.fillStyle = gr; ctx.beginPath();
      ctx.moveTo(x + nx * w0, trussY + ny * w0); ctx.lineTo(ex + nx * w1, ey + ny * w1); ctx.lineTo(ex - nx * w1, ey - ny * w1); ctx.lineTo(x - nx * w0, trussY - ny * w0); ctx.closePath(); ctx.fill();
      const sp = ctx.createRadialGradient(ex, Math.min(ey, floorY), 2, ex, Math.min(ey, floorY), w1 * 1.3); sp.addColorStop(0, "rgba(255,220,160,0.35)"); sp.addColorStop(1, "rgba(255,220,160,0)");
      ctx.fillStyle = sp; ctx.beginPath(); ctx.ellipse(ex, Math.min(ey, floorY), w1 * 1.3, w1 * 0.35, 0, 0, 2 * Math.PI); ctx.fill();
      ctx.globalCompositeOperation = "source-over"; ctx.fillStyle = "#3A4150"; ctx.fillRect(x - 9, trussY - 4, 18, 14); ctx.fillStyle = "#FFE2AA"; ctx.beginPath(); ctx.arc(x, trussY + 12, 4, 0, 2 * Math.PI); ctx.fill(); ctx.globalCompositeOperation = "lighter";
    }
    ctx.globalCompositeOperation = "source-over";
  }
  return { draw, fit };
}
