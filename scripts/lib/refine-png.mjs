// refine-png — the smallest PNG reader/writer the refine harness needs, and no dependency.
//
// WHY NOT A LIBRARY. The comparison has to run in `npm test`, on a machine with no
// browser downloaded and no network. A pixel comparator that needs a canvas needs a
// browser; an image library is a new engine dependency, and every dependency this repo
// takes is one every instance takes at its next pin bump. The subset below is small
// enough to read in one sitting: 8-bit, non-interlaced PNG, which is the only thing a
// browser screenshot ever is.
//
// WHAT IT REFUSES, LOUDLY. 16-bit samples, interlaced (Adam7) images, and palette
// images all throw by name rather than decoding to something plausible — a comparator
// fed a silently wrong decode reports a silently wrong number, which is the one failure
// this whole harness exists to prevent.

import zlib from "node:zlib";

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/** Bytes per pixel for the colour types this reader accepts. */
const CHANNELS = { 0: 1, 2: 3, 4: 2, 6: 4 };

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/**
 * Decode a PNG buffer to `{width, height, data}` where `data` is RGBA, 8 bits per
 * sample, row-major — the same shape a canvas ImageData carries.
 */
export function decodePng(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 8 || !buf.subarray(0, 8).equals(SIG)) {
    throw new Error("not a PNG (bad signature)");
  }
  let off = 8;
  let ihdr = null;
  const idat = [];
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("latin1", off + 4, off + 8);
    const body = buf.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") {
      ihdr = {
        width: body.readUInt32BE(0),
        height: body.readUInt32BE(4),
        bitDepth: body[8],
        colorType: body[9],
        compression: body[10],
        filter: body[11],
        interlace: body[12],
      };
    } else if (type === "IDAT") {
      idat.push(Buffer.from(body));
    } else if (type === "IEND") {
      break;
    }
    off += 12 + len;
  }
  if (!ihdr) throw new Error("PNG has no IHDR chunk");
  if (ihdr.bitDepth !== 8) throw new Error(`PNG bit depth ${ihdr.bitDepth} unsupported — this reader is 8-bit only`);
  if (ihdr.interlace !== 0) throw new Error("interlaced PNG unsupported — this reader reads non-interlaced only");
  if (!CHANNELS[ihdr.colorType]) throw new Error(`PNG colour type ${ihdr.colorType} unsupported (0, 2, 4 and 6 only)`);

  const { width, height, colorType } = ihdr;
  const ch = CHANNELS[colorType];
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * ch;
  if (raw.length < (stride + 1) * height) throw new Error("PNG pixel data is short — truncated file");

  // Unfilter in place into one contiguous buffer of native-channel samples.
  const flat = Buffer.alloc(stride * height);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const ft = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = flat.subarray(y * stride, (y + 1) * stride);
    for (let i = 0; i < stride; i++) {
      const x = line[i];
      const a = i >= ch ? out[i - ch] : 0;
      const b = prev[i];
      const c = i >= ch ? prev[i - ch] : 0;
      let v;
      switch (ft) {
        case 0: v = x; break;
        case 1: v = x + a; break;
        case 2: v = x + b; break;
        case 3: v = x + ((a + b) >> 1); break;
        case 4: v = x + paeth(a, b, c); break;
        default: throw new Error(`PNG filter type ${ft} is not one of the five defined ones`);
      }
      out[i] = v & 0xff;
    }
    prev = out;
  }

  // Widen to RGBA.
  const data = Buffer.alloc(width * height * 4);
  for (let p = 0; p < width * height; p++) {
    const s = p * ch, d = p * 4;
    if (colorType === 6) { data[d] = flat[s]; data[d + 1] = flat[s + 1]; data[d + 2] = flat[s + 2]; data[d + 3] = flat[s + 3]; }
    else if (colorType === 2) { data[d] = flat[s]; data[d + 1] = flat[s + 1]; data[d + 2] = flat[s + 2]; data[d + 3] = 255; }
    else if (colorType === 0) { data[d] = data[d + 1] = data[d + 2] = flat[s]; data[d + 3] = 255; }
    else { data[d] = data[d + 1] = data[d + 2] = flat[s]; data[d + 3] = flat[s + 1]; }
  }
  return { width, height, data };
}

function chunk(type, body) {
  const out = Buffer.alloc(body.length + 12);
  out.writeUInt32BE(body.length, 0);
  out.write(type, 4, "latin1");
  body.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + body.length)), 8 + body.length);
  return out;
}

/** Encode `{width, height, data}` (RGBA) back to a PNG buffer. Used for diff images and test fixtures. */
export function encodePng({ width, height, data }) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none — these images are written once and read once
    data.copy ? data.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
      : Buffer.from(data.subarray(y * stride, (y + 1) * stride)).copy(raw, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([SIG, chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
