// zip-store.mjs — one file, zipped, with its unix mode intact.
//
// WHY THIS EXISTS AT ALL. HTTP carries no file mode. A `.command` served as a plain
// download lands on the disk 0644, and Terminal refuses to run it — which is the one
// failure the macOS installer cannot recover from, because the person it is written for
// has no terminal to `chmod` from. A ZIP entry DOES carry a mode: the central directory's
// `external file attributes` hold it, and they are honoured when `version made by` says
// the archive was made on Unix. Both `unzip` and macOS's own Archive Utility restore it.
// So the download is a zip holding exactly one file, and unpacking it leaves an
// executable `.command` the person can open.
//
// WHY IT IS WRITTEN OUT BY HAND. It is a hundred lines of header fields and a CRC, and
// the alternative is a dependency in the request path of a Worker that has none. STORE
// (no compression) is deliberate on top of that: the payload is a few kilobytes of shell
// script, DEFLATE would mean shipping a compressor, and an uncompressed entry leaves the
// script legible in the archive's own bytes — which is what lets a caller assert on what
// it is about to serve without unzipping it first.
//
// WHAT IT IS NOT. One entry, no directories, no zip64, no encryption, no archive comment.
// A second entry is a second set of decisions (ordering, offsets, the directory walk) and
// there has never been a second file to ship. Grow it deliberately or not at all.
//
// The CRC is computed without a lookup table on purpose: a 256-entry table is module-scope
// state in a module that otherwise has none, and the inputs here are kilobytes.

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c ^= bytes[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * A ZIP archive holding one stored (uncompressed) file, carrying its unix mode.
 *
 * @param {object} o
 * @param {string} o.name    the entry's name inside the archive — what unpacking writes.
 * @param {Uint8Array|string} o.bytes  the file's contents.
 * @param {number} [o.mode]  the unix mode to restore, default 0o755 (executable).
 * @param {Date}   [o.mtime] the entry's timestamp; DOS dates start at 1980, so anything
 *   earlier (or unusable) is clamped there rather than wrapping into a negative year.
 * @returns {Uint8Array} the archive.
 */
export function zipSingleFile({ name, bytes, mode = 0o755, mtime = new Date() } = {}) {
  const enc = new TextEncoder();
  const nameBytes = enc.encode(String(name || ""));
  if (!nameBytes.length) throw new Error("zipSingleFile: an entry name is required");
  const data = bytes instanceof Uint8Array
    ? bytes
    : enc.encode(String(bytes === undefined || bytes === null ? "" : bytes));
  const crc = crc32(data);
  // Bit 11 declares the name is UTF-8. Set only when it has to be: an ASCII name means
  // the same archive whatever writes it, which keeps a byte-for-byte comparison honest.
  const flags = nameBytes.some((b) => b > 0x7f) ? 0x0800 : 0;
  const when = mtime instanceof Date && !Number.isNaN(mtime.getTime()) && mtime.getFullYear() >= 1980
    ? mtime
    : new Date(Date.UTC(1980, 0, 1));
  const time = ((when.getHours() << 11) | (when.getMinutes() << 5) | (when.getSeconds() >> 1)) & 0xffff;
  const date = ((((when.getFullYear() - 1980) & 0x7f) << 9) | ((when.getMonth() + 1) << 5) | when.getDate()) & 0xffff;

  const localSize = 30 + nameBytes.length;
  const centralSize = 46 + nameBytes.length;
  const out = new Uint8Array(localSize + data.length + centralSize + 22);
  const view = new DataView(out.buffer);

  // ── local file header ──
  view.setUint32(0, 0x04034b50, true);
  view.setUint16(4, 20, true);          // version needed to extract: 2.0
  view.setUint16(6, flags, true);
  view.setUint16(8, 0, true);           // method 0 = stored
  view.setUint16(10, time, true);
  view.setUint16(12, date, true);
  view.setUint32(14, crc, true);
  view.setUint32(18, data.length, true);
  view.setUint32(22, data.length, true);
  view.setUint16(26, nameBytes.length, true);
  view.setUint16(28, 0, true);          // extra field length
  out.set(nameBytes, 30);
  out.set(data, localSize);

  // ── central directory ──
  const cd = localSize + data.length;
  view.setUint32(cd, 0x02014b50, true);
  view.setUint16(cd + 4, (3 << 8) | 20, true); // version made by: upper byte 3 = Unix
  view.setUint16(cd + 6, 20, true);
  view.setUint16(cd + 8, flags, true);
  view.setUint16(cd + 10, 0, true);
  view.setUint16(cd + 12, time, true);
  view.setUint16(cd + 14, date, true);
  view.setUint32(cd + 16, crc, true);
  view.setUint32(cd + 20, data.length, true);
  view.setUint32(cd + 24, data.length, true);
  view.setUint16(cd + 28, nameBytes.length, true);
  view.setUint16(cd + 30, 0, true);     // extra field length
  view.setUint16(cd + 32, 0, true);     // file comment length
  view.setUint16(cd + 34, 0, true);     // disk number start
  view.setUint16(cd + 36, 0, true);     // internal file attributes
  // The whole point of the module: the mode, in the high 16 bits, with S_IFREG (0o100000)
  // so the entry reads as a regular file rather than as one with no type at all.
  view.setUint32(cd + 38, ((mode | 0o100000) << 16) >>> 0, true);
  view.setUint32(cd + 42, 0, true);     // relative offset of the local header
  out.set(nameBytes, cd + 46);

  // ── end of central directory ──
  const eo = cd + centralSize;
  view.setUint32(eo, 0x06054b50, true);
  view.setUint16(eo + 4, 0, true);      // this disk
  view.setUint16(eo + 6, 0, true);      // disk holding the central directory
  view.setUint16(eo + 8, 1, true);      // entries on this disk
  view.setUint16(eo + 10, 1, true);     // entries in total
  view.setUint32(eo + 12, centralSize, true);
  view.setUint32(eo + 16, cd, true);
  view.setUint16(eo + 20, 0, true);     // archive comment length

  return out;
}
