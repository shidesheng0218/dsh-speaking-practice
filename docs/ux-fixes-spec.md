# UX 修复（P0）实现规格：错误恢复 / 结束兜底 / 流式朗读

> 目标：解决三个最伤体验的问题——①错误只说英文/进日志，用户无法自助；②不说 "end session" 就没有复盘；③回复整段生成完才朗读，对话空窗 3–5 秒。
> 分工纪律：本文件是接口契约。队员只改自己范围内文件，src/index.js 由 Lead 统一改动，避免冲突。

## 0. 文件所有权

| 文件 | 所有者 |
|---|---|
| `src/core/stream-speech.js`（新）、`src/core/loop.js`、`test/stream-speech.test.mjs`、`test/loop.test.mjs` | stream-tts-dev |
| `src/core/stats.js`（新）、`src/core/light-recap.js`（新）、`test/stats.test.mjs` | session-guard-dev |
| `src/index.js`、README、docs | Lead |
| 其余文件 | 不要动 |

## 1. 流式朗读（stream-tts-dev）

### 1.1 新模块 `src/core/stream-speech.js`（纯逻辑，不 import @deepseek-ai）

```js
export function createStreamSpeaker(options) -> speaker
// options: { tts, log, maxSentenceChars=220, languageThreshold=0.3, minSegmentChars=8, onBeforeSpeak? }
//   tts: { speak(segments), cancel(), speaking }   —— 现有 src/tts.js 的 Speaker
//   onBeforeSpeak?: () => void   —— 每段开播前调用（loop 用来抑制 VAD 误触发）
// speaker 方法：
//   reset()                     —— 新一轮 assistant attempt 开始：清空缓冲与队列、递增 generation
//   pushText(delta)             —— 追加文本增量；自动按句边界（.!? 或换行 + 后随空白/结尾）切句并排队朗读
//   flush()                     —— 把剩余缓冲切成段并排队；返回 Promise，等队列真正读完
//   cancel()                    —— 清空缓冲/队列、tts.cancel()、使旧结果失效；随后 resolve
//   get spokenText()            —— 本轮已交给 TTS 的全文（去重用）
//   get speaking()              —— 队列非空或 tts.speaking
//   dispose()                   —— 清理
```

要求：
- 复用 `./text.js` 的 `prepareSpeechText`（清洗/分句/语言分段），但**增量**处理（不要等全文）。
- 句边界判据：`[.!?…]` 后跟空白或结尾；缓冲超过 maxSentenceChars 时在逗号/空格处硬切，避免长句无限等待。
- 段文本过短（< minSegmentChars 且不是最后 flush）先不播，合并到下一段。
- 顺序播放：内部 Promise 链串行 await `tts.speak(segments)`；单个段失败只 log，继续后面的段。
- cancel 后旧队列不得再出声；pushText/flush 在 cancel 后调用应安全（丢弃）。
- 每段播放前调用 onBeforeSpeak（loop 用来 `vad.suppress(ttsOnsetGuardMs)`）。

### 1.2 `src/core/loop.js` 修改

- 新增 deps：`stats`（可选，见 §2），start 时创建 streamSpeaker（注入 onBeforeSpeak → vad.suppress）。
- 新方法 `onStreamFrame(frame)`：
  - 仅在 `awaiting-reply` / `speaking` 且 `frame.turn === reply.activeTurn`（reply 模块需暴露当前期望 turn，可加 getter）时接受。
  - `start`：`streamSpeaker.reset()`；`chunk` 且 `chunk.type === 'text-delta'`：`streamSpeaker.pushText(chunk.text)`；首次真正开播时状态转 `speaking`（沿用现有 suppression 与 barge-in 逻辑）。
  - `end`：忽略。
- `turn/end`（completed）：若本 turn 有流式文本（spokenText 非空）→ `await streamSpeaker.flush()`，然后回 listening；**不再重复整段朗读**。若无流式文本 → 保留现有兜底（用 assistant/message 收敛文本朗读）。
- barge-in（speaking 时 speech-start）：调 `streamSpeaker.cancel()` 而不是直接 `tts.cancel()`，状态转 capturing。
- stop/dispose：`streamSpeaker.cancel()` + dispose；忽略迟到 flush。
- 错误话术（说人话）：
  - 连续转写失败计数；第 1–2 次仍说英文 "Sorry, I didn't catch that."；**第 3 次连续失败**改名 `_sayTranscribeFailure()`：说中文 "我这边一直没听清你的声音，先暂停语音模式。检查一下麦克风，然后再输入 /voice on 重试。"（`tts.speak([{lang:'zh',text}], ...)`），随后 `requestVoiceOff('transcribe-failed')`；成功转写后计数清零。
  - 新增 `announceChinese(text)` 方法（供 Lead 的 idle 提醒使用）。
  - status() 增加字段：`lastActivityAt`（毫秒时间戳；VAD speech-start、utterance、提交、回复都更新）、`consecutiveFailures`、`speaking`（是否在朗读）。
- stats 钩子：用户文本提交成功 → `stats.onUserText(text)`；assistant/message 收到文本 → `stats.onAssistantText(text)`；utterance → `stats.onSpeech(durationMs)`；错误 → `stats.onError(kind)`；均 try/catch 包裹。
- 保持现有 87 个测试全绿（必要时更新 test/loop.test.mjs，新增 stream 用例）。

### 1.3 测试
- stream-speech：增量切句、硬切、短段合并、串行顺序、cancel 后不出声、失败继续、flush 尾巴。
- loop：流式帧驱动到 speaking、turn/end flush 不重复、无流式时兜底、barge-in cancel、三次转写失败转中文+关闭、status 字段。

## 2. 统计与轻量复盘（session-guard-dev）

### 2.1 `src/core/stats.js`（纯逻辑）
```js
export function createSessionStats(options) -> stats
// options: { sessionId, scenarioId, level, startedAt=Date.now() }
// stats 方法（都幂等/防御式，不抛）：
//   onUserText(text) / onAssistantText(text) / onSpeech(ms) / onError(kind)
//   snapshot() -> {
//     sessionId, scenarioId, level, startedAt, endedAt, durationMs,
//     userUtterances, userWords, avgWordsPerUtterance, longestWords,
//     assistantMessages, assistantWords, speechMs,
//     errors, errorKinds,
//     fillerCounts: {um, uh, like, 'you know', actually, basically, so, well},
//     fillerTotal, fillerPer100Words,
//     userTexts: [...最多 40 条，每条截断 160 字]
//   }
```
填充词统计：对 user text 做词边界、大小写不敏感匹配；"you know" 为短语。

### 2.2 `src/core/light-recap.js`（纯逻辑 + fs 写入）
```js
export function findModelRecap({ practiceDir, scenarioId, sinceMs }) -> Promise<string|null>
// 在 practiceDir 里找 *-<scenarioId>.md（排除 *-auto.md），mtime >= sinceMs 视为模型已写
export function renderLightRecap({ stats, scenario, level, note }) -> string
// Markdown：会话事实（时长/轮数/字数/填充词/语音时长）、你的发言摘录、填充词统计、
// 下次建议（确定性规则：填充词最多→建议停顿；字数少→建议扩展；错误多→检查麦克风），
// 结尾注明"说 end session 可让教练写完整复盘"
export async function writeLightRecap({ practiceDir, stats, scenario, level, log, now = new Date() }) -> { path, skipped, reason }
// 文件名 YYYY-MM-DD-HHmm-<scenarioId>-auto.md；目录不存在则 mkdir -p；
// 若 findModelRecap 找到本次会话的模型复盘 → skipped=true, reason='model-recap-exists'
```
要求：中文正文 + 学员发言原样摘录；写失败只 log 不抛。

### 2.3 测试：`test/stats.test.mjs`
填充词计数、平均/最长句长、错误计数、快照不变性、轻量复盘渲染、目录创建、模型复盘存在时跳过、写失败降级。

## 3. Lead 的 index 接线（不在队员范围）

- `ctx.on('agent/assistant-stream', ({ agent, frame }) => ..., { global: true })`：过滤 `agent.session.id === active.sessionId` 后调 `active.loop.onStreamFrame(frame)`。
- `/voice on`：创建 stats（sessionId/scenarioId/level）、创建 practice 目录，注入 loop deps。
- `/voice off` / idle 自动关 / mic fatal / dispose：停 loop 后若 `stats.snapshot().userUtterances > 0` → `writeLightRecap`；成功后说中文 "练习记录已保存到 practice 文件夹。"，失败只日志。
- idle 计时器：活动时每 15s 检查，180s 无活动 → `loop.announceChinese('还在吗？我们可以继续，或者说 end session 结束练习。')`（每个静默周期一次）；600s → `voiceOff('idle')`（走轻量复盘）。
- mic fatal：先说中文 "麦克风好像断开了，语音模式已关闭。"，再 off + 轻量复盘。
- voiceOff 的英文播报改中文 "语音模式已关闭。"。

## 4. 验收
- `node --test` 全绿（含新增用例）。
- 热重载后插件正常加载；日志出现 stream / light-recap 关键行。
- 真实会话：教练回复第一句即开始朗读（不等整段）；说错/静默时有中文提示；`/voice off` 后 practice/ 出现 *-auto.md；第三次转写失败会中文解释并自动关闭。
