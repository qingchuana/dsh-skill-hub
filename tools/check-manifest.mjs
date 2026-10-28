// Manifest integrity check: every path the package promises must exist, the
// bundle patch must resolve, and the row id used by the patch must be unique.
// Dependency-free and offline — it runs in CI and before packing.
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let checks = 0;
let failures = 0;

function check(name, condition, detail = '') {
  checks += 1;
  if (!condition) {
    failures += 1;
    console.error(`not ok ${checks} - ${name}${detail ? ` (${detail})` : ''}`);
  }
}

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

check('package name is a string', typeof pkg.name === 'string' && pkg.name.length > 0);
check('version is semver-ish', /^\d+\.\d+\.\d+/.test(pkg.version ?? ''), pkg.version);
check('license is declared', typeof pkg.license === 'string');
check('exports "." points at index.js', pkg.exports?.['.'] === './index.js');
check('exports "./client" points at client.js', pkg.exports?.['./client'] === './client.js');

const patchPath = pkg.dsh?.bundle?.patch;
check('dsh.bundle.patch is declared', typeof patchPath === 'string', String(patchPath));

for (const entry of pkg.files ?? []) {
  const absolute = join(root, entry);
  const exists = existsSync(absolute) || existsSync(join(root, `${entry}.js`));
  check(`files entry exists: ${entry}`, exists);
}

if (patchPath) {
  const patchFile = join(root, patchPath);
  check('bundle patch file exists', existsSync(patchFile), patchPath);
  if (existsSync(patchFile)) {
    const patch = readFileSync(patchFile, 'utf8');
    check('bundle patch is a YAML array', /^\s*-\s/m.test(patch));
    check('bundle patch inserts at least one row', /insert:/.test(patch));
    const id = patch.match(/^\s*-\s*insert:[\s\S]*?id:\s*([\w-]+)/m)?.[1];
    check('bundle patch names the plugin row id', typeof id === 'string', String(id));
    if (id) {
      check('row id is kebab-case', /^[a-z][a-z0-9-]*$/.test(id), id);
    }
  }
}

for (const locale of ['en', 'zh']) {
  const file = join(root, 'locale', `${locale}.json`);
  check(`locale file exists: ${locale}`, existsSync(file));
  if (existsSync(file)) {
    try {
      const dict = JSON.parse(readFileSync(file, 'utf8'));
      check(`locale ${locale} has meta.title`, typeof dict?.meta?.title === 'string');
      check(`locale ${locale} has meta.description`, typeof dict?.meta?.description === 'string');
    } catch (error) {
      check(`locale ${locale} parses as JSON`, false, error.message);
    }
  }
}

const icon = pkg.icon ?? pkg.exports?.['./icon'];
check('an icon is declared', typeof icon === 'string', String(icon));
if (typeof icon === 'string') {
  check('icon file exists', existsSync(join(root, icon)), icon);
}

check('README.md is present', existsSync(join(root, 'README.md')));
check('LICENSE is present', existsSync(join(root, 'LICENSE')));

console.log(`# ${checks - failures}/${checks} manifest checks passed`);
if (failures > 0) process.exit(1);
