/**
 * Frontmatter surgery for `SKILL.md`.
 *
 * Deliberately not a YAML parser: this module only ever needs to READ the
 * identity fields of a skill and to change one scalar without disturbing the
 * rest of the document. Every edit is therefore line-local — a key's own line
 * span is replaced or removed and nothing else in the file is re-serialized —
 * so unknown keys, comments, ordering and the author's own quoting style all
 * survive a round trip.
 *
 * Handles the subset real SKILL.md files use: plain and quoted scalars, block
 * scalars (`|`, `>`, with `-`/`+` chomping), one level of nesting, and simple
 * `- item` lists. Line endings are detected and preserved.
 *
 * @module dsh-skill-hub/lib/frontmatter
 */

/** Name grammar the skill scanner accepts. */
const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** Longest accepted skill name. */
const MAX_NAME_LENGTH = 64;
/** Longest accepted description. */
const MAX_DESCRIPTION_LENGTH = 1024;
/** Keys whose value is a scalar this module understands. */
const SCALAR_KEYS = new Set(['name', 'description', 'whenToUse', 'disable-model-invocation', 'user-invocable']);

/**
 * Split text into lines, remembering which ending it used.
 * @param text - raw file text.
 * @returns the lines and the dominant line ending.
 */
function splitLines(text) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  return { lines: text.split(/\r?\n/), eol };
}

/** Index of a frontmatter delimiter line, or -1. */
function isDelimiter(line) {
  const trimmed = line.trim();
  return trimmed === '---' || trimmed === '...';
}

/**
 * Locate the frontmatter block.
 * @param lines - file lines.
 * @returns `{ start, end }` line indexes of the delimiters, or undefined.
 */
function blockBounds(lines) {
  if (lines.length === 0 || lines[0].trim() !== '---') return undefined;
  for (let index = 1; index < lines.length; index += 1) {
    if (isDelimiter(lines[index])) return { start: 0, end: index };
  }
  return undefined;
}

/** Leading whitespace width of a line. */
function indentOf(line) {
  const match = /^[ \t]*/.exec(line);
  return match === null ? 0 : match[0].length;
}

/** Whether a line is blank or a full-line comment. */
function isSkippable(line) {
  const trimmed = line.trim();
  return trimmed === '' || trimmed.startsWith('#');
}

/** Interpret a scalar's source text. */
function decodeScalar(raw) {
  const text = raw.trim();
  if (text === '') return '';
  if ((text.startsWith('"') && text.endsWith('"') && text.length > 1) || (text.startsWith("'") && text.endsWith("'") && text.length > 1)) {
    return text.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (text === 'null' || text === '~') return null;
  return text;
}

/**
 * Boolean interpretation matching the scanner's own `frontmatterBoolean`.
 *
 * The scanner accepts `true/yes/on/1` and `false/no/off/0` and throws on
 * anything else. An unrecognised value is reported as "not set" here rather
 * than throwing, because this module only reads; the plugin never rewrites a
 * value it did not understand.
 */
function truthy(value) {
  if (value === true || value === 1) return true;
  if (typeof value !== 'string') return false;
  return ['true', 'yes', 'on', '1'].includes(value.toLowerCase());
}

/** Boolean interpretation matching the scanner's own `frontmatterBoolean`. */
function falsy(value) {
  if (value === false || value === 0) return true;
  if (typeof value !== 'string') return false;
  return ['false', 'no', 'off', '0'].includes(value.toLowerCase());
}

/**
 * The invocation policy a document's frontmatter expresses, on its own.
 *
 * This is what the *file* says, which is not always what the registry reports:
 * another provider may override `invocation` for a skill it manages by name.
 * Keeping the two apart is what lets the settings page show a skill as enabled
 * while warning that the registry disagrees.
 *
 * @param text - `SKILL.md` contents.
 * @returns `{ modelInvocable, userInvocable, hasFrontmatter }`.
 */
export function invocationOf(text) {
  const parsed = parseSkill(text);
  if (!parsed.hasFrontmatter) return { modelInvocable: true, userInvocable: true, hasFrontmatter: false };
  return {
    modelInvocable: parsed.flags.modelDisabled !== true,
    userInvocable: parsed.flags.userDisabled !== true,
    hasFrontmatter: true,
  };
}

/**
 * Read one top-level key's line span and decoded value.
 *
 * A key's span covers its own line plus every following line that is blank or
 * indented deeper, which is exactly what a nested map, a block scalar or a list
 * occupies — so replacing the span replaces the whole value.
 *
 * @param lines - frontmatter lines (without delimiters).
 * @param offset - line number of the first frontmatter line in the file.
 * @param key - top-level key to find.
 * @returns `{ start, end, raw, value, style }` or undefined.
 */
function findKey(lines, offset, key) {
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (isSkippable(line) || indentOf(line) !== 0) continue;
    const match = /^([A-Za-z0-9_-]+)[ \t]*:(.*)$/.exec(line);
    if (match === null || match[1] !== key) continue;
    const inline = match[2];
    const trimmedInline = inline.trim();
    /* A block scalar indicator means the value lives on the INDENTED LINES
       BELOW the key, exactly like an empty inline value does. */
    const isBlock = /^[|>][+-]?[0-9]?$/.test(trimmedInline);
    let end = index;
    if (trimmedInline === '' || isBlock) {
      while (end + 1 < lines.length) {
        const next = lines[end + 1];
        if (next.trim() !== '' && indentOf(next) === 0) break;
        end += 1;
      }
    }
    const body = lines.slice(index + 1, end + 1);
    if (isBlock) {
      const indents = body.filter((entry) => entry.trim() !== '').map(indentOf);
      const base = indents.length === 0 ? 0 : Math.min(...indents);
      const raw = body.map((entry) => entry.slice(Math.min(base, indentOf(entry)))).join('\n');
      const folded = trimmedInline.startsWith('>');
      /* Trailing newlines are chomping detail with no meaning for a skill's
         identity fields, so both styles report the same trimmed text. */
      const value = (folded ? raw.replace(/\n(?!$)/g, ' ') : raw).replace(/\n+$/, '');
      return { start: offset + index, end: offset + end, raw: inline, value, style: 'block' };
    }
    if (body.length > 0) return { start: offset + index, end: offset + end, raw: inline, value: undefined, style: 'nested' };
    return { start: offset + index, end: offset + end, raw: inline, value: decodeScalar(inline), style: 'plain' };
  }
  return undefined;
}

/**
 * Parse a SKILL.md document.
 * @param text - raw file text.
 * @returns a report carrying the block, the identity fields and any error.
 */
export function parseSkill(text) {
  const source = String(text ?? '').replace(/^\uFEFF/, '');
  const { lines, eol } = splitLines(source);
  const bounds = blockBounds(lines);
  if (bounds === undefined) {
    return { hasFrontmatter: false, eol, error: 'missing frontmatter block (the file must start with a `---` line)', body: source, bodyStart: 0 };
  }
  const block = lines.slice(bounds.start + 1, bounds.end);
  const offset = bounds.start + 1;
  const read = (key) => findKey(block, offset, key);
  const name = read('name');
  const description = read('description');
  const whenToUse = read('whenToUse');
  const disabled = read('disable-model-invocation');
  const invocable = read('user-invocable');
  return {
    hasFrontmatter: true,
    eol,
    error: undefined,
    blockStart: bounds.start,
    blockEnd: bounds.end,
    /** The frontmatter lines exactly as they appear, delimiters excluded. */
    frontmatterText: block.join(eol),
    body: lines.slice(bounds.end + 1).join(eol),
    /** Decoded frontmatter values, exactly as written (never coerced). */
    fields: {
      name: name?.value,
      description: description?.value,
      whenToUse: whenToUse?.value,
      'disable-model-invocation': disabled?.value,
      'user-invocable': invocable?.value,
    },
    /**
     * Convenience booleans for the two invocation keys, using the scanner's own
     * truthy/falsy spellings. Separate from `fields` because `yes`, `on` and
     * `1` all mean `true` to the scanner, and collapsing them there would lose
     * what the file actually says.
     */
    flags: {
      modelDisabled: disabled !== undefined && truthy(disabled.value),
      userDisabled: invocable !== undefined && falsy(invocable.value),
    },
    spans: {
      name: name === undefined ? undefined : [name.start, name.end],
      description: description === undefined ? undefined : [description.start, description.end],
      whenToUse: whenToUse === undefined ? undefined : [whenToUse.start, whenToUse.end],
      'disable-model-invocation': disabled === undefined ? undefined : [disabled.start, disabled.end],
      'user-invocable': invocable === undefined ? undefined : [invocable.start, invocable.end],
    },
  };
}

/**
 * Render a value as a single YAML line.
 * @param value - string, boolean or number.
 * @returns the serialized scalar.
 */
function encodeScalar(value) {
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  const text = String(value);
  if (text === '') return '""';
  const needsQuotes =
    /^[\s>|&*!%@`{}[\],#?:-]/.test(text) ||
    /:\s/.test(text) ||
    /\s#/.test(text) ||
    /[\r\n]/.test(text) ||
    /^(true|false|null|~)$/.test(text) ||
    text !== text.trim();
  if (!needsQuotes) return text;
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, '\\n')}"`;
}

/**
 * Replace or insert one top-level scalar key, leaving every other byte alone.
 *
 * @param text - current file text.
 * @param key - top-level key to write.
 * @param value - new scalar value.
 * @returns the new file text.
 */
export function setField(text, key, value) {
  const source = String(text ?? '');
  const { lines, eol } = splitLines(source);
  const bounds = blockBounds(lines);
  const rendered = `${key}: ${encodeScalar(value)}`;
  if (bounds === undefined) {
    /* No frontmatter at all: create a minimal block rather than corrupting the body. */
    return `---${eol}${rendered}${eol}---${eol}${source}`;
  }
  const block = lines.slice(bounds.start + 1, bounds.end);
  const found = findKey(block, bounds.start + 1, key);
  if (found === undefined) {
    lines.splice(bounds.end, 0, rendered);
  } else {
    lines.splice(found.start, found.end - found.start + 1, rendered);
  }
  return lines.join(eol);
}

/**
 * Remove one top-level key and its whole value.
 * @param text - current file text.
 * @param key - top-level key to delete.
 * @returns the new file text.
 */
export function removeField(text, key) {
  const source = String(text ?? '');
  const { lines, eol } = splitLines(source);
  const bounds = blockBounds(lines);
  if (bounds === undefined) return source;
  const block = lines.slice(bounds.start + 1, bounds.end);
  const found = findKey(block, bounds.start + 1, key);
  if (found === undefined) return source;
  lines.splice(found.start, found.end - found.start + 1);
  return lines.join(eol);
}

/**
 * The readable ASCII skeleton of arbitrary text, or `''` when nothing survives.
 *
 * This is what makes a name the scanner would skip salvageable: `Web和AI安全测试专家`
 * keeps `web-ai`, `PDF 处理工具` keeps `pdf`.
 *
 * @param raw - arbitrary text.
 * @returns a kebab-case fragment, or `''`.
 */
export function kebabSkeleton(raw) {
  return String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_NAME_LENGTH)
    .replace(/-+$/g, '');
}

/**
 * A legal name to install a skill under when its own `name` breaks the grammar.
 *
 * The directory wins whenever it carries more ASCII than the name does
 * (`web-ai-security-expert` beats a translation-reduced `web-ai`), because the
 * scanner keys on `name` and a name nobody can type is useless.
 *
 * @param raw - the offending frontmatter name.
 * @param directoryName - the skill's directory name, when it has one.
 * @returns a valid kebab-case name.
 */
export function suggestName(raw, directoryName) {
  const fromName = kebabSkeleton(raw);
  const fromDirectory = kebabSkeleton(directoryName);
  if (fromDirectory !== '' && fromDirectory.length > fromName.length) return fromDirectory;
  if (fromName !== '') return fromName;
  if (fromDirectory !== '') return fromDirectory;
  return 'skill';
}

/**
 * Validate a skill document against the scanner's requirements.
 *
 * Only the scanner's own hard requirements are errors — a missing or illegal
 * `name`, a missing `description`, a legacy invocation key. Length and
 * directory-name mismatches are warnings, because the scanner accepts them and
 * a manager should not refuse a file the harness itself loads.
 *
 * A name that breaks only the grammar is marked `renamable`: the skill is worth
 * installing under {@link suggestName} rather than refused, because the scanner
 * would otherwise ignore it forever.
 *
 * @param text - current file text.
 * @param directoryName - the skill's directory name, when it has one.
 * @returns `{ ok, errors, warnings, name, description, whenToUse, disabled, invocation, renamable, suggested }`.
 */
export function validateSkill(text, directoryName) {
  const parsed = parseSkill(text);
  const errors = [];
  const warnings = [];
  if (!parsed.hasFrontmatter) {
    errors.push(parsed.error);
    return { ok: false, errors, warnings, name: undefined, description: undefined, disabled: false, invocation: { modelInvocable: true, userInvocable: true }, renamable: false, suggested: undefined };
  }
  const name = typeof parsed.fields.name === 'string' ? parsed.fields.name.trim() : '';
  const description = typeof parsed.fields.description === 'string' ? parsed.fields.description.trim() : '';
  let badName = false;
  if (name === '') errors.push('frontmatter is missing `name`');
  else if (!NAME_PATTERN.test(name)) {
    badName = true;
    errors.push('`name` must be kebab-case: lowercase letters, digits and single hyphens');
  } else if (name.length > MAX_NAME_LENGTH) warnings.push(`\`name\` is longer than ${String(MAX_NAME_LENGTH)} characters`);
  if (description === '') errors.push('frontmatter is missing `description`');
  else if (description.length > MAX_DESCRIPTION_LENGTH) warnings.push(`\`description\` is longer than ${String(MAX_DESCRIPTION_LENGTH)} characters`);
  if (directoryName !== undefined && name !== '' && name !== directoryName) {
    warnings.push(`\`name\` (${name}) differs from the directory name (${directoryName}); the scanner keys on \`name\``);
  }
  /* The scanner throws on these and skips the whole skill, so they are errors. */
  for (const legacy of ['disableModelInvocation', 'modelInvocable', 'userInvocable']) {
    if (new RegExp(`^[ \\t]*${legacy}[ \\t]*:`, 'm').test(parsed.frontmatterText ?? '')) {
      errors.push(`frontmatter field \`${legacy}\` is unsupported; the scanner throws on it (use \`disable-model-invocation\` or \`user-invocable\`)`);
    }
  }
  const invocation = invocationOf(text);
  return {
    ok: errors.length === 0,
    errors,
    warnings,
    name: name === '' ? undefined : name,
    description: description === '' ? undefined : description,
    whenToUse: typeof parsed.fields.whenToUse === 'string' ? parsed.fields.whenToUse : undefined,
    disabled: !invocation.modelInvocable,
    invocation,
    /* The name is the one problem, so a rename is all this skill needs. */
    renamable: badName && errors.length === 1,
    suggested: badName ? suggestName(name, directoryName) : undefined,
  };
}

/**
 * Build a new SKILL.md document.
 * @param input - `{ name, description, whenToUse, body, disabled }`.
 * @returns the file text.
 */
export function renderSkill(input) {
  const lines = ['---', `name: ${encodeScalar(input.name)}`, `description: ${encodeScalar(input.description)}`];
  if (input.whenToUse !== undefined && String(input.whenToUse).trim() !== '') {
    lines.push(`whenToUse: ${encodeScalar(input.whenToUse)}`);
  }
  if (input.disabled === true) lines.push('disable-model-invocation: true');
  lines.push('---', '');
  lines.push(String(input.body ?? `# ${String(input.name)}\n\n${String(input.description)}`).trimEnd());
  lines.push('');
  return lines.join('\n');
}

export { NAME_PATTERN, MAX_NAME_LENGTH, MAX_DESCRIPTION_LENGTH, SCALAR_KEYS };
