/**
 * Static invariants for the two halves of the plugin.
 *
 * These catch the regressions a unit test cannot: layout rules that only show
 * up as a squashed modal in the browser, a Client importing a Host-only module,
 * and a mount point that stopped being scoped.
 *
 * Usage: node tools/test-static.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const client = readFileSync(`${ROOT}/client.js`, 'utf8');
const host = readFileSync(`${ROOT}/index.js`, 'utf8');
const manifest = JSON.parse(readFileSync(`${ROOT}/package.json`, 'utf8'));

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

/* ---------- the squashed-list regressions ---------- */
check('the file row is fixed-size inside the scrolling list', /\.skill-hub-file\s*\{[^}]*flex:\s*0 0 auto/.test(client));
check('the list forces its children not to shrink', /\.skill-hub-files\s*>\s*\*\s*\{[^}]*flex-shrink:\s*0/.test(client));
check('the modal body protects its fixed rows', /\.skill-hub-modal-body\s*>\s*\*:not\(\.skill-hub-spacer\)\s*\{[^}]*flex-shrink:\s*0/.test(client));
check('the file name is the flexible part', /\.skill-hub-file-name\s*\{[^}]*min-width:\s*0/.test(client));
check('the grow helper keeps a flex basis', /\.skill-hub-grow\s*\{[^}]*flex:\s*1 1 220px/.test(client));

/* ---------- mount + accessibility ---------- */
check('the page is mounted as a settings section', client.includes("ctx.slots.inject('settings.section'") && client.includes('ctx.slots.register('));
check('the dialog declares its role', /role:\s*'dialog'/.test(client));
check('the dialog is modal for assistive tech', client.includes("'aria-modal': 'true'"));

/* ---------- module boundaries ---------- */
check('the Client does not import the Host-only paths helper', !client.includes('dsh-home-paths'));
check('the Host does not import a Client-only module', !/@deepseek-ai\/dsh-client-/u.test(host));
check('the Host exports its plugin name', /export const name = 'skill-hub'/.test(host));
check('the Host declares the services it consumes', /export const inject = \[[^\]]*'skills'[^\]]*'tools'/.test(host));

/* ---------- hygiene ---------- */
check('no debug logging is left in the Client', !client.includes('console.log('));
check('no debug logging is left in the Host', !host.includes('console.log('));
check('the Client has no emoji', !/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(client));
check('the Client registers its dictionaries through ctx.locale', client.includes('ctx.locale.register(NS'));
check('the Client binds the namespace before translating', client.includes('ctx.locale.bind(NS)'));
check('the Client translates at least 20 strings', (client.match(/\bt\('/g) ?? []).length >= 20);

/* ---------- manifest wiring ---------- */
check('the package declares a DSH bundle', manifest.dsh?.bundle?.patch !== undefined);
check('the Client half is injected from the bundle', manifest.dsh?.client?.inject !== undefined);
check('the package name is the npm name', manifest.name === 'skill-tool');
check('the package is publishable', manifest.private !== true);

console.log(`# ${String(checks - failures)}/${String(checks)} static checks passed`);
if (failures > 0) process.exit(1);
