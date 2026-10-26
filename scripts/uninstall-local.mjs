#!/usr/bin/env node
/**
 * uninstall-local.mjs - remove dsh-speaking-practice from the Desktop profile patch layer.
 *
 * Idempotent reverse of install-local.mjs:
 *   1. backs up <profile>/cordis.patch.yml to <pluginRoot>/backup/<UTC stamp>/;
 *   2. removes the managed insert block from the profile patch (only that block);
 *   3. removes the linked-root symlink <profile>/node_modules/dsh-speaking-practice
 *      when it points at this checkout;
 *   4. rolls back automatically if any step fails.
 *
 * It never touches profile package.json, dsh.profile.bundles, pnpm-lock.yaml or
 * pnpm-workspace.yaml. Dry-run writes nothing at all.
 *
 * Usage: node scripts/uninstall-local.mjs [options]   (see --help)
 */
import { existsSync, unlinkSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import * as shared from './_shared.mjs';

const USAGE = [
  '用法: node scripts/uninstall-local.mjs [选项]',
  '',
  '从 Desktop profile 的 patch 层移除 dsh-speaking-practice（幂等）。',
  '',
  '选项:',
  '  --dry-run              只打印计划，不写任何文件、不创建 backup/ 目录',
  '  --profile-dir <path>   指定 profile 目录（默认 $DSH_HOME/profiles/desktop）',
  '  --profile <name>       用 profile 名称代替 --profile-dir（默认 desktop）',
  '  --root <path>          插件根目录（默认本脚本上一级目录）',
  '  --backup-dir <path>    备份根目录（默认 <root>/backup）',
  '  --rollback <dir>       从 backup/<时间戳> 目录回滚（执行后退出，不做卸载）',
  '  --help                 显示本帮助',
].join('\n');

class UserError extends Error {}

function fail(message) {
  throw new UserError(message);
}

function errorText(error) {
  return error && error.message !== undefined ? error.message : String(error);
}

const parsed = shared.parseArgs(process.argv.slice(2), {
  values: ['profile', 'profile-dir', 'root', 'backup-dir', 'rollback'],
  bools: ['dry-run', 'help'],
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
      shared.line('未发现本插件的 managed 块或归属 symlink，已经处于未安装状态，脚本不会写入任何文件。');
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
    shared.warn('卸载前检查失败: ' + errorText(error));
    process.exitCode = 1;
  }
}

function buildPlan() {
  if (!existsSync(profileDir)) fail('profile 目录不存在: ' + profileDir);
  if (!existsSync(paths.packageJson)) fail('不是已初始化的 profile（缺少 package.json）: ' + profileDir);
  const patchInfo = shared.readTextIfExists(paths.patchFile);
  if (patchInfo.exists && patchInfo.content === null) fail('profile patch 不是普通文件: ' + paths.patchFile);
  const patchContent = patchInfo.content === null ? '' : patchInfo.content;
  const blocks = shared.findManagedBlocks(patchContent);
  const removal = shared.removeManagedBlock(patchContent);
  const patchChanged = blocks.length > 0 && removal.content !== patchContent;
  const link = shared.inspectLink(paths.linkPath);
  const linkOwned = shared.linkOwnedBy(link, pluginRoot);
  const linkAction = linkOwned ? 'remove' : link.kind === 'symlink' ? 'leave-other' : link.kind === 'absent' ? 'absent' : 'leave-real';
  const changes = patchChanged || linkOwned;
  return {
    patchInfo: patchInfo,
    patchContent: patchContent,
    removal: removal,
    blockCount: blocks.length,
    patchChanged: patchChanged,
    link: link,
    linkOwned: linkOwned,
    linkAction: linkAction,
    changes: changes,
    backup: shared.planBackup(backupRoot),
  };
}

function printPlan(plan) {
  shared.printHeader(dryRun ? 'dsh-speaking-practice 卸载计划（dry-run，不写入）' : 'dsh-speaking-practice 卸载计划');
  shared.line('  profile 目录 : ' + profileDir);
  shared.line('  profile patch: ' + paths.patchFile + (plan.patchInfo.exists ? '（已存在）' : '（不存在）'));
  shared.line('  插件根       : ' + pluginRoot);
  shared.line('');
  shared.line('  managed 块   : ' + (plan.blockCount === 0 ? '未发现（无需移除）' : '发现 ' + plan.blockCount + ' 份（将全部移除）'));
  shared.line('  linked-root symlink: ' + paths.linkPath);
  shared.line('    当前: ' + (plan.link.kind === 'absent' ? '不存在' : shared.formatLink(plan.link, pluginRoot)));
  shared.line('    动作: ' + describeLinkAction(plan.linkAction));
  if (plan.linkAction === 'leave-other') {
    shared.line('    注意: symlink 指向别处，不属于本插件，脚本不会删除。');
  }
  if (plan.linkAction === 'leave-real') {
    shared.line('    注意: 不是 symlink，脚本不会删除。');
  }
  shared.line('');
  shared.line('  备份（执行时创建）: ' + plan.backup.dir);
  shared.line('    内容: cordis.patch.yml（若存在）、state.json、RESTORE.md');
  shared.line('');
  shared.line('  卸载后的 profile patch:');
  if (plan.blockCount === 0) {
    shared.line('    不变');
  } else if (plan.removal.content.trim() === '') {
    shared.line('    移除 managed 块后文件为空 -> 写入 "[]"（空 profile patch 必须写成合法空数组）');
  } else {
    shared.line('    只移除 managed 块，原有内容与顺序保持不变');
  }
  shared.line('');
  shared.line('  执行步骤:');
  shared.numbered(1, '创建备份目录并复制 profile 的 cordis.patch.yml（若存在）');
  shared.numbered(2, plan.blockCount === 0 ? 'profile patch 无需变更' : '原子写入 profile patch（只移除 managed 块）');
  shared.numbered(3, plan.linkOwned ? '删除 linked-root symlink' : 'symlink 无需变更');
  shared.numbered(4, '读回校验：managed 块为 0 份、symlink 已移除、patch 仍是合法非空 YAML 数组文件');
  shared.line('');
  shared.line('  生效方式: HMR 监听 profile patch，写入后约 2-5 秒重组并停止 voice-practice 条目；不需要重启 App。');
}

function describeLinkAction(action) {
  if (action === 'remove') return '删除 symlink（指向本插件）';
  if (action === 'absent') return '无需变更（不存在）';
  if (action === 'leave-other') return '保留（指向别处）';
  if (action === 'leave-real') return '保留（真实文件/目录）';
  return action;
}

function executePlan(plan) {
  let backupDir = null;
  const undo = [];
  try {
    const backup = shared.createBackup({
      backupRoot: backupRoot,
      stamp: plan.backup.stamp,
      action: 'uninstall',
      pluginRoot: pluginRoot,
      profileDir: profileDir,
      entryPath: join(pluginRoot, shared.ENTRY_FILE),
      files: [{ label: shared.PROFILE_PATCH_FILE, path: paths.patchFile }],
      state: {
        patchExisted: plan.patchInfo.exists,
        patchSha256: plan.patchInfo.exists ? shared.sha256(plan.patchContent) : null,
        symlinkBefore: plan.link.kind === 'symlink' ? { kind: 'symlink', rawTarget: plan.link.rawTarget } : { kind: plan.link.kind, rawTarget: null },
        removeBlockCount: plan.blockCount,
      },
    });
    backupDir = backup.dir;
    shared.line('');
    shared.line('执行卸载...');
    shared.line('  - 备份: ' + backupDir);

    if (plan.patchChanged) {
      shared.atomicWriteFile(paths.patchFile, plan.removal.content, plan.patchInfo.mode === undefined ? 0o600 : plan.patchInfo.mode);
      undo.push({
        kind: 'patch',
        previous: plan.patchInfo.exists
          ? { existed: true, content: plan.patchContent, mode: plan.patchInfo.mode }
          : { existed: false },
      });
      shared.line('  - profile patch: 已移除 managed 块');
    } else {
      shared.line('  - profile patch: 无需变更');
    }

    if (plan.linkOwned) {
      shared.removeSymlink(paths.linkPath);
      undo.push({ kind: 'symlink-restore', rawTarget: plan.link.rawTarget });
      shared.line('  - symlink: 已删除 ' + paths.linkPath);
    } else {
      shared.line('  - symlink: 无需变更');
    }

    verifyUninstalled(plan);
    shared.line('  - 读回校验: 通过');
    shared.line('');
    shared.line('卸载完成。');
    printNextSteps(backupDir);
    process.exitCode = 0;
  } catch (error) {
    rollback(undo);
    shared.warn('卸载失败: ' + errorText(error));
    shared.warn('已按记录自动回滚到卸载前状态。');
    if (backupDir !== null) shared.warn('备份保留在: ' + backupDir);
    process.exitCode = 1;
  }
}

function verifyUninstalled(plan) {
  if (!plan.patchChanged) return;
  const patchNow = shared.readTextIfExists(paths.patchFile);
  if (!patchNow.exists || patchNow.content === null) throw new Error('写入后 profile patch 不可读: ' + paths.patchFile);
  const blocks = shared.findManagedBlocks(patchNow.content);
  if (blocks.length !== 0) throw new Error('卸载后仍存在 managed 块: ' + blocks.length + ' 份');
  if (patchNow.content.trim() === '') throw new Error('卸载后 profile patch 变成空文件（会导致启动失败）');
  if (plan.linkOwned) {
    const linkNow = shared.inspectLink(paths.linkPath);
    if (shared.linkOwnedBy(linkNow, pluginRoot)) throw new Error('卸载后 symlink 仍指向本插件');
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
      } else if (entry.kind === 'symlink-restore') {
        shared.createSymlink(paths.linkPath, entry.rawTarget);
        shared.line('  - 回滚 symlink: 已恢复 ' + entry.rawTarget);
      }
    } catch (error) {
      shared.warn('回滚步骤失败（' + entry.kind + '）: ' + errorText(error));
    }
  }
}

function printNextSteps(backupDir) {
  shared.line('');
  shared.line('下一步（无需重启 App）：');
  shared.numbered(1, '等待 HMR 自动生效：约 2-5 秒后重组，voice-practice 条目停止并从插件页消失');
  shared.numbered(2, '验证：node scripts/smoke-check.mjs（应报告未注册、voice-loader.log 不再更新）');
  shared.numbered(3, '插件自身日志（' + join(pluginRoot, 'logs', 'voice-loader.log') + '、logs/voice-practice.log）保留，记录可手工删除');
  shared.numbered(4, '如果当初是从 Web GUI「插件」页按本地包安装的 bundle，请在插件页卸载（本脚本只管 patch 层）');
  shared.numbered(5, '若 10 秒后条目仍在：刷新 Web GUI；仍不行再重启 DeepSeek Harness');
  shared.line('');
  shared.line('如需恢复本次卸载前的状态：');
  shared.line('  node scripts/uninstall-local.mjs --rollback ' + backupDir);
  shared.line('');
  shared.line('备份目录（保留，供手工恢复）：' + backupDir);
}
