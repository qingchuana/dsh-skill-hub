/**
 * Unit tests for lib/zip.js — the hand-written zip reader.
 *
 * Fixtures are assembled byte by byte so the suite stays offline and every
 * branch the reader documents (stored/deflate, directories, traversal,
 * encryption, ZIP64) can be reached on purpose.
 *
 * Usage: node tools/test-zip.mjs
 */
import { deflateRawSync } from 'node:zlib';
import { extractZip } from '../lib/zip.js';

let checks = 0;
let failures = 0;

/** Assert one expectation. */
function check(name, condition, detail = '') {
  checks += 1;
  if (!condition) {
    failures += 1;
    console.error(`not ok ${String(checks)} - ${name}${detail === '' ? '' : ` (${detail})`}`);
  }
}

/**
 * Build a zip archive.
 * @param entries - `[{ name, data?, compress?, flags?, unixMode?, method? }]`.
 * @returns the archive bytes.
 */
function makeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const raw = Buffer.from(entry.data ?? '', 'utf8');
    const method = entry.method ?? (entry.compress === false ? 0 : 8);
    const body = method === 8 ? deflateRawSync(raw) : raw;
    const flags = entry.flags ?? 0;
    const unixMode = entry.unixMode ?? 0x81a4; /* 100644 */

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x031e, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt32LE((unixMode << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += 30 + name.length + body.length;
  }
  const localBytes = Buffer.concat(locals);
  const centralBytes = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBytes.length, 12);
  eocd.writeUInt32LE(localBytes.length, 16);
  return Buffer.concat([localBytes, centralBytes, eocd]);
}

/* ---------- stored and deflated entries ---------- */
{
  const archive = makeZip([
    { name: 'SKILL.md', data: '---\nname: demo\n---\n', compress: false },
    { name: 'lib/notes.txt', data: 'compressed body' },
  ]);
  const result = extractZip(archive);
  check('no errors are reported', result.errors.length === 0, result.errors.join('; '));
  check('nothing is skipped', result.skipped.length === 0, result.skipped.join('; '));
  const stored = result.entries.find((entry) => entry.path === 'SKILL.md');
  check('a stored entry decodes', stored?.data.toString() === '---\nname: demo\n---\n', stored?.data.toString());
  const deflated = result.entries.find((entry) => entry.path === 'lib/notes.txt');
  check('a deflated entry inflates', deflated?.data.toString() === 'compressed body', deflated?.data.toString());
  check('a file entry is typed file', deflated?.type === 'file');
}

/* ---------- directories ---------- */
{
  const archive = makeZip([
    { name: 'pkg/', data: '', compress: false, unixMode: 0x41ed /* 40755 */ },
    { name: 'pkg/SKILL.md', data: 'x', compress: false },
  ]);
  const result = extractZip(archive);
  const dir = result.entries.find((entry) => entry.type === 'dir');
  check('a trailing slash makes a directory', dir !== undefined);
  check('the directory name loses the slash', dir?.path === 'pkg', dir?.path);
  check('a file entry inside it survives', result.entries.some((entry) => entry.path === 'pkg/SKILL.md'));
}

/* ---------- Windows separators ---------- */
{
  const archive = makeZip([{ name: 'a\\b\\SKILL.md', data: 'x', compress: false }]);
  const result = extractZip(archive);
  check('backslashes are normalized to slashes', result.entries.some((entry) => entry.path === 'a/b/SKILL.md'), result.entries.map((entry) => entry.path).join(','));
}

/* ---------- refusals ---------- */
{
  const traversal = extractZip(makeZip([{ name: '../evil.sh', data: 'no', compress: false }]));
  check('a traversal entry is skipped', traversal.skipped.some((entry) => entry.includes('parent-directory segment')), traversal.skipped.join('; '));
  check('a traversal entry never materializes', traversal.entries.length === 0);

  const encrypted = extractZip(makeZip([{ name: 'secret.txt', data: 'x', flags: 0x1, compress: false }]));
  check('an encrypted entry is skipped', encrypted.skipped.some((entry) => entry.includes('encrypted')), encrypted.skipped.join('; '));

  const unsupported = extractZip(makeZip([{ name: 'weird.bin', data: 'x', method: 12 }]));
  check('an unknown compression method is skipped', unsupported.skipped.some((entry) => entry.includes('compression method 12')), unsupported.skipped.join('; '));

  const symlink = extractZip(makeZip([{ name: 'link', data: 'target', compress: false, unixMode: 0xa1ff /* 120777 */ }]));
  check('a symlink entry is skipped', symlink.skipped.some((entry) => entry.includes('link')), symlink.skipped.join('; '));
}

/* ---------- damaged archives ---------- */
{
  const short = extractZip(Buffer.alloc(4));
  check('a tiny file is refused', short.errors[0]?.includes('too short'), short.errors.join('; '));

  const noEocd = extractZip(Buffer.concat([Buffer.alloc(64), Buffer.from('nope')]));
  check('a missing EOCD is reported', noEocd.errors[0]?.includes('end-of-central-directory'), noEocd.errors.join('; '));

  const truncated = makeZip([{ name: 'SKILL.md', data: 'x', compress: false }]);
  const cut = truncated.subarray(0, truncated.length - 40);
  const result = extractZip(cut);
  check('a truncated archive reports an error', result.errors.length > 0, result.errors.join('; '));
}

/* ---------- size cap ---------- */
{
  const archive = makeZip([{ name: 'big.txt', data: 'hello world', compress: false }]);
  const capped = extractZip(archive, { maxBytes: 4 });
  check('an entry past maxBytes is refused', capped.errors.some((entry) => entry.includes('more than 4 bytes')), capped.errors.join('; '));
  check('nothing is returned once the cap trips', capped.entries.length === 0);
}

console.log(`# ${String(checks - failures)}/${String(checks)} zip checks passed`);
if (failures > 0) process.exit(1);
