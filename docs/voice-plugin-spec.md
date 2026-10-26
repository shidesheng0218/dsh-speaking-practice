# 英语口语语音插件 v0.1 技术规格（host-only voice loop）

> 目标：在 DSH 桌面版里输入 `/voice on` 后，和 Harness 进入免按键语音对话：说话→自动断句→本地 SenseVoice 转写→自动作为用户消息提交→助手回复自动用 macOS `say` 朗读（Samantha 美音）→读完继续听，可随时开口打断朗读。
> 本版只做 **host 半**（无客户端 UI）；`/voice` 斜杠命令控制。客户端 UI 是下一阶段。
> 工作目录（插件包根）：`/Users/eastbuy/Documents/梦想草稿/练习口语`。

## 0. 文件与所有权（避免写冲突）

| 路径 | 所有者 | 说明 |
|---|---|---|
| `package.json` / `cordis.patch.yml` / `icon.svg` / `.gitignore` | Lead | 已建好，不要改 |
| `src/index.js` | voice-core-dev | Cordis 插件入口：命令、配置、session/event、组装 loop |
| `src/core/*.js` | voice-core-dev | 纯逻辑（VAD、WAV、文本清洗、分句、语言分段、状态机），不 import @deepseek-ai/*，可单测 |
| `src/mic.js` `src/tts.js` `src/log.js` | voice-core-dev | ffmpeg 常驻采集 / say 播放 / 文件日志封装 |
| `test/*.test.mjs` | voice-core-dev | node:test 单测（纯模块 + fake service） |
| `scripts/install-profile.mjs` `scripts/uninstall-profile.mjs` `docs/install-notes.md` | plugin-ops-dev | 安装/回滚脚本与说明；**不执行**，由 Lead 带审批执行 |
| `docs/voice-plugin-spec.md` | Lead | 本文件 |

约束：不写入 workspace 之外；不安装依赖；不重启 App；不修改 DSH 安装目录。日志与测试产物放 `logs/`、`lab/.work/`。

## 1. 运行时 API 事实（已从 app.asar 解包验证，建议自行复核）

- 插件入口（cordis）：`export const name / export const inject / export const Config / export function apply(ctx, config)`。参考已解包源码 `/tmp/dsh-asar-extract/dsh/node_modules/@deepseek-ai/dsh-experimental-speech-to-text/lib/index.js`，以及已装第三方插件 `~/.dsh/profiles/desktop/node_modules/dsh-context/lib/index.js`（尾部 `const name/inject; function apply(ctx, config); export { Config, apply, inject, name }`）。
- Config 用 `@deepseek-ai/schemastery`：`import z from '@deepseek-ai/schemastery'; export const Config = z.object({...})`（运行时解析由 profile 的 peer resolution 提供，插件目录无需 node_modules；把包名写进 package.json 的 peerDependencies）。Loader 会把 `cordis.patch.yml` 里 `insert[].config` 传给 `apply(ctx, config)`。
- 命令：`ctx.commands.register({ name:'voice', description, input:{ hint:'on | off | status' }, handler: ({ agent, rawInput }) => ({kind:'success', text:'...'}) })`；错误结果 `{kind:'error', text}`。命令不产生模型消息。
- Agent：命令 handler 的 `agent` 是 Agent 实例（有 `agent.session`；session 有 `session.id` 与 `session.header.cwd`）。实时注册表：`ctx.agents.get(sessionId)` 返回 **AgentHandle**，用 `handle.agent.followup(msg)`。
- 注入用户消息：
  ```js
  import { createUserMessage } from '@deepseek-ai/dsh-llm'
  ctx.agents.get(sessionId)?.agent.followup(createUserMessage({ content:[{type:'text', text}], source:{ kind:'user' } }))
  ```
  followup 入 next-turn 并唤醒；若在运行中则排队。
- 会话事件：`ctx.on('session/event', (session, event) => ...)`。
  - `event.type === 'assistant/message'`，`event.data = { turn, step, message, usage?, stream? }`，文本在 `message.content.filter(b=>b.type==='text')`。
  - `event.type === 'turn/end'`，`data = { turn, reason }`，`reason.kind` = `completed | blocked | max-tokens | error | aborted`。
  - 另有 `event.type === 'user/message'`（我们注入的消息也会出现；可用于状态判断）。
  - 只处理 `session.id === activeSessionId` 的事件。
- 语音识别（本机已启用 sensevoice-local，模型已下载）：
  ```js
  const spec = ctx.speechToText.resolve({ audio: wavBuffer, language: config.language })  // audio: Uint8Array/Buffer，16k mono PCM16 WAV
  const result = await ctx.speechToText.transcribe(spec, signal)  // { text, audioSeconds, inferenceSeconds }
  ```
  首次转写会懒启动 worker（可能 1~3s）；可在 /voice on 时调用 `ctx.speechToText.prepare('sensevoice-local')` 预热并吞掉错误（provider 未就绪时日志记录）。
- 子进程：`ctx.subprocess.resolveExecutable('say')` / `resolveExecutable('ffmpeg')`；`ctx.subprocess.spawn({ argv, cwd:'/', stdio:{ stdin:'ignore', stdout:'pipe', stderr:{maxBytes:8192} }, graceMs:1000 })`。返回 handle：`{ stdin, stdout, stderr, collected, done, terminate(), waitForExit() }`；`stdout` 是 Node Readable（pipe 模式）；`handle.done` resolve `{exitCode, signal}`；`terminate()` 幂等。**注意**：ffmpeg 非 PATH 内可执行文件时用绝对路径 `/opt/homebrew/bin/ffmpeg`（先 resolveExecutable('ffmpeg') 失败再回退绝对路径）。
- 音频采集（已实测 TCC 放行）：`/opt/homebrew/bin/ffmpeg -hide_banner -loglevel error -f avfoundation -i :0 -ar 16000 -ac 1 -f s16le -`，stdout 为连续 PCM。设备打开有 0.35–0.5s 固定延迟（只在启动时）。退出/重启进程要打日志。
- 朗读：`say -v Samantha -r 175 <text>`（argv 直传，不经 shell，text 作为单独 argv）。实测首音 0.7–0.85s，合成固定开销 ~0.77s；SIGTERM 打断 1–6ms。`say -v '?'` 本机英文只有 6 个 compact 音色：Samantha(en_US) 推荐、Daniel(en_GB)、Karen、Moira、Rishi、Tessa。中文音色需运行时探测（`say -v '?'` 里有 zh_CN 才用，否则跳过中文朗读或仍用 Samantha）。
- 音频语义：16kHz 单声道 16-bit LE PCM。20ms = 320 samples = 640 bytes。
- 日志：插件内写 `<practiceRoot>/logs/voice-practice.log`（UTF-8，追加，带时间戳与级别）；同时 `ctx.logger.info/warn` 输出关键行。日志是安装验证与用户反馈的唯一可靠通道（GUI 不显示插件日志）。

## 2. 配置（Config schema，v0.1）

```js
export const Config = z.object({
  practiceRoot: z.string().default(''),        // 只对 cwd 以它开头的 session 生效；空=不限制
  englishVoice: z.string().default('Samantha'),
  chineseVoice: z.string().default('Tingting'), // 若本机无此音色，运行时探测后回退到 englishVoice 或跳过
  rate: z.natural().min(80).max(320).default(175),  // say -r
  language: z.string().default('auto'),         // 传给 STT 的语言提示 en/auto/zh...
  silenceMs: z.natural().min(250).max(2000).default(600),   // 说完判定
  minSpeechMs: z.natural().min(80).max(2000).default(200),  // 最短有效语音
  maxUtteranceSec: z.natural().min(5).max(180).default(45),
  bargeIn: z.boolean().default(true),
  logFile: z.string().default('logs/voice-practice.log'),
})
```
`cordis.patch.yml` 已带 `practiceRoot`（Lead 维护）。

## 3. 语音循环设计（v0.1）

### 3.1 命令
- `/voice on`：校验 session cwd（若配置 practiceRoot 非空，要求 cwd === practiceRoot 或以它开头）；若已有活动会话则先停；启动 mic + 预热 STT；返回 success 文本；**同时用 TTS 说一句** "Voice mode is on. I'm listening."（失败不影响命令成功）。
- `/voice off`：停 TTS、停 mic、清状态；返回 success；说 "Voice mode is off."
- `/voice status`：返回当前状态（active session id、state、音量是否在用、上次转写/错误摘要）。不朗读。
- 命令注册一次（全局）；`/voice` 无参数等于 status。

### 3.2 状态机
`idle → listening ⇄ capturing → transcribing → awaiting-reply → speaking → listening ...`
- `listening`：mic PCM 流持续进入 VAD；始终保留 300ms pre-roll 环形缓冲。
- 检测到起说（连续 3 帧高于阈值）→ 把 pre-roll+后续帧写入 utterance buffer，进入 `capturing`；若此时 `speaking` 且 bargeIn → 立即 `say` terminate()，状态转 `capturing`。
- 连续 silenceMs 静音 或 达到 maxUtteranceSec → 结束采集 → `transcribing`：
  - 构造 WAV → `speechToText.transcribe`（带 AbortSignal 超时 15s）。
  - 文本 trim；空/太短（<1 字符）→ 丢弃回 `listening`。
  - 特殊口头命令（忽略大小写和标点）：`stop listening / stop / voice off` → 执行 off 行为；`repeat that / say that again` → 重读上一段回复（若缓存存在）。
  - 否则 `agent.followup(createUserMessage(...))`，进入 `awaiting-reply`，记录注入的 message 以便关联轮次（可用 `user/message` 事件里的文本匹配或直接以"下一次 turn/start"为准）。
- TTS 播放：在 `turn/end` 且 reason.kind==='completed' 时，取本 turn 累积的 assistant 文本 → 清洗分句 → 顺序 say 播放（一次或多次 spawn）→ 全部结束回 `listening`。播放期间 VAD 继续运行（barge-in 打断见上）。
- 只有当前活动 session 的事件参与朗读。`turn/end` 前若无 assistant 文本（只有工具调用）不朗读。
- 关闭/插件 dispose：terminate 所有子进程（say/ffmpeg），清理监听。

### 3.3 VAD（纯 JS，可单测）
- 20ms 帧 RMS → dBFS；启动时用前 400ms 估计环境本底（中位数）；阈值 = 本底 + 12dB，且不低于 -45dBFS（上限 -20dBFS）。
- 起说：连续 3 帧超阈值；结束：连续 silenceMs 帧低于阈值。
- 最短语音 minSpeechMs；丢弃过短（咳嗽）。
- 录音期间允许能量短暂低于阈值，不切断（hangover 即 silenceMs）。
- 播放 TTS 时若 bargeIn，用同一阈值（耳机场景）；另加保护：TTS 开始后 150ms 内的帧忽略（防播放起始瞬态）。
- 输出事件回调：`onSpeechStart` / `onSpeechEnd({pcm, durationMs})`。

### 3.4 文本清洗/朗读
- 取 assistant 文本块 join `\n`；去掉 fenced code block、行内 code、markdown 链接保留文字、标题/列表符号/强调符号、HTML 标签、多余空白；保留标点。
- 句子切分：按 `.!?\n` 切；合并相邻短句到 ≤ 220 字符。
- 语言判定：CJK 字符占比 > 0.3 视为中文段，否则英文段；连续同语言段合并。
- 英文段用 englishVoice，中文段用 chineseVoice（音色不存在则整段跳过或 fallback，日志记录一次）。
- 每段 `say` 一个进程，顺序 await；段间可取消。若文本为空则跳过。
- 长回复保护：总字符 > 1200 时只读前 1200 字并追加 "…"（避免一次读太久）。

### 3.5 错误与日志
- 首次启动 mic 失败：命令返回 error，并把 ffmpeg stderr 最后 500 字写入日志。
- 转写失败：日志 + （首次）说 "Sorry, I didn't catch that."；状态回 listening。
- say 失败：日志，不阻塞循环。
- mic 进程意外退出：1s 后重试最多 3 次；仍失败则停用并日志。
- 所有状态迁移写日志（含时间、会话 id、文本摘要）。

## 4. 验收标准（v0.1）
1. `/voice on` 返回成功，日志出现 mic started / stt prepare 行；2 秒内能听到 "Voice mode is on. I'm listening."
2. 对一个 session 说一句英文 → 聊天记录出现一条 user 消息（文字合理）→ 助手回复 → 扬声器读出回复（Samantha）。
3. 朗读过程中开口说话 → 朗读 ≤0.5s 内停止，之后新内容被转写并提交。
4. `/voice off` 后 mic 与 say 进程全部退出（`pgrep ffmpeg`/播放停止），日志记录。
5. 单元测试：VAD 起止点、WAV header、句子清洗/切分/语言分段、状态机（fake deps）通过。
6. 插件卸载/dispose 后无残留子进程。

## 5. 待验证/已知风险（实现时保持防御）
- `ctx.commands` 在 desktop 是否可用（dsh-base 应启用；若 ctx.commands 不存在，inject 会让插件不加载——先在代码里用可选注入并记录日志，便于诊断）。
- `ctx.speechToText` 是否在插件注入时可用（voice-input bundle 已在 profile bundles 中，应可用）。
- `agent.followup` 的消息是否会即时触发新 turn（运行中会排队，属预期）。
- session/event 的 assistant/message 可能分步多次、可能被 compaction 替换；只按 turn 聚合最终文本即可。
- 首次 STT worker 冷启动延迟；已在 /voice on 时尝试 prepare。
- 麦克风子进程 TCC 依赖宿主 App 身份（已实测通过）；不要从 launchd/终端单独跑。
