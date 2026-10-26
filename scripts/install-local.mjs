#!/usr/bin/env node
/**
 * install-local.mjs - register dsh-speaking-practice in the Desktop profile patch layer.
 *
 * What it does (all writes are atomic and rolled back on failure):
 *   1. backs up <profile>/cordis.patch.yml to <pluginRoot>/backup/<UTC stamp>/;
 *   2. ensures the linked-root symlink <profile>/node_modules/dsh-speaking-practice
 *      -> <pluginRoot> (needed so @deepseek-ai/* bare imports of src/*.js are routed
 *      through the profile runtime resolution; pnpm is NOT used);
 *   3. appends one clearly marked insert block to <profile>/cordis.patch.yml that
 *      loads <pluginRoot>/plugin.js (absolute path -> file URL by app-boot) with
 *      config.practiceRoot = <pluginRoot>.
 *
 * It never writes the profile package.json, dsh.profile.bundles, pnpm-lock.yaml or
 * pnpm-workspace.yaml. Dry-run writes nothing at all (not even backup/).
 *
 * Usage: node scripts/install-local.mjs [options]   (see --help)
 */
import { existsSync, unlinkSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import * as shared from './_shared.mjs';

const USAGE = [
  '用法: node scripts/install-local.mjs [选项]',
  '',
  '把 dsh-speaking-practice 注册进 Desktop profile 的 patch 层。',
  '不写 profile package.json / dsh.profile.bundles / pnpm-lock.yaml，不运行 pnpm。',
  '',
  '选项:',
  '  --dry-run              只打印计划：YAML 块全文、symlink 目标、备份路径；不写任何文件',
  '  --profile-dir <path>   指定 profile 目录（默认 $DSH_HOME/profiles/desktop，即 ~/.dsh/profiles/desktop）',
  '  --profile <name>       用 profile 名称代替 --profile-dir（默认 desktop）',
  '  --root <path>          插件根目录（默认本脚本上一级目录）',
  '  --entry <path>         patch 条目指向的入口文件（默认 <root>/plugin.js）',
  '  --backup-dir <path>    备份根目录（默认 <root>/backup）',
  '  --symlink              兼容选项（默认就会创建 linked-root symlink）',
  '  --no-symlink           不创建 linked-root symlink（若 src 里有 @deepseek-ai/* 导入，插件会 mount failed）',
  '  --replace-symlink      允许替换已存在但指向别处的 node_modules/dsh-speaking-practice symlink',
  '  --rollback <dir>       从 backup/<时间戳> 目录回滚（执行后退出，不做安装）',
  '  --help                 显示本帮助',
  '',
  '示例:',
  '  node scripts/install-local.mjs --dry-run',
  '  node scripts/install-local.mjs',
  '  node scripts/install-local.mjs --rollback backup/20261026T090500Z',
].join('\n');

class UserError extends Error {}

function fail(message) {
  throw new UserError(message);
}

function errorText(error) {
  return error && error.message !== undefined ? error.message : String(error);
}

const parsed = shared.parseArgs(process.argv.slice(2), {
  values: ['profile', 'profile-dir', 'root', 'entry', 'backup-dir', 'rollback'],
  bools: ['dry-run', 'symlink', 'no-symlink', 'replace-symlink', 'help'],
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

const dryRun = parsed.bools['dry-run'] === true;
const pluginRoot = shared.resolveProjectRoot(parsed.values.root, import.meta.url);
const profileDir = shared.resolveProfileDir(parsed.values);
const paths = shared.profilePaths(profileDir);
const backupRoot = parsed.values['backup-dir'] === undefined ? join(pluginRoot, 'backup') : resolve(parsed.values['backup-dir']);
const entryPath = parsed.values.entry === undefined ? join(pluginRoot, shared.ENTRY_FILE) : resolve(parsed.values.entry);

function resolveBackupArg(arg) {
  if (isAbsolute(arg)) return arg;
  const direct = resolve(arg);
  if (existsSync(join(direct, 'state.json'))) return direct;
  return join(backupRoot, arg);
}

function runRollback(arg) {
  const dir = resolveBackupArg(arg);
  try {
    const result = shared.restoreFromBackup({ backupDir: dir });
    shared.line('回滚完成（备份来源: ' + dir + '）');
    shared.line('  profile: ' + result.state.profileDir);
    for (const action of result.actions) shared.line('  - ' + action);
    shared.line('');
    shared.line('HMR 会在约 2-5 秒内按恢复后的 profile patch 重新组合；');
    shared.line('如果插件仍在运行旧条目，刷新 Web GUI，必要时重启 DeepSeek Harness。');
    process.exitCode = 0;
  } catch (error) {
    shared.warn('回滚失败: ' + errorText(error));
    process.exitCode = 1;
  }
}

if (parsed.values.rollback !== undefined) {
  runRollback(parsed.values.rollback);
} else {
  main();
}

function main() {
  try {
    const plan = buildPlan();
    printPlan(plan);
    if (!plan.changes) {
      shared.line('');
      shared.line('当前 profile 已经安装且无需变更，脚本不会写入任何文件。');
      process.exitCode = 0;
      return;
    }
    if (dryRun) {
      shared.line('');
      shared.line('dry-run 结束：未写入任何文件，backup/ 目录也未创建。');
      shared.line('确认无误后去掉 --dry-run 再执行。');
      process.exitCode = 0;
      return;
    }
    executePlan(plan);
  } catch (error) {
    if (error instanceof UserError) {
      shared.usageError(error.message);
      process.exitCode = 2;
      return;
    }
    shared.warn('安装前检查失败: ' + errorText(error));
    process.exitCode = 1;
  }
}

function buildPlan() {
  if (!existsSync(profileDir)) fail('profile 目录不存在: ' + profileDir);
  if (!existsSync(paths.packageJson)) fail('不是已初始化的 profile（缺少 package.json）: ' + profileDir);
  if (!existsSync(entryPath)) fail('入口文件不存在: ' + entryPath + '（plugin.js 由插件根维护，可用 --entry 指定）');
  const patchInfo = shared.readTextIfExists(paths.patchFile);
  if (patchInfo.exists && patchInfo.content === null) fail('profile patch 不是普通文件: ' + paths.patchFile);
  const patchContent = patchInfo.content === null ? '' : patchInfo.content;
  const fields = { entryPath: entryPath, practiceRoot: pluginRoot };
  const upsert = shared.upsertManagedBlock(patchContent, fields);
  const blocks = shared.findManagedBlocks(patchContent);
  const patchAction = upsert.changed === false ? 'noop' : blocks.length > 0 ? 'replace-block' : 'append-block';

  const bare = shared.scanBareImports(pluginRoot);
  const bareNeeded = bare.specifiers.length > 0;
  // 默认总是创建 linked root：src/*.js 依赖 @deepseek-ai/* bare import，而插件根
  // 不在 profile 树里，只有 linked root 才会让 runtime resolution 接管这些 import。
  const needLink = parsed.bools['no-symlink'] !== true;
  const link = shared.inspectLink(paths.linkPath);
  let linkAction = { kind: 'skip' };
  if (needLink) {
    if (link.kind === 'absent') {
      linkAction = { kind: 'create' };
    } else if (link.kind === 'symlink' && shared.linkOwnedBy(link, pluginRoot)) {
      linkAction = { kind: 'noop' };
    } else if (link.kind === 'symlink' && parsed.bools['replace-symlink']) {
      linkAction = { kind: 'replace', previousRaw: link.rawTarget };
    } else if (link.kind === 'symlink') {
      fail('node_modules 里已有 ' + shared.PLUGIN_NAME + ' symlink，但指向 ' + link.rawTarget + '；确认要替换请加 --replace-symlink');
    } else {
      fail('node_modules 里的 ' + shared.PLUGIN_NAME + ' 是真实的' + (link.kind === 'dir' ? '目录' : '文件') + '，脚本不会自动删除，请手工处理后重试: ' + paths.linkPath);
    }
  }
  const changes = patchAction !== 'noop' || linkAction.kind === 'create' || linkAction.kind === 'replace';
  return {
    fields: fields,
    patchInfo: patchInfo,
    patchContent: patchContent,
    upsert: upsert,
    patchAction: patchAction,
    bare: bare,
    bareNeeded: bareNeeded,
    needLink: needLink,
    link: link,
    linkAction: linkAction,
    changes: changes,
    backup: shared.planBackup(backupRoot),
  };
}

function describeLinkAction(action) {
  if (action.kind === 'skip') return '跳过（--no-symlink 或未检测到 bare import）';
  if (action.kind === 'noop') return '无需变更（已指向本插件）';
  if (action.kind === 'create') return '创建 symlink';
  if (action.kind === 'replace') return '替换 symlink（原目标: ' + action.previousRaw + '）';
  return '未知';
}

function printPlan(plan) {
  shared.printHeader(dryRun ? 'dsh-speaking-practice 安装计划（dry-run，不写入）' : 'dsh-speaking-practice 安装计划');
  shared.line('  profile 目录 : ' + profileDir);
  shared.line('  profile patch: ' + paths.patchFile + (plan.patchInfo.exists ? '（已存在）' : '（不存在，将创建）'));
  shared.line('  插件根       : ' + pluginRoot);
  shared.line('  入口文件     : ' + entryPath);
  shared.line('  config       : practiceRoot = ' + pluginRoot);
  shared.line('');
  shared.line('  bare import 扫描: ' + (plan.bare.specifiers.length === 0 ? '未发现' : plan.bare.specifiers.join(', ')));
  shared.line('  linked-root symlink: ' + paths.linkPath);
  shared.line('    当前: ' + shared.formatLink(plan.link, pluginRoot));
  shared.line('    动作: ' + describeLinkAction(plan.linkAction));
  if (!plan.needLink) {
    if (plan.bareNeeded) {
      shared.line('    警告: 已用 --no-symlink 跳过，但插件里有 @deepseek-ai/* bare import；');
      shared.line('          src/index.js 将无法解析这些包（voice-loader.log 会出现 mount failed）。');
    } else {
      shared.line('    提示: 已用 --no-symlink 跳过；若以后 src 里加入 @deepseek-ai/* 导入，需重跑安装补齐 symlink。');
    }
  }
  shared.line('');
  shared.line('  备份（执行时创建）: ' + plan.backup.dir);
  shared.line('    内容: cordis.patch.yml（若存在）、state.json、RESTORE.md');
  shared.line('');
  shared.line('  将追加/替换到 profile patch 末尾的 YAML 块（全文）:');
  shared.line('  ----- 开始 -----');
  for (const blockLine of shared.managedBlockLines(plan.fields)) shared.line(blockLine);
  shared.line('  ----- 结束 -----');
  shared.line('');
  shared.line('  变更摘要:');
  shared.line('    - profile patch: ' + (plan.patchAction === 'noop' ? '无需变更' : plan.patchAction === 'append-block' ? '追加 managed 块' : '替换现有 managed 块'));
  shared.line('    - symlink: ' + describeLinkAction(plan.linkAction));
  shared.line('');
  shared.line('  执行步骤:');
  shared.numbered(1, '创建备份目录并复制 profile 的 cordis.patch.yml（若存在）');
  shared.numbered(2, plan.linkAction.kind === 'create' || plan.linkAction.kind === 'replace' ? '创建 linked-root symlink' : 'symlink 无需变更');
  shared.numbered(3, plan.patchAction === 'noop' ? 'profile patch 无需变更' : '原子写入 profile patch（只追加/替换 managed 块，不动原有内容）');
  shared.numbered(4, '读回校验：managed 块只有一份、symlink 指向插件根、入口文件存在');
  shared.line('');
  shared.line('  生效方式: HMR 监听 profile patch 文件，写入后约 2-5 秒自动重组；不需要重启 App。');
}

function executePlan(plan) {
  let backupDir = null;
  const undo = [];
  try {
    const backup = shared.createBackup({
      backupRoot: backupRoot,
      stamp: plan.backup.stamp,
      action: 'install',
      pluginRoot: pluginRoot,
      profileDir: profileDir,
      entryPath: entryPath,
      files: [{ label: shared.PROFILE_PATCH_FILE, path: paths.patchFile }],
      state: {
        patchExisted: plan.patchInfo.exists,
        patchSha256: plan.patchInfo.exists ? shared.sha256(plan.patchContent) : null,
        symlinkBefore: plan.link.kind === 'symlink' ? { kind: 'symlink', rawTarget: plan.link.rawTarget } : { kind: plan.link.kind, rawTarget: null },
        bareImports: plan.bare.specifiers.slice(0, 50),
        entryExists: true,
      },
    });
    backupDir = backup.dir;
    shared.line('');
    shared.line('执行安装...');
    shared.line('  - 备份: ' + backupDir);

    if (plan.linkAction.kind === 'create' || plan.linkAction.kind === 'replace') {
      if (plan.linkAction.kind === 'replace') {
        undo.push({ kind: 'symlink-replace', previousRaw: plan.linkAction.previousRaw });
        shared.removeSymlink(paths.linkPath);
      }
      shared.createSymlink(paths.linkPath, pluginRoot);
      if (plan.linkAction.kind === 'create') undo.push({ kind: 'symlink-create' });
      shared.line('  - symlink: ' + paths.linkPath + ' -> ' + pluginRoot);
    } else {
      shared.line('  - symlink: 无需变更');
    }

    if (plan.patchAction !== 'noop') {
      shared.atomicWriteFile(paths.patchFile, plan.upsert.content, plan.patchInfo.mode === undefined ? 0o600 : plan.patchInfo.mode);
      undo.push({
        kind: 'patch',
        previous: plan.patchInfo.exists
          ? { existed: true, content: plan.patchContent, mode: plan.patchInfo.mode }
          : { existed: false },
      });
      shared.line('  - profile patch: ' + (plan.patchAction === 'append-block' ? '已追加 managed 块' : '已替换 managed 块'));
    } else {
      shared.line('  - profile patch: 无需变更');
    }

    verifyInstalled(plan);
    shared.line('  - 读回校验: 通过');
    shared.line('');
    shared.line('安装完成。');
    printNextSteps(backupDir);
    process.exitCode = 0;
  } catch (error) {
    rollback(undo);
    shared.warn('安装失败: ' + errorText(error));
    shared.warn('已按记录自动回滚到安装前状态。');
    if (backupDir !== null) shared.warn('备份保留在: ' + backupDir);
    process.exitCode = 1;
  }
}

function verifyInstalled(plan) {
  const patchNow = shared.readTextIfExists(paths.patchFile);
  if (!patchNow.exists || patchNow.content === null) throw new Error('写入后 profile patch 不可读: ' + paths.patchFile);
  const blocks = shared.findManagedBlocks(patchNow.content);
  if (blocks.length !== 1) throw new Error('写入后 managed 块数量异常（应为 1，实际 ' + blocks.length + '）');
  if (!patchNow.content.includes(shared.managedBlockText(plan.fields))) throw new Error('写入后找不到期望的 YAML 块');
  if (!existsSync(entryPath)) throw new Error('入口文件在安装后消失: ' + entryPath);
  if (plan.needLink) {
    const linkNow = shared.inspectLink(paths.linkPath);
    if (linkNow.kind !== 'symlink' || !shared.linkOwnedBy(linkNow, pluginRoot)) {
      throw new Error('symlink 校验失败: ' + shared.formatLink(linkNow, pluginRoot));
    }
  }
}

function rollback(undo) {
  const entries = undo.slice().reverse();
  for (const entry of entries) {
    try {
      if (entry.kind === 'patch') {
        if (entry.previous.existed) {
          shared.atomicWriteFile(paths.patchFile, entry.previous.content, entry.previous.mode);
          shared.line('  - 回滚 profile patch: 已恢复原内容');
        } else if (existsSync(paths.patchFile)) {
          unlinkSync(paths.patchFile);
          shared.line('  - 回滚 profile patch: 已删除本次创建的文件');
        }
      } else if (entry.kind === 'symlink-create') {
        const linkNow = shared.inspectLink(paths.linkPath);
        if (linkNow.kind === 'symlink' && shared.linkOwnedBy(linkNow, pluginRoot)) {
          shared.removeSymlink(paths.linkPath);
          shared.line('  - 回滚 symlink: 已删除本次创建的 symlink');
        }
      } else if (entry.kind === 'symlink-replace') {
        const linkNow = shared.inspectLink(paths.linkPath);
        if (linkNow.kind === 'symlink') shared.removeSymlink(paths.linkPath);
        shared.createSymlink(paths.linkPath, entry.previousRaw);
        shared.line('  - 回滚 symlink: 已恢复原目标 ' + entry.previousRaw);
      }
    } catch (error) {
      shared.warn('回滚步骤失败（' + entry.kind + '）: ' + errorText(error));
    }
  }
}

function printNextSteps(backupDir) {
  shared.line('');
  shared.line('下一步（无需重启 App）：');
  shared.numbered(1, '等待 HMR 自动生效：profile patch 变更后约 2-5 秒重组（Chokidar 写入稳定窗 2s）');
  shared.numbered(2, '验证：node scripts/smoke-check.mjs --wait 20');
  shared.numbered(3, '日志：' + join(pluginRoot, 'logs', 'voice-loader.log') + ' 应出现 mounted (startup)');
  shared.numbered(4, 'Web GUI 侧栏「插件」页应出现 voice-practice 行；在「练习口语」工作区会话输入 /voice status');
  shared.numbered(5, '若 10 秒后仍未生效：刷新 Web GUI；仍不行再重启 DeepSeek Harness');
  shared.line('');
  shared.line('回滚 / 卸载：');
  shared.line('  node scripts/install-local.mjs --rollback ' + backupDir);
  shared.line('  node scripts/uninstall-local.mjs');
  shared.line('');
  shared.line('备份目录（保留，供手工恢复）：' + backupDir);
}
