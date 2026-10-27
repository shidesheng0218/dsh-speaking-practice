# dsh-speaking-practice 安装、加载与卸载说明

> 适用环境：macOS 桌面版 DSH 0.2.1-rc.3，Desktop profile 位于 `~/.dsh/profiles/desktop`（app-owned，CLI 不管理）。
> 相关文件：`scripts/install-local.mjs`、`scripts/uninstall-local.mjs`、`scripts/smoke-check.mjs`、`scripts/_shared.mjs`。
> 设计原则：只改 profile 的 **patch 层**和一个 **node_modules symlink**；不写 `package.json` / `dsh.profile.bundles` / `pnpm-lock.yaml`，不运行 pnpm，不需要重启 App。

---

## 0. TL;DR

```bash
cd "/Users/eastbuy/Documents/梦想草稿/练习口语"

# 1. 先看计划（不写任何文件、不会创建 backup/）
node scripts/install-local.mjs --dry-run

# 2. 执行（会先备份 profile 的 cordis.patch.yml 到 backup/<UTC 时间戳>/）
node scripts/install-local.mjs

# 3. 等 2-5 秒让 HMR 重组，然后验证
node scripts/smoke-check.mjs --wait 20

# 4. 完全卸载（幂等，可重复执行）
node scripts/uninstall-local.mjs
```

dry-run 会打印：将追加的 YAML 块全文、symlink 目标、备份路径、生效方式。真正执行前请完整看一遍。

---

## 1. 安装原理

### 1.1 profile 的组合方式

Desktop 主进程启动 host 时用 `loadProfileDirectory("dsh", projectDir, installAnchor)` 加载 profile，然后 `runProfile(...)`（`@deepseek-ai/dsh-desktop-host/lib/index.js:218-250`）。profile 由两部分组成：

1. `package.json` 的 `dsh.profile.bundles`——有序组合包列表；每个组合包自带 `cordis.patch.yml`，按列表顺序叠加；
2. profile 自己的 `cordis.patch.yml`——用户层，在**所有组合包层之后**应用（`~/.dsh/cordis.patch.yml` 再之后，优先级更高）。

patch 的语义是：`insert` 新行；按 `id` 覆盖时**整体替换该行的 config**（不做深度合并）；可 `disabled: true`；`!!js` 表达式可用。空文件或纯注释的 profile patch 会导致启动失败（要禁用它必须写 `[]`）。

我们**不新增组合包**，而是往 profile patch 末尾追加一条 insert 行：

```yaml
# >>> dsh-speaking-practice (managed by scripts/install-local.mjs)
- insert:
    - id: voice-practice
      name: "/Users/eastbuy/Documents/梦想草稿/练习口语/plugin.js"
      config:
        practiceRoot: "/Users/eastbuy/Documents/梦想草稿/练习口语"
# <<< dsh-speaking-practice
```

`name` 是**绝对文件路径**（不是包名）：app-boot 在解析 patch 时会把 insert 里的绝对路径（及相对 patch 文件的 `./`、`../` 路径）转换成 file URL——`anchorInsertedPluginNames()`，`@deepseek-ai/dsh-app-boot/lib/index.js:3970-3978`（README.zh 第 65 行也写明"插入条目的插件名可以是绝对文件系统路径、文件 URL 或包标识符"）。Loader 随后直接 `import()` 这个 file URL。

### 1.2 plugin.js 是"稳定的 dev shell"

插件根的 `plugin.js` 被设计成一个很少变化的壳：

- 只 import `node:fs` / `node:path` / `node:url` 等内置模块，**没有任何 @deepseek-ai/* bare import**；
- 动态 `import('./src/index.js')`，用 `ctx.plugin(child, config)` 挂载真正的实现；
- 监视 `./src`（600ms 防抖）：改实现代码后自动重新挂载，日志写 `logs/voice-loader.log`；
- 注册 `/voice-reload` 命令手动重挂载。

因此 patch 条目只需要指向 `plugin.js`，`config` 只需要 `practiceRoot`（其余字段由 `src/index.js` 的 Config schema 给默认值，用户仍可在块里加字段覆盖）。

### 1.3 为什么还需要一个 node_modules symlink（linked root）

只把 `plugin.js` 用绝对路径挂上去**并不够**：`src/index.js` 里的 `@deepseek-ai/schemastery`、`@deepseek-ai/dsh-llm` 等 bare import 会解析失败。

原因（源码事实）：

- launcher 在挂载条目前计算一份不可变的 **runtime resolution**，并安装进 Node 的 ESM/CJS resolver（`@deepseek-ai/dsh-app-boot/README.zh.md:67,134,138`）；
- ESM resolve hook 只在 **importer 位于 profile 树 / 当前 profile / linked root** 时才把 bare import 路由到运行时包：`if (parent === void 0 || !router.hasInterceptionLayerForUrl(parent)) return native(request, parent, attributes)`（`dsh-app-boot/lib/index.js:1855`）；
- `findInterceptionLayer()` 只认这三类路径（`:1337-1345`）；**linked root** 的定义是 `profile/node_modules` 下指向 profiles 树/profile 之外的 symlink（`linkedProfileRoots()`，`:664-692`）；
- linked root 下的模块导入 peer 时，会按该目录 `package.json` 的 `peerDependencies` 逐名路由到运行时包（README.zh:134）。

`plugin.js` 位于插件根、不在上述任何范围内，但它本身只有内置模块，所以能加载；一旦它动态 import 的 `src/index.js` 去 import `@deepseek-ai/*`，importer 不在拦截范围 → Node 原生解析 → `Cannot find package`。

所以安装时在 `<profile>/node_modules/dsh-speaking-practice` 建一个指向插件根的 symlink。它和 pnpm 安装 `link:` 依赖产生的布局完全一样（profile 的 `pnpm-workspace.yaml` 是 `nodeLinker: hoisted`），但**不需要 pnpm、不需要改 package.json/lockfile**。好处：

- bare import 经 linked root 路由到运行时包（peer 名来自插件根 `package.json` 的 `peerDependencies`）；
- HMR 会把 linked target 里的文件纳入变更比较（`dsh-hmr/README.zh.md:49,65`），改 `src/` 后触发 profile 重组时能换掉旧模块。

没有这个 symlink 时：`plugin.js` 能挂上（`logs/voice-loader.log` 会先出现 `watching ./src`，然后出现 `mount failed (startup): Cannot find package '@deepseek-ai/...'`），`/voice` 命令不可用。所以脚本**默认总是创建**该 symlink；`--no-symlink` 只适用于以后插件实现完全不含 bare import 的情况，脚本会告警。

### 1.4 安装脚本做了什么

`scripts/install-local.mjs` 的执行顺序（全部写操作原子化：同目录临时文件 + rename）：

1. 前置校验：profile 目录存在且已初始化（有 `package.json`）、入口 `plugin.js` 存在、patch 不是目录、symlink 现状可处理；
2. 有变更才创建备份：`backup/<UTC 时间戳>/cordis.patch.yml` + `state.json`（记录 patch 是否原本存在、sha256、symlink 原状态、bare import 列表）+ `RESTORE.md`；
3. **默认创建/校验** `node_modules/dsh-speaking-practice -> <插件根>` symlink（`--no-symlink` 可跳过；已指向本插件则不动；指向别处需显式 `--replace-symlink`；真实目录/文件绝不删除）；
4. 原子写入 profile patch：只把 markers 之间的内容替换/追加到文件末尾，**原有内容一行不动**；如果文件原本是 `[]` 占位，会用 managed 块替换它（`[]` 后面直接跟列表项是非法 YAML）；
5. 读回校验：managed 块恰好 1 份、name 指向预期路径、symlink 指向插件根、入口存在；
6. 任一步失败：按记录自动回滚（恢复 patch 原内容、删除本次创建的 symlink/恢复旧 symlink），备份保留供排查。

幂等：已经安装且内容一致时只打印"无需变更"，不写文件、不建备份。`--dry-run` 不写任何文件，也不会创建 `backup/`。

配置块用 JSON 式双引号 YAML 标量，中文与空格路径不需要 shell 转义（脚本内部全程 `fs` API + `JSON.stringify`，不拼 shell 命令）。

---

## 2. 加载与热重载的实际情况

### 2.1 HMR 监听什么

`@deepseek-ai/dsh-base` 的 patch 中有 HMR 行（`dsh-base/cordis.patch.yml:27-32`）：Desktop 存在 `profileContext` → HMR 启用，`root: []` 表示**不监听源码模块**，只保留"显式注册的配置监听"。HMR 初始化时注册（`dsh-hmr/lib/index.js:849-873`）：

- profile 的 `package.json`——但**仅当有序 `dsh.profile.bundles` 列表变化**才触发重组；只改 `dependencies` 不触发；
- profile 的 `cordis.patch.yml`；
- `~/.dsh/cordis.patch.yml`。

触发条件是"文件内容真的变了"（比较 `bundles` + 两个 patch 的文字），单纯 touch 不触发。Chokidar 默认 `awaitWriteFinish: true`，等待 2 秒写入稳定窗口，所以**写入后约 2-5 秒**发生重组。

重组调 `reconcileProfile()`（`dsh-hmr/lib/index.js:1320-1384`）：从磁盘重新读组合包与 patch（`readProfilePatches` → `loadProfileDirectory`），重新计算 runtime resolution（`computeLatestResolution()`，`dsh-app-boot/lib/index.js:830-837`；重新扫描 `node_modules` symlink 得到 linked roots），然后由 `recomposeProfile()` 应用新配置、启动新条目、判定激活。运行中的坏 patch 会被拒绝且不改变现有配置（app-boot README 失败表），但**启动时**读到坏 patch 会直接启动失败。

### 2.2 什么需要刷新/重启

| 变更 | 生效方式 | 需要重启？ |
|---|---|---|
| 安装/卸载（脚本改 profile patch） | HMR live 重组，约 2-5 秒 | 不需要 |
| 改 `src/**`（插件实现） | `plugin.js` 自己 watch，600ms 防抖后重挂载；日志 `mounted (watcher)` | 不需要 |
| 改 `src/index.js` 的 Config/schema 默认值 | 同上（重新挂载时重新读取） | 不需要 |
| 改 `plugin.js` 本身 | HMR 只在"下一次 profile 重组"时替换已变化的 linked 文件；单纯改文件不会触发重组 | 需要**触发一次重组**（插件页启停一次 voice-practice 行 / 改一下 profile patch 内容）或重启 App |
| 手工改 profile patch | HMR live 重组 | 不需要 |
| 将来新增客户端 bundle（`dsh.client`） | 浏览器模块图是独立加载机制；HMR 不覆盖浏览器已有模块 | 刷新 Web GUI；首次加载新 bundle 可能还要重启 App |
| HMR 未启用，或提示 `restart-required` | 改动只在重启后生效 | 需要 |

注：`dsh-hmr/README.zh.md:118` 明确"在 Plugin Manager 之外执行的安装在下一次重组或重启时生效"；本方案的 patch 内容变化本身就会触发重组，且 symlink 在写 patch**之前**创建，重组读取时 linked root 已就绪。

### 2.3 首次安装的时序

1. 脚本创建 symlink 并写入 profile patch（原子 rename）；
2. Chokidar `awaitWriteFinish` 稳定窗约 2 秒；
3. HMR 重组：重新解析 patch → `plugin.js` 的绝对路径转 file URL → Loader import；
4. `plugin.js` 动态 import `src/index.js` 并 `ctx.plugin` 挂载 → 写 `logs/voice-loader.log`：`watching ./src for dev reloads`，随后 `mounted (startup) t=...`；
5. Web GUI 插件页出现 `voice-practice` 行；`/voice` 命令可用。

总计约 2-5 秒（不含首次执行 `/voice on` 时 SenseVoice worker 的懒启动）。

---

## 3. 安装操作手册

### 3.1 前置条件

- Node 24（脚本只用标准库；不需要 pnpm，不需要网络）；
- 插件根存在 `plugin.js` 与 `src/index.js`（src 尚未实现完也能安装，但日志里会先出现 `mount failed`，实现修好后自动/手动重挂载）；
- 当前用户对 `~/.dsh/profiles/desktop` 有写权限（脚本**不需要 sudo**；不要用 root 跑，否则会改变文件属主）。

### 3.2 预演

```bash
node scripts/install-local.mjs --dry-run
```

输出包含：profile 目录、patch 路径、插件根、入口文件、`practiceRoot`、bare import 扫描结果、symlink 当前状态与将执行的动作、备份目录（执行时才创建）、**将追加的 YAML 块全文**、变更摘要、执行步骤、生效方式。确认后去掉 `--dry-run`。

### 3.3 执行

```bash
node scripts/install-local.mjs
```

成功后输出备份目录、下一步与验证命令、回滚命令。若失败：非 0 退出、自动回滚、stderr 说明原因、备份目录保留。

### 3.4 常用参数

| 参数 | 说明 |
|---|---|
| `--dry-run` | 只打印计划，不写任何文件 |
| `--profile-dir <path>` | 指定 profile 目录（默认 `$DSH_HOME/profiles/desktop`） |
| `--profile <name>` | 用名称指定 profile（默认 desktop） |
| `--root <path>` | 插件根（默认脚本上一级目录；测试用） |
| `--entry <path>` | patch 条目指向的入口（默认 `<root>/plugin.js`） |
| `--backup-dir <path>` | 备份根（默认 `<root>/backup`） |
| `--no-symlink` | 跳过 linked-root symlink（默认总是创建；跳过时若检测到 bare import 会告警） |
| `--symlink` | 兼容选项（默认行为即创建） |
| `--replace-symlink` | 允许替换已存在但指向别处的同名 symlink |
| `--rollback <dir>` | 从备份目录回滚（不执行安装） |

---

## 4. 验证插件已加载

推荐顺序：

**(1) smoke-check（读日志，最直接）**

```bash
node scripts/smoke-check.mjs --wait 20
```

检查并输出：

- `<插件根>/logs/` 目录是否存在；
- `<插件根>/logs/voice-loader.log` 是否出现 `mounted (startup)` / 其它 `mounted (`，以及是否出现（之后的）`mount failed`；
- profile patch 是否有本插件的 managed 块且 `name` 指向 `<插件根>/plugin.js`；
- `node_modules/dsh-speaking-practice` symlink 是否指向插件根。

退出码：`0` = 已加载；`1` = 未确认；`2` = 参数/配置错误。`--json` 输出结构化结果。`--wait N` 会在 N 秒内轮询（安装后立刻用很方便）。

**(2) 日志**（`logs/` 已被 `.gitignore` 忽略）

| 文件 | 关键行 | 含义 |
|---|---|---|
| `logs/voice-loader.log` | `watching ./src for dev reloads` | dev shell 已挂载并开始监视 |
| | `mounted (startup)` / `(watcher)` / `(command)` | 插件实现挂载成功（启动 / 文件变化 / `/voice-reload`） |
| | `mount failed (...)` | 实现加载失败，后面跟错误（常见：`Cannot find package '@deepseek-ai/...'` → symlink 缺失或插件根被移动） |
| | `shell disposed` | 条目被卸载（卸载脚本或 profile 重组移除） |
| `logs/voice-practice.log` | 实现自己的运行日志 | `/voice on` 之后的录音/识别/朗读过程 |

**(3) Web GUI 插件页**：侧栏「插件」页应出现 `voice-practice` 行（来自 managed 块），可查看状态/启停。被启用但加载失败时页面会显示错误。

**(4) 命令**：在「练习口语」工作区（`practiceRoot` 下的 cwd）开会话，输入 `/voice status`、`/voice on`。

**(5) 静态检查**（不依赖运行中的 App）：

```bash
node -e "const fs=require('node:fs');const p='/Users/eastbuy/.dsh/profiles/desktop/cordis.patch.yml';const c=fs.readFileSync(p,'utf8');console.log('blocks:',(c.match(/# >>> dsh-speaking-practice/g)||[]).length)"
readlink "/Users/eastbuy/.dsh/profiles/desktop/node_modules/dsh-speaking-practice"
```

**失败诊断**

| 现象 | 可能原因 | 处理 |
|---|---|---|
| patch 块在，但日志一直不出现 | HMR 未生效/禁用了 HMR | 刷新 Web GUI；等 10 秒；重启 App |
| `mount failed ... Cannot find package` | symlink 缺失/指向错误，或插件根被移动 | 重跑 `install-local.mjs`；用 `smoke-check` 看 symlink 行 |
| `mount failed ... SyntaxError` 等 | `src/index.js`/其依赖有语法/运行错误 | 修代码，`/voice-reload` 或等 watcher |
| 插件页没有 voice-practice 行 | patch 写入未生效或块被手工删掉 | 重跑安装脚本（幂等） |
| 启动 App 直接失败/白屏 | patch YAML 语法被破坏 | 从 `backup/<时间戳>/cordis.patch.yml` 恢复；见 §6 |

---

## 5. 完全卸载

```bash
node scripts/uninstall-local.mjs --dry-run   # 先看计划
node scripts/uninstall-local.mjs             # 备份 -> 删除 managed 块 -> 删除归属 symlink
```

- 只删除 markers 之间的块；原有内容与顺序不动；若删完只剩空内容会写入 `[]`（合法空数组，避免"空 patch 启动失败"）；
- 只在 symlink 指向本插件时删除；指向别处/真实目录一律保留并提示；
- 幂等：未安装时只打印"已经处于未安装状态"，不写文件、不备份；
- 失败自动回滚。

卸载后：

- HMR 约 2-5 秒重组，`voice-practice` 条目停止并从插件页消失，`voice-loader.log` 出现 `shell disposed`；
- 日志文件（`logs/`）与 `backup/` 备份不会自动删除，可手工清理：`rm -rf logs backup`；
- 如果曾经从 Web GUI「插件」页按本地包安装过 bundle，那条路径需要**在插件页卸载**（本脚本只管 patch 层，见 §7）。

---

## 6. 回滚与恢复

### 6.1 自动回滚

安装/卸载过程中任何一步失败，脚本按记录自动回滚到执行前状态（patch 内容、symlink），并保留备份目录。stderr 会打印失败原因和备份路径。

### 6.2 用备份回滚

```bash
node scripts/install-local.mjs --rollback "backup/20261026T090500Z"
# 或
node scripts/uninstall-local.mjs --rollback "backup/20261026T090500Z"
```

`--rollback` 读取备份里的 `state.json`：若备份包含 `cordis.patch.yml` 则复制回去；若安装前没有 patch 且当前文件只剩我们的块则删除；symlink 恢复为安装前状态（不存在则删除本次创建的；原本指向别处则重建）。回滚同样是幂等的。

### 6.3 手工恢复

备份目录里有 `RESTORE.md`、`state.json` 和改动前的 `cordis.patch.yml`。最直接：

```bash
cp "backup/<时间戳>/cordis.patch.yml" "/Users/eastbuy/.dsh/profiles/desktop/cordis.patch.yml"
```

如果备份里没有该文件（说明改动前不存在），应写入一行 `[]` 而不是留空文件；空 patch/纯注释 patch 会导致启动失败。

### 6.4 典型恢复决策

- **App 启动失败**：先恢复备份的 patch（或写 `[]`），重启 App；再看 `logs/voice-loader.log` 找插件自身错误。
- **App 运行中但插件没生效**：检查块与 symlink（`smoke-check`），必要时重跑安装脚本；仍不行重启 App。
- **插件根目录被移动/改名**：patch 里的绝对路径失效。移动后重跑 `install-local.mjs`（块会被替换为新路径；symlink 会自动修正），或先 `uninstall-local.mjs` 再安装。
- **疑似 pnpm 操作改了 profile**：Web 插件页装/卸其它插件会跑 pnpm 并可能重建 `node_modules`。之后用 `smoke-check` 复查 symlink，必要时重跑 `install-local.mjs`（幂等补齐）。

---

## 7. 风险与注意事项

1. **配置文件损坏风险**：profile patch 是启动关键文件。脚本只追加/删除自己的块并做读回校验，但仍建议执行前看 `--dry-run`。已备份，且回滚是一行命令。
2. **与 GUI 插件页并存**：插件页按行 id 管理，可能往 profile patch 追加 `- id: voice-practice` 的 `disabled` 覆盖；按"最后写入者胜"，它会覆盖我们块里的行状态。卸载脚本只删自己的块，不会动插件页写入的覆盖项。
3. **与 GUI 本地包安装互斥**：如果同时用「插件」页把本目录作为 bundle 安装，组合包里也会 insert 同一个 id `voice-practice`，profile 中会出现两条同 id insert。**不要同时使用**；切换方案前先卸载另一个。
4. **symlink 不是唯一真相**：`node_modules` 被重建/清理后 symlink 可能消失，插件会在下次重组时变成 `mount failed`。`smoke-check` 可快速确认，`install-local.mjs` 幂等补齐。
5. **路径含中文与空格**：脚本用 `JSON.stringify` 生成 YAML 双引号标量、全程 `fs` API，不拼 shell 命令；请勿把块里的路径手工改成未加引号的写法。
6. **不要以 root 运行**：否则 `~/.dsh` 下文件属主可能变化。脚本不需要 sudo，只需当前用户对 profile 有写权限。
7. **备份目录增长**：每次有实际变更都会新建 `backup/<时间戳>/`（`.gitignore` 已忽略）。确认稳定后可删除旧备份。
8. **HMR 的边界**：HMR 只保证 profile 配置层 live；`plugin.js` 自身的改动、客户端 bundle 的改动需要触发重组/刷新 GUI/重启（见 §2.2）。
9. **provider/麦克风权限**：语音功能还依赖系统麦克风权限与 SenseVoice 模型（见 README 与 `docs/voice-plugin-spec.md`），与安装脚本无关。

---

## 8. 备用方案：从 Web「插件」页按本地路径安装

如果以后要把插件作为**组合包**分发（而不是 dev shell 方式），可以走 Desktop 内置的插件管理：

1. 侧栏「插件」页 → 安装 → 选择/输入本地目录 `/Users/eastbuy/Documents/梦想草稿/练习口语`；
2. 管理端会调用 Desktop 内置 pnpm，写入 profile `package.json` 的 `dependencies`（`link:<绝对路径>`）、把包名追加到 `dsh.profile.bundles`、更新 `pnpm-lock.yaml`，并在 `node_modules` 建 symlink；
3. 生效时仍是 HMR 重组（Plugin Manager 的操作直接触发，不等文件事件），首次加载新组合包/客户端 bundle 可能仍需刷新 GUI 或重启。

两种方案的差异：

| | 脚本（本说明主方案） | GUI 插件页安装 bundle |
|---|---|---|
| 改 profile `package.json` / `bundles` | 否 | 是 |
| 改 `pnpm-lock.yaml` / 跑 pnpm | 否 | 是 |
| patch 来源 | profile patch 里的 managed 块 | 包内 `cordis.patch.yml`（本包已有，id 同为 `voice-practice`） |
| 生效 | HMR，约 2-5 秒 | HMR / 首次可能需重启 |
| 卸载 | `uninstall-local.mjs` | 插件页卸载（走 pnpm remove） |
| 适用 | 本机开发、快速回滚 | 分发、稳定版本、非开发机 |

> 切换前务必先卸载现有方案，避免同 id `voice-practice` 两条 insert 冲突。

---

## 9. 文件与常量参考

| 常量 | 值 |
|---|---|
| 包名 | `dsh-speaking-practice` |
| Loader 行 id | `voice-practice` |
| managed 块起始标记 | `# >>> dsh-speaking-practice (managed by scripts/install-local.mjs)` |
| managed 块结束标记 | `# <<< dsh-speaking-practice` |
| 入口文件 | `<插件根>/plugin.js` |
| linked-root symlink | `~/.dsh/profiles/desktop/node_modules/dsh-speaking-practice -> <插件根>` |
| profile patch | `~/.dsh/profiles/desktop/cordis.patch.yml` |
| 备份 | `<插件根>/backup/<UTC 时间戳>/` |
| 日志 | `<插件根>/logs/voice-loader.log`、`<插件根>/logs/voice-practice.log` |

---

## 10. 证据索引（本机 0.2.1-rc.3 解包源码/README）

| 结论 | 证据 |
|---|---|
| Desktop 用 loadProfileDirectory 加载 app-owned profile | `@deepseek-ai/dsh-desktop-host/lib/index.js:218-250` |
| profile 结构、patch 顺序、空 patch 启动失败 | `@deepseek-ai/dsh-app-boot/README.zh.md:48-69`（61、65 行） |
| insert.name 支持绝对路径/文件 URL，绝对路径转 file URL | `dsh-app-boot/lib/index.js:3970-3978`；README.zh:65 |
| bundle 解析双锚点（安装目录优先，再 profile） | `dsh-app-boot/lib/index.js:995-1001` |
| runtime resolution 计算、linkedRoots 来自 node_modules symlink | `dsh-app-boot/lib/index.js:664-692,766-798` |
| ESM hook 仅对 profile 树/profile/linked root 的 importer 路由 bare import | `dsh-app-boot/lib/index.js:1337-1345,1855` |
| linked 目录参与 peer 查询 | `dsh-app-boot/README.zh.md:134` |
| 重组时重新读取 profile 并发布新 resolution | `dsh-app-boot/lib/index.js:830-837,3797-3910` |
| HMR 行（profileContext 时启用，root: []） | `@deepseek-ai/dsh-base/cordis.patch.yml:27-32` |
| HMR 监听 manifest + 两份 patch；manifest 仅 bundles 变化触发；2s 稳定窗 | `dsh-hmr/lib/index.js:849-873`；`dsh-hmr/README.zh.md:27-36,47,59,118` |
| HMR 重组读磁盘 patch 并替换 linked 包变化文件 | `dsh-hmr/lib/index.js:1320-1384`；README.zh:49,65 |
| 插件管理写 manifest/bundles、走内置 pnpm、HMR 生效 | `@deepseek-ai/dsh-plugin-manager/README.zh.md:40,44,98-100,102` |
| desktop profile 被 CLI 拒绝管理 | `dsh/README.zh.md:18-20`（见 docs/dsh-extension-notes.md §1.2） |
| plugin.js 日志格式 | 本仓库 `plugin.js:16-34,97,125` |

以上行号基于本机解包产物 `/tmp/dsh-asar-extract`（app.asar，0.2.1-rc.3）；升级 DSH 后行号可能偏移，结论以同版本源码复核为准。


---

## 客户端半（browser half）说明

v0.3 spike 起，包内增加了浏览器半：`lib/client.js` + package.json 的 `dsh.client` / `exports["./client"]`。

- `dsh-client-modules` 从 **Loader 条目解析到的最近 package.json** 读取 `dsh.client`，因此 patch 条目的 `name` 用 **包名**（默认，脚本已改为该行为）时最稳；用绝对路径也能在启动时被识别，但 `dsh-client-modules` 对"不是客户端包"的判定会按 Loader specifier 缓存到重启，所以**热加客户端半**可能不生效。
- 客户端半更新后：刷新 Web GUI；首次新增客户端半或模块图异常时重启 App。
- 入口文件/包名切换会触发 profile 重组（HMR 监听 patch 文件）。本次实测：把条目 name 从绝对路径切到 `dsh-speaking-practice` 后，宿主插件热重载成功。
