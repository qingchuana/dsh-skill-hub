/**
 * Unit tests for lib/tar.js — the hand-written tarball reader.
 *
 * Fixtures are built here block by block (the reader deliberately never trusts
 * the header checksum, so these stay short), which keeps the suite offline.
 *
 * Usage: node tools/test-tar.mjs
 */
import { gzipSync } from 'node:zlib';
import { extractTarGz, findSkills, unsafeReason } from '../lib/tar.js';

const BLOCK = 512;
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

/** Write a NUL-padded field. */
function field(buffer, offset, length, text) {
  buffer.write(text.slice(0, length), offset, 'utf8');
}

/** Write an octal field the way tar does. */
function octal(buffer, offset, length, value) {
  const text = `${value.toString(8).padStart(length - 1, '0')}\0`;
  buffer.write(text.slice(0, length), offset, 'ascii');
}

/**
 * Build one tar header block.
 * @param name - entry path.
 * @param size - payload length.
 * @param typeflag - ustar type flag.
 * @returns the 512-byte header.
 */
function header(name, size, typeflag) {
  const block = Buffer.alloc(BLOCK);
  field(block, 0, 100, name);
  octal(block, 100, 8, 0o644);
  octal(block, 108, 8, 0);
  octal(block, 116, 8, 0);
  octal(block, 124, 12, size);
  octal(block, 136, 12, 0);
  block.fill(0x20, 148, 156);
  block[156] = typeflag.charCodeAt(0);
  block.write('ustar\0', 257, 'ascii');
  block.write('00', 263, 'ascii');
  return block;
}

/** Pad a payload to a whole number of blocks. */
function pad(payload) {
  const remainder = payload.length % BLOCK;
  if (remainder === 0) return payload;
  return Buffer.concat([payload, Buffer.alloc(BLOCK - remainder)]);
}

/**
 * Build a tarball from a list of entries.
 * @param entries - `[{ name, data?, type? }]`.
 * @returns gzipped bytes.
 */
function tar(entries) {
  const parts = [];
  for (const entry of entries) {
    const data = Buffer.from(entry.data ?? '');
    const type = entry.type ?? '0';
    parts.push(header(entry.name, data.length, type));
    if (data.length > 0) parts.push(pad(data));
  }
  parts.push(Buffer.alloc(BLOCK * 2));
  return gzipSync(Buffer.concat(parts));
}

/** A PAX record for one path. */
function paxPath(path) {
  const body = `path=${path}\n`;
  const length = Buffer.byteLength(body) + String(Buffer.byteLength(body) + 2).length + 1;
  const record = `${String(length)} ${body}`;
  return Buffer.from(record, 'utf8');
}

/* ---------- unsafeReason ---------- */
{
  check('a relative path is safe', unsafeReason('skills/pdf/SKILL.md') === undefined);
  check('an empty path is refused', unsafeReason('') === 'empty path');
  check('an absolute path is refused', unsafeReason('/etc/passwd') === 'absolute path');
  check('a drive path is refused', unsafeReason('C:/Windows/win.ini') === 'absolute path');
  check('a parent segment is refused', unsafeReason('../evil') === 'parent-directory segment');
  check('a nested parent segment is refused', unsafeReason('a/../../b') === 'parent-directory segment');
  check('a NUL byte is refused', unsafeReason('a\0b') === 'NUL byte');
}

/* ---------- basic extraction ---------- */
{
  const archive = tar([
    { name: 'repo-main/', type: '5' },
    { name: 'repo-main/SKILL.md', data: '---\nname: demo\ndescription: d\n---\n' },
    { name: 'repo-main/lib/notes.txt', data: 'hello' },
  ]);
  const result = extractTarGz(archive);
  check('no errors are reported', result.errors.length === 0, result.errors.join('; '));
  check('nothing is skipped', result.skipped.length === 0, result.skipped.join('; '));
  const dir = result.entries.find((entry) => entry.type === 'dir');
  check('a directory entry is materialized', dir !== undefined);
  check('the directory name loses its trailing slash', dir?.path === 'repo-main', dir?.path);
  const file = result.entries.find((entry) => entry.path === 'repo-main/lib/notes.txt');
  check('a nested file is materialized', file?.type === 'file');
  check('the file contents survive', file?.data.toString() === 'hello', file?.data.toString());
}

/* ---------- strip ---------- */
{
  const archive = tar([{ name: 'repo-main/SKILL.md', data: 'x' }]);
  const stripped = extractTarGz(archive, { strip: 1 });
  check('strip drops a leading component', stripped.entries.some((entry) => entry.path === 'SKILL.md'));
  check('strip leaves nothing of the prefix', !stripped.entries.some((entry) => entry.path.startsWith('repo-main')));
}

/* ---------- PAX path ---------- */
{
  const longPath = `${'deep/'.repeat(30)}SKILL.md`;
  const pax = paxPath(longPath);
  const archive = gzipSync(
    Buffer.concat([
      header('PaxHeader', pax.length, 'x'),
      pad(pax),
      header('short-name', 1, '0'),
      pad(Buffer.from('y')),
      Buffer.alloc(BLOCK * 2),
    ]),
  );
  const result = extractTarGz(archive);
  check('a PAX path overrides the header name', result.entries.some((entry) => entry.path === longPath), result.entries.map((entry) => entry.path).join(','));
}

/* ---------- GNU long name ---------- */
{
  const longName = `${'d'.repeat(120)}/SKILL.md`;
  const longData = Buffer.from(`${longName}\0`, 'utf8');
  const archive = gzipSync(
    Buffer.concat([
      header('LongLink', longData.length, 'L'),
      pad(longData),
      header('short', 1, '0'),
      pad(Buffer.from('z')),
      Buffer.alloc(BLOCK * 2),
    ]),
  );
  const result = extractTarGz(archive);
  check('a GNU long name is applied', result.entries.some((entry) => entry.path === longName), result.entries.map((entry) => entry.path).join(','));
}

/* ---------- refused entry kinds ---------- */
{
  const archive = tar([
    { name: 'good.txt', data: 'ok' },
    { name: 'link', data: '', type: '2' },
    { name: '../escape.txt', data: 'no' },
  ]);
  const result = extractTarGz(archive);
  check('a symlink is skipped', result.skipped.some((entry) => entry.includes('link')), result.skipped.join('; '));
  check('a traversal path is skipped', result.skipped.some((entry) => entry.includes('parent-directory segment')), result.skipped.join('; '));
  check('the safe file still arrives', result.entries.some((entry) => entry.path === 'good.txt'));
  check('the traversal payload never becomes an entry', !result.entries.some((entry) => entry.path.includes('escape')));
}

/* ---------- damaged input ---------- */
{
  const result = extractTarGz(Buffer.from('not gzip at all', 'utf8'));
  check('a non-gzip stream is reported as an error', result.errors.length > 0 && result.errors[0].includes('gzip'));
  check('the damaged archive yields no entries', result.entries.length === 0);
}

/* ---------- findSkills ---------- */
{
  const nested = extractTarGz(
    tar([
      { name: 'repo-main/README.md', data: 'outside' },
      { name: 'repo-main/pdf/SKILL.md', data: 'pdf skill' },
      { name: 'repo-main/pdf/extra.md', data: 'inside pdf' },
      { name: 'repo-main/notes/todo.md', data: 'outside too' },
    ]),
  );
  const one = findSkills(nested.entries);
  check('one nested skill is found', one.skills.length === 1, String(one.skills.length));
  check('the skill directory is relative', one.skills[0]?.dir === 'repo-main/pdf', one.skills[0]?.dir);
  check('a file next to the skill is a root', one.roots.some((entry) => entry.path === 'repo-main/README.md'));
  check('a file inside the skill directory is not a root', !one.roots.some((entry) => entry.path === 'repo-main/pdf/extra.md'));
  check('an unrelated nested file is a root', one.roots.some((entry) => entry.path === 'repo-main/notes/todo.md'));
  check('every skill carries its SKILL.md entry', one.skills.every((skill) => skill.entry.path.endsWith('SKILL.md')));

  const atRoot = extractTarGz(tar([{ name: 'SKILL.md', data: 'root skill' }, { name: 'other.txt', data: 'x' }]));
  const root = findSkills(atRoot.entries);
  check('a root SKILL.md is reported as .', root.skills[0]?.dir === '.', root.skills[0]?.dir);
  check('a file beside a root skill is inside it', !root.roots.some((entry) => entry.path === 'other.txt'));
}

console.log(`# ${String(checks - failures)}/${String(checks)} tar checks passed`);
if (failures > 0) process.exit(1);
