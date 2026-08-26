// kv-codec — how a KV value survives being written into a JSON backup, and how a
// restore reads one back.
//
// THE BUG THIS EXISTS TO CLOSE. Every export path used to read a value as TEXT —
// `kv.get(name, "text")` in the worker, `res.text()` over the REST API, `jq --rawfile`
// in a workflow. KV values are BYTES, and the canvas stores pasted board images raw
// under `basset:<sha256-prefix>`. A JPEG is not valid UTF-8, so every invalid sequence
// became U+FFFD on the way in and no re-encoding ever brought it back: a 75,963-byte
// image came out of the copy as 137,439 bytes of different data, a third of its
// characters replacement characters, no longer matching the content-addressed key it
// was stored under. That is worse than a short backup, twice over. The copy is
// confidently WRONG rather than visibly missing, so nothing looks broken until someone
// restores. And a restore writes the garbage back under the content-addressed key, after
// which the canvas client SKIPS re-uploading the real image because the key exists — so
// the image is lost a second time, by the repair.
//
// THE FORMAT (`format: 2`). A value in `data` is EITHER:
//
//   a JSON string  — the value's bytes, which are valid UTF-8 text. Unchanged from
//                    format 1, so every value a format-1 copy holds still reads.
//   {"b64": "…"}   — the value's bytes, base64. Written whenever the bytes are not
//                    valid UTF-8, i.e. whenever a string could not carry them.
//
// The marker is an OBJECT rather than a prefixed string on purpose: `data` values have
// always been strings, so an object cannot collide with a real value, and a reader that
// predates the marker gets something it cannot write rather than something plausible.
// Detection is per value, so a reader needs no version negotiation — a copy taken before
// this existed and one taken after are read by the same code.
//
// WHAT DECIDES. `TextDecoder` with `fatal: true` — the exact question "do these bytes
// round-trip as text", asked of the bytes rather than guessed from the key name or a
// content type. `ignoreBOM: true` matters as much as `fatal`: without it the decoder
// SWALLOWS a leading U+FEFF, which is valid UTF-8 that would come back one BOM shorter.
//
// A NOTE ON `bytes`. Byte counts here are byte counts. The old envelope reported
// `v.length` on a decoded string, which undercounts every non-ASCII value and was
// nonsense for a binary one.

export const KV_BACKUP_FORMAT = 2;

// The one field name in the marker. Kept as a constant so the encoder, the decoder and
// the detector cannot drift apart, and so a grep for it finds all three.
const B64_FIELD = "b64";

// Content-addressed key schemes. Today there is exactly one: the canvas board assets the
// worker stores under the first 40 hex characters of the SHA-256 of the image bytes
// (`ASSET_PREFIX` + hash in src/_worker.js). The key IS the checksum, which is what lets
// a restore prove a value is intact without having anything to compare it against.
const CONTENT_ADDRESSED = /^basset:([0-9a-f]{40})$/;

const toBytes = (v) => (v instanceof Uint8Array ? v : new Uint8Array(v));

/**
 * The bytes as JSON: a string when they are text, the base64 marker when they are not.
 * @param {Uint8Array|ArrayBuffer} value
 * @returns {string|{b64: string}}
 */
export function encodeKvValue(value) {
  const bytes = toBytes(value);
  try {
    // fatal → throws rather than substituting U+FFFD. ignoreBOM → a leading U+FEFF is
    // returned rather than eaten, so a decode/encode round trip is byte-exact.
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch (e) {
    return { [B64_FIELD]: bytesToBase64(bytes) };
  }
}

/** True when this JSON value is the base64 marker rather than a plain text value. */
export function isBinaryKvValue(v) {
  return !!v && typeof v === "object" && !Array.isArray(v) && typeof v[B64_FIELD] === "string";
}

/**
 * The bytes a backup value stands for. Throws on anything that is neither a string nor
 * the marker — a restore must stop on a value it does not understand rather than write
 * its best guess.
 * @param {string|{b64: string}} v
 * @returns {Uint8Array}
 */
export function decodeKvValue(v) {
  if (typeof v === "string") return new TextEncoder().encode(v);
  if (isBinaryKvValue(v)) return base64ToBytes(v[B64_FIELD]);
  throw new Error(`unreadable backup value: expected a string or {"${B64_FIELD}": "…"}, got ${Array.isArray(v) ? "an array" : typeof v}`);
}

/** The hash a content-addressed key promises, or null if the key promises nothing. */
export function contentAddressOf(key) {
  const m = CONTENT_ADDRESSED.exec(String(key || ""));
  return m ? m[1] : null;
}

/**
 * Does this value match the checksum its own key name carries?
 *   true  — it does
 *   false — it does NOT: the value under this key is not the value that was stored
 *   null  — the key is not content-addressed, so there is nothing to check
 * @param {string} key
 * @param {Uint8Array|ArrayBuffer} value
 */
export async function contentAddressMatches(key, value) {
  const want = contentAddressOf(key);
  if (!want) return null;
  return (await sha256Hex(toBytes(value))).slice(0, want.length) === want;
}

export async function sha256Hex(value) {
  const bytes = toBytes(value);
  // A Uint8Array view may sit on a larger buffer; hand digest() exactly these bytes.
  const digest = await crypto.subtle.digest("SHA-256", bytes.slice().buffer);
  let out = "";
  for (const b of new Uint8Array(digest)) out += b.toString(16).padStart(2, "0");
  return out;
}

// btoa/atob are the only base64 both a Worker and Node have without an import, and both
// speak binary strings, so the bytes go through String.fromCharCode. In CHUNKS: spreading
// a multi-megabyte array into apply() overflows the stack, which would turn a large image
// into an export failure instead of a base64 string.
export function bytesToBase64(value) {
  const bytes = toBytes(value);
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export function base64ToBytes(b64) {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
