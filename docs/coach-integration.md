# Coach 模式集成实现说明（v0.2）

> 范围：`src/coach.js`（新建）、`src/index.js`（接线）、`test/coach.test.mjs`（新建）、本文件。
> 素材 `content/*` 与 `profile.md` 由 content-writer / Lead 维护，本实现只读、不改。
> 规格见 `docs/coach-content-spec.md`；语音循环见 `docs/voice-implementation.md`。

## 1. 文件与职责

| 文件 | 职责 |
|---|---|
| `src/coach.js` | 教练提示词集成：读取 `<pluginRoot>/content` 与 `profile.md`、组合提示词、场景加载/选择、注入/释放 system prompt section 的可测试控制器。无 `@deepseek-ai/*` 依赖。 |
| `src/index.js` | 接线：`/voice on [scenario]`（先场景预检，再建 practice 目录、注入、启动 loop）、`/voice off`（先释放注入再停 loop）、`/voice scenarios`、`/voice status` 增加 scenario/coach 行、on→on 先释放旧注入、loop 启动失败与插件 dispose 释放注入。 |
| `test/coach.test.mjs` | 22 个 node:test 用例：组合/选择/降级/fake 注入释放/状态字段/控制器生命周期/index 接线静态检查。 |
| `content/coach.md`、`content/recap-template.md`、`content/scenarios/*.json`、`profile.md` | 素材（只读）。缺失/损坏只降级 + 日志，不阻塞语音。 |

插件根由 `src/coach.js` 的 `import.meta.url` 推（`src/..`），素材路径 = `<pluginRoot>/content/...`、`<pluginRoot>/profile.md`。安装用 docs/install-notes.md 的 symlink 方式时解析到练习目录，素材可直接编辑生效。

## 2. 提示词组合规则（单一 section）

每次 `/voice on` 重新读取素材，按下列顺序拼成一段纯文本，注册为名为 `voice-practice:coach`、`order: 500`、**`interpolate: false`** 的 system prompt section：

1. `content/coach.md` 原文（缺失时用内置最小协议 `FALLBACK_COACH_TEXT`）
2. `## Learner profile` + `profile.md`（缺失时整段省略）
3. `## Active scenario` + 场景卡渲染：id/name/nameZh、level、durationMinutes、goal、roles.coach/learner、opening、beats（id/intent/coachMove）、usefulPhrases、successCriteria、wrapUp、recapFocus
4. `## Recap template` + `content/recap-template.md`，并附写入说明：用 write 工具按模板写 `<practiceDir>/YYYY-MM-DD-HHmm-<scenario-id>.md`（模板缺失时改为一段简短的复盘写入要求）
5. `## Today's date` + 本地 `YYYY-MM-DD`

占位替换：
- `{{date}}` → 注入当天本地日期；`{{scenario}}` → 场景 id；`{{level}}` → 场景等级。模板里只可能在会话结束后才知道的 `{{duration}}` / `{{turns}}` 统一替换成 `…`，由模型复盘时按实际填写。
- 最后再对整段做一次“已知占位”替换（`fillKnownPlaceholders`），未知的 `{{...}}` 原样保留；由于 section 设了 `interpolate: false`，DSH 不会对它们做变量插值，不会导致 prompt 组装失败。

## 3. 素材读取与降级

- 全部用 `node:fs/promises`；`content/scenarios` 用 `readdir` 扫 `*.json` 后逐个 `JSON.parse`。
- 每个文件独立 try/catch：缺失、空文件、非法 JSON、字段残缺都只记 warn + 收集到 `warnings`，其余素材照常使用。
- scenarios 目录不存在或没有可用卡：用内置 `BUILTIN_SCENARIO`（id `daily-chat`）继续；`coach.md` 缺失用内置协议；profile/recap 缺失就省略对应段。
- 因此“只有 coach.md 也能跑”；日志会出现 `coach protocol unavailable`、`using the built-in coach protocol fallback`、`no usable scenario files ...` 等行。

## 4. 场景选择

`selectScenario(scenarios, query)`（query 大小写不敏感）：

1. 空参数：优先 `daily-chat`，没有则取按 id 排序后的第一张（`matchedBy: default | first`）。
2. 完全等于 id（`matchedBy: id`）。
3. id 唯一前缀（`matchedBy: prefix`，如 `/voice on job-i`）。
4. 唯一片段匹配 id / name / nameZh（`matchedBy: fragment`，让 `/voice on interview` 命中 `job-interview`、`/voice on chat` 命中 `daily-chat`）。
5. 前缀或片段命中多张：`ambiguous scenario ...`，列出候选。
6. 无命中：`unknown scenario ...`，命令返回 error 并列出可用 id；**不会启动麦克风，也不会打断已在运行的会话**（预检在 voiceOff 之前）。

`/voice scenarios` 每次实时读取并列出 `id — nameZh [level]`（使用内置兜底卡时标注 `built-in fallback`）。

## 5. 注入路径与生命周期

`installCoachSection` 的注册顺序：

1. **agent 作用域优先**：`agent.ctx.systemPrompt.section({ name, order: 500, text, interpolate: false })`。Cordis 的 service 访问是 traceable 的，`section()` 内部用调用方上下文（即 `agent.ctx` 的 scope）注册，所以只影响当前 agent，返回该注册的 Cordis effect disposer。
2. **回退插件上下文**：agent 作用域不可用/注册失败时，用插件 `ctx.systemPrompt`（或 `ctx.get('systemPrompt')`）注册全局 section，并写 warn `coach section registered in GLOBAL scope ...`；仍只在语音 active 期间存在，停止时移除。
3. 两条路径都失败：`{ ok: false, error }`，日志 error，语音继续但不带教练协议（硬约束：注入失败不阻塞语音）。

释放点（`createCoachController.release()`，幂等、不抛异常）：
- `/voice off`：先 `coach.release()`，再 `loop.stop()`（任务要求顺序）。
- on→on：先 `voiceOff('restart')` → 释放旧注入，再重新读取/注入。
- `loop.start()` 失败：释放刚注入的 section，避免“语音没起来但提示词还在”。
- mic fatal / 口头 off：走 `voiceOff()`，同样释放。
- 插件 dispose（热重载/卸载）：`ctx.effect` 的清理函数里先 `await coach.release()` 再停 loop；这样即使 Agent 比插件活得久，也不会残留旧教练提示。
- Agent 自己结束/关闭：agent 作用域注册随 scope 一起销毁（Cordis 语义），无需插件额外处理。

注入时机：section 在模型下一次组装 system prompt 时生效；on→on 时若旧 turn 正在组装，该 turn 仍可能看到旧提示词，属预期。

## 6. 命令行为

- `/voice on`：默认场景 `daily-chat`。校验 session/cwd/服务 → **场景预检**（失败直接返回 error，不打断现有会话）→ 若已有会话先停（释放旧注入）→ `mkdir -p <practiceRoot>/practice`（`practiceRoot` 为空时用 `<session cwd>/practice`；失败只 warn）→ 注入 → 启动 loop/预热 STT/播报。成功文本包含 `Scenario: <id>` 与 `Coach prompt: on (agent scope)`。
- `/voice on <scenario>`：支持完整 id、唯一前缀、唯一片段；未知/歧义返回 error 与可用列表。
- `/voice scenarios`（别名 `/voice list`）：列出可用场景，注明内置兜底。
- `/voice off`：释放注入 → 停 loop → 结束播报；未启动时也安全（会清理可能残留的注入）。
- `/voice status`：off 时输出 `Voice mode: off.\nscenario: (none)\ncoach: off\nlog: ...`；on 时输出 `scenario: <id>  practice=<dir>` 与 `coach: on (scope=agent|global, N chars)`，注入失败则 `coach: off (injection failed: ...)`。
- `/voice selftest` 行为不变。命令的 `input.hint` 保持 `on | off | status`（现有 `test/entry.test.mjs` 断言该字符串；scenarios 用法写进 usage 错误文本与本文档）。

## 7. 日志关键字（`<practiceRoot>/logs/voice-practice.log`）

- `coach prompt injected (scope=agent|global, scenario=<id>, N chars)`
- `coach prompt released (scenario=<id>, scope=...)`
- `coach prompt injection failed; voice mode continues without the coach protocol: ...`
- `coach activation threw; continuing without the coach prompt: ...`
- `coach prompt is not active; voice mode continues without it`
- `recap directory ready: ...` / `cannot create recap directory ...`
- 素材降级：`coach protocol unavailable`、`learner profile unavailable`、`recap template unavailable`、`no usable scenario files`、`invalid scenario JSON`
- 入口状态：`voice mode ON session=... scenario=... coach=...`

## 8. 单元测试

```bash
cd "/Users/eastbuy/Documents/梦想草稿/练习口语"
node --test
```

`test/coach.test.mjs`（22 个用例）覆盖：日期格式化/插件根推导；scenarios 读取、排序、坏 JSON 跳过、目录缺失兜底；只有 coach.md / 根目录缺失时的降级；默认/精确/前缀/片段/歧义/未知场景选择；场景卡渲染全字段；占位替换与 section 顺序；agent 作用域注册与 disposer 释放；全局回退 + 降级日志；两条路径都失败时的错误聚合；controller 的 prepare/activate/on-over-on/release/status；注入失败不阻塞；practice 目录创建与失败；index.js 接线静态检查（release 顺序、dispose 释放、命令解析）。全部 fake agent ctx / fake systemPrompt registry，使用 `lab/.work/coach-test-<pid>` 临时素材并清理，不启动 DSH、麦克风或 say。

## 9. 手工验证步骤（需已按 install-notes 把插件链接进 desktop profile）

1. 打开一个 cwd 在本练习目录下的会话，确认 `/voice` 出现在命令列表（日志出现 plugin loaded / command registered）。
2. `/voice scenarios` → 期望两行：`daily-chat — 日常闲聊 [B1]`、`job-interview — 英文面试 [B1-B2]`；若素材还没写会显示 built-in fallback 并给出提示。
3. `/voice on` → 返回 success 且含 `Scenario: daily-chat`、`Coach prompt: on (agent scope)`；日志依次出现 `recap directory ready`、`coach prompt injected (scope=agent ...)`、`voice mode ON ... scenario=daily-chat coach=agent`；约 2s 内听到 "Voice mode is on. I am listening."。
4. `/voice status` → 出现 `scenario: daily-chat  practice=<...>/practice` 与 `coach: on (scope=agent, N chars)`。
5. 验证提示词确实进了当前 agent：保持语音模式，在聊天框问一句（例如 "For the next answer, tell me which scenario is active and the exact recap file path you will write."）→ 回答应提到当前场景 id 与 `practice/YYYY-MM-DD-HHmm-<id>.md`；可说 "end session" 观察是否按 coach 协议收尾（复盘文件写到 `practice/`）。
6. `/voice on job` → 日志先 `coach prompt released` 再 `coach prompt injected ... job-interview`，status 的 scenario 变为 `job-interview`。
7. `/voice on bogus` → 返回 error 并列出可用场景；若当时语音在跑，status 应仍是 ON（预检不打断）。
8. `/voice off` → 日志 `coach prompt released` 在 `[voice] stopped` 之前；status 显示 `scenario: (none)` / `coach: off`；`pgrep -fl "ffmpeg|say"` 无残留。
9. 完整跑一个短会话并结束：检查 `practice/YYYY-MM-DD-HHmm-<scenario>.md` 存在且按模板写（date/scenario/level 已填，duration/turns 为实际值）。
10. 热重载插件（Lead 的 reload 路径）：若语音在跑，日志应有 `coach prompt released` 并停麦；重新 `/voice on` 后注入一次；语音关闭状态下热重载不应产生新的注入日志。日志里不应出现重复 `coach prompt injected` 而不配对 `released`。

## 10. 未验证点 / 风险

1. **运行时 API 未实测**：本实现只做了 node --test 与 `node --check`，未在真实 DSH 中执行 `/voice on`（本任务不重启 App、不安装）。注入 API 已从解包源码核对（`dsh-system-prompt` 的 `section()` 返回 Cordis effect disposer；Cordis traceable service 把调用方 scope 作为 `this.ctx`；`ReactLoopAgent.ctx` 即 agent scope），但 `agent.ctx.systemPrompt` 在命令 handler 的 agent 上是否始终可解析、disposer 的真实释放效果需在集成时复测。
2. **全局回退的可见范围**：agent 作用域不可用时 section 注册为全局，语音 active 期间同进程其他 agent 也可能看到教练提示（限制在语音时长内，停止即释放）；正常路径应走 agent 作用域，日志会明确 scope。
3. **非 symlink 安装**：`package.json` 的 `files` 未包含 `content/` 与 `profile.md`（这两类文件不在本次可写范围），若按“拷贝”方式安装，素材会走内置兜底；文档中的安装方式为 symlink，可解析回本练习目录。
4. **practice 目录创建失败**（权限/路径异常）只 warn：语音与教练提示正常，但模型写复盘可能失败，status 的 practice= 路径可用于排障。
5. **复盘文件名的时间**由模型按注入的 `YYYY-MM-DD` 与当前本地时间生成，插件只保证目录存在与 date 正确，不校验模型写出的文件名。
6. **注入生效边界**：on→on 的瞬间若旧 turn 已在组装 prompt，该 turn 可能仍使用旧提示；新 turn 生效。
7. **异常终态**：若插件进程被强杀而未走 dispose（例如崩溃），agent 作用域的 section 会随 agent scope 关闭一起移除；若 agent 仍存活，则可能残留旧提示，下一次 `/voice on` 会因同名 section 已注册而报注入失败并回退，需 `/voice off` 或重开 agent 恢复（正常卸载/热重载路径已覆盖 release）。
8. **素材演化**：测试不依赖 content/ 的具体内容（只做结构断言与内置兜底断言），content-writer 修改素材不会弄坏单测；但 `docs/coach-content-spec.md` 的字段约定是组合函数的输入契约。

## 11. 与任务/规格的差异（有意的决定）

- 共享任务描述写“必须成功注册注入后才启动 loop”，而硬约束写“注入失败不阻塞语音并写日志”。实现以后者为准：**场景选择错误**（用户输入问题）在启动 mic 前返回 error；**注入失败**（运行时/注册问题）记录日志并继续启动语音，status 显示 `coach: off (injection failed: ...)`。两种失败都不会悄悄启用错误场景。
- 场景选择在 id 精确/前缀之外，增加“唯一片段匹配”，因为任务示例 `/voice on interview` 需要命中 `job-interview`；歧义时仍报错并列出候选。
- 命令 `input.hint` 未加入 scenarios（保持 `on | off | status` 以兼容现有 entry 测试），scenarios 写进 usage 文本与 README 之外的本文件。
- `/voice on` 时按 Lead 要求 `mkdir -p <practiceRoot>/practice`（recursive），失败不阻塞语音。
- 未改动 `content/`、`profile.md`、`package.json`、`cordis.patch.yml`、`plugin.js`、`lib/`、`scripts/`、`README`。
