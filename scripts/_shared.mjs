/**
 * _shared.mjs - helpers shared by scripts/install-local.mjs,
 * uninstall-local.mjs and smoke-check.mjs. Node 24 ESM, standard library only.
 *
 * The desktop profile is app-owned: these scripts never use pnpm and never write
 * package.json / pnpm-lock.yaml / pnpm-workspace.yaml. They only
 *   1. back up <profile>/cordis.patch.yml into <pluginRoot>/backup/<UTC stamp>/;
 *   2. upsert/remove one clearly marked top-level YAML block in that patch file;
 *   3. create/remove the linked-root symlink <profile>/node_modules/<pkg> -> <pluginRoot>.
 * Every write is atomic (temp file + rename) and rollback-able.
 */
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

export const SCRIPT_VERSION = '1.0.0';
export const PLUGIN_NAME = 'dsh-speaking-practice';
export const ROW_ID = 'voice-practice';
export const ENTRY_FILE = 'plugin.js';
export const DEFAULT_PROFILE = 'desktop';
export const PROFILE_PATCH_FILE = 'cordis.patch.yml';
export const MARK_BEGIN = '# >>> ' + PLUGIN_NAME + ' (managed by scripts/install-local.mjs)';
export const MARK_END = '# <<< ' + PLUGIN_NAME;

/* ------------------------------------------------------------------ paths */

/** Plugin root = parent directory of scripts/ (this file lives in <root>/scripts). */
export function pluginRootFrom(importMetaUrl) {
  return dirname(dirname(fileURLToPath(importMetaUrl)));
}

export function resolveProjectRoot(argRoot, importMetaUrl) {
  const raw = argRoot === undefined || argRoot === '' ? pluginRootFrom(importMetaUrl) : resolve(argRoot);
  return realpathOrNull(raw) ?? raw;
}

export function resolveDshHome() {
  const fromEnv = process.env.DSH_HOME;
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return resolve(fromEnv);
  return join(homedir(), '.dsh');
}

export function resolveProfileDir(values) {
  if (typeof values['profile-dir'] === 'string' && values['profile-dir'] !== '') {
    return resolve(values['profile-dir']);
  }
  const profile = typeof values.profile === 'string' && values.profile !== '' ? values.profile : DEFAULT_PROFILE;
  return join(resolveDshHome(), 'profiles', profile);
}

export function profilePaths(profileDir) {
  return {
    profileDir: profileDir,
    packageJson: join(profileDir, 'package.json'),
    patchFile: join(profileDir, PROFILE_PATCH_FILE),
    nodeModules: join(profileDir, 'node_modules'),
    linkPath: join(profileDir, 'node_modules', PLUGIN_NAME),
  };
}

export function realpathOrNull(path) {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------- args */

/**
 * Tiny argument parser: supports --flag, --key value and --key=value.
 * Unknown arguments are reported instead of silently ignored.
 */
export function parseArgs(argv, spec) {
  const valueFlags = new Set((spec && spec.values) || []);
  const boolFlags = new Set((spec && spec.bools) || []);
  const values = Object.create(null);
  const bools = Object.create(null);
  const unknown = [];
  const missing = [];
  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index];
    if (!raw.startsWith('--')) {
      unknown.push(raw);
      continue;
    }
    let name = raw.slice(2);
    let inline;
    const eq = name.indexOf('=');
    if (eq >= 0) {
      inline = name.slice(eq + 1);
      name = name.slice(0, eq);
    }
    if (boolFlags.has(name)) {
      bools[name] = true;
      continue;
    }
    if (!valueFlags.has(name)) {
      unknown.push(raw);
      continue;
    }
    if (inline !== undefined) {
      values[name] = inline;
      continue;
    }
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) {
      missing.push(name);
      continue;
    }
    values[name] = next;
    index += 1;
  }
  return { values: values, bools: bools, unknown: unknown, missing: missing };
}

export function usageError(message) {
  process.stderr.write('错误: ' + message + '\n');
  process.exitCode = 2;
}

/* ------------------------------------------------------------------- logs */

export function line(text) {
  process.stdout.write((text === undefined ? '' : text) + '\n');
}

export function warn(text) {
  process.stderr.write('警告: ' + text + '\n');
}

export function numbered(index, text) {
  line('  ' + index + '. ' + text);
}

/* ------------------------------------------------------------------- yaml */

/** JSON escaping is a valid YAML double-quoted scalar for every path we emit. */
export function yamlString(value) {
  return JSON.stringify(value);
}

export function managedBlockLines(fields) {
  return [
    MARK_BEGIN,
    '- insert:',
    '    - id: ' + ROW_ID,
    '      name: ' + yamlString(fields.entryPath),
    '      config:',
    '        practiceRoot: ' + yamlString(fields.practiceRoot),
    MARK_END,
  ];
}

export function managedBlockText(fields) {
  return managedBlockLines(fields).join('\n') + '\n';
}

export function splitLines(content) {
  return content.split('\n');
}

/** Locate every managed block; a begin marker without an end marker extends to EOF. */
export function findManagedBlocks(content) {
  const lines = splitLines(content);
  const blocks = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].trim() !== MARK_BEGIN) continue;
    let end = index + 1;
    while (end < lines.length && lines[end].trim() !== MARK_END) end += 1;
    blocks.push({ begin: index, end: Math.min(end, lines.length - 1), closed: end < lines.length });
    index = end;
  }
  return blocks;
}

/** Remove every managed block (and nothing else). Returns the count removed. */
export function stripManagedBlocks(content) {
  const lines = splitLines(content);
  const kept = [];
  let removed = 0;
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].trim() !== MARK_BEGIN) {
      kept.push(lines[index]);
      continue;
    }
    removed += 1;
    let end = index + 1;
    while (end < lines.length && lines[end].trim() !== MARK_END) end += 1;
    index = end;
  }
  return { content: kept.join('\n'), removed: removed };
}

/**
 * Drop a bare empty-sequence placeholder ("[]" alone on its line, possibly with
 * comments around it). Appending a block item after "[]" would be invalid YAML,
 * so the placeholder is replaced by the managed block instead.
 */
function dropEmptySequencePlaceholder(text) {
  const lines = splitLines(text);
  const meaningful = lines.filter((value) => value.trim() !== '' && value.trim().startsWith('#') === false);
  if (meaningful.length !== 1 || meaningful[0].trim() !== '[]') return text;
  return lines.filter((value) => value.trim() !== '[]').join('\n');
}

/**
 * Replace any existing managed block with fields, appended at the end of the
 * file. Existing content keeps its exact order; only the marked block moves.
 */
export function upsertManagedBlock(content, fields) {
  const stripped = stripManagedBlocks(content);
  let base = dropEmptySequencePlaceholder(stripped.content);
  if (base.trim() === '') base = '';
  if (base !== '' && !base.endsWith('\n')) base += '\n';
  const next = base + managedBlockText(fields);
  return { content: next, changed: next !== content, removed: stripped.removed };
}

/**
 * Remove managed blocks. A file that would be left without any YAML content must
 * still be the valid empty patch list ([]), because an empty or comment-only
 * profile patch file makes profile loading fail.
 */
export function removeManagedBlock(content) {
  const stripped = stripManagedBlocks(content);
  let next = stripped.content;
  const meaningful = splitLines(next).filter((value) => value.trim() !== '' && value.trim().startsWith('#') === false);
  if (meaningful.length === 0) {
    let base = next;
    if (base !== '' && !base.endsWith('\n')) base += '\n';
    next = base + '[]\n';
  }
  return { content: next, changed: next !== content, removed: stripped.removed };
}

export function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

/* --------------------------------------------------------------------- fs */

export function readTextIfExists(file) {
  try {
    const stat = statSync(file);
    if (!stat.isFile()) return { exists: true, content: null, mode: stat.mode & 0o7777, stat: stat };
    return { exists: true, content: readFileSync(file, 'utf8'), mode: stat.mode & 0o7777, stat: stat };
  } catch (error) {
    if (error && error.code === 'ENOENT') return { exists: false, content: null, mode: undefined, stat: undefined };
    throw error;
  }
}

/** Write a file atomically: same-directory temp file then rename; keeps the mode. */
export function atomicWriteFile(file, content, mode) {
  const tmp = join(dirname(file), '.' + basename(file) + '.tmp-' + process.pid + '-' + Date.now());
  const options = mode === undefined ? undefined : { mode: mode };
  try {
    writeFileSync(tmp, content, options);
    if (mode !== undefined) chmodSync(tmp, mode);
    renameSync(tmp, file);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {}
    throw error;
  }
}

/* ---------------------------------------------------------------- symlink */

/**
 * Inspect <profile>/node_modules/<PLUGIN_NAME>.
 * kind: 'absent' | 'symlink' | 'dir' | 'file'
 */
export function inspectLink(linkPath) {
  let stat;
  try {
    stat = lstatSync(linkPath);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return { path: linkPath, kind: 'absent', rawTarget: null, realTarget: null };
    }
    throw error;
  }
  if (stat.isSymbolicLink()) {
    const rawTarget = readlinkSync(linkPath);
    return { path: linkPath, kind: 'symlink', rawTarget: rawTarget, realTarget: realpathOrNull(linkPath) };
  }
  return { path: linkPath, kind: stat.isDirectory() ? 'dir' : 'file', rawTarget: null, realTarget: null };
}

/**
 * A symlink belongs to this checkout when it resolves to the plugin root, or is
 * dangling but was created with the plugin root as its target.
 */
export function linkOwnedBy(inspected, pluginRoot) {
  if (inspected.kind !== 'symlink') return false;
  if (inspected.realTarget !== null) return inspected.realTarget === pluginRoot;
  const raw = isAbsolute(inspected.rawTarget) ? resolve(inspected.rawTarget) : resolve(dirname(inspected.path), inspected.rawTarget);
  return raw === pluginRoot;
}

/* --------------------------------------------------------- bare imports */

const BARE_IMPORT_PATTERNS = [
  /^[ \t]*(?:import|export)\b[^\n]*?\bfrom[ \t]*['"]([^'"]+)['"]/gm,
  /^[ \t]*import[ \t]*['"]([^'"]+)['"]/gm,
  /\bimport[ \t]*\([ \t]*['"]([^'"]+)['"]/g,
  /\brequire[ \t]*\([ \t]*['"]([^'"]+)['"]/g,
];

const IGNORED_SCAN_DIRS = new Set(['node_modules', '.git', 'logs', 'backup', 'lab', 'coverage', '.cache']);

function isBareSpecifier(specifier) {
  if (specifier === '') return false;
  const first = specifier[0];
  if (first === '.' || first === '/' || first === '#') return false;
  if (specifier.startsWith('node:')) return false;
  if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(specifier)) return false;
  return true;
}

/**
 * Collect bare package imports found in the plugin's own JavaScript files.
 * Used only to decide whether the linked-root symlink is required for peer
 * resolution; a false positive is harmless (it keeps the symlink), while a
 * missed real bare import would break the child plugin at import time.
 *
 * @param {string} pluginRoot
 * @param {{maxFiles?: number, maxBytes?: number}} [options]
 * @returns {{specifiers: string[], files: string[]}}
 */
export function scanBareImports(pluginRoot, options) {
  const settings = options || {};
  const maxFiles = settings.maxFiles === undefined ? 400 : settings.maxFiles;
  const maxBytes = settings.maxBytes === undefined ? 2 * 1024 * 1024 : settings.maxBytes;
  const found = new Map();
  const files = [];
  const walk = (directory) => {
    if (files.length >= maxFiles) return;
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= maxFiles) return;
      if (entry.name.startsWith('.')) continue;
      const full = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (IGNORED_SCAN_DIRS.has(entry.name)) continue;
        walk(full);
        continue;
      }
      if (!/\.(?:m?js|cjs)$/u.test(entry.name)) continue;
      let stat;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (!stat.isFile() || stat.size > maxBytes) continue;
      files.push(full);
      const source = readFileSync(full, 'utf8');
      for (const pattern of BARE_IMPORT_PATTERNS) {
        pattern.lastIndex = 0;
        for (const match of source.matchAll(pattern)) {
          const specifier = match[1];
          if (!isBareSpecifier(specifier)) continue;
          if (!found.has(specifier)) found.set(specifier, full);
        }
      }
    }
  };
  walk(pluginRoot);
  return { specifiers: Array.from(found.keys()).sort(), files: files };
}

/* ----------------------------------------------------------------- backup */

/** UTC stamp safe for directory names: 20261026T090500Z. */
export function utcStamp(date) {
  const value = date === undefined ? new Date() : date;
  return value.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

export function uniqueDirectory(parent, name) {
  let candidate = join(parent, name);
  let index = 1;
  while (existsSync(candidate)) {
    candidate = join(parent, name + '-' + index);
    index += 1;
  }
  return candidate;
}

/**
 * Create backup/<stamp>/ and copy the named files into it. Writes state.json
 * with the pre-change state so a human can restore files manually.
 *
 * @param {object} options
 * @param {string} options.backupRoot  e.g. <pluginRoot>/backup
 * @param {string} options.action      install | uninstall
 * @param {string} options.pluginRoot
 * @param {string} options.profileDir
 * @param {string} options.entryPath
 * @param {Array<{label: string, path: string}>} options.files
 * @param {object} [options.state]     extra JSON-serializable state
 * @returns {{dir: string, records: Array<object>}}
 */
export function createBackup(options) {
  const stamp = options.stamp === undefined ? utcStamp() : options.stamp;
  mkdirSync(options.backupRoot, { recursive: true });
  const dir = uniqueDirectory(options.backupRoot, stamp);
  mkdirSync(dir, { recursive: false });
  const records = [];
  for (const file of options.files) {
    const target = join(dir, file.label);
    if (!existsSync(file.path)) {
      records.push({ label: file.label, path: file.path, copied: false });
      continue;
    }
    copyFileSync(file.path, target);
    const mode = statSync(file.path).mode & 0o7777;
    chmodSync(target, mode);
    records.push({ label: file.label, path: file.path, copied: true, bytes: statSync(target).size });
  }
  const state = {
    script: 'dsh-speaking-practice - ' + options.action,
    scriptVersion: SCRIPT_VERSION,
    action: options.action,
    createdAt: new Date().toISOString(),
    node: process.version,
    pluginRoot: options.pluginRoot,
    profileDir: options.profileDir,
    entryPath: options.entryPath,
    files: records,
  };
  if (options.state !== undefined) {
    for (const key of Object.keys(options.state)) state[key] = options.state[key];
  }
  writeFileSync(join(dir, 'state.json'), JSON.stringify(state, null, 2) + '\n');
  writeFileSync(
    join(dir, 'RESTORE.md'),
    [
      '# 如何手工恢复',
      '',
      '本目录是 scripts/install-local.mjs / scripts/uninstall-local.mjs 在改动前自动创建的备份。',
      '',
      '恢复 profile 的 cordis.patch.yml（在终端里执行）：',
      '',
      '    cp "' + join(dir, PROFILE_PATCH_FILE) + '" "' + join(options.profileDir, PROFILE_PATCH_FILE) + '"',
      '',
      '如果备份里没有 cordis.patch.yml，说明改动前该文件不存在。注意：空文件或只有注释的',
      'profile patch 会导致启动失败，这种情况下应往该文件写入一行 []。',
      '',
      '更多上下文见 state.json 与 docs/install-notes.md。',
      '',
    ].join('\n'),
  );
  return { dir: dir, records: records };
}

/* ---------------------------------------------------------------- reports */

export function formatLink(inspected, pluginRoot) {
  if (inspected.kind === 'absent') return '不存在（将创建）';
  if (inspected.kind === 'symlink') {
    const owned = linkOwnedBy(inspected, pluginRoot);
    return 'symlink -> ' + inspected.rawTarget + (owned ? '（指向本插件）' : '（指向别处，未管理）');
  }
  return (inspected.kind === 'dir' ? '真实目录' : '真实文件') + '（不是 symlink，脚本不会改动）';
}

export function printHeader(title) {
  line(title);
  line('='.repeat(Math.min(72, Math.max(24, Array.from(title).length * 2))));
}

/* ---------------------------------------------------------------- symlink */

/** Create (or replace) the linked-root symlink, creating node_modules if needed. */
export function createSymlink(linkPath, target) {
  mkdirSync(dirname(linkPath), { recursive: true });
  const tmp = linkPath + '.tmp-' + process.pid + '-' + Date.now();
  symlinkSync(target, tmp, 'dir');
  try {
    renameSync(tmp, linkPath);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {}
    throw error;
  }
}

export function removeSymlink(linkPath) {
  try {
    unlinkSync(linkPath);
    return true;
  } catch (error) {
    if (error && error.code === 'ENOENT') return false;
    throw error;
  }
}

/* --------------------------------------------------------------- rollback */

/** Planned backup directory for a run: {stamp, dir}, uniquified against existing directories. */
export function planBackup(backupRoot) {
  const stamp = utcStamp();
  return { stamp: stamp, dir: uniqueDirectory(backupRoot, stamp) };
}

export function readBackupState(backupDir) {
  const statePath = join(backupDir, 'state.json');
  if (!existsSync(statePath)) throw new Error('备份目录里没有 state.json: ' + backupDir);
  return JSON.parse(readFileSync(statePath, 'utf8'));
}

/**
 * Restore a previous run from its backup directory:
 *   - copy the backed-up cordis.patch.yml back (if it was copied);
 *   - remove a patch file the run created (only when nothing but the managed
 *     block remains, so post-install user edits are never destroyed);
 *   - undo / recreate the linked-root symlink recorded in state.json.
 *
 * @param {{backupDir: string, profileDir?: string}} options
 * @returns {{state: object, actions: string[]}}
 */
export function restoreFromBackup(options) {
  const backupDir = options.backupDir;
  const state = readBackupState(backupDir);
  const profileDir = options.profileDir === undefined || options.profileDir === '' ? state.profileDir : options.profileDir;
  const actions = [];
  const files = Array.isArray(state.files) ? state.files : [];
  const patchRecord = files.find((file) => file.label === PROFILE_PATCH_FILE);
  const patchPath = join(profileDir, PROFILE_PATCH_FILE);
  if (patchRecord !== undefined && patchRecord.copied === true) {
    const source = join(backupDir, PROFILE_PATCH_FILE);
    const content = readFileSync(source, 'utf8');
    atomicWriteFile(patchPath, content, statSync(source).mode);
    actions.push('profile patch 已从备份恢复: ' + patchPath);
  } else if (state.patchExisted === false && existsSync(patchPath)) {
    const current = readTextIfExists(patchPath);
    const stripped = stripManagedBlocks(current.content === null ? '' : current.content);
    if (stripped.content.trim() === '') {
      unlinkSync(patchPath);
      actions.push('已删除本次安装创建的 profile patch 文件: ' + patchPath);
    } else {
      actions.push('profile patch 在安装后又被修改过，未删除（请手工检查）: ' + patchPath);
    }
  } else if (patchRecord === undefined) {
    actions.push('备份未包含 profile patch（改动前不存在），未处理: ' + patchPath);
  }
  const before = state.symlinkBefore;
  const linkPath = join(profileDir, 'node_modules', PLUGIN_NAME);
  const current = inspectLink(linkPath);
  if (before !== undefined && before.kind === 'absent') {
    if (current.kind === 'symlink') {
      removeSymlink(linkPath);
      actions.push('已删除本次安装创建的 symlink: ' + linkPath);
    }
  } else if (before !== undefined && before.kind === 'symlink') {
    if (current.kind === 'symlink' && current.rawTarget === before.rawTarget) {
      actions.push('symlink 无需恢复（已经是原目标）: ' + before.rawTarget);
    } else {
      if (current.kind === 'symlink') removeSymlink(linkPath);
      createSymlink(linkPath, before.rawTarget);
      actions.push('symlink 已恢复为: ' + before.rawTarget);
    }
  } else if (before === undefined) {
    actions.push('备份没有记录 symlink 状态，未处理: ' + linkPath);
  }
  return { state: state, actions: actions };
}
