/**
 * Minimal tar.gz reader.
 *
 * Installing a skill from a GitHub repository means reading the repository's
 * archive, and the archive formats GitHub serves (`codeload` tarballs, release
 * assets) are plain ustar with occasional GNU long-name and PAX path records.
 * That is a small enough subset to read directly, which keeps this plugin free
 * of runtime dependencies.
 *
 * Only regular files and directories are materialized; symbolic links, hard
 * links and device nodes are reported and skipped, and every path is checked
 * against traversal before it is handed back to the caller.
 *
 * @module dsh-skill-hub/lib/tar
 */
import { gunzipSync } from 'node:zlib';

/** Bytes in one tar block. */
const BLOCK = 512;
/** Largest archive this module will inflate, in bytes. */
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;

/** Read a NUL/space-terminated field. */
function readString(buffer, offset, length) {
  const slice = buffer.subarray(offset, offset + length);
  const end = slice.indexOf(0);
  return (end === -1 ? slice : slice.subarray(0, end)).toString('utf8').trim();
}

/** Read a numeric field in octal, or base-256 when the high bit is set. */
function readNumber(buffer, offset, length) {
  const slice = buffer.subarray(offset, offset + length);
  if (slice.length > 0 && (slice[0] & 0x80) !== 0) {
    let value = 0;
    for (const byte of slice) value = value * 256 + (byte & 0xff);
    return value;
  }
  const text = readString(buffer, offset, length);
  if (text === '') return 0;
  const parsed = Number.parseInt(text, 8);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Whether a block is entirely NUL (the archive's end marker). */
function isZeroBlock(block) {
  for (const byte of block) {
    if (byte !== 0) return false;
  }
  return true;
}

/** Parse a PAX extended-header payload into key/value pairs. */
function parsePax(data) {
  const record = {};
  const text = data.toString('utf8');
  let offset = 0;
  while (offset < text.length) {
    const space = text.indexOf(' ', offset);
    if (space === -1) break;
    const length = Number.parseInt(text.slice(offset, space), 10);
    if (!Number.isFinite(length) || length <= 0 || offset + length > text.length) break;
    const entry = text.slice(space + 1, offset + length).replace(/\n$/, '');
    const equals = entry.indexOf('=');
    if (equals > 0) record[entry.slice(0, equals)] = entry.slice(equals + 1);
    offset += length;
  }
  return record;
}

/**
 * Reject a path that would escape the destination.
 * @param path - archive path.
 * @returns the reason it is unsafe, or undefined.
 */
export function unsafeReason(path) {
  if (path === '') return 'empty path';
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path)) return 'absolute path';
  const parts = path.split('/');
  if (parts.includes('..')) return 'parent-directory segment';
  if (path.includes('\0')) return 'NUL byte';
  return undefined;
}

/**
 * Inflate and read a `.tar.gz` archive.
 *
 * @param gzipped - the archive bytes.
 * @param options - `{ strip, maxBytes }`; `strip` drops leading path components.
 * @returns `{ entries, skipped, errors }`, where each entry is `{ path, type, data }`.
 */
export function extractTarGz(gzipped, options = {}) {
  const strip = options.strip ?? 0;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const errors = [];
  const skipped = [];
  let tar;
  try {
    tar = gunzipSync(gzipped, { maxOutputLength: maxBytes });
  } catch (error) {
    return { entries: [], skipped, errors: [`not a readable gzip stream: ${error instanceof Error ? error.message : String(error)}`] };
  }
  const entries = [];
  let offset = 0;
  let pendingLongName;
  let pendingPax = {};
  while (offset + BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK);
    if (isZeroBlock(header)) break;
    const size = readNumber(header, 124, 12);
    const typeflag = header[156] === 0 ? '0' : String.fromCharCode(header[156]);
    const dataStart = offset + BLOCK;
    const data = tar.subarray(dataStart, dataStart + size);
    offset = dataStart + Math.ceil(size / BLOCK) * BLOCK;

    if (typeflag === 'L') {
      pendingLongName = data.toString('utf8').replace(/\0+$/, '');
      continue;
    }
    if (typeflag === 'x' || typeflag === 'g') {
      pendingPax = parsePax(data);
      continue;
    }

    const name = readString(header, 0, 100);
    const prefix = readString(header, 345, 155);
    let path = pendingPax.path ?? pendingLongName ?? (prefix === '' ? name : `${prefix}/${name}`);
    pendingLongName = undefined;
    pendingPax = {};

    const reason = unsafeReason(path);
    if (reason !== undefined) {
      skipped.push(`${path} (${reason})`);
      continue;
    }
    if (strip > 0) {
      const parts = path.split('/').filter((part) => part !== '');
      path = parts.slice(strip).join('/');
      if (path === '') continue;
    }
    if (typeflag === '5' || path.endsWith('/')) {
      entries.push({ path: path.replace(/\/+$/, ''), type: 'dir', data: Buffer.alloc(0) });
      continue;
    }
    if (typeflag === '0' || typeflag === '\0') {
      entries.push({ path, type: 'file', data: Buffer.from(data) });
      continue;
    }
    skipped.push(`${path} (type ${typeflag})`);
  }
  return { entries, skipped, errors };
}

/**
 * Pick the directories that hold a `SKILL.md`, as relative paths.
 *
 * A repository archive is a tree of arbitrary shape, so the useful unit is the
 * directory containing a skill rather than a hard-coded layout.
 *
 * @param entries - result of {@link extractTarGz}.
 * @returns `{ skills, roots }` — one entry per SKILL.md found, plus files that
 *   sit outside any skill directory, which the caller usually ignores.
 */
export function findSkills(entries) {
  const files = entries.filter((entry) => entry.type === 'file');
  const skills = [];
  for (const entry of files) {
    const match = /^(.*\/)?SKILL\.md$/.exec(entry.path);
    if (match === null) continue;
    const dir = (match[1] ?? '').replace(/\/$/, '');
    skills.push({ dir: dir === '' ? '.' : dir, entry });
  }
  const inSkill = (path) => skills.some((skill) => skill.dir === '.' || path.startsWith(`${skill.dir}/`));
  return { skills, roots: files.filter((entry) => !inSkill(entry.path)) };
}
