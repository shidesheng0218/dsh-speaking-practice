#!/usr/bin/env node
/**
 * smoke-check.mjs - read-only verification that dsh-speaking-practice is registered
 * in the Desktop profile patch layer and that its dev shell actually mounted.
 *
 * Checks:
 *   1. <pluginRoot>/logs/ exists;
 *   2. <pluginRoot>/logs/voice-loader.log exists and contains 'mounted (startup)'
 *      or another 'mounted (' line, and whether a later 'mount failed' line exists;
 *   3. the managed block is present in <profile>/cordis.patch.yml and points at
 *      <pluginRoot>/plugin.js;
 *   4. the linked-root symlink <profile>/node_modules/dsh-speaking-practice points
 *      at the plugin root.
 *
 * Exit code: 0 = loaded, 1 = not verified, 2 = usage/config error.
 * Usage: node scripts/smoke-check.mjs [--wait 20] [--json]
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import * as shared from './_shared.mjs';

const USAGE = [
  '用法: node scripts/smoke-check.mjs [选项]',
  '',
  '只读检查 dsh-speaking-practice 是否已注册并成功挂载（不会写任何文件）。',
  '',
  '选项:',
  '  --wait <秒>            最长等待秒数（默认 0）；用于安装后轮询日志出现 mounted',
  '  --profile-dir <path>   指定 profile 目录（默认 $DSH_HOME/profiles/desktop）',
  '  --profile <name>       用 profile 名称代替 --profile-dir（默认 desktop）',
  '  --root <path>          插件根目录（默认本脚本上一级目录）',
  '  --entry <path>         patch 条目应指向的入口文件（默认 <root>/plugin.js）',
  '  --json                 以 JSON 输出检查结果',
  '  --help                 显示本帮助',
].join('\n');

const parsed = shared.parseArgs(process.argv.slice(2), {
  values: ['wait', 'profile', 'profile-dir', 'root', 'entry'],
  bools: ['json', 'help'],
});

if (parsed.bools.help) {
  shared.line(USAGE);
  process.exit(0);
}
if (parsed.unknown.length > 0) {
  shared.usageError('未知参数: ' + parsed.unknown.join(' '));
  shared.line(USAGE);
  process.exit(2);
}
if (parsed.missing.length > 0) {
  shared.usageError('参数缺少取值: ' + parsed.missing.join(' '));
  process.exit(2);
}

const waitSeconds = parsed.values.wait === undefined ? 0 : Number(parsed.values.wait);
if (!Number.isFinite(waitSeconds) || waitSeconds < 0) {
  shared.usageError('--wait 需要是非负秒数: ' + parsed.values.wait);
  process.exit(2);
}
const asJson = parsed.bools.json === true;
const pluginRoot = shared.resolveProjectRoot(parsed.values.root, import.meta.url);
const profileDir = shared.resolveProfileDir(parsed.values);
const paths = shared.profilePaths(profileDir);
const entryPath = parsed.values.entry === undefined ? join(pluginRoot, shared.ENTRY_FILE) : resolve(parsed.values.entry);
const logsDir = join(pluginRoot, 'logs');
const loaderLog = join(logsDir, 'voice-loader.log');
const practiceLog = join(logsDir, 'voice-practice.log');

function readLoaderLog() {
  if (!existsSync(loaderLog)) return { exists: false, lines: [], state: 'absent', lastMounted: null, lastFail: null, watching: false };
  let content = '';
  try {
    content = readFileSync(loaderLog, 'utf8');
  } catch (error) {
    return { exists: true, lines: [], state: 'unreadable', lastMounted: null, lastFail: null, watching: false, error: String(error) };
  }
  const lines = content.split('\n').filter((value) => value.trim() !== '');
  let lastMounted = null;
  let lastFail = null;
  let watching = false;
  let disposed = false;
  for (let index = 0; index < lines.length; index += 1) {
    const value = lines[index];
    if (value.includes('mounted (')) lastMounted = { line: index, text: value };
    if (value.includes('mount failed')) lastFail = { line: index, text: value };
    if (value.includes('watching ./src')) watching = true;
    if (value.includes('shell disposed')) disposed = true;
  }
  let state = 'absent';
  if (lastMounted !== null && (lastFail === null || lastMounted.line > lastFail.line)) state = 'mounted';
  else if (lastFail !== null) state = 'failed';
  else state = lines.length > 0 ? 'starting' : 'empty';
  return {
    exists: true,
    lines: lines,
    state: state,
    lastMounted: lastMounted === null ? null : lastMounted.text,
    lastFail: lastFail === null ? null : lastFail.text,
    watching: watching,
    disposed: disposed,
    tail: lines.slice(-8),
  };
}

function readRegistration() {
  const patchInfo = shared.readTextIfExists(paths.patchFile);
  if (!patchInfo.exists) return { patchExists: false, blocks: 0, entryMatches: false };
  if (patchInfo.content === null) return { patchExists: true, blocks: 0, entryMatches: false, error: 'profile patch 不是普通文件' };
  const blocks = shared.findManagedBlocks(patchInfo.content);
  const entryMatches = blocks.length > 0 && patchInfo.content.includes('name: ' + shared.yamlString(entryPath));
  return { patchExists: true, blocks: blocks.length, entryMatches: entryMatches };
}

function readLink() {
  const link = shared.inspectLink(paths.linkPath);
  return {
    kind: link.kind,
    owned: shared.linkOwnedBy(link, pluginRoot),
    rawTarget: link.rawTarget,
    realTarget: link.realTarget,
  };
}

function snapshot() {
  let logsDirExists = false;
  try {
    logsDirExists = statSync(logsDir).isDirectory();
  } catch {
    logsDirExists = false;
  }
  return {
    pluginRoot: pluginRoot,
    profileDir: profileDir,
    patchFile: paths.patchFile,
    entryPath: entryPath,
    entryExists: existsSync(entryPath),
    logsDirExists: logsDirExists,
    loaderLogPath: loaderLog,
    practiceLogExists: existsSync(practiceLog),
    loader: readLoaderLog(),
    registration: readRegistration(),
    link: readLink(),
  };
}

function loaded(result) {
  return result.loader.state === 'mounted';
}

function report(result) {
  const ok = (text) => shared.line('  [ok]   ' + text);
  const bad = (text) => shared.line('  [fail] ' + text);
  const info = (text) => shared.line('  [info] ' + text);

  shared.printHeader('dsh-speaking-practice smoke check');
  shared.line('  插件根   : ' + result.pluginRoot);
  shared.line('  profile  : ' + result.profileDir);
  shared.line('  入口     : ' + result.entryPath + (result.entryExists ? '' : '（不存在！）'));
  shared.line('');

  if (result.logsDirExists) ok('logs/ 目录存在: ' + join(result.pluginRoot, 'logs'));
  else bad('logs/ 目录不存在: ' + join(result.pluginRoot, 'logs'));
  if (result.practiceLogExists) ok('logs/voice-practice.log 存在（插件实现已写过日志）');
  else info('logs/voice-practice.log 尚未出现（可能还没执行过 /voice on）');
  if (!result.loader.exists) {
    bad('logs/voice-loader.log 不存在（dev shell 从未加载）');
  } else if (result.loader.state === 'mounted') {
    ok('logs/voice-loader.log 出现挂载成功: ' + result.loader.lastMounted);
    if (result.loader.lastFail !== null) info('历史失败记录（之后已成功挂载）: ' + result.loader.lastFail);
  } else if (result.loader.state === 'failed') {
    bad('logs/voice-loader.log 最近一次加载失败: ' + result.loader.lastFail);
  } else {
    info('logs/voice-loader.log 存在，但还没有 mounted / mount failed 行（state=' + result.loader.state + '）');
  }

  const registration = result.registration;
  if (!registration.patchExists) bad('profile patch 不存在: ' + result.patchFile);
  else if (registration.blocks === 0) bad('profile patch 里没有本插件的 managed 块（未注册）');
  else if (!registration.entryMatches) bad('managed 块存在，但 name 不指向 ' + result.entryPath);
  else ok('profile patch 已注册 voice-practice，entry 指向 ' + result.entryPath + '（managed 块 ' + registration.blocks + ' 份）');

  const link = result.link;
  if (link.owned) ok('linked-root symlink 指向插件根');
  else if (link.kind === 'absent') info('linked-root symlink 不存在（--no-symlink 安装，或未安装）');
  else bad('linked-root symlink 异常: ' + shared.formatLink(link, result.pluginRoot));

  if (result.loader.exists && result.loader.tail.length > 0) {
    shared.line('');
    shared.line('  voice-loader.log 末尾:');
    for (const tailLine of result.loader.tail) shared.line('    ' + tailLine);
  }
  shared.line('');
}

async function waitForMount() {
  const deadline = Date.now() + waitSeconds * 1000;
  let result = snapshot();
  while (!loaded(result) && Date.now() < deadline) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1000));
    result = snapshot();
  }
  return result;
}

const result = waitSeconds > 0 ? await waitForMount() : snapshot();

if (asJson) {
  shared.line(JSON.stringify({ loaded: loaded(result), checks: result }, null, 2));
  process.exitCode = loaded(result) ? 0 : 1;
} else {
  report(result);
  if (loaded(result)) {
    shared.line('结论: 已加载。可继续验证 /voice status、/voice on（插件页应能看到 voice-practice 行）。');
    process.exitCode = 0;
  } else {
    shared.line('结论: 未确认已加载。先看上面的 [fail] 行；安装后等待 2-5 秒 HMR，或加 --wait 20。');
    process.exitCode = 1;
  }
}
