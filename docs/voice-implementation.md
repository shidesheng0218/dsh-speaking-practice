# Voice 插件 host 半实现说明（v0.1 免按键语音循环）

> 实现范围：`src/index.js`、`src/core/*.js`、`src/mic.js`、`src/tts.js`、`src/log.js`、`test/*.test.mjs`。
> 规格见 `docs/voice-plugin-spec.md`；音频实测数据见 `docs/audio-feasibility.md`。
> 本文件记录实现落点、手工验证步骤与仍未验证的风险点。

## 1. 文件与职责

| 文件 | 职责 |
|---|---|
| `src/index.js` | Cordis 入口：Config、`/voice on\|off\|status` 命令、单活动会话管理、`session/event` 事件转发、`createUserMessage + agent.followup` 注入、STT 适配与 prewarm、dispose 清理 |
| `src/core/options.js` | Config 归一化/夹取、`isWithinRoot`（路径边界判断）、日志路径解析；纯逻辑 |
| `src/core/vad.js` | 能量 VAD：20ms 帧、RMS→dBFS、400ms 本底中位数、阈值 clamp(本底+12, -45, -20)dBFS、3 帧起说、silenceMs hangover、300ms pre-roll、minSpeechMs 过滤、maxUtteranceSec 强断句、`suppress()` 瞬态保护；纯逻辑 |
| `src/core/wav.js` | 16kHz mono PCM16 WAV 构造 (`buildWav`)、头部解析/校验、时长换算；纯逻辑 |
| `src/core/text.js` | 助手文本清洗（代码块/行内代码/markdown/HTML/表格）、按 `.!?。！？…` 与换行分句、≤220 字符合并、CJK 占比>0.3 分语言段、1200 字截断、口头命令匹配；纯逻辑 |
| `src/core/state.js` | 状态机：`idle → listening ⇄ capturing → transcribing → awaiting-reply → speaking → listening`，非法迁移默认抛错，stop/dispose 用 force 收敛 idle |
| `src/core/reply.js` | 把一次提交绑定到“提交后的第一个 turn/start”，按 turn 累积 assistant 文本，turn/end 时产出待朗读文本 |
| `src/core/loop.js` | 语音循环编排（依赖注入 mic/stt/tts/submit）：VAD 事件、转写（15s 超时 + abort）、口头命令、barge-in、回复朗读、错误提示、回复超时；不 import @deepseek-ai/* |
| `src/mic.js` | 常驻 `ffmpeg -f avfoundation -i :0 -ar 16000 -ac 1 -f s16le -`；等首块 PCM（默认 8s）判定启动成功；异常退出 3 次重试后 onFatal；`stop()` terminate + 等退出 |
| `src/tts.js` | `say -v <voice> -r <rate> <text>` 分段顺序播放；`say -v '?'` 音色探测与中文回退；`cancel()` SIGTERM 立即打断；每段超时与 stderr 日志 |
| `src/log.js` | 追加写 `<practiceRoot>/logs/voice-practice.log`（ISO 时间戳+级别），同时镜像 `ctx.logger`；串行化写、失败只 warn 一次、不抛异常 |
| `test/*.test.mjs` | node:test 单测；纯模块 + fake subprocess/service，不启动真实 ffmpeg/say、不访问麦克风 |

## 2. 运行数据流

```text
ffmpeg(stdout s16le) ──data──► VoiceLoop.handleAudio
        │                        │
        │                   EnergyVad.push
        │                        │ speech-start ──► listening→capturing
        │                        │ utterance ─────► buildWav → stt.transcribe(AbortSignal.timeout 15s)
        │                        │                    │ text
        │                        │                    ├─ 空 → listening
        │                        │                    ├─ stop listening/stop/voice off → index.voiceOff()
        │                        │                    ├─ repeat that/say that again → 重读缓存
        │                        │                    └─ submit → createUserMessage → agent.followup
        │                        │                                      → awaiting-reply
        │                        └ discarded ────────► capturing→listening
        │
        └─ 播放期间 VAD 继续运行；speech-start ∧ bargeIn → tts.cancel() → capturing

session/event ──► index.js(active session only) ──► VoiceLoop.onSessionEvent
  turn/start(第一个) ──► ReplyTracker 绑定 turn
  assistant/message  ──► 累积该 turn 的 text blocks
  turn/end(completed) ─► text.js 清洗/分句/语言分段 → say 逐段播放 → listening
  turn/end(其他 reason) ─► 不朗读，回 listening
```

### 状态机

```text
idle ──start/on──► listening ──speech-start──► capturing ──utterance──► transcribing
  ▲                    ▲                          │                         │
  │                    │                          │ discarded(too-short)    ├─ 空文本/失败 ──► listening
  │                    └──────────────────────────┘                         ├─ repeat ───────► speaking ─► listening
  │                                                                         └─ submit ───────► awaiting-reply
  │                                                                                                │
  │                                                          turn/end(completed,有文本) ──► speaking ─► listening
  │                                                          turn/end(其他或无文本) ─────► listening
  │
  └──── /voice off、口头 off、mic fatal、dispose（force 迁移到 idle）
speaking ──barge-in(speech-start 且 bargeIn=true)──► capturing
```

## 3. 命令行为

- `/voice on`：校验 `session.header.cwd` 在 `practiceRoot` 内（空 root 不限制）；已有活动会话先停；启动 mic（等待首块 PCM，失败时把 ffmpeg stderr 最后 500 字写日志并返回 error）；`ctx.speechToText.prepare('sensevoice-local')` 预热（失败只 warn）；异步朗读 "Voice mode is on. I am listening."（失败不影响命令成功）。
- `/voice off`：停 TTS、停 mic、清状态；返回 success；异步朗读 "Voice mode is off."。
- `/voice status`（或 `/voice` 无参数）：返回 状态/会话/麦克风/上次转写/上次错误/日志路径，不朗读。
- 命令只注册一次（全局）；重复注册异常只记日志，不让插件崩溃。

## 4. 错误与清理

- mic 首次启动失败：命令返回 error，日志含 `ffmpeg stderr tail: ...`（最后 500 字）。
- mic 异常退出：1s 后重试，最多 3 次（可配置）；仍失败 → `onFatal` → 自动 `voiceOff('mic-fatal')`。
- 转写失败/超时：日志 + 首次朗读一次 "Sorry, I did not catch that."，回 listening。
- say 失败：记日志，继续后续段，不阻塞循环；`say` 超时（按文本长度估算 ×1.5 + 5s，5s–240s）自动 terminate。
- 回复超时（默认 120s 无 turn/start）：清 tracker 回 listening。
- `dispose`/`/voice off`：abort 在途转写、terminate say/ffmpeg、等待退出、关闭日志文件；循环用 generation 计数丢弃停止后的异步结果，避免竞态泄漏。
- 所有状态迁移写 `<practiceRoot>/logs/voice-practice.log`，同时 `ctx.logger.info/warn/error`。

## 5. 单元测试

在插件包根执行（无需 DSH、无需麦克风、不需要安装依赖）：

```bash
cd "/Users/eastbuy/Documents/梦想草稿/练习口语"
node --test
```

覆盖：VAD 起止点/pre-roll/hangover/too-short/max-duration/本底校准/suppress；WAV header；文本清洗/分句/合并/语言分段/截断/口头命令；状态机；回复绑定；options/路径判断；VoiceLoop 全流程（fake mic/stt/tts/submit，含 barge-in、口头 off、repeat、超时、错误恢复）；mic argv/首块超时/重试/onFatal；tts 音色解析/分段播放/失败继续/打断/中文回退；日志写文件+镜像+失败容忍；入口导出与 `node --check`、纯模块禁止 @deepseek-ai import。

> 说明：`test/support.mjs` 是共享 helper，node --test 会把它当作空测试文件执行一次，不影响结果。

## 6. 手工验证步骤（需安装到 desktop profile 后）

1. 安装：按 `scripts/install-profile.mjs` / `docs/install-notes.md`（plugin-ops-dev 维护）把本包 link 进 `~/.dsh/profiles/desktop` 并加入 bundles，重启 App（首次安装）。确认 `~/.dsh/profiles/desktop/node_modules/dsh-speaking-practice` 存在。
2. 打开一个 cwd 在 `practiceRoot`（= 本 workspace）下的会话，确认 `/voice` 命令出现在斜杠命令列表。
3. 输入 `/voice on` → 应返回 success，日志出现 `ffmpeg capture started`、`speech-to-text prepare requested`，约 2s 内听到 "Voice mode is on. I am listening."。
4. 说一句英文（如 "Hello, how are you today?"）→ 停 0.6s 后聊天记录出现一条 user 文字消息（SenseVoice 转写）→ 助手回复 → 扬声器用 Samantha 朗读。
5. 朗读过程中开口说话 → 朗读 ≤0.5s 内停止（say terminate 实测 1–6ms），新内容随后被转写并提交。
6. 说 "repeat that" → 重读上一段回复；说 "stop listening" → 退出语音模式。
7. `/voice status` 查看状态与上次转写/错误；`/voice off` 后执行 `pgrep -fl "ffmpeg|say"` 确认无残留进程。
8. 检查 `<practiceRoot>/logs/voice-practice.log`：应包含 plugin loaded / command registered / state 迁移 / transcript / submit / speaking reply / stopped 等行；`ffmpeg stderr tail` 仅在失败时出现。

## 7. 未验证 / 已知风险（v0.1）

1. **真实 DSH 加载未验证**：本实现只做了 `node --check` 与纯模块/ fake service 单测；`ctx.commands.register`、`ctx.get('speechToText')`、`ctx.agents.get(id).followup()` 的实际可用性依赖目标 App 版本（0.2.1-rc.3 解包源码已核对签名，但未在运行中调用）。
2. **`ctx.agents.get(id)` 返回形态**：0.2.1-rc.3 源码返回 Agent 本身（不是 handle）；实现同时兼容 `{agent}` wrapper，冷会话（无 live Agent）会报 "no live agent" 并保持 listening。
3. **回复轮次关联**：用“提交后的第一个 turn/start”绑定回复；若提交时 agent 繁忙、或用户同时手动发言，可能把别的 turn 当回复（tracker 只累积绑定 turn 的 assistant 文本，turn/end 其他 reason 不朗读）。
4. **ffmpeg TCC/设备**：采集依赖宿主 App 的麦克风授权（实测通过）；设备打开 0.35–0.5s，`/voice on` 等待首块 PCM 最多 8s（首次 TCC 冷查询可能更久，失败可重试）。
5. **外放回采/barge-in 误触发**：TTS 播放期间 VAD 继续运行且用同一阈值（耳机场景按规格）；外放时回声可能被判为起说。已加“TTS 起播 150ms 内 suppress”保护，真实音量下需复测；保守用法是戴耳机。
6. **say 音色**：本机有 Samantha/Tingting；`say -v '?'` 探测只接受/回退到已安装音色（配置中文音色不存在时优先同 zh_CN 首个音色，再退回 englishVoice）。Premium 音色缺失导致机械音，属已知体验限制。
7. **STT 行为**：`resolve({audio, language})` 依赖 `speechToText` 默认 provider 为 `sensevoice-local`（voice-input bundle 已配置）；`prepare` 失败被吞掉只记日志；首次转写 worker 冷启动 1–3s 未实测。
8. **HMR/重载**：插件 dispose 会 unregister 命令（`ctx.effect` 持有 register 返回的 disposer）、terminate 子进程；热重载后建议再执行 `/voice on`。客户端 UI 不在本版范围。
9. **超时数值**：转写 15s、回复 120s、say 按字数估算、mic 首块 8s 为工程默认值；长回复朗读受 1200 字截断限制。
10. **未实测的日志目录**：插件运行时会在 `<practiceRoot>/logs/` 建目录写日志；本机单元测试只用 `test/.tmp` 临时目录（测试后清理），未在真实 profile 下运行验证写入权限。

## 8. 与规格的差异 / 补充

- 规格 §1 写 `ctx.agents.get(sessionId)` 返回 AgentHandle 用 `handle.agent.followup`；实际 0.2.1-rc.3 源码返回 Agent，实现做两种形态兼容。
- 规格 §3.4 中文段音色缺失时“整段跳过或 fallback”；实现优先回退到本机第一个 zh_CN 音色，再退 englishVoice（只 warn 一次）。
- 规格 §3.2 说“speech-start 时若 speaking 且 bargeIn → 立即 say terminate”；实现由 VAD 的 speech-start 事件触发 `tts.cancel()`（同步 terminate），并先迁移 capturing 再等 cancel 完成。
- 未实现客户端 UI / 全局快捷键（下一阶段），host 半通过 `/voice` 命令控制。


---

## 集成验证（Lead，2026-10-26 本机实测）

安装方式：profile patch 追加绝对路径入口 + linked-root symlink（见 docs/install-notes.md），HMR 热加载，全程未重启 App。

结果：插件条目 `voice-practice` 已挂载，`/voice` 已注册。硬件/识别自检（`selfTest: true` 与 `/voice selftest` 两条路径）PASS：

- 服务：subprocess / speechToText / commands / agents / createUserMessage 全部可用
- 识别器：`sensevoice-local`（selection language=auto）
- 音色：检测到 174 个系统音色（英文预置 Samantha 等）
- 麦克风：ffmpeg 常驻采集 1.5s，43KB PCM，rms ≈ -41 dBFS / peak ≈ -27 dBFS（TCC 经 Electron 宿主放行）
- 识别往返：`say` 合成 → ffmpeg 转 16k PCM → 插件 `buildWav` 规范头 → `ctx.speechToText.transcribe`，回读文本与原文一致
- 播放：`say` 分段朗读成功；SIGTERM 打断路径单测覆盖

**仍未实测**（需要真人对着麦克风）：VAD 起说/断句 → followup 注入 → 模型回合结束 → 朗读的完整对话闭环，以及外放回采。第一轮真实测试以 `logs/voice-practice.log` 的状态迁移行为准。
