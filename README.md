# dsh-speaking-practice

在 DeepSeek Harness 桌面版里练英语口语的本地插件。

当前 v0.4：免按键语音循环 + 教练模式 + 客户端浮层（状态/波形/字幕/Stop）+ 跟读练习 + 4 个场景 + 结束兜底复盘。

仓库：<https://github.com/shidesheng0218/dsh-speaking-practice>
打开后**不用打字、不用按键**：你对着电脑说话 → 本机 SenseVoice 转成文字 → 自动作为消息发给 Harness → 它回复时用 macOS 语音读给你听 → 你说完它继续听。朗读过程中你随时开口，它会停下来听你说。

- 语音识别：DSH 自带的本地 SenseVoice（模型已在本机，离线可用）
- 语音合成：macOS `say`（默认 Samantha 美音；可在配置里换音色/语速）
- 对话模型：当前会话所用的模型
- v0.1 只有 host 半 + `/voice` 命令；带麦克风按钮/波形/字幕的客户端 UI 在下一阶段

## 安装

插件已在 DSH 桌面版 profile 的 patch 层注册（见 `scripts/install-local.mjs`）。安装后无需重启，HMR 会自动加载。也可以从 Web GUI 侧栏「插件」页把本目录当作本地包安装（用于分发时的备用路径，见 `docs/install-notes.md`）。

## 客户端 UI（spike）

输入框右侧（模型选择器左边）会出现 **🎙 语音** 按钮（客户端插件 `lib/client.js`，slot `conversation.input.right`）：

- 点一下 = 相当于是往输入框写入并提交 `/voice on`；再点一下 = `/voice off`。
- 按钮状态是本地乐观状态，暂时不带实时 Speaking/Listening 指示（等 v0.3 完整版接通道）。
- 客户端 bundle 首次注册/更新后如果没有出现按钮：先刷新页面（Cmd+R）；仍没有则重启一次 DeepSeek Harness（客户端模块图在启动时组合最稳）。

## 客户端 UI（v0.5）

- **入口**：输入框工具栏里的声波小图标（无文字），点击打开语音练习
- **练习态**：居中沉浸面板 —— 呼吸感声波球、实时状态、双方字幕、计时；底部「停止朗读 / 结束对话」
- **场景选择**：同一面板内的场景列表（日常闲聊 / 英文面试 / 雅思 Part 2 / 职场英语）
- **跟读练习**：面板内切换，逐词高亮 + 分数
- 支持 Esc 关闭；「减少动态效果」下自动关闭动画

## 使用

1. 在本目录（`练习口语`）下新建一个会话（工作区就是本文件夹）。
2. 输入命令 `/voice on`。
3. 听到 "Voice mode is on. I'm listening." 后开口说英语。
   - 停顿约 0.6 秒自动断句；说完看到你的话出现在聊天里。
   - Harness 回复时会被朗读出来；朗读中开口即打断。
4. 结束：`/voice off`（会自动保存轻量记录）。查看状态：`/voice status`。
5. 开发调试用 `/voice-reload` 重新加载插件代码（改完 `src/` 也会自动重载）。

体验细节（v0.3）：

- **流式朗读**：教练回复第一句生成完就开始读，不再等整段。
- **中文系统提示**：麦克风断开、连续 3 次没听清、长时间静默时会用中文语音说明并给出下一步。
- **结束兜底**：`/voice off`、麦克风故障、静默超时自动关闭时，会自动写一份轻量复盘 `practice/*-auto.md`（若已说 "end session" 生成完整复盘则跳过；短于 60 秒的会话不写）。
- **静默提醒**：3 分钟没说话提醒一次；10 分钟无活动自动关闭并保存记录。

## 命令

| 命令 | 作用 |
|---|---|
| `/voice on [场景]` | 开启语音模式（麦克风常开）；可带场景 id 或唯一前缀，如 `interview` |
| `/voice scenarios` | 列出可用场景 |
| `/voice off` | 关闭语音模式，释放麦克风和播放进程 |
| `/voice status` | 显示当前状态 |
| `/voice shadow [句数]` | 开始跟读练习（默认 5 句） |
| `/voice-reload` | 重新加载插件实现（开发用） |

## 教练模式（v0.2）

`/voice on` 时插件会把以下内容组合成一段**只对当前会话生效**的系统提示词（agent 作用域）：

1. `content/coach.md` —— 教练协议（英文、1–3 句、温和 recast、每轮一个追问）
2. `profile.md` —— 你的水平/目标/偏好
3. `content/scenarios/<id>.json` —— 场景卡（角色、目标、开场、推进节点、可用句型、成功标准）
4. `content/recap-template.md` —— 复盘模板
5. 今天的日期（用于复盘文件名）

场景：

| id | 场景 | 级别 |
|---|---|---|
| `daily-chat` | 日常闲聊（默认） | B1 |
| `job-interview` | 英文面试（自我介绍/经历/挑战/动机/反问） | B1–B2 |
| `ielts-part2` | 雅思口语 Part 2（题卡 1 分钟准备 + 2 分钟陈述 + 追问） | B1–B2 |
| `workplace` | 职场英语（standup / 邮件口述 / 会议表达 / action items） | B1–B2 |

练习结束时对麦克风说 **"end session"**（或 "finish / stop practice"）。教练会做口头收尾，并按模板把复盘写到 `practice/YYYY-MM-DD-HHmm-<场景>.md`。`practice/` 目录默认不进 Git（学习记录留在本地）。

## 复盘文件

| 类型 | 触发 | 内容 |
|---|---|---|
| 完整复盘 | 说 "end session"（模型用 write 工具写） | 逐句纠错、地道表达、生词、流利度、下次目标 |
| 轻量记录 | `/voice off` / 静默超时 / 麦克风故障 | 会话事实、发言摘录、填充词统计、确定性建议 |

两类文件都在 `practice/`（默认不进 Git）。轻量记录文件名带 `-auto.md` 后缀。

## 素材库

| 路径 | 内容 |
|---|---|
| `content/coach.md` | 教练协议（核心） |
| `content/scenarios/*.json` | 场景卡 |
| `content/topics.json` | 20 个话题 + 追问 |
| `content/corrections/common-errors.md` | 20 条中文母语者高频错误 |
| `content/pronunciation/drills.json` | 10 组最小对立体 + 30 句跟读 |
| `content/recap-template.md` | 复盘模板 |
| `profile.md` | 学习者画像（可直接改） |

素材都是纯文本，可自行修改；改完下次 `/voice on` 生效（素材在开启时读取）。新增场景：在 `content/scenarios/` 加一个 JSON（格式见 `docs/coach-content-spec.md`）。

## 配置

在 profile patch 的 `insert[].config` 里覆盖（安装脚本默认只写 `practiceRoot`）：

| 字段 | 默认 | 说明 |
|---|---|---|
| `practiceRoot` | 本目录 | 只对该工作区下的会话生效 |
| `englishVoice` | `Samantha` | 英文音色（也可用 Daniel 英音） |
| `chineseVoice` | `Tingting` | 中文音色（本机没有则跳过中文朗读） |
| `rate` | `175` | 朗读语速（词/分钟） |
| `language` | `auto` | 识别语言提示（en/auto/zh…） |
| `silenceMs` | `600` | 说完判定（毫秒） |
| `bargeIn` | `true` | 朗读中是否允许开口打断 |
| `selfTest` | `false` | 加载后自动做一次硬件/识别自检（结果写日志，用后关掉） |

## 自检

`/voice selftest` 会立即跑一次集成自检：检查服务（subprocess / speechToText / commands / agents / createUserMessage）、列出识别器与音色、录 1.5 秒麦克风、用 `say` 合成一句话→转成 WAV→调用本地 SenseVoice 识别并回读文本，最后用 Samantha 播报一句。结果写到日志的 `SELFTEST` 行。

本机实测结果：

```
SELFTEST PASS | subprocess=ok | speechToText=ok | commands=ok | agents=ok |
createUserMessage=ok | providers=sensevoice-local | voices=174 | mic=ok |
stt-transcribe=ok text="Hello, this is a speech recognition self test." | say=ok
```

## 已知限制 / 注意

- **建议戴耳机**。外放时 TTS 声音会被麦克风拾取，可能误触发录音或打断。
- 本机只装了 compact 级系统音色（Samantha 等），听感偏机械。想要更自然：系统设置 → 辅助功能 → 朗读内容 → 系统声音 → 管理声音，下载 Premium/Enhanced 音色，无需改代码。
- 首次识别会懒启动 SenseVoice worker，可能有 1–3 秒延迟；`/voice on` 时已做预热。
- 保存的语音不进入模型请求之外的内容：转写后的文字就是一条普通用户消息；录音只存在于内存/临时文件。
- 只对 `practiceRoot` 下的会话生效；其它工作区不受影响。

## 日志与排障

运行日志：`logs/voice-practice.log`；装载/热重载日志：`logs/voice-loader.log`。

常见问题：
- 没有听到 "Voice mode is on"：看日志里 mic 是否启动；检查系统设置 → 隐私与安全性 → 麦克风 → DeepSeek Harness 是否允许。
- 说了没反应：看日志里的 VAD 阈值与转写结果；环境嘈杂时调大 `silenceMs`，或把系统输入换成外接麦克风。
- 第一次转写超时：看日志是否在准备模型（`~/.dsh/speech-to-text` 已缓存 230MB 模型）。

## 架构（v0.1）

```
plugin.js（稳定 dev shell，被 profile patch 以绝对路径加载）
  ├─ 动态 import ./src/index.js  (Cordis 插件，ctx.plugin 挂载)
  ├─ /voice-reload 命令 + 监视 src/ 自动重载
  └─ logs/voice-loader.log

src/index.js（Cordis 插件）
  ├─ Config（schemastery）
  ├─ /voice on|off|status 命令
  ├─ session/event 监听（assistant/message + turn/end → 朗读）
  └─ VoiceLoop
       ├─ src/mic.js   ffmpeg 常驻 PCM 采集
       ├─ src/core/vad.js  能量 VAD（pre-roll/断句）
       ├─ ctx.speechToText  本地 SenseVoice 转写
       ├─ ctx.agents.get(id).agent.followup()  提交用户消息
       └─ src/tts.js   say 分段朗读 / 打断
```

下一阶段：会话内麦克风按钮 + 实时字幕 + Listening/Thinking/Speaking 状态浮层（客户端插件），以及英语教练人设 / 场景课程 / 会话复盘。

## 开发

```bash
node --test          # 纯逻辑单测（VAD / WAV / 文本 / 状态机）
```

改 `src/` 后无需重启：dev shell 会监视文件并自动重载，或手动 `/voice-reload`。
