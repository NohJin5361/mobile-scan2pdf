// Minimal ZIP writer (stored entries, UTF-8 names). JPEGs are already compressed, so
// "store" is both fastest and smallest.

let CRC_TABLE = null;

export function crc32(data) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const date = ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

/**
 * @param {Array<{name: string, data: Uint8Array, date?: Date}>} files
 * @returns {Uint8Array}
 */
export function buildZip(files) {
  const enc = new TextEncoder();
  const used = new Set();
  const entries = files.map((f) => {
    let name = f.name;
    // Keep names unique inside the archive.
    for (let k = 2; used.has(name); k++) name = f.name.replace(/(\.[^.]*)?$/, (ext) => ` (${k})${ext || ''}`);
    used.add(name);
    return { nameBytes: enc.encode(name), data: f.data, crc: crc32(f.data), ...dosDateTime(f.date || new Date()) };
  });
  let size = 22;
  for (const e of entries) size += 30 + e.nameBytes.length + e.data.length + 46 + e.nameBytes.length;
  const out = new Uint8Array(size);
  const dv = new DataView(out.buffer);
  let p = 0;
  const offsets = [];
  for (const e of entries) {
    offsets.push(p);
    dv.setUint32(p, 0x04034b50, true);
    dv.setUint16(p + 4, 20, true);
    dv.setUint16(p + 6, 0x0800, true); // UTF-8 names
    dv.setUint16(p + 8, 0, true); // stored
    dv.setUint16(p + 10, e.time, true);
    dv.setUint16(p + 12, e.date, true);
    dv.setUint32(p + 14, e.crc, true);
    dv.setUint32(p + 18, e.data.length, true);
    dv.setUint32(p + 22, e.data.length, true);
    dv.setUint16(p + 26, e.nameBytes.length, true);
    dv.setUint16(p + 28, 0, true);
    out.set(e.nameBytes, p + 30);
    p += 30 + e.nameBytes.length;
    out.set(e.data, p);
    p += e.data.length;
  }
  const cdStart = p;
  entries.forEach((e, i) => {
    dv.setUint32(p, 0x02014b50, true);
    dv.setUint16(p + 4, 20, true);
    dv.setUint16(p + 6, 20, true);
    dv.setUint16(p + 8, 0x0800, true);
    dv.setUint16(p + 10, 0, true);
    dv.setUint16(p + 12, e.time, true);
    dv.setUint16(p + 14, e.date, true);
    dv.setUint32(p + 16, e.crc, true);
    dv.setUint32(p + 20, e.data.length, true);
    dv.setUint32(p + 24, e.data.length, true);
    dv.setUint16(p + 28, e.nameBytes.length, true);
    // extra, comment, disk, internal attrs = 0; external attrs = 0
    dv.setUint32(p + 42, offsets[i], true);
    out.set(e.nameBytes, p + 46);
    p += 46 + e.nameBytes.length;
  });
  const cdSize = p - cdStart;
  dv.setUint32(p, 0x06054b50, true);
  dv.setUint16(p + 8, entries.length, true);
  dv.setUint16(p + 10, entries.length, true);
  dv.setUint32(p + 12, cdSize, true);
  dv.setUint32(p + 16, cdStart, true);
  return out;
}
