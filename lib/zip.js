/**
 * Minimal zip reader.
 *
 * The install wizard accepts a `.zip` skill package — most often a GitHub
 * "Download ZIP", but also whatever a user zipped themselves — and reading one
 * directly keeps this plugin free of runtime dependencies, for the same reason
 * `lib/tar.js` reads tarballs by hand.
 *
 * Only the two compression methods real archives use are handled: stored (`0`)
 * and raw deflate (`8`). Encryption and ZIP64 are refused loudly instead of
 * being half-read, symlink entries are skipped rather than materialized as a
 * file holding their target, and every path is checked against traversal before
 * it is handed back to the caller. A damaged archive comes back as `errors`
 * rather than as a throw, matching {@link extractTarGz} so both formats feed
 * the same install path.
 *
 * @module dsh-skill-hub/lib/zip
 */
import { inflateRawSync } from 'node:zlib';
import { unsafeReason } from './tar.js';

/** End of central directory record. */
const EOCD_SIGNATURE = 0x06054b50;
/** Bytes in that record without its trailing comment. */
const EOCD_MIN = 22;
/** Central directory file header. */
const CENTRAL_SIGNATURE = 0x02014b50;
/** Local file header. */
const LOCAL_SIGNATURE = 0x04034b50;
/** Largest comment the record can carry, which bounds the backwards search. */
const MAX_COMMENT = 0xffff;
/** The `0xffffffff` marker that means "the real value is in a ZIP64 record". */
const ZIP64_MARKER = 0xffffffff;
/** Largest archive this module will inflate, in bytes. */
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;

/** One human-readable line for an unknown thrown value. */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Locate the end-of-central-directory record.
 *
 * It sits at the very end of the file unless a comment follows it, so the
 * search walks backwards over the largest comment a zip can hold.
 * @param buffer - the whole file.
 * @returns its offset, or -1.
 */
function findEocd(buffer) {
  const lowest = Math.max(0, buffer.length - MAX_COMMENT - EOCD_MIN);
  for (let offset = buffer.length - EOCD_MIN; offset >= lowest; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) return offset;
  }
  return -1;
}

/**
 * Normalize an archive entry name for the rest of the plugin.
 *
 * Tools on Windows write `\` separators, and `findSkills` matches `/`.
 * @param name - the raw entry name.
 * @returns the name with `/` separators.
 */
function normalizeName(name) {
  return name.replace(/\\/g, '/');
}

/**
 * Inflate and read a `.zip` archive.
 *
 * @param bytes - the archive bytes.
 * @param options - `{ maxBytes }`, the total inflated size to accept.
 * @returns `{ entries, skipped, errors }`, where each entry is
 *   `{ path, type, data }` — the shape {@link extractTarGz} returns.
 */
export function extractZip(bytes, options = {}) {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const errors = [];
  const skipped = [];
  const entries = [];
  if (bytes.length < EOCD_MIN) return { entries, skipped, errors: ['not a readable zip archive: too short'] };
  const eocd = findEocd(bytes);
  if (eocd === -1) return { entries, skipped, errors: ['not a readable zip archive: no end-of-central-directory record'] };

  const count = bytes.readUInt16LE(eocd + 10);
  const directorySize = bytes.readUInt32LE(eocd + 12);
  const directoryOffset = bytes.readUInt32LE(eocd + 16);
  if (count === 0xffff || directoryOffset === ZIP64_MARKER || directorySize === ZIP64_MARKER) {
    return { entries, skipped, errors: ['ZIP64 archives are not supported'] };
  }
  if (directoryOffset + directorySize > bytes.length) {
    return { entries, skipped, errors: ['the central directory lies outside the file'] };
  }

  let offset = directoryOffset;
  let total = 0;
  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > bytes.length || bytes.readUInt32LE(offset) !== CENTRAL_SIGNATURE) {
      errors.push(`central directory entry ${index + 1} is truncated`);
      break;
    }
    const flags = bytes.readUInt16LE(offset + 8);
    const method = bytes.readUInt16LE(offset + 10);
    /* The central directory holds the authoritative sizes even when the local
       header defers them to a trailing data descriptor (flag bit 3). */
    const compressedSize = bytes.readUInt32LE(offset + 20);
    const uncompressedSize = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    /* The Unix mode lives in the high half of the external attributes, and is 0
       for archives written by DOS tools, which store attribute bits there. */
    const unixMode = (bytes.readUInt32LE(offset + 38) >>> 16) & 0xffff;
    const localOffset = bytes.readUInt32LE(offset + 42);
    const name = normalizeName(bytes.subarray(offset + 46, offset + 46 + nameLength).toString('utf8'));
    offset += 46 + nameLength + extraLength + commentLength;

    if ((flags & 0x1) !== 0) {
      skipped.push(`${name} (encrypted)`);
      continue;
    }
    const path = name.replace(/\/+$/, '');
    const reason = unsafeReason(path);
    if (reason !== undefined) {
      skipped.push(`${path} (${reason})`);
      continue;
    }
    if (name.endsWith('/') || (unixMode & 0xf000) === 0x4000) {
      entries.push({ path, type: 'dir', data: Buffer.alloc(0) });
      continue;
    }
    /* Anything that is not a regular file or a directory is reported, never
       materialized: a symlink entry's data is its target, not content. */
    const kind = unixMode & 0xf000;
    if (kind !== 0 && kind !== 0x8000) {
      skipped.push(`${path} (mode ${kind.toString(8)})`);
      continue;
    }
    /* Bound the work by what the archive declares before inflating anything. */
    total += uncompressedSize;
    if (total > maxBytes) {
      errors.push(`archive declares more than ${maxBytes} bytes`);
      break;
    }
    if (localOffset + 30 > bytes.length || bytes.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) {
      errors.push(`${path}: local header is missing or truncated`);
      continue;
    }
    const dataStart = localOffset + 30 + bytes.readUInt16LE(localOffset + 26) + bytes.readUInt16LE(localOffset + 28);
    if (dataStart + compressedSize > bytes.length) {
      errors.push(`${path}: data is truncated`);
      continue;
    }
    const data = bytes.subarray(dataStart, dataStart + compressedSize);
    let content;
    if (method === 0) {
      content = Buffer.from(data);
    } else if (method === 8) {
      try {
        content = inflateRawSync(data, { maxOutputLength: maxBytes });
      } catch (error) {
        errors.push(`${path}: ${messageOf(error)}`);
        continue;
      }
    } else {
      skipped.push(`${path} (compression method ${method})`);
      continue;
    }
    entries.push({ path, type: 'file', data: content });
  }
  return { entries, skipped, errors };
}

export { DEFAULT_MAX_BYTES };
