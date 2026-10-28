/**
 * dsh-skill-hub — Host half.
 *
 * Manages Agent Skills in the root the shipped `@deepseek-ai/dsh-skill-filesystem`
 * provider already watches: `$DSH_HOME/skills` (rank 400, source `user-dsh`).
 * Anything written there appears in `ctx.skills` on its own within a few hundred
 * milliseconds, so this plugin needs no provider of its own and no patch to the
 * profile — it edits files and then invalidates the registry cache so the change
 * is visible immediately rather than after the watcher's debounce.
 *
 * Three facts about the scanner shape the design:
 *
 * 1. `disable-model-invocation` does NOT hide a skill from `ctx.skills.list()`.
 *    It sets `invocation.modelInvocable = false`, and the *consumer*
 *    (`dsh-tool-skill`) is what filters. So "enabled/disabled" here means two
 *    independent switches, both written as frontmatter.
 * 2. Discovery is exactly one level deep: `<root>/<dir>/SKILL.md` or
 *    `<root>/<name>.md`. Nothing nested is ever found.
 * 3. A frontmatter mistake (a missing `name`, a legacy key such as
 *    `disableModelInvocation`) makes the scanner log a warning and SKIP the
 *    skill silently. The skill then simply is not in the list, with no hint in
 *    any UI. Reporting those files is a core feature of this plugin, not a
 *    side effect: see {@link SkillHub#inventory}.
 *
 * State: `$DSH_HOME/skill-hub/config.json` and `$DSH_HOME/skill-hub/backups/`.
 *
 * @module dsh-skill-hub
 */
import { mkdir, readFile, readdir, rename, rm, copyFile, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import { renderSkill, setField, validateSkill, removeField, invocationOf, parseSkill, NAME_PATTERN } from './lib/frontmatter.js';
import { extractTarGz, findSkills } from './lib/tar.js';
import { extractZip } from './lib/zip.js';

/** Stable Cordis plugin name. */
export const name = 'skill-hub';
/** The skill registry to read, and the tool registry to publish into. */
export const inject = ['skills', 'tools'];

/** The one filename the scanner looks for inside a skill directory. */
const SKILL_FILE = 'SKILL.md';
/** Source label the filesystem provider gives `$DSH_HOME/skills`. */
const PRIMARY_SOURCE = 'user-dsh';
/** Directory names never copied into an installed skill. */
const JUNK_DIRS = new Set(['.git', 'node_modules', '.idea', '.vscode', '__MACOSX']);
/** File names never copied into an installed skill. */
const JUNK_FILES = new Set(['.DS_Store', 'Thumbs.db']);
/** Deepest directory nesting copied from a skill source. */
const MAX_COPY_DEPTH = 6;
/** Most files copied into one skill. */
const MAX_COPY_FILES = 500;
/** Largest total copied into one skill, in bytes. */
const MAX_COPY_BYTES = 8 * 1024 * 1024;
/** Largest downloaded archive, in bytes. */
const MAX_DOWNLOAD_BYTES = 32 * 1024 * 1024;
/** Largest local `.zip` package, in bytes. */
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
/** Largest package the page may upload, in bytes. Kept well under any transport
 * frame limit: base64 inflates by a third, and real skill packages are tiny. */
const MAX_UPLOAD_BYTES = 16 * 1024 * 1024;
/** Uploaded packages kept on disk before the oldest are dropped. */
const MAX_UPLOADS = 8;
/** Directory entries one `listLocal` answer may carry. */
const MAX_LIST_ENTRIES = 400;
/** Files the install wizard can consume when browsing a folder. */
const INSTALLABLE_FILE = /\.(zip|tar\.gz|tgz|md)$/i;
/** Download timeout, in milliseconds. */
const DOWNLOAD_TIMEOUT_MS = 60_000;
/** Backups kept before the oldest are pruned. */
const DEFAULT_BACKUP_LIMIT = 20;
/** Archive mirror used when direct GitHub is unreachable. Proven to work where
 * `codeload.github.com` is blocked and where `ghproxy.net` answers 403. */
const DEFAULT_MIRROR = 'https://gh-proxy.com/';
/** Config document version. */
const CONFIG_VERSION = 1;
/** Prototype property the Typert gateway reads Remote markers from. */
const REMOTE_MARKER = '@deepseek-ai/dsh-typert-protocol/remote-methods';
/**
 * Every method the settings page may call.
 *
 * The gateway refuses a Client-mounted method whose name collides with its
 * `RemoteNamespaceService` surface — the reserved fields `ctx`, `empty`,
 * `invokeRemote`, `methods`, `name`, `namespace`, the prototype members
 * `empty`, `has`, `install`, `installDirect`, `installScoped`, `remove`, and
 * every `Object.prototype` key. `install` and `remove` are why the mutating
 * methods here are spelled `installDir`, `installUrl` and `removeSkill`.
 */
const REMOTE_METHODS = [
  'state',
  'heartbeat',
  'read',
  'validate',
  'save',
  'create',
  'installDir',
  'installUrl',
  'removeSkill',
  'setInvocation',
  'setConfig',
  'scanDir',
  'listLocal',
  'upload',
  'browseRepo',
  'restoreBackup',
];

/* ------------------------------------------------------------------ *
 * Shared helpers
 * ------------------------------------------------------------------ */

/** Strip `undefined` recursively so every Remote result is lossless JSON. */
function jsonSafe(value) {
  if (Array.isArray(value)) return value.map((entry) => jsonSafe(entry));
  if (typeof value === 'object' && value !== null) {
    const out = {};
    for (const [key, entry] of Object.entries(value)) if (entry !== undefined) out[key] = jsonSafe(entry);
    return out;
  }
  return value;
}

/** One human-readable line for an unknown thrown value. */
function messageOf(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** Whether a filesystem error means "not there". */
function isMissing(error) {
  return error?.code === 'ENOENT' || error?.code === 'ENOTDIR';
}

/** `$DSH_HOME`. */
function homeDir() {
  return resolveDshHome();
}

/** `$DSH_HOME/skills` — the native, writable skill root. */
function primaryRoot() {
  return join(homeDir(), 'skills');
}

/** `$DSH_HOME/skill-hub`. */
function hubDir() {
  return join(homeDir(), 'skill-hub');
}

/**
 * `$DSH_HOME/skill-hub/tmp` — where a `.zip` package is unpacked before it is
 * inspected or installed. It holds at most one extraction: the next one clears
 * the directory, and `boot()` clears it again on every start.
 */
function tmpRoot() {
  return join(hubDir(), 'tmp');
}

/**
 * `$DSH_HOME/skill-hub/uploads` — packages the page sent over, kept until the
 * wizard installs them. A browser file dialog hands over bytes and never a path,
 * so an uploaded package becomes a real temporary file here and the ordinary
 * scan/install pipeline takes over. `boot()` clears the directory, and each
 * upload drops the oldest beyond `MAX_UPLOADS`.
 */
function uploadsRoot() {
  return join(hubDir(), 'uploads');
}

/** `$DSH_HOME/skill-hub/config.json`. */
function configFile() {
  return join(hubDir(), 'config.json');
}

/** `$DSH_HOME/skill-hub/backups`. */
function backupsDir() {
  return join(hubDir(), 'backups');
}

/**
 * The candidate fields every install source shares.
 *
 * `renamable` and `suggested` let the wizard warn *before* installing that a
 * skill whose `name` breaks the scanner's grammar will be renamed instead of
 * refused — the scanner skips such a skill outright, so refusing it would be
 * honest but useless.
 */
function candidateFlags(verdict) {
  return {
    valid: verdict.ok,
    errors: verdict.errors,
    warnings: verdict.warnings,
    renamable: verdict.renamable === true,
    suggested: verdict.suggested,
  };
}

/**
 * The document text with its frontmatter `name` made to equal `target`.
 *
 * The scanner keys on `name` and silently skips a skill whose name breaks the
 * grammar, so an install that had to rename must rewrite the field too —
 * otherwise a CJK or capitalised name would be copied onto disk and then never
 * load. The text comes back unchanged when the field already agrees.
 *
 * @param text - the `SKILL.md` contents.
 * @param target - the name the skill is being installed as.
 * @returns the text to write.
 */
function alignSkillName(text, target) {
  const parsed = parseSkill(text);
  const declared = typeof parsed.fields.name === 'string' ? parsed.fields.name.trim() : '';
  return declared === target ? text : setField(text, 'name', target);
}

/** Publish a file atomically: write a sibling temp file, then rename over. */
async function atomicWrite(file, text) {
  await mkdir(dirname(file), { recursive: true });
  const tmp = join(dirname(file), `.${basename(file)}.${String(process.pid)}.${Date.now().toString(36)}.tmp`);
  await writeFile(tmp, text, 'utf8');
  await rename(tmp, file);
}

/** Read a JSON file, or `undefined` when it is absent or unreadable. */
async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return undefined;
  }
}

/** File/directory existence without throwing. */
async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** True when `child` is `parent` or lives inside it. */
function isInside(parent, child) {
  const from = resolve(parent).replace(/[\\/]+$/, '');
  const to = resolve(child);
  if (from.toLowerCase() === to.toLowerCase()) return true;
  const prefix = from.toLowerCase() + sep.toLowerCase();
  return to.toLowerCase().startsWith(prefix);
}

/** Turn arbitrary text into a legal skill name. */
function slugify(raw) {
  const slug = String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '');
  return slug === '' ? 'skill' : slug;
}

/** First free name derived from a base, avoiding a set of taken names. */
function uniqueName(base, taken) {
  const root = slugify(base);
  if (!taken.has(root)) return root;
  for (let index = 2; index < 200; index += 1) {
    const candidate = `${root}-${String(index)}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${root}-${Date.now().toString(36)}`;
}

/** Prefix a URL with a mirror, honouring a `{url}` placeholder when present. */
function applyMirror(url, mirror) {
  const trimmed = String(mirror ?? '').trim();
  if (trimmed === '') return url;
  if (trimmed.includes('{url}')) return trimmed.replace('{url}', url);
  return `${trimmed.replace(/\/+$/, '')}/${url}`;
}

/** Build the candidate archive URLs for a GitHub repository reference. */
function archiveCandidates({ repo, ref, path }) {
  const clean = String(repo ?? '')
    .trim()
    .replace(/^https?:\/\/github\.com\//i, '')
    .replace(/\.git$/i, '')
    .replace(/^\/+|\/+$/g, '');
  if (!/^[^/\s]+\/[^/\s]+$/.test(clean)) {
    throw new Error(`\`repo\` must look like owner/name, got ${JSON.stringify(String(repo ?? ''))}`);
  }
  const branch = String(ref ?? 'main').trim() === '' ? 'main' : String(ref).trim();
  const file = path !== undefined && String(path).trim() !== '' ? String(path).trim().replace(/^\/+/, '') : undefined;
  const urls = [`https://github.com/${clean}/archive/refs/heads/${branch}.tar.gz`];
  /* Annotated releases often live under tags only, so try the tag namespace too. */
  urls.push(`https://github.com/${clean}/archive/refs/tags/${branch}.tar.gz`);
  return { urls, repo: clean, ref: branch, path: file };
}

/** Fetch a URL into memory, honouring a byte cap and a timeout. */
async function fetchBytes(url, { max = MAX_DOWNLOAD_BYTES, timeout = DOWNLOAD_TIMEOUT_MS } = {}) {
  const response = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(timeout),
    headers: { 'user-agent': 'dsh-skill-hub', accept: '*/*' },
  });
  if (!response.ok) throw new Error(`HTTP ${String(response.status)} ${response.statusText}`.trim());
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > max) {
    throw new Error(`refusing a ${String(declared)}-byte download (limit ${String(max)})`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength > max) throw new Error(`refusing a ${String(bytes.byteLength)}-byte download (limit ${String(max)})`);
  return bytes;
}

/**
 * Walk a directory tree, skipping junk.
 * @param root - directory to walk.
 * @param options - `{ maxDepth, maxFiles, maxBytes }`.
 * @returns `{ files, skipped, truncated }` with root-relative paths.
 */
async function walkFiles(root, options = {}) {
  const maxDepth = options.maxDepth ?? MAX_COPY_DEPTH;
  const maxFiles = options.maxFiles ?? MAX_COPY_FILES;
  const maxBytes = options.maxBytes ?? MAX_COPY_BYTES;
  const files = [];
  const skipped = [];
  let bytes = 0;
  let truncated = false;
  const queue = [{ dir: root, depth: 0 }];
  while (queue.length > 0 && !truncated) {
    const { dir, depth } = queue.shift();
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      skipped.push(`${relative(root, dir) || '.'}: ${messageOf(error)}`);
      continue;
    }
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      const rel = relative(root, abs);
      if (entry.isSymbolicLink()) {
        skipped.push(`${rel}: symbolic link`);
        continue;
      }
      if (entry.isDirectory()) {
        if (JUNK_DIRS.has(entry.name)) {
          skipped.push(`${rel}: ignored directory`);
          continue;
        }
        if (depth + 1 > maxDepth) {
          skipped.push(`${rel}: deeper than ${String(maxDepth)} levels`);
          continue;
        }
        queue.push({ dir: abs, depth: depth + 1 });
        continue;
      }
      if (!entry.isFile() || JUNK_FILES.has(entry.name)) continue;
      let size = 0;
      try {
        size = (await stat(abs)).size;
      } catch {
        continue;
      }
      if (files.length >= maxFiles) {
        truncated = true;
        skipped.push(`${rel}: file-count limit ${String(maxFiles)} reached`);
        break;
      }
      if (bytes + size > maxBytes) {
        truncated = true;
        skipped.push(`${rel}: size limit ${String(maxBytes)} reached`);
        break;
      }
      bytes += size;
      files.push({ rel, abs, size });
    }
  }
  return { files, skipped, truncated, bytes };
}

/** Copy a skill directory tree into `dest`, returning a copy report. */
async function copyTree(sourceDir, destDir) {
  const walked = await walkFiles(sourceDir);
  await mkdir(destDir, { recursive: true });
  for (const file of walked.files) {
    const target = join(destDir, file.rel);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(file.abs, target);
  }
  return { copied: walked.files.length, bytes: walked.bytes, skipped: walked.skipped, truncated: walked.truncated };
}

/**
 * The instruction file inside a backup directory.
 *
 * A backup holds either a bundle (`skill/SKILL.md`) or one loose document
 * (`skill/<name>.md`) captured from the managed root.
 *
 * @param dir - the backup directory.
 * @returns the file plus whether it is a loose document, or `undefined`.
 */
async function backupManifest(dir) {
  const bundle = join(dir, 'skill', SKILL_FILE);
  if (await exists(bundle)) return { file: bundle, loose: false };
  const flat = join(dir, SKILL_FILE);
  if (await exists(flat)) return { file: flat, loose: false };
  const entries = await readdir(join(dir, 'skill'), { withFileTypes: true }).catch(() => []);
  const docs = entries.filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.md'));
  return docs.length === 1 ? { file: join(dir, 'skill', docs[0].name), loose: true } : undefined;
}

/** The skill name of a loose document: `<name>.md` sits directly in the root. */
function stemOfDocument(fileName) {
  return fileName.replace(/\.md$/iu, '');
}

/** The installable suffix of a package name, keeping a two-part `.tar.gz`. */
function suffixOf(fileName) {
  const lower = String(fileName).toLowerCase();
  if (lower.endsWith('.tar.gz')) return fileName.slice(fileName.length - '.tar.gz'.length);
  const dot = fileName.lastIndexOf('.');
  return dot <= 0 ? '' : fileName.slice(dot);
}

/** The loose document in a root listing whose skill name is `target`, if any. */
function looseDocumentOf(files, target) {
  const wanted = String(target).toLowerCase();
  return files.find((name) => stemOfDocument(name).toLowerCase() === wanted);
}

/** Every skill directory already present in a root, one level deep. */
async function listRootEntries(root) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return { dirs: [], files: [], missing: true };
    throw error;
  }
  const dirs = [];
  const files = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    if (entry.isDirectory()) dirs.push(entry.name);
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) files.push(entry.name);
  }
  return { dirs, files, missing: false };
}

/* ------------------------------------------------------------------ *
 * The `skillHub` service (Remote namespace for the settings page)
 * ------------------------------------------------------------------ */

/** Install the Remote marker descriptor the gateway's source mode reads. */
function markRemoteMethods(klass, methods) {
  Object.defineProperty(klass.prototype, REMOTE_MARKER, {
    configurable: true,
    value: Object.freeze({
      version: 1,
      methods: Object.freeze(
        methods.map((method) => Object.freeze({ method, invocation: Object.freeze({ kind: 'direct' }) })),
      ),
    }),
  });
}

/** The management service behind the `skillHub` Remote namespace. */
class SkillHub extends TypertRemoteService {
  /**
   * @param ctx - the plugin's registration context (owns `skills` and `tools`).
   */
  constructor(ctx) {
    super(ctx, 'skillHub');
    this.root = ctx;
    this.log = ctx.logger;
    this.config = { version: CONFIG_VERSION, mirror: DEFAULT_MIRROR, backupLimit: DEFAULT_BACKUP_LIMIT };
    /* Presence of the settings page, so the agent-facing `list` can report
       whether the browser half is actually loaded. */
    this.lastClientSeen = 0;
  }

  /** Load persisted settings; never rejects. */
  async boot() {
    const stored = await readJson(configFile());
    if (stored !== undefined && typeof stored === 'object') {
      this.config = {
        version: CONFIG_VERSION,
        mirror: typeof stored.mirror === 'string' ? stored.mirror : DEFAULT_MIRROR,
        backupLimit: Number.isInteger(stored.backupLimit) ? stored.backupLimit : DEFAULT_BACKUP_LIMIT,
      };
    } else {
      await atomicWrite(configFile(), `${JSON.stringify(this.config, null, 2)}\n`).catch(() => {});
    }
    this.log.info(`skill-hub: managing ${primaryRoot()} (mirror ${this.config.mirror === '' ? 'none' : this.config.mirror})`);
    /* A `.zip` candidate list re-scans from the archive, so nothing under `tmp`
       has to survive a restart; a leftover extraction is only wasted disk. */
    await rm(tmpRoot(), { recursive: true, force: true }).catch(() => {});
    /* Uploaded packages are the same kind of scratch: the page can send them
       again, and a stale upload would only be a file the wizard cannot explain. */
    await rm(uploadsRoot(), { recursive: true, force: true }).catch(() => {});
  }

  /** Ask the registry to re-collect now instead of after the watcher debounce. */
  refresh() {
    try {
      this.root.skills.invalidateCache();
    } catch (error) {
      this.log.warn(`skill-hub: cache invalidation failed: ${messageOf(error)}`);
    }
  }

  /** The registry snapshot, or a described failure. */
  async snapshot() {
    try {
      const result = await this.root.skills.snapshot();
      return { skills: Array.isArray(result?.skills) ? result.skills : [], complete: result?.complete !== false, error: undefined };
    } catch (error) {
      return { skills: [], complete: false, error: messageOf(error) };
    }
  }

  /** The registry record for one name, or `undefined`. */
  async find(name) {
    const wanted = String(name ?? '').trim();
    const { skills } = await this.snapshot();
    const record = skills.find((skill) => skill.name === wanted);
    if (record !== undefined) return record;
    /* The registry is layered: skills provided inside an agent preset's scope
       are invisible to this host-level plugin's global read. Management must
       not depend on that view, so fall back to the managed root itself. */
    return await this.findOnDisk(wanted);
  }

  /**
   * A skill record built from the managed root, for a name the registry does
   * not report.
   *
   * @param wanted - the skill name.
   * @returns a registry-shaped record, or `undefined` when nothing valid is there.
   */
  async findOnDisk(wanted) {
    if (wanted === '') return undefined;
    const root = primaryRoot();
    const entries = await listRootEntries(root);
    const directory = entries.dirs.includes(wanted) ? join(root, wanted) : root;
    const loose = looseDocumentOf(entries.files, wanted);
    const file = entries.dirs.includes(wanted) ? join(directory, SKILL_FILE) : loose === undefined ? undefined : join(root, loose);
    if (file === undefined) return undefined;
    const text = await readFile(file, 'utf8').catch(() => undefined);
    if (text === undefined) return undefined;
    const validation = validateSkill(text, wanted);
    if (!validation.ok || validation.name !== wanted) return undefined;
    return {
      name: wanted,
      path: file,
      description: validation.description ?? '',
      ...(validation.whenToUse === undefined ? {} : { whenToUse: validation.whenToUse }),
      invocation: invocationOf(text),
      source: PRIMARY_SOURCE,
      provider: 'skill-hub',
      resourceBase: { kind: 'directory', path: directory },
    };
  }

  /** A skill's directory and instruction file, from a registry record. */
  locate(skill) {
    const directory =
      skill?.resourceBase?.kind === 'directory' && typeof skill.resourceBase.path === 'string'
        ? skill.resourceBase.path
        : skill?.path !== undefined
          ? dirname(skill.path)
          : undefined;
    const file = typeof skill?.path === 'string' ? skill.path : directory === undefined ? undefined : join(directory, SKILL_FILE);
    return { directory, file };
  }

  /**
   * The full management view.
   *
   * Beyond the live registry records this reads the managed root from disk to
   * answer the question the registry cannot: which skills are sitting on disk
   * but missing from `ctx.skills`, and why. A skill whose frontmatter fails
   * validation is skipped by the scanner with only a Host log line, so without
   * this it would look as if it had never been installed.
   */
  async inventory() {
    const root = primaryRoot();
    const { skills, complete, error } = await this.snapshot();
    const byName = new Map(skills.map((skill) => [skill.name, skill]));
    const entries = await listRootEntries(root);
    const broken = [];
    const shadowed = [];
    /* Every valid skill sitting in this root, whatever the registry reports. */
    const onDisk = [];

    for (const dir of entries.dirs) {
      const directory = join(root, dir);
      const file = join(directory, SKILL_FILE);
      if (!(await exists(file))) {
        broken.push({ name: dir, dir, directory, file, reason: `no ${SKILL_FILE} in this directory`, errors: [], warnings: [] });
        continue;
      }
      const text = await readFile(file, 'utf8').catch(() => undefined);
      if (text === undefined) {
        broken.push({ name: dir, dir, directory, file, reason: 'unreadable', errors: [], warnings: [] });
        continue;
      }
      const validation = validateSkill(text, dir);
      const declared = validation.name;
      if (!validation.ok) {
        broken.push({ name: declared ?? dir, dir, declared, directory, file, reason: 'frontmatter rejected by the scanner', errors: validation.errors, warnings: validation.warnings });
        continue;
      }
      const record = declared === undefined ? undefined : byName.get(declared);
      if (record !== undefined) {
        const located = this.locate(record);
        if (located.directory !== undefined && !isInside(root, located.directory)) {
          shadowed.push({ name: declared, dir, directory, file, reason: `a higher-ranked source is used instead: ${record.source} (${located.directory})` });
        }
      }
      onDisk.push({ name: declared ?? dir, dir, declared, directory, file, text, validation, registered: record !== undefined });
    }

    for (const file of entries.files) {
      const abs = join(root, file);
      const text = await readFile(abs, 'utf8').catch(() => undefined);
      if (text === undefined) continue;
      const validation = validateSkill(text, basename(file, '.md'));
      const declared = validation.name;
      if (!validation.ok) {
        broken.push({ name: declared ?? basename(file, '.md'), dir: file, declared, directory: root, file: abs, reason: 'frontmatter rejected by the scanner', errors: validation.errors, warnings: validation.warnings });
        continue;
      }
      onDisk.push({ name: declared ?? basename(file, '.md'), dir: file, declared, directory: root, file: abs, text, validation, registered: declared !== undefined && byName.has(declared) });
    }

    /* A layered registry only merges the layers the caller's scope can reach, so
       this host-level plugin can observe an empty catalog while the very same
       files load fine for the agent. That is a blind catalog, not a broken
       file: say it once, and keep managing the root from disk. */
    const registryBlind = onDisk.length > 0 && !onDisk.some((entry) => entry.registered);
    if (!registryBlind) {
      for (const entry of onDisk) {
        if (entry.registered) continue;
        broken.push({ name: entry.declared ?? entry.name, dir: entry.dir, declared: entry.declared, directory: entry.directory, file: entry.file, reason: 'valid on disk but absent from the registry', errors: [], warnings: entry.validation.warnings });
      }
    }

    const projected = [];
    for (const skill of skills) {
      const located = this.locate(skill);
      const writable = located.directory !== undefined && isInside(root, located.directory);
      /* For a managed skill the frontmatter in the file is what this plugin can
         actually change. The registry value is what the model sees, and another
         provider (for example `dsh-agent-skills`, which disables skills by name)
         can override it — so both are reported and a disagreement is flagged
         rather than hidden. */
      let onFile;
      if (writable && located.file !== undefined) {
        const text = await readFile(located.file, 'utf8').catch(() => undefined);
        if (text !== undefined) onFile = invocationOf(text);
      }
      const registryInvocation = {
        modelInvocable: skill.invocation?.modelInvocable !== false,
        userInvocable: skill.invocation?.userInvocable !== false,
      };
      const effective = onFile ?? registryInvocation;
      projected.push({
        name: skill.name,
        description: skill.description,
        whenToUse: skill.whenToUse,
        source: skill.source,
        provider: skill.provider,
        modelInvocable: effective.modelInvocable,
        userInvocable: effective.userInvocable,
        registryModelInvocable: registryInvocation.modelInvocable,
        registryUserInvocable: registryInvocation.userInvocable,
        fileModelInvocable: onFile?.modelInvocable,
        fileUserInvocable: onFile?.userInvocable,
        overridden: onFile !== undefined && (onFile.modelInvocable !== registryInvocation.modelInvocable || onFile.userInvocable !== registryInvocation.userInvocable),
        directory: located.directory,
        file: located.file,
        writable,
        managed: writable,
        registered: true,
      });
    }

    /* With a blind catalog the disk is the only source of truth, so the rows
       this plugin can still manage come from the root itself. Their invocation
       policy is the file's own value: no provider is overriding it. */
    if (registryBlind) {
      for (const entry of onDisk) {
        projected.push({
          name: entry.declared ?? entry.name,
          description: entry.validation.description ?? '',
          whenToUse: entry.validation.whenToUse,
          source: PRIMARY_SOURCE,
          provider: 'skill-hub',
          modelInvocable: entry.validation.invocation.modelInvocable,
          userInvocable: entry.validation.invocation.userInvocable,
          fileModelInvocable: entry.validation.invocation.modelInvocable,
          fileUserInvocable: entry.validation.invocation.userInvocable,
          overridden: false,
          directory: entry.directory,
          file: entry.file,
          writable: true,
          managed: true,
          registered: false,
        });
      }
    }

    const bySource = new Map();
    for (const skill of projected) {
      const bucket = bySource.get(skill.source) ?? { source: skill.source, count: 0, writable: false };
      bucket.count += 1;
      bucket.writable = bucket.writable || skill.writable;
      bySource.set(skill.source, bucket);
    }

    return {
      home: homeDir(),
      root,
      configFile: configFile(),
      backupsDir: backupsDir(),
      config: this.config,
      complete,
      error,
      registryCount: skills.length,
      registryBlind,
      lastClientSeen: this.lastClientSeen,
      sources: [...bySource.values()].sort((left, right) => left.source.localeCompare(right.source)),
      skills: projected,
      broken,
      shadowed,
      backups: await this.readBackups(),
    };
  }

  /** Every backup directory, newest first. */
  async readBackups() {
    let entries;
    try {
      entries = await readdir(backupsDir(), { withFileTypes: true });
    } catch (error) {
      if (isMissing(error)) return [];
      return [];
    }
    const out = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = join(backupsDir(), entry.name);
      const meta = await readJson(join(dir, 'backup.json'));
      const manifest = await backupManifest(dir);
      out.push({
        id: entry.name,
        name: typeof meta?.name === 'string' ? meta.name : entry.name.replace(/^\d{8}-\d{6}-/, ''),
        at: typeof meta?.at === 'string' ? meta.at : undefined,
        reason: typeof meta?.reason === 'string' ? meta.reason : undefined,
        restorable: manifest !== undefined,
      });
    }
    /* `at` carries milliseconds; the id only has seconds, so two backups in one
       second would otherwise be ordered by name. */
    return out.sort((left, right) => {
      const stamp = String(right.at ?? '').localeCompare(String(left.at ?? ''));
      return stamp === 0 ? right.id.localeCompare(left.id) : stamp;
    });
  }

  /** Prune old backups down to the configured limit. */
  async pruneBackups() {
    const limit = Number.isInteger(this.config.backupLimit) ? this.config.backupLimit : DEFAULT_BACKUP_LIMIT;
    if (limit <= 0) return 0;
    const backups = await this.readBackups();
    let removed = 0;
    for (const backup of backups.slice(limit)) {
      await rm(join(backupsDir(), backup.id), { recursive: true, force: true }).catch(() => {});
      removed += 1;
    }
    return removed;
  }

  /** Move a skill's tree into the backup store, ready to be restored. */
  async backupSkill(directory, skillName, reason, file) {
    const stamp = new Date();
    const pad = (value) => String(value).padStart(2, '0');
    const id = `${String(stamp.getFullYear())}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}-${pad(stamp.getHours())}${pad(stamp.getMinutes())}${pad(stamp.getSeconds())}-${slugify(skillName)}`;
    /* Two backups of one skill inside the same second must not collide: the
       second would silently replace the first one's directory. */
    let unique = id;
    for (let attempt = 2; await exists(join(backupsDir(), unique)); attempt += 1) unique = `${id}-${String(attempt)}`;
    const target = join(backupsDir(), unique);
    /* A loose document's directory is the managed root itself, so copying the
       directory would back up every skill in it: copy the one document. */
    const loose = typeof file === 'string' && resolve(directory) === resolve(primaryRoot());
    let copied;
    if (loose) {
      await mkdir(join(target, 'skill'), { recursive: true });
      await copyFile(file, join(target, 'skill', basename(file)));
      copied = 1;
    } else {
      copied = (await copyTree(directory, join(target, 'skill'))).copied;
    }
    await atomicWrite(
      join(target, 'backup.json'),
      `${JSON.stringify({ name: skillName, at: stamp.toISOString(), reason, source: directory, ...(loose ? { document: basename(file) } : {}), copied }, null, 2)}\n`,
    );
    await this.pruneBackups();
    return { id: unique, copied };
  }

  /**
   * Clear whatever already holds `target` in the managed root, after backing it
   * up: replacing a skill must never destroy it silently.
   *
   * @param root - the managed root.
   * @param target - the slug of the name being replaced.
   * @param existing - the root listing that reported the collision.
   */
  async replaceExisting(root, target, existing) {
    const directory = join(root, target);
    const loose = looseDocumentOf(existing.files, target);
    if (loose !== undefined) {
      await this.backupSkill(root, target, 'overwrite', join(root, loose));
      await rm(join(root, loose), { force: true });
    }
    if (existing.dirs.includes(target)) {
      await this.backupSkill(directory, target, 'overwrite');
      await rm(directory, { recursive: true, force: true });
    }
  }

  /** Record a registry-record edit and return the refreshed inventory. */
  async touched() {
    this.refresh();
    return await this.inventory();
  }

  /* ---- Remote methods ---- */

  /**
   * Presence ping from the settings page.
   *
   * The page polls this alongside `state()`. It exists so the agent-facing
   * `skill_hub` tool can report whether the browser half is loaded and able to
   * reach this Host service — the one Client-side fact that is otherwise
   * invisible without access to the browser console.
   */
  async heartbeat() {
    this.lastClientSeen = Date.now();
    return jsonSafe({ at: this.lastClientSeen });
  }

  /** The full management view. */
  async state() {
    return jsonSafe(await this.inventory());
  }

  /** Read one skill's raw document plus its validation report. */
  async read(input) {
    input = input ?? {};
    const wanted = String(input.name ?? '').trim();
    if (wanted === '') throw new Error('`name` is required');
    const record = await this.find(wanted);
    if (record === undefined) throw new Error(`unknown skill ${JSON.stringify(wanted)}`);
    const located = this.locate(record);
    let content;
    let contentError;
    if (located.file !== undefined) {
      content = await readFile(located.file, 'utf8').catch((error) => {
        contentError = messageOf(error);
        return undefined;
      });
    }
    if (content === undefined) {
      /* Bundled skills may live inside an archive the filesystem cannot open;
         fall back to the registry's own copy of the document body. */
      try {
        const full = await this.root.skills.get(wanted);
        if (typeof full?.content === 'string') content = full.content;
      } catch (error) {
        contentError = messageOf(error);
      }
    }
    const validation = content === undefined ? undefined : validateSkill(content, located.directory === undefined ? undefined : basename(located.directory));
    return jsonSafe({
      name: record.name,
      source: record.source,
      directory: located.directory,
      file: located.file,
      writable: located.directory !== undefined && isInside(primaryRoot(), located.directory),
      content,
      contentError,
      validation,
      bytes: typeof content === 'string' ? Buffer.byteLength(content, 'utf8') : 0,
    });
  }

  /** Validate one skill document and return the verdict without writing it. */
  async validate(input) {
    input = input ?? {};
    const text = String(input.content ?? '');
    const directoryName = input.name === undefined ? undefined : String(input.name);
    return jsonSafe(validateSkill(text, directoryName));
  }

  /** Overwrite one managed skill's document. */
  async save(input) {
    input = input ?? {};
    const wanted = String(input.name ?? '').trim();
    if (wanted === '') throw new Error('`name` is required');
    const content = String(input.content ?? '');
    const record = await this.find(wanted);
    if (record === undefined) throw new Error(`unknown skill ${JSON.stringify(wanted)}`);
    const located = this.locate(record);
    if (located.file === undefined || located.directory === undefined) {
      throw new Error(`skill ${JSON.stringify(wanted)} has no file on disk to write`);
    }
    if (!isInside(primaryRoot(), located.directory)) {
      throw new Error(`skill ${JSON.stringify(wanted)} lives in a read-only source (${record.source}); copy it into ${primaryRoot()} first`);
    }
    const verdict = validateSkill(content, basename(located.directory));
    if (!verdict.ok) throw new Error(`refusing to save: ${verdict.errors.join('; ')}`);
    if (input.backup !== false) await this.backupSkill(located.directory, wanted, 'edit', located.file);
    await atomicWrite(located.file, content);
    this.log.info(`skill-hub: saved ${wanted}`);
    return jsonSafe({ saved: true, validation: verdict, state: await this.touched() });
  }

  /** Create a new skill directory from form fields. */
  async create(input) {
    input = input ?? {};
    const rawName = String(input.name ?? '').trim();
    if (rawName === '') throw new Error('`name` is required');
    if (!NAME_PATTERN.test(rawName)) {
      throw new Error('`name` must be kebab-case: lowercase letters, digits and single hyphens');
    }
    const description = String(input.description ?? '').trim();
    if (description === '') throw new Error('`description` is required');
    const root = primaryRoot();
    await mkdir(root, { recursive: true });
    const existing = await listRootEntries(root);
    if (existing.dirs.includes(rawName) || looseDocumentOf(existing.files, rawName) !== undefined) {
      throw new Error(`a skill named ${JSON.stringify(rawName)} already exists in ${root}`);
    }
    const registry = await this.snapshot();
    if (registry.skills.some((skill) => skill.name === rawName)) {
      throw new Error(`a skill named ${JSON.stringify(rawName)} is already registered (from another source)`);
    }
    const text = renderSkill({
      name: rawName,
      description,
      whenToUse: input.whenToUse === undefined ? undefined : String(input.whenToUse),
      body: input.body === undefined ? undefined : String(input.body),
      disabled: input.modelInvocable === false,
    });
    const directory = join(root, rawName);
    await mkdir(directory, { recursive: true });
    await atomicWrite(join(directory, SKILL_FILE), text);
    this.log.info(`skill-hub: created ${rawName} in ${directory}`);
    return jsonSafe({ created: rawName, directory, state: await this.touched() });
  }

  /** Inspect a directory for installable skills without changing anything. */
  async scanDir(input) {
    input = input ?? {};
    const source = String(input.source ?? input.dir ?? '').trim();
    if (source === '') throw new Error('`source` is required');
    return jsonSafe(await this.inspectSource(source));
  }

  /**
   * Unpack a `.zip` package into `$DSH_HOME/skill-hub/tmp`.
   *
   * Installing copies from the filesystem, and the skills inside an archive sit
   * at whatever depth the archiver chose, so the archive is materialized first
   * and `findSkills` then locates every `SKILL.md` in it.
   *
   * @param abs - absolute path to the archive.
   * @returns `{ root, extracted }` — the extraction root and the reader result.
   */
  async materializeZip(abs) {
    const extracted = extractZip(await readFile(abs), { maxBytes: MAX_ARCHIVE_BYTES });
    if (extracted.entries.length === 0) {
      throw new Error(`${basename(abs)} produced no files: ${extracted.errors.join('; ') || 'empty archive'}`);
    }
    /* One extraction at a time: a candidate list that is still on screen is
       re-derived from the archive by `installDir`, never from these paths. */
    await rm(tmpRoot(), { recursive: true, force: true });
    const root = join(tmpRoot(), `${String(process.pid)}-${Date.now().toString(36)}-${slugify(basename(abs).replace(/\.zip$/i, ''))}`);
    await mkdir(root, { recursive: true });
    const base = resolve(root);
    for (const entry of extracted.entries) {
      const target = join(root, ...entry.path.split('/'));
      const inside = resolve(target);
      /* `extractZip` already refused traversal, so this is a second lock on the
         same door rather than the only one. */
      if (inside !== base && !inside.startsWith(base + sep)) throw new Error(`refusing to write outside ${root}: ${entry.path}`);
      if (entry.type === 'dir') {
        await mkdir(target, { recursive: true });
        continue;
      }
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, entry.data);
    }
    return { root, extracted };
  }

  /**
   * Inspect a `.zip` skill package.
   *
   * @param abs - absolute path to the archive.
   * @returns `{ kind, candidates, skipped }`, like {@link SkillHub#inspectSource}.
   */
  async inspectZip(abs) {
    const { root, extracted } = await this.materializeZip(abs);
    const found = findSkills(extracted.entries);
    if (found.skills.length === 0) throw new Error(`no ${SKILL_FILE} found anywhere in ${basename(abs)}`);
    const candidates = found.skills.map((candidate) => {
      const directory = join(root, ...candidate.dir.split('/'));
      const verdict = validateSkill(candidate.entry.data.toString('utf8'), basename(candidate.dir));
      return {
        name: verdict.name ?? slugify(basename(candidate.dir)),
        directory,
        file: join(directory, SKILL_FILE),
        archive: abs,
        archiveDir: candidate.dir,
        description: verdict.description,
        ...candidateFlags(verdict),
        source: 'archive',
      };
    });
    return { kind: 'collection', candidates, skipped: extracted.skipped };
  }

  /**
   * List one directory level for the install wizard's folder browser.
   *
   * The Host-native directory picker only returns directories and the Client
   * cannot enumerate a folder's files, so the wizard asks here right after the
   * user picks a folder. This is what makes a `.zip` package selectable without
   * typing its path.
   *
   * @param input - `{ path }`; empty means `$DSH_HOME`.
   * @returns `{ path, parent, home, entries, truncated }`, where an entry is
   *   `{ name, path, kind }` with `kind` `dir`, `archive` or `document`.
   */
  async listLocal(input) {
    input = input ?? {};
    const raw = String(input.path ?? '').trim();
    const current = raw === '' ? homeDir() : resolve(raw);
    const info = await stat(current).catch(() => undefined);
    if (info === undefined) throw new Error(`no such path: ${current}`);
    if (!info.isDirectory()) throw new Error(`not a directory: ${current}`);
    let listed;
    try {
      listed = await readdir(current, { withFileTypes: true });
    } catch (error) {
      throw new Error(`cannot read ${current}: ${messageOf(error)}`);
    }
    const dirs = [];
    const files = [];
    for (const entry of listed) {
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        dirs.push({ name: entry.name, path, kind: 'dir' });
        continue;
      }
      if (!entry.isFile() || !INSTALLABLE_FILE.test(entry.name) || entry.name.toLowerCase() === 'readme.md') continue;
      const info = await stat(path).catch(() => undefined);
      files.push({ name: entry.name, path, kind: entry.name.toLowerCase().endsWith('.md') ? 'document' : 'archive', size: info === undefined ? undefined : info.size });
    }
    const byName = (left, right) => left.name.localeCompare(right.name);
    dirs.sort(byName);
    files.sort(byName);
    const all = [...dirs, ...files];
    const parent = dirname(current);
    /* The managed root is offered as a jump target, but only when it is really
       there: a link that can only fail is worse than no link. */
    const rootPath = primaryRoot();
    const rootInfo = await stat(rootPath).catch(() => undefined);
    return jsonSafe({
      path: current,
      parent: parent === current ? undefined : parent,
      home: homeDir(),
      root: rootInfo === undefined ? undefined : rootPath,
      entries: all.slice(0, MAX_LIST_ENTRIES),
      truncated: all.length > MAX_LIST_ENTRIES,
    });
  }

  /**
   * Take one file the page picked in a real "open file" dialog and put it
   * somewhere the ordinary installer can read it.
   *
   * A browser never reveals the path of a chosen file, only its bytes, so the
   * wizard cannot hand `scanDir` the path the user clicked. Uploading the bytes
   * is what closes that gap: the result is a plain temp path, and from there the
   * local install pipeline (inspection, candidates, overwrite, backups) is
   * unchanged. Uploads live under `$DSH_HOME/skill-hub/uploads`, are capped at
   * `MAX_UPLOAD_BYTES` and at `MAX_UPLOADS` files, and are cleared on boot.
   *
   * @param input - `{ name, data }`, where `data` is base64 of the file.
   * @returns `{ source, name, size }` — `source` is what `scanDir`/`installDir` want.
   */
  async upload(input) {
    input = input ?? {};
    const raw = String(input.name ?? '').trim().replace(/\\/g, '/');
    const name = basename(raw);
    if (name === '' || name === '.' || name === '..') throw new Error('`name` is required');
    if (!INSTALLABLE_FILE.test(name) || name.toLowerCase() === 'readme.md') {
      throw new Error(`only a .md document, a .zip package or a .tar.gz archive can be uploaded, got ${name}`);
    }
    const data = String(input.data ?? '').replace(/\s+/g, '');
    if (data === '') throw new Error('`data` is required');
    /* Reject on the encoded size first: 4 base64 characters carry 3 bytes, and
       decoding a multi-megabyte string only to throw it away wastes the heap. */
    if (Math.floor((data.length * 3) / 4) > MAX_UPLOAD_BYTES) {
      throw new Error(`refusing an upload over ${String(MAX_UPLOAD_BYTES)} bytes`);
    }
    const bytes = Buffer.from(data, 'base64');
    if (bytes.byteLength === 0) throw new Error(`the uploaded ${name} was empty`);
    if (bytes.byteLength > MAX_UPLOAD_BYTES) {
      throw new Error(`refusing a ${String(bytes.byteLength)}-byte upload (limit ${String(MAX_UPLOAD_BYTES)})`);
    }
    const directory = uploadsRoot();
    await mkdir(directory, { recursive: true });
    const source = join(directory, `${Date.now().toString(36)}-${String(process.pid)}-${slugify(name.replace(INSTALLABLE_FILE, ''))}${suffixOf(name)}`);
    await writeFile(source, bytes);
    await this.pruneUploads(source);
    this.log.info(`skill-hub: received ${name} (${String(bytes.byteLength)} bytes) from the page`);
    return jsonSafe({ source, name, size: bytes.byteLength });
  }

  /** Keep the newest `MAX_UPLOADS` uploads, dropping the rest. */
  async pruneUploads(keep) {
    const listed = await readdir(uploadsRoot(), { withFileTypes: true }).catch(() => []);
    const files = [];
    for (const entry of listed) {
      if (!entry.isFile()) continue;
      const path = join(uploadsRoot(), entry.name);
      if (path === keep) continue;
      const info = await stat(path).catch(() => undefined);
      files.push({ path, at: info === undefined ? 0 : info.mtimeMs });
    }
    files.sort((left, right) => left.at - right.at);
    for (const entry of files.slice(0, Math.max(0, files.length - (MAX_UPLOADS - 1)))) {
      await rm(entry.path, { force: true }).catch(() => {});
    }
  }

  /**
   * List the skills inside a GitHub repository without installing anything: the
   * "browse a repo, then install the one you want" half of the wizard.
   *
   * It downloads the archive and reads it in memory, exactly like `installUrl`,
   * so mirrors, timeouts and size caps behave the same and the `path` values it
   * returns are the ones `installUrl` accepts.
   *
   * @param input - `{ repo, ref, url, mirror }`.
   * @returns `{ repo, ref, skills, skipped }`, where a skill is
   *   `{ name, path, description, valid, errors }`.
   */
  async browseRepo(input) {
    input = input ?? {};
    const explicitUrl = String(input.url ?? '').trim();
    const mirror = input.mirror === undefined ? this.config.mirror : String(input.mirror);
    const urls = [];
    let repo = '';
    let ref = 'main';
    if (String(input.repo ?? '').trim() !== '') {
      const built = archiveCandidates({ repo: input.repo, ref: input.ref });
      repo = built.repo;
      ref = built.ref;
      for (const url of built.urls) urls.push(applyMirror(url, mirror));
    }
    if (explicitUrl !== '') urls.push(explicitUrl);
    if (urls.length === 0) throw new Error('`repo` or `url` is required to list a repository');

    const failures = [];
    let bytes;
    for (const url of urls) {
      try {
        bytes = await fetchBytes(url);
        break;
      } catch (error) {
        failures.push(`${url} → ${messageOf(error)}`);
      }
    }
    if (bytes === undefined) throw new Error(`every download route failed:\n${failures.join('\n')}`);

    const extracted = extractTarGz(bytes, { strip: 1 });
    if (extracted.entries.length === 0) {
      throw new Error(`archive produced no files: ${extracted.errors.join('; ') || 'empty'}`);
    }
    const found = findSkills(extracted.entries);
    if (found.skills.length === 0) throw new Error(`no ${SKILL_FILE} found anywhere in ${repo === '' ? explicitUrl : `${repo}@${ref}`}`);
    const skills = found.skills.map((entry) => {
      const verdict = validateSkill(entry.entry.data.toString('utf8'), basename(entry.dir));
      return {
        name: verdict.name ?? slugify(basename(entry.dir)),
        path: entry.dir,
        description: verdict.description,
        ...candidateFlags(verdict),
      };
    });
    skills.sort((left, right) => left.path.localeCompare(right.path));
    this.log.info(`skill-hub: listed ${String(skills.length)} skill(s) in ${repo === '' ? explicitUrl : `${repo}@${ref}`}`);
    return jsonSafe({ repo, ref, skills, skipped: extracted.skipped });
  }

  /**
   * Inspect an arbitrary path for skill candidates.
   *
   * Accepts a directory holding `SKILL.md`, a directory holding several skill
   * directories, a single `.md` document, or a `.zip` package of any shape.
   * @param source - absolute path.
   * @returns `{ kind, candidates, skipped }`.
   */
  async inspectSource(source) {
    const abs = resolve(source);
    const info = await stat(abs).catch(() => undefined);
    if (info === undefined) throw new Error(`no such path: ${abs}`);
    const skipped = [];
    if (info.isFile()) {
      if (abs.toLowerCase().endsWith('.zip')) return await this.inspectZip(abs);
      if (!abs.toLowerCase().endsWith('.md')) throw new Error(`only a .md document, a .zip package or a directory can be installed, got ${basename(abs)}`);
      const text = await readFile(abs, 'utf8');
      const verdict = validateSkill(text, basename(abs, '.md'));
      return {
        kind: 'file',
        candidates: [
          {
            name: verdict.name ?? slugify(basename(abs, '.md')),
            directory: dirname(abs),
            file: abs,
            description: verdict.description,
            ...candidateFlags(verdict),
            source: 'file',
          },
        ],
        skipped,
      };
    }
    const own = join(abs, SKILL_FILE);
    if (await exists(own)) {
      const verdict = validateSkill(await readFile(own, 'utf8'), basename(abs));
      return {
        kind: 'skill',
        candidates: [
          {
            name: verdict.name ?? slugify(basename(abs)),
            directory: abs,
            file: own,
            description: verdict.description,
            ...candidateFlags(verdict),
            source: 'directory',
          },
        ],
        skipped,
      };
    }
    const candidates = [];
    let entries;
    try {
      entries = await readdir(abs, { withFileTypes: true });
    } catch (error) {
      throw new Error(`cannot read ${abs}: ${messageOf(error)}`);
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      if (entry.isSymbolicLink()) {
        skipped.push(`${entry.name}: symbolic link`);
        continue;
      }
      if (entry.isFile() && entry.name.toLowerCase().endsWith('.md') && entry.name.toLowerCase() !== 'readme.md') {
        const file = join(abs, entry.name);
        const verdict = validateSkill(await readFile(file, 'utf8'), basename(entry.name, '.md'));
        if (verdict.ok || verdict.renamable === true || verdict.errors.length > 1) {
          candidates.push({
            name: verdict.name ?? slugify(basename(entry.name, '.md')),
            directory: abs,
            file,
            description: verdict.description,
            ...candidateFlags(verdict),
            source: 'file',
          });
        }
        continue;
      }
      if (!entry.isDirectory()) continue;
      const file = join(abs, entry.name, SKILL_FILE);
      if (!(await exists(file))) {
        skipped.push(`${entry.name}: no ${SKILL_FILE}`);
        continue;
      }
      const verdict = validateSkill(await readFile(file, 'utf8'), entry.name);
      candidates.push({
        name: verdict.name ?? slugify(entry.name),
        directory: join(abs, entry.name),
        file,
        description: verdict.description,
        ...candidateFlags(verdict),
        source: 'directory',
      });
    }
    if (candidates.length === 0) throw new Error(`no ${SKILL_FILE} found in ${abs} or its immediate subdirectories`);
    return { kind: 'collection', candidates, skipped };
  }
  /**
   * Copy one candidate into the managed root.
   *
   * @param candidate - a result of {@link SkillHub#inspectSource}.
   * @param requestedName - explicit target name, or undefined to derive one.
   * @param overwrite - replace an existing directory of the same name.
   */
  async place(candidate, requestedName, overwrite) {
    const root = primaryRoot();
    await mkdir(root, { recursive: true });
    const existing = await listRootEntries(root);
    const taken = new Set([...existing.dirs, ...existing.files.map(stemOfDocument)]);
    /* A source whose own name breaks the scanner's grammar is installed under
       the suggested legal name, so `place` and its caller agree on the target. */
    const fallback = candidate.valid === true || candidate.renamable !== true ? candidate.name : candidate.suggested ?? candidate.name;
    const asked = requestedName === undefined || String(requestedName).trim() === '';
    let target = asked ? slugify(fallback) : slugify(requestedName);
    if (taken.has(target)) {
      if (overwrite !== true) throw new Error(`a skill named ${JSON.stringify(target)} already exists in ${root}; turn on overwrite to replace it`);
      await this.replaceExisting(root, target, existing);
    } else if (asked) {
      target = uniqueName(fallback, taken);
    }
    const directory = join(root, target);
    /* A loose document is one file, whatever its parent directory holds: it
       becomes `<root>/<name>/SKILL.md` rather than dragging its siblings in. */
    if (candidate.source === 'file') {
      await mkdir(directory, { recursive: true });
      const text = await readFile(candidate.file, 'utf8');
      await atomicWrite(join(directory, SKILL_FILE), alignSkillName(text, target));
      return { name: target, directory, files: 1, skipped: [] };
    }
    const report = await copyTree(candidate.directory, directory);
    if (report.copied === 0) {
      await rm(directory, { recursive: true, force: true });
      throw new Error(
        report.truncated
          ? `nothing to copy from ${candidate.directory}: it exceeds the copy limits (${String(MAX_COPY_FILES)} files / ${String(MAX_COPY_BYTES / (1024 * 1024))} MB)`
          : `nothing to copy from ${candidate.directory}`,
      );
    }
    await this.alignInstalled(directory, target);
    /* A partial copy must never look like a successful install. */
    return { name: target, directory, files: report.copied, skipped: report.skipped, truncated: report.truncated === true };
  }

  /**
   * Make the installed `SKILL.md` agree with the name it was installed under.
   *
   * The scanner keys on the frontmatter `name` and skips a skill whose name
   * breaks the grammar, so a source with a CJK or capitalised name would be
   * copied into a directory the harness then ignores. Only that one field is
   * touched, and only when it really differs; everything else stays verbatim.
   *
   * @param directory - the installed skill directory.
   * @param target - the name the skill was installed as.
   */
  async alignInstalled(directory, target) {
    const file = join(directory, SKILL_FILE);
    const current = await readFile(file, 'utf8').catch(() => undefined);
    if (current === undefined) return;
    const aligned = alignSkillName(current, target);
    if (aligned !== current) await atomicWrite(file, aligned);
  }

  /**
   * Write a skill document that was fetched rather than read from disk.
   *
   * @param text - the `SKILL.md` contents.
   * @param requestedName - explicit target name, or undefined to use the document's own.
   * @param overwrite - replace an existing directory of the same name.
   */
  async placeDocument(text, requestedName, overwrite) {
    const verdict = validateSkill(text, requestedName === undefined ? undefined : slugify(String(requestedName)));
    /* A document whose only problem is the name grammar is salvageable: it is
       written under a legal name with the field rewritten to match. */
    const renamable = verdict.ok !== true && verdict.renamable === true;
    if (verdict.ok !== true && !renamable) throw new Error(`downloaded document is not a valid skill: ${verdict.errors.join('; ')}`);
    const root = primaryRoot();
    await mkdir(root, { recursive: true });
    const existing = await listRootEntries(root);
    const taken = new Set([...existing.dirs, ...existing.files.map(stemOfDocument)]);
    const explicit = requestedName !== undefined && String(requestedName).trim() !== '';
    let target = explicit ? slugify(String(requestedName)) : slugify(renamable ? verdict.suggested : verdict.name ?? 'skill');
    if (taken.has(target)) {
      if (overwrite !== true) throw new Error(`a skill named ${JSON.stringify(target)} already exists in ${root}; turn on overwrite to replace it`);
      await this.replaceExisting(root, target, existing);
    } else if (!explicit) {
      target = uniqueName(renamable ? verdict.suggested ?? 'skill' : verdict.name ?? 'skill', taken);
    }
    const directory = join(root, target);
    await mkdir(directory, { recursive: true });
    /* A valid document is written back verbatim; only a rename rewrites it. */
    await atomicWrite(join(directory, SKILL_FILE), verdict.name === target ? text : setField(text, 'name', target));
    return { name: target, directory, files: 1, validation: verdict, renamed: verdict.name === undefined || verdict.name === target ? undefined : { from: verdict.name, to: target } };
  }

  /** Install skills from a local directory, document or `.zip` package. */
  async installDir(input) {
    input = input ?? {};
    const source = String(input.source ?? '').trim();
    if (source === '') throw new Error('`source` is required');
    const inspection = await this.inspectSource(source);
    const wanted = input.path === undefined ? undefined : String(input.path).trim();
    let candidates = inspection.candidates;
    if (inspection.kind === 'collection') {
      if (wanted !== undefined && wanted !== '') {
        candidates = candidates.filter((candidate) => candidate.name === wanted || basename(candidate.directory) === wanted);
        if (candidates.length === 0) {
          const available = inspection.candidates.map((candidate) => candidate.name).join(', ');
          throw new Error(`no skill named ${JSON.stringify(wanted)} in ${source}; available: ${available}`);
        }
      } else if (candidates.length > 1 && input.all !== true) {
        return jsonSafe({
          needSelection: true,
          kind: inspection.kind,
          candidates: inspection.candidates.map((candidate) => ({ name: candidate.name, directory: candidate.directory, description: candidate.description, valid: candidate.valid, errors: candidate.errors, renamable: candidate.renamable === true, suggested: candidate.suggested })),
          skipped: inspection.skipped,
        });
      }
    }
    const installed = [];
    const rejected = [];
    const skippedExisting = [];
    /* A batch source is a catalogue: a name that is already installed is a
       reason to skip that entry, not to abandon the rest of the batch. An
       explicit single-skill request still fails loudly. */
    const batch = candidates.length > 1;
    const listed = await listRootEntries(primaryRoot());
    const existing = new Set([...listed.dirs, ...listed.files.map(stemOfDocument)]);
    for (const candidate of candidates) {
      /* A name that breaks only the grammar is not a reason to refuse: the
         scanner would ignore the skill either way, so it is installed under a
         legal name with the field rewritten to match. */
      const renamable = candidate.valid !== true && candidate.renamable === true;
      if (candidate.valid !== true && !renamable) {
        rejected.push({ name: candidate.name, errors: candidate.errors });
        continue;
      }
      const explicit = candidates.length === 1 ? input.name : undefined;
      const fallback = renamable ? candidate.suggested ?? candidate.name : candidate.name;
      const target = slugify(explicit === undefined || String(explicit).trim() === '' ? fallback : String(explicit));
      if (batch && input.overwrite !== true && existing.has(target)) {
        skippedExisting.push(target);
        continue;
      }
      const placed = await this.place(candidate, explicit, input.overwrite === true);
      existing.add(placed.name);
      installed.push({
        name: placed.name,
        directory: placed.directory,
        files: placed.files,
        from: candidate.directory,
        skipped: placed.skipped,
        truncated: placed.truncated === true,
        renamed: renamable ? { from: candidate.name, to: placed.name } : undefined,
      });
    }
    if (installed.length === 0 && skippedExisting.length === 0) {
      throw new Error(`nothing installed: ${rejected.map((entry) => `${entry.name} (${entry.errors.join('; ')})`).join(', ') || 'no valid candidate'}`);
    }
    this.log.info(`skill-hub: installed ${installed.map((entry) => entry.name).join(', ') || '(nothing new)'} from ${source}`);
    return jsonSafe({ installed, rejected, skippedExisting, skipped: inspection.skipped, state: await this.touched() });
  }

  /**
   * Install from a URL: a GitHub repository archive, any `.tar.gz`, or a single
   * markdown document.
   *
   * @param input - `{ repo, ref, path, url, mirror, mode, name, overwrite, all }`.
   */
  async installUrl(input) {
    input = input ?? {};
    const explicitUrl = String(input.url ?? '').trim();
    const repo = input.repo === undefined ? '' : String(input.repo).trim();
    const mirror = input.mirror === undefined ? this.config.mirror : String(input.mirror);
    const requested = input.path === undefined || String(input.path).trim() === '' ? undefined : String(input.path).trim();
    let mode = String(input.mode ?? '').trim();
    if (mode === '') {
      if (explicitUrl.toLowerCase().endsWith('.md')) mode = 'file';
      else mode = 'archive';
    }
    const attempts = [];

    if (mode === 'file') {
      if (explicitUrl === '') throw new Error('`url` is required for mode=file');
      const bytes = await fetchBytes(explicitUrl, { max: MAX_COPY_BYTES });
      const placed = await this.placeDocument(bytes.toString('utf8'), input.name, input.overwrite === true);
      this.log.info(`skill-hub: installed ${placed.name} from ${explicitUrl}`);
      return jsonSafe({
        installed: [{ name: placed.name, directory: placed.directory, files: placed.files, from: explicitUrl, renamed: placed.renamed }],
        rejected: [],
        skipped: [],
        state: await this.touched(),
      });
    }

    const urls = [];
    if (repo !== '') {
      const built = archiveCandidates({ repo, ref: input.ref, path: requested });
      for (const url of built.urls) urls.push(applyMirror(url, mirror));
      attempts.push(`repo ${built.repo}@${built.ref}`);
    }
    if (explicitUrl !== '') urls.push(explicitUrl);
    if (urls.length === 0) throw new Error('`repo` or `url` is required to install from an archive');

    let bytes;
    const failures = [];
    for (const url of urls) {
      try {
        bytes = await fetchBytes(url);
        attempts.push(url);
        break;
      } catch (error) {
        failures.push(`${url} → ${messageOf(error)}`);
      }
    }
    if (bytes === undefined) {
      throw new Error(`every download route failed:\n${failures.join('\n')}`);
    }

    const extracted = extractTarGz(bytes, { strip: 1 });
    if (extracted.entries.length === 0) {
      throw new Error(`archive produced no files: ${extracted.errors.join('; ') || 'empty'}`);
    }
    const found = findSkills(extracted.entries);
    if (found.skills.length === 0) throw new Error('no SKILL.md found anywhere in the archive');

    let picked = found.skills;
    if (requested !== undefined) {
      picked = found.skills.filter((entry) => entry.dir === requested || entry.dir.endsWith(`/${requested}`) || basename(entry.dir) === requested);
      if (picked.length === 0) {
        const available = found.skills.map((entry) => entry.dir).slice(0, 40).join(', ');
        throw new Error(`no skill at ${JSON.stringify(requested)} in the archive; available: ${available}`);
      }
    } else if (found.skills.length > 1 && input.all !== true) {
      return jsonSafe({
        needSelection: true,
        kind: 'archive',
        source: urls[0],
        candidates: found.skills.map((entry) => {
          const verdict = validateSkill(entry.entry.data.toString('utf8'), basename(entry.dir));
          return { name: verdict.name ?? slugify(basename(entry.dir)), path: entry.dir, description: verdict.description, ...candidateFlags(verdict) };
        }),
        skipped: extracted.skipped,
      });
    }

    const root = primaryRoot();
    await mkdir(root, { recursive: true });
    const listed = await listRootEntries(root);
    const taken = new Set([...listed.dirs, ...listed.files.map(stemOfDocument)]);
    const installed = [];
    const rejected = [];
    const skippedExisting = [];
    const batch = picked.length > 1;
    for (const candidate of picked) {
      const text = candidate.entry.data.toString('utf8');
      const verdict = validateSkill(text, basename(candidate.dir));
      /* Only the name grammar is worth rescuing; anything else is a real defect. */
      const renamable = verdict.ok !== true && verdict.renamable === true;
      if (verdict.ok !== true && !renamable) {
        rejected.push({ name: basename(candidate.dir), path: candidate.dir, errors: verdict.errors });
        continue;
      }
      const explicit = picked.length === 1 && input.name !== undefined && String(input.name).trim() !== '' ? slugify(String(input.name)) : undefined;
      let target = explicit ?? slugify(renamable ? verdict.suggested ?? basename(candidate.dir) : verdict.name ?? basename(candidate.dir));
      if (taken.has(target)) {
        if (batch && input.overwrite !== true) {
          skippedExisting.push(target);
          continue;
        }
        if (input.overwrite !== true) throw new Error(`a skill named ${JSON.stringify(target)} already exists in ${root}; turn on overwrite to replace it`);
        await this.replaceExisting(root, target, await listRootEntries(root));
      } else if (explicit === undefined) {
        target = uniqueName(target, taken);
      }
      taken.add(target);
      const directory = join(root, target);
      await mkdir(directory, { recursive: true });
      const scope = `${candidate.dir}/`;
      let files = 0;
      for (const entry of extracted.entries) {
        if (entry.type !== 'file') continue;
        if (candidate.dir !== '.' && !entry.path.startsWith(scope)) continue;
        const rel = candidate.dir === '.' ? entry.path : entry.path.slice(scope.length);
        if (rel === '' || rel.startsWith('/') || rel.split('/').includes('..')) continue;
        if (JUNK_DIRS.has(rel.split('/')[0]) || JUNK_FILES.has(basename(rel))) continue;
        const dest = join(directory, rel);
        if (!isInside(directory, dest)) continue;
        await mkdir(dirname(dest), { recursive: true });
        await writeFile(dest, entry.data);
        files += 1;
      }
      if (files === 0) {
        await rm(directory, { recursive: true, force: true });
        rejected.push({ name: target, path: candidate.dir, errors: ['no files were written'] });
        continue;
      }
      await this.alignInstalled(directory, target);
      installed.push({ name: target, directory, files, from: `${attempts.at(-1) ?? 'archive'}#${candidate.dir}`, renamed: renamable ? { from: verdict.name, to: target } : undefined });
    }
    if (installed.length === 0 && skippedExisting.length === 0) {
      throw new Error(`nothing installed: ${rejected.map((entry) => `${entry.name} (${entry.errors.join('; ')})`).join(', ') || 'no valid candidate'}`);
    }
    this.log.info(`skill-hub: installed ${installed.map((entry) => entry.name).join(', ') || '(nothing new)'} from archive`);
    return jsonSafe({ installed, rejected, skippedExisting, skipped: extracted.skipped, state: await this.touched() });
  }

  /** Delete a managed skill, keeping a backup by default. */
  async removeSkill(input) {
    input = input ?? {};
    const wanted = String(input.name ?? '').trim();
    if (wanted === '') throw new Error('`name` is required');
    const record = await this.find(wanted);
    if (record === undefined) throw new Error(`unknown skill ${JSON.stringify(wanted)}`);
    const located = this.locate(record);
    if (located.directory === undefined || !isInside(primaryRoot(), located.directory)) {
      throw new Error(`skill ${JSON.stringify(wanted)} comes from ${record.source} and is not managed here; only skills under ${primaryRoot()} can be deleted`);
    }
    let backup;
    if (input.hard !== true) backup = await this.backupSkill(located.directory, wanted, 'delete', located.file);
    /* A bundle is a directory; a loose document is a single file. */
    if (resolve(located.directory) === resolve(primaryRoot())) {
      await rm(located.file, { force: true });
    } else {
      await rm(located.directory, { recursive: true, force: true });
    }
    this.log.info(`skill-hub: removed ${wanted}${backup === undefined ? '' : ` (backup ${backup.id})`}`);
    return jsonSafe({ removed: wanted, backup, state: await this.touched() });
  }

  /** Flip the two invocation switches by editing only their frontmatter lines. */
  async setInvocation(input) {
    input = input ?? {};
    const wanted = String(input.name ?? '').trim();
    if (wanted === '') throw new Error('`name` is required');
    const record = await this.find(wanted);
    if (record === undefined) throw new Error(`unknown skill ${JSON.stringify(wanted)}`);
    const located = this.locate(record);
    if (located.file === undefined || located.directory === undefined) throw new Error(`skill ${JSON.stringify(wanted)} has no file`);
    if (!isInside(primaryRoot(), located.directory)) {
      throw new Error(`skill ${JSON.stringify(wanted)} comes from ${record.source} and is read-only; copy it into ${primaryRoot()} to change it`);
    }
    let text = await readFile(located.file, 'utf8');
    const before = validateSkill(text, basename(located.directory));
    if (!before.ok) throw new Error(`cannot edit a skill the scanner rejects: ${before.errors.join('; ')}`);
    if (input.modelInvocable !== undefined) {
      text = input.modelInvocable === false ? setField(text, 'disable-model-invocation', true) : removeField(text, 'disable-model-invocation');
    }
    if (input.userInvocable !== undefined) {
      text = input.userInvocable === false ? setField(text, 'user-invocable', false) : removeField(text, 'user-invocable');
    }
    const after = validateSkill(text, basename(located.directory));
    if (!after.ok) throw new Error(`edit would break the skill: ${after.errors.join('; ')}`);
    await atomicWrite(located.file, text);
    return jsonSafe({ name: wanted, validation: after, state: await this.touched() });
  }

  /** Persist plugin settings. */
  async setConfig(input) {
    input = input ?? {};
    const next = { ...this.config };
    if (input.mirror !== undefined) next.mirror = String(input.mirror).trim();
    if (input.backupLimit !== undefined) {
      const limit = Number(input.backupLimit);
      if (!Number.isInteger(limit) || limit < 0) throw new Error('`backupLimit` must be a non-negative integer');
      next.backupLimit = limit;
    }
    this.config = next;
    await atomicWrite(configFile(), `${JSON.stringify(next, null, 2)}\n`);
    await this.pruneBackups();
    return jsonSafe({ config: this.config, state: await this.inventory() });
  }

  /** Restore a skill from a backup, without overwriting a live skill. */
  async restoreBackup(input) {
    input = input ?? {};
    const id = String(input.id ?? '').trim();
    if (id === '') throw new Error('`id` is required');
    const dir = join(backupsDir(), id);
    if (!isInside(backupsDir(), dir) || !(await exists(dir))) throw new Error(`unknown backup ${JSON.stringify(id)}`);
    const meta = await readJson(join(dir, 'backup.json'));
    const source = join(dir, 'skill');
    const manifest = await backupManifest(dir);
    if (manifest === undefined) throw new Error(`backup ${JSON.stringify(id)} has no ${SKILL_FILE} to restore`);
    const looseFile = manifest.loose ? manifest.file : undefined;
    const text = await readFile(manifest.file, 'utf8');
    const verdict = validateSkill(text, typeof meta?.name === 'string' ? meta.name : undefined);
    if (!verdict.ok) throw new Error(`backup ${JSON.stringify(id)} does not validate: ${verdict.errors.join('; ')}`);
    const name = input.name === undefined || String(input.name).trim() === '' ? (verdict.name ?? slugify(typeof meta?.name === 'string' ? meta.name : id)) : slugify(String(input.name));
    const root = primaryRoot();
    if (looseFile !== undefined) {
      const document = join(root, `${name}.md`);
      const existing = await listRootEntries(root);
      const target = join(root, name);
      if ((await exists(document)) || (await exists(target))) {
        if (input.overwrite !== true) throw new Error(`${(await exists(document)) ? document : target} already exists; turn on overwrite to replace it`);
        await this.replaceExisting(root, name, existing);
      }
      await atomicWrite(document, text);
      this.log.info(`skill-hub: restored loose document ${name} from ${id}`);
      return jsonSafe({ restored: name, directory: root, file: document, files: 1, state: await this.touched() });
    }
    const target = join(root, name);
    if (await exists(target)) {
      if (input.overwrite !== true) throw new Error(`${target} already exists; turn on overwrite to replace it`);
      await this.backupSkill(target, name, 'restore-overwrite');
      await rm(target, { recursive: true, force: true });
    }
    const report = await copyTree(source, target);
    this.log.info(`skill-hub: restored ${name} from ${id}`);
    return jsonSafe({ restored: name, directory: target, files: report.copied, state: await this.touched() });
  }
}

markRemoteMethods(SkillHub, REMOTE_METHODS);

/* ------------------------------------------------------------------ *
 * Agent-facing tool
 * ------------------------------------------------------------------ */

/** Render one skill line for the agent-facing list. */
function skillLine(skill) {
  const flags = [];
  if (skill.modelInvocable !== true) flags.push('model-off');
  if (skill.userInvocable !== true) flags.push('user-off');
  if (skill.overridden === true) {
    flags.push(`overridden: the registry reports model ${skill.registryModelInvocable === true ? 'on' : 'off'}, user ${skill.registryUserInvocable === true ? 'on' : 'off'}`);
  }
  const origin = skill.registered === false ? 'managed; not in the registry' : skill.writable ? 'managed' : `read-only:${skill.source}`;
  return `- ${skill.name} [${origin}${flags.length === 0 ? '' : `; ${flags.join('; ')}`}] — ${String(skill.description ?? '').slice(0, 120)}`;
}

/**
 * Register one compact management tool so the model can install, read and
 * toggle skills in the same root the settings page edits.
 * @param ctx - plugin context carrying `tools`.
 * @param hub - the management service.
 */
function registerHubTool(ctx, hub) {
  ctx.tools.register(
    defineTool({
      name: 'skill_hub',
      description:
        'Manage the user\'s Agent Skills in $DSH_HOME/skills (the root the native scanner watches). `list` shows every skill from every source plus any file that is on disk but rejected by the scanner; `read` returns one SKILL.md; `create` and `edit` write one; `install` copies from a local directory, a local `.zip`, a URL, or a GitHub repository archive, and a source whose `name` breaks the scanner\'s kebab-case grammar is installed under a legal name with that one field rewritten (the rename is reported); `remove` deletes one (keeping a backup); `enable`/`disable` flip the two frontmatter invocation switches; `scan` inspects a path before installing.',
      parameters: {
        action: {
          type: 'string',
          required: true,
          enum: ['list', 'read', 'create', 'edit', 'install', 'remove', 'enable', 'disable', 'scan', 'backups', 'restore'],
          description: 'Operation to perform.',
        },
        name: { type: 'string', description: 'Skill name for read/create/edit/remove/enable/disable/restore.' },
        description: { type: 'string', description: 'Skill description for `create`.' },
        whenToUse: { type: 'string', description: 'Optional `whenToUse` line for `create`.' },
        content: { type: 'string', description: 'Full SKILL.md document for `edit`.' },
        body: { type: 'string', description: 'Markdown body for `create`.' },
        source: { type: 'string', description: 'Local directory, `.md` document or `.zip` package for `install`/`scan`.' },
        url: { type: 'string', description: 'Direct .tar.gz archive or .md document URL for `install`.' },
        repo: { type: 'string', description: 'GitHub owner/name for `install`.' },
        ref: { type: 'string', description: 'Branch or tag for `repo` installs (default main).' },
        mirror: { type: 'string', description: 'Prefix for a `repo` or GitHub `url` download when GitHub is unreachable, e.g. `https://gh-proxy.com/`; empty means direct.' },
        path: { type: 'string', description: 'Subdirectory inside the archive, e.g. `skills/pdf`.' },
        overwrite: { type: 'boolean', description: 'Replace an existing skill of the same name.' },
        all: { type: 'boolean', description: 'Install every candidate found in a multi-skill source.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { text: { type: 'string', required: true } },
        },
        render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '(no result)') }],
      },
      execute: async (args) => {
        const action = String(args.action);
        /** One-line-per-skill summary of an install result. */
        const installReport = (result) => {
          const parts = [
            result.installed.length === 0
              ? 'Nothing new to install.'
              : `Installed ${result.installed.map((entry) => `${entry.name} (${String(entry.files)} files) → ${entry.directory}`).join('\n')}`,
          ];
          const rescued = result.installed.filter((entry) => entry.renamed !== undefined);
          if (rescued.length > 0) {
            parts.push(`Renamed so the scanner loads them: ${rescued.map((entry) => `${entry.renamed.from} → ${entry.name}`).join('; ')}`);
          }
          if ((result.skippedExisting ?? []).length > 0) parts.push(`Already present: ${result.skippedExisting.join(', ')}`);
          const truncated = (result.installed ?? []).filter((entry) => entry.truncated === true);
          if (truncated.length > 0) parts.push(`INCOMPLETE COPY (copy limits reached, files were skipped): ${truncated.map((entry) => `${entry.name} — ${(entry.skipped ?? []).join('; ')}`).join('; ')}`);
          if ((result.rejected ?? []).length > 0) parts.push(`Rejected: ${result.rejected.map((entry) => `${entry.name}: ${entry.errors.join('; ')}`).join('; ')}`);
          return parts.join('\n');
        };
        switch (action) {
          case 'list': {
            const view = await hub.state();
            const where = view.lastClientSeen === 0 ? 'never (settings page not loaded)' : `${String(Math.round((Date.now() - view.lastClientSeen) / 1000))}s ago`;
            const head = `Managed root: ${view.root}\nRegistry: ${String(view.registryCount)} record(s)${view.complete === true ? '' : ' (incomplete)'}${view.error === undefined ? '' : ` (snapshot failed: ${view.error})`}\nSettings page last seen: ${where}.`;
            const parts = [head];
            if (view.registryBlind === true) {
              parts.push(
                `\nNOTE: the registry reports none of this root's skills, so it is blind to this root (a layered registry only merges the layers the caller's scope can reach) — not every file being invalid. The rows below come straight from disk and stay editable.`,
              );
            }
            if (view.skills.length > 0) parts.push(`\nSkills:\n${view.skills.map(skillLine).join('\n')}`);
            else parts.push('\nNo skills are registered.');
            if (view.broken.length > 0) {
              parts.push(
                `\nOn disk but NOT loaded by the scanner (${String(view.broken.length)}):\n${view.broken
                  .map((entry) => `- ${entry.name} — ${entry.reason}${entry.errors.length === 0 ? '' : `: ${entry.errors.join('; ')}`}`)
                  .join('\n')}`,
              );
            }
            if (view.shadowed.length > 0) {
              parts.push(`\nShadowed by a higher-ranked source (${String(view.shadowed.length)}):\n${view.shadowed.map((entry) => `- ${entry.name} — ${entry.reason}`).join('\n')}`);
            }
            if (view.backups.length > 0) parts.push(`\nBackups: ${String(view.backups.length)} (newest ${view.backups[0].id})`);
            return { text: parts.join('\n') };
          }
          case 'read': {
            const result = await hub.read({ name: args.name });
            if (result.content === undefined) throw new Error(`could not read ${JSON.stringify(String(args.name))}: ${result.contentError ?? 'no content'}`);
            const verdict = result.validation ?? {};
            return {
              text: `${result.file ?? '(browser-only skill)'}${result.writable ? '' : ' [read-only]'}\nvalidation: ${verdict.ok === true ? 'ok' : `FAILED — ${(verdict.errors ?? []).join('; ')}`}\n\n${result.content}`,
            };
          }
          case 'create': {
            const created = await hub.create({
              name: args.name,
              description: args.description,
              whenToUse: args.whenToUse,
              body: args.body,
            });
            return { text: `Created skill ${JSON.stringify(created.created)} at ${created.directory}.` };
          }
          case 'edit': {
            if (args.content === undefined) throw new Error('`content` is required for `edit`');
            const result = await hub.save({ name: args.name, content: String(args.content) });
            return { text: `Saved ${JSON.stringify(String(args.name))}. ${result.validation.warnings.length === 0 ? '' : `Warnings: ${result.validation.warnings.join('; ')}`}` };
          }
          case 'install': {
            if (args.source !== undefined) {
              const result = await hub.installDir({ source: args.source, name: args.name, path: args.path, overwrite: args.overwrite === true, all: args.all === true });
              if (result.needSelection === true) {
                return { text: `Several skills found; pass \`path\` or \`all\`:\n${result.candidates.map((entry) => `- ${entry.name} (${entry.valid ? 'valid' : `invalid: ${entry.errors.join('; ')}`})`).join('\n')}` };
              }
              return { text: installReport(result) };
            }
            const result = await hub.installUrl({ repo: args.repo, ref: args.ref, url: args.url, path: args.path, mirror: args.mirror, name: args.name, overwrite: args.overwrite === true, all: args.all === true });
            if (result.needSelection === true) {
              return { text: `Several skills in the archive; pass \`path\` or \`all\`:\n${result.candidates.map((entry) => `- ${entry.path}${entry.valid ? '' : ` (invalid: ${entry.errors.join('; ')})`}`).join('\n')}` };
            }
            return { text: installReport(result) };
          }
          case 'remove': {
            const result = await hub.removeSkill({ name: args.name });
            return { text: `Removed skill ${JSON.stringify(result.removed)}${result.backup === undefined ? '' : `; backup ${result.backup.id}`}.` };
          }
          case 'enable':
          case 'disable': {
            await hub.setInvocation({ name: args.name, modelInvocable: action === 'enable' });
            return { text: `${action === 'enable' ? 'Enabled' : 'Disabled'} model invocation for ${JSON.stringify(String(args.name))}.` };
          }
          case 'scan': {
            const result = await hub.scanDir({ source: args.source });
            return { text: `${result.kind} — ${String(result.candidates.length)} candidate(s):\n${result.candidates.map((entry) => `- ${entry.name} (${entry.valid ? 'valid' : `invalid: ${entry.errors.join('; ')}`}) ${entry.directory}`).join('\n')}${result.skipped.length === 0 ? '' : `\nSkipped: ${result.skipped.join('; ')}`}` };
          }
          case 'backups': {
            const view = await hub.state();
            if (view.backups.length === 0) return { text: `No backups in ${view.backupsDir}.` };
            return { text: `Backups (${view.backupsDir}):\n${view.backups.map((entry) => `- ${entry.id} — ${entry.name}${entry.at === undefined ? '' : ` at ${entry.at}`}${entry.reason === undefined ? '' : ` (${entry.reason})`}`).join('\n')}` };
          }
          case 'restore': {
            const result = await hub.restoreBackup({ id: args.name, name: undefined, overwrite: args.overwrite === true });
            return { text: `Restored ${JSON.stringify(result.restored)} into ${result.directory}.` };
          }
          default:
            throw new Error(`unsupported action ${JSON.stringify(action)}`);
        }
      },
    }),
  );
}

/* ------------------------------------------------------------------ *
 * Plugin entry
 * ------------------------------------------------------------------ */

/**
 * Mount the management service and register the agent-facing tool.
 * @param ctx - plugin context.
 */
export function apply(ctx) {
  const hub = new SkillHub(ctx);
  registerHubTool(ctx, hub);
  hub.boot().catch((error) => {
    ctx.logger.error(`skill-hub: settings could not be loaded: ${messageOf(error)}`);
  });
}
