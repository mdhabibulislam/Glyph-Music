// A tiny ZIP writer for the browser. Files are stored without compression (MP3s are
// already compressed) and the archive is assembled from Blobs, so the browser can keep
// the data on disk instead of in memory.

const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** Incremental CRC-32. Start with 0 and pass the previous result back in. */
export function crc32(chunk: Uint8Array, previous = 0): number {
  let c = ~previous >>> 0;
  for (let i = 0; i < chunk.length; i++) c = TABLE[(c ^ chunk[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

export interface ZipEntry {
  name: string;
  data: Blob;
  /** CRC-32 of the data, if already known (saves reading the file again). */
  crc?: number;
}

const LIMIT = 0xffffffff;

export async function buildZip(entries: ZipEntry[]): Promise<Blob> {
  const encoder = new TextEncoder();
  const now = new Date();
  const time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const parts: BlobPart[] = [];
  const central: BlobPart[] = [];
  let centralSize = 0;
  let offset = 0;
  if (entries.length > 65000) throw new Error("Too many files for one ZIP.");

  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const size = entry.data.size;
    const crc = entry.crc ?? crc32(new Uint8Array(await entry.data.arrayBuffer()));
    if (offset + size > LIMIT - 1024 * 1024) throw new Error("This ZIP would be larger than 4 GB. Download it in smaller parts.");

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true); // UTF-8 names
    local.setUint16(8, 0, true); // stored
    local.setUint16(10, time, true);
    local.setUint16(12, date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, size, true);
    local.setUint32(22, size, true);
    local.setUint16(26, name.length, true);
    parts.push(local.buffer, name.buffer as ArrayBuffer, entry.data);

    const dir = new DataView(new ArrayBuffer(46));
    dir.setUint32(0, 0x02014b50, true);
    dir.setUint16(4, 20, true);
    dir.setUint16(6, 20, true);
    dir.setUint16(8, 0x0800, true);
    dir.setUint16(10, 0, true);
    dir.setUint16(12, time, true);
    dir.setUint16(14, date, true);
    dir.setUint32(16, crc, true);
    dir.setUint32(20, size, true);
    dir.setUint32(24, size, true);
    dir.setUint16(28, name.length, true);
    dir.setUint32(42, offset, true);
    central.push(dir.buffer, name.buffer as ArrayBuffer);
    centralSize += 46 + name.length;
    offset += 30 + name.length + size;
  }

  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end.buffer], { type: "application/zip" });
}
