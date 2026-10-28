/**
 * Unit tests for lib/frontmatter.js — the line-local SKILL.md surgery.
 *
 * Every assertion here comes from a documented behaviour of the module: the
 * decoder's scalar rules, the block-scalar folding rules, "replace only the
 * key's own span", and the scanner-mirroring validation contract.
 *
 * Usage: node tools/test-frontmatter.mjs
 */
import {
  NAME_PATTERN,
  MAX_NAME_LENGTH,
  invocationOf,
  kebabSkeleton,
  parseSkill,
  removeField,
  renderSkill,
  setField,
  suggestName,
  validateSkill,
} from '../lib/frontmatter.js';

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

/** Assert strict equality with a readable diff. */
function equal(name, actual, expected) {
  check(name, Object.is(actual, expected) || JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

const BASIC = ['---', 'name: pdf-tools', 'description: Handles PDF files.', '---', '', '# PDF tools', '', 'Body text.', ''].join('\n');

/* ---------- parseSkill: no frontmatter ---------- */
{
  const parsed = parseSkill('just a body');
  equal('a document without frontmatter reports hasFrontmatter=false', parsed.hasFrontmatter, false);
  check('the missing block is reported as an error', typeof parsed.error === 'string' && parsed.error.includes('missing frontmatter'));
  equal('the whole text stays available as the body', parsed.body, 'just a body');
}

/* ---------- parseSkill: identity fields ---------- */
{
  const parsed = parseSkill(BASIC);
  equal('frontmatter is detected', parsed.hasFrontmatter, true);
  equal('name is decoded', parsed.fields.name, 'pdf-tools');
  equal('description is decoded', parsed.fields.description, 'Handles PDF files.');
  equal('the body keeps the text after the block', parsed.body.startsWith('\n# PDF tools'), true);
  equal('LF documents keep LF', parsed.eol, '\n');
  check('the name span covers one line', parsed.spans.name[1] - parsed.spans.name[0] === 0);
  equal('frontmatterText excludes the delimiters', parsed.frontmatterText, 'name: pdf-tools\ndescription: Handles PDF files.');
}

/* ---------- parseSkill: CRLF is preserved ---------- */
{
  const crlf = BASIC.replace(/\n/g, '\r\n');
  const parsed = parseSkill(crlf);
  equal('CRLF is detected', parsed.eol, '\r\n');
  check('the CRLF body keeps its line endings', parsed.body.includes('\r\n'));
  check('the CRLF body holds no bare LF', !/(^|[^\r])\n/.test(parsed.body));
}

/* ---------- parseSkill: quoted scalars ---------- */
{
  const parsed = parseSkill('---\nname: "my-skill"\ndescription: \'It uses "quotes".\'\n---\n');
  equal('double quotes are stripped', parsed.fields.name, 'my-skill');
  equal('single quotes are stripped', parsed.fields.description, 'It uses "quotes".');
  const escaped = parseSkill('---\nname: x\ndescription: "a \\"b\\" c"\n---\n');
  equal('escaped double quotes decode', escaped.fields.description, 'a "b" c');
}

/* ---------- parseSkill: block scalars ---------- */
{
  const literal = parseSkill(['---', 'name: x', 'description: |', '  line one', '  line two', '---', ''].join('\n'));
  equal('a literal block keeps its newlines', literal.fields.description, 'line one\nline two');
  const folded = parseSkill(['---', 'name: x', 'description: >', '  line one', '  line two', '---', ''].join('\n'));
  equal('a folded block rejoins its lines', folded.fields.description, 'line one line two');
  const nested = parseSkill(['---', 'name: x', 'metadata:', '  owner: someone', '  tags:', '    - a', '---', ''].join('\n'));
  equal('a nested map is not read as a scalar', nested.fields.description, undefined);
  equal('the nested value keeps its span', nested.spans.description, undefined);
}

/* ---------- parseSkill: invocation booleans ---------- */
{
  const disabled = parseSkill('---\nname: x\ndescription: d\ndisable-model-invocation: yes\n---\n');
  equal('yes means disabled for the scanner', disabled.flags.modelDisabled, true);
  equal('the raw spelling survives in fields', disabled.fields['disable-model-invocation'], 'yes');
  equal('a disabled model invocation leaves user invocation on', invocationOf('---\nname: x\ndescription: d\ndisable-model-invocation: yes\n---\n').userInvocable, true);
  const off = parseSkill('---\nname: x\ndescription: d\nuser-invocable: off\n---\n');
  equal('off means not user-invocable', off.flags.userDisabled, true);
  const nonsense = parseSkill('---\nname: x\ndescription: d\ndisable-model-invocation: maybe\n---\n');
  equal('an unrecognised boolean is not treated as true', nonsense.flags.modelDisabled, false);
  equal('a file without frontmatter is invocable', invocationOf('body').modelInvocable, true);
  equal('hasFrontmatter is reported through invocationOf', invocationOf('body').hasFrontmatter, false);
}

/* ---------- setField: replace only that span ---------- */
{
  const source = ['---', 'name: old', '# keep this comment', 'description: keep me', 'custom: untouched', '---', 'body', ''].join('\n');
  const next = setField(source, 'name', 'new-name');
  equal('the edited key changes', /name: new-name/.test(next), true);
  equal('the old value is gone', next.includes('name: old'), false);
  check('comments survive', next.includes('# keep this comment'));
  check('other keys survive', next.includes('custom: untouched'));
  check('the body survives', next.endsWith('body\n'));
}

/* ---------- setField: insert when missing ---------- */
{
  const source = ['---', 'name: x', 'description: d', '---', ''].join('\n');
  const next = setField(source, 'whenToUse', 'when the user asks for a PDF');
  check('a missing key is inserted inside the block', next.includes('whenToUse: when the user asks for a PDF'));
  equal('the block delimiters are unchanged', (next.match(/^---$/gm) ?? []).length, 2);
  equal('the inserted key is still parsed', parseSkill(next).fields.whenToUse, 'when the user asks for a PDF');
}

/* ---------- setField: no frontmatter, quoting ---------- */
{
  const next = setField('plain body', 'name', 'x');
  check('a document without frontmatter gets a minimal block', next === '---\nname: x\n---\nplain body');
  const quoted = setField(BASIC, 'description', 'a: b');
  check('a value containing a colon-space is quoted', quoted.includes('description: "a: b"'));
  equal('the quoted value parses back identically', parseSkill(quoted).fields.description, 'a: b');
  const empty = setField(BASIC, 'whenToUse', '');
  check('an empty value is written as explicit quotes', empty.includes('whenToUse: ""'));
}

/* ---------- removeField ---------- */
{
  const source = ['---', 'name: x', 'description: |', '  multi', '  line', 'keep: yes', '---', 'body', ''].join('\n');
  const next = removeField(source, 'description');
  equal('the key is gone', next.includes('description'), false);
  check('its multi-line value is gone too', !next.includes('multi'));
  check('a later key survives', next.includes('keep: yes'));
  equal('removing an absent key is a no-op', removeField('body', 'name'), 'body');
  equal('removing from a document without frontmatter is a no-op', removeField('body', 'name'), 'body');
}

/* ---------- kebabSkeleton / suggestName ---------- */
{
  equal('mixed prose keeps its ASCII words', kebabSkeleton('PDF 处理工具'), 'pdf');
  equal('embedded Chinese splits the ASCII words', kebabSkeleton('Web和AI安全测试专家'), 'web-ai');
  equal('punctuation collapses', kebabSkeleton('My  Skill!!'), 'my-skill');
  equal('nothing ASCII survives to an empty string', kebabSkeleton('纯中文'), '');
  check('the skeleton respects the length cap', kebabSkeleton('a'.repeat(200)).length <= MAX_NAME_LENGTH);
  check('the suggestion is a legal name', NAME_PATTERN.test(suggestName('Web和AI安全测试专家', 'web-ai-security-expert')));
  equal('a longer directory beats a shorter name skeleton', suggestName('Web和AI', 'web-ai-security-expert'), 'web-ai-security-expert');
  equal('the name skeleton wins when it is longer', suggestName('pdf-processing-tools', 'x'), 'pdf-processing-tools');
  equal('nothing salvageable falls back to skill', suggestName('纯中文', undefined), 'skill');
}

/* ---------- validateSkill ---------- */
{
  const good = validateSkill(BASIC, 'pdf-tools');
  equal('a valid document passes', good.ok, true);
  equal('no errors are reported', good.errors.length, 0);
  equal('the parsed name is returned', good.name, 'pdf-tools');
  equal('a disabled skill reports disabled', validateSkill('---\nname: x\ndescription: d\ndisable-model-invocation: true\n---\n').disabled, true);

  const missing = validateSkill('no frontmatter here');
  equal('a document without frontmatter fails', missing.ok, false);

  const noName = validateSkill('---\ndescription: d\n---\n');
  equal('a missing name is an error', noName.ok, false);
  check('the error names the missing field', noName.errors.join(' ').includes('name'));

  const bad = validateSkill('---\nname: My Skill\ndescription: d\n---\n', 'my-skill');
  equal('a non-kebab name fails', bad.ok, false);
  equal('only a name-grammar failure is renamable', bad.renamable, true);
  check('the suggestion is legal', NAME_PATTERN.test(bad.suggested));

  const twoProblems = validateSkill('---\nname: My Skill\n---\n');
  equal('two problems are not renamable', twoProblems.renamable, false);
  equal('two problems report two errors', twoProblems.errors.length, 2);

  const mismatch = validateSkill(BASIC, 'other-dir');
  equal('a directory mismatch still passes', mismatch.ok, true);
  check('the mismatch is a warning', mismatch.warnings.join(' ').includes('differs from the directory name'));

  const legacy = validateSkill('---\nname: x\ndescription: d\ndisableModelInvocation: true\n---\n');
  equal('a legacy invocation key is an error', legacy.ok, false);
  check('the error explains the replacement', legacy.errors.join(' ').includes('disable-model-invocation'));

  const shortDescription = validateSkill('---\nname: x\n---\n');
  equal('a missing description is an error', shortDescription.ok, false);

  const longName = validateSkill(`---\nname: ${'a'.repeat(70)}\ndescription: d\n---\n`);
  equal('an over-long name only warns', longName.ok, true);
  check('the over-long name warning is present', longName.warnings.join(' ').includes('longer than'));
}

/* ---------- renderSkill round trip ---------- */
{
  const text = renderSkill({ name: 'pdf-tools', description: 'Handles PDF files.', whenToUse: 'when asked about PDFs' });
  const parsed = parseSkill(text);
  equal('the rendered name parses back', parsed.fields.name, 'pdf-tools');
  equal('the rendered description parses back', parsed.fields.description, 'Handles PDF files.');
  equal('the rendered whenToUse parses back', parsed.fields.whenToUse, 'when asked about PDFs');
  equal('a rendered file validates', validateSkill(text, 'pdf-tools').ok, true);
  check('the default body is generated', text.includes('# pdf-tools'));
  const disabled = renderSkill({ name: 'x', description: 'd', disabled: true });
  equal('disabled renders the invocation key', parseSkill(disabled).fields['disable-model-invocation'], true);
  const quoted = renderSkill({ name: 'x', description: 'a: b' });
  equal('a description needing quotes round-trips', parseSkill(quoted).fields.description, 'a: b');
}

console.log(`# ${String(checks - failures)}/${String(checks)} frontmatter checks passed`);
if (failures > 0) process.exit(1);
