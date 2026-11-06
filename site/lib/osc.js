// Minimal OSC 1.0 message codec (int32 'i', float32 'f', string 's'), big-endian, 4-byte padded.
const pad4 = (n) => (n + 3) & ~3;
function strBytes(s) { const b = new TextEncoder().encode(s); const out = new Uint8Array(pad4(b.length + 1)); out.set(b); return out; }

export function encode(address, args = []) {
  const parts = [strBytes(address), strBytes("," + args.map((a) => a.type).join(""))];
  for (const a of args) {
    if (a.type === "s") parts.push(strBytes(a.value));
    else { const b = new Uint8Array(4), dv = new DataView(b.buffer); a.type === "i" ? dv.setInt32(0, a.value | 0) : dv.setFloat32(0, a.value); parts.push(b); }
  }
  const len = parts.reduce((s, p) => s + p.length, 0), out = new Uint8Array(len); let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export function decode(buf) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf), dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let o = 0;
  const str = () => { let e = o; while (u8[e] !== 0) e++; const s = new TextDecoder().decode(u8.subarray(o, e)); o = pad4(e + 1); return s; };
  const address = str(); const tags = str(); if (tags[0] !== ",") throw new Error("bad OSC type tag");
  const args = [];
  for (const t of tags.slice(1)) {
    if (t === "i") { args.push({ type: "i", value: dv.getInt32(o) }); o += 4; }
    else if (t === "f") { args.push({ type: "f", value: dv.getFloat32(o) }); o += 4; }
    else if (t === "s") args.push({ type: "s", value: str() });
    else throw new Error(`unsupported OSC type ${t}`);
  }
  return { address, args };
}
