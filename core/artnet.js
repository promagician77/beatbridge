// Art-Net ArtDmx (OpCode 0x5000) build/parse: used to watch Onyx's own DMX output while
// calibrating the FX-speed fader.
const ID = [0x41, 0x72, 0x74, 0x2d, 0x4e, 0x65, 0x74, 0x00]; // "Art-Net\0"

export function buildArtDmx(universe, data, seq = 0) {
  const len = Math.max(2, data.length + (data.length & 1)), b = new Uint8Array(18 + len);
  b.set(ID, 0); b[8] = 0x00; b[9] = 0x50;          // OpCode 0x5000, little-endian
  b[10] = 0; b[11] = 14;                            // protocol version 14
  b[12] = seq & 0xff; b[13] = 0;                    // sequence, physical
  b[14] = universe & 0xff; b[15] = (universe >> 8) & 0x7f; // SubUni, Net
  b[16] = (len >> 8) & 0xff; b[17] = len & 0xff;   // length, big-endian
  b.set(data, 18); return b;
}

export function parseArtDmx(buf) {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (b.length < 18) return null;
  for (let i = 0; i < 8; i++) if (b[i] !== ID[i]) return null;
  if (b[8] !== 0x00 || b[9] !== 0x50) return null;
  const universe = b[14] | (b[15] << 8), len = (b[16] << 8) | b[17];
  return { universe, seq: b[12], data: b.subarray(18, 18 + len) };
}

// Period of a periodic DMX channel trace [[tMs, value], ...]: median time between rising
// crossings of the mean, with hysteresis so noise doesn't add crossings.
export function periodOf(trace, hyst = 4) {
  if (trace.length < 8) return null;
  const mean = trace.reduce((s, [, v]) => s + v, 0) / trace.length;
  let armed = false; const ups = [];
  for (let i = 1; i < trace.length; i++) {
    const [t0, v0] = trace[i - 1], [t1, v1] = trace[i];
    if (v1 < mean - hyst) armed = true;
    if (armed && v0 < mean && v1 >= mean) { ups.push(t0 + ((mean - v0) / (v1 - v0 || 1)) * (t1 - t0)); armed = false; }
  }
  if (ups.length < 3) return null;
  const d = ups.slice(1).map((t, i) => t - ups[i]).sort((a, b) => a - b);
  return d[Math.floor(d.length / 2)];
}
