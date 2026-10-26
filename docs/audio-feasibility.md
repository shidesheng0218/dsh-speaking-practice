# macOS 音频链路可行性实验报告（DSH 英语口语语音对话插件）

> 实验环境：macOS 26.6.2 / Apple Silicon MacBook Pro / ffmpeg 9.0.1（/opt/homebrew/bin/ffmpeg）
> 宿主：DeepSeek Harness.app 0.2.1-rc.3（Electron 44.7.0 / Chromium 152.0.7977.130）
> 结论口径：全部数字为本机实测；未测项明确标注「未验证」。

## 0. 结论速览（TL;DR）

| 环节 | 结论 | 关键数字 |
|---|---|---|
| 麦克风子进程采集 | ✅ TCC 放行，ffmpeg avfoundation 可直接录 16k 单声道 | 1.0s 录音墙钟 1.34–1.51s（开销 0.35–0.51s） |
| say TTS | ✅ 可用，但只有 compact 音色；无 Premium/Enhanced | 单句固定开销 ≈0.77s，≥1s 音频 RTF 0.11–0.21 |
| 播放/打断 | ✅ afplay 可播、可 1–6ms 内杀掉；但 afplay 固定启动 ≈1.0s | afplay 固定开销 0.97–1.06s |
| 断句 (VAD) | ✅ silencedetect 延迟≈d+0.03s；更推荐能量 VAD | d=0.6 → 检出延迟 0.603s |
| 本地 TTS 备选 | ✅ sherpa-onnx-node 1.13.8 已随 App 打包，支持非流式 TTS | 需另下 60–310MB 模型 |
| Web Speech API | ⚠️ macOS 上 Chromium 用系统 TTS，很可能可用；未实测 GUI | 需 5 分钟运行时探针 |

**核心建议**：采集用「常驻 ffmpeg 进程 + 能量 VAD」或渲染进程 getUserMedia；合成用 `say -v Samantha` 直接播放（0.85s 首音），或 `say -o` + 渲染进程 Web Audio 播放；断句参数 `rel=+12dB / abs=-45dBFS / hangover=600ms`。

---

## 1. 麦克风采集可行性（TCC）

### 1.1 结论
- 子进程（ffmpeg）**可以**直接采集内置麦克风，**没有弹窗、没有被拒**：说明 TCC 以「负责进程」为准，
  ffmpeg 作为 DeepSeek Harness.app 的子进程继承了该 App 的麦克风授权。
- 证据：App Info.plist 有 `NSMicrophoneUsageDescription`（"…uses your microphone to transcribe speech…"），
  且签名 entitlements 含 `com.apple.security.device.audio-input`；见 §5。
- 风险：授权绑定 App 身份（bundle id `com.deepseek.dsh`）。若插件让 ffmpeg 从**别的宿主**（Terminal、
  独立守护进程、launchd）启动，会变成另一个 TCC 主体 → 可能弹窗或被拒。

### 1.2 实测命令（可直接复用）
```bash
FF=/opt/homebrew/bin/ffmpeg

# 设备枚举（音频设备 0 = MacBook Pro麦克风）
$FF -hide_banner -f avfoundation -list_devices true -i "" 2>&1 | sed -n '/audio devices/,$p'

# 录 1.5 秒 16k 单声道 WAV
$FF -hide_banner -loglevel error -y -f avfoundation -i ":0" \
    -t 1.5 -ar 16000 -ac 1 -c:a pcm_s16le mic.wav

# 电平校验（确认不是纯静音）
$FF -hide_banner -i mic.wav -af volumedetect -f null - 2>&1 | grep -E 'mean_volume|max_volume'
```

实测输出：`mean_volume: -34.7 dB / max_volume: -14.5 dB`，exit 0 → 采到真实环境声。

### 1.3 实测数据
| 项 | 数值 | 说明 |
|---|---|---|
| 首次调用墙钟 | 14.3s（含一次冷启动/TCC 首次查询） | 只在进程首次调用出现，后续稳定 |
| 热态 1.0s 录音墙钟 | 1.34 / 1.46 / 1.51s | 固定开销约 0.35–0.51s（设备打开+重采样） |
| 实际写入时长 | 请求 1.0s → 文件 0.896–1.0s | avfoundation 首帧有时间戳偏移，开头可能丢 ≤0.1s |
| 设备原生格式 | 48kHz mono → 由 ffmpeg 重采样到 16k | 目标 16k 单声道可直接用 |

> 采集启动有 0.35–0.51s 固定延迟。**逐句 spawn ffmpeg 会切掉句首**，生产实现应
> （a）常驻一个 ffmpeg 进程持续出 PCM，或（b）用渲染进程 `getUserMedia`。

### 1.4 封装脚本：`lab/record.py`
```bash
# 固定时长
python3 lab/record.py --out lab/.work/mic.wav --duration 2
# 自动断句（推荐能量引擎，自适应本底噪声）
python3 lab/record.py --out lab/.work/utt.wav --vad --engine energy --max-duration 20
# 自动断句（ffmpeg silencedetect，阈值自动标定） + 去首尾静音
python3 lab/record.py --out lab/.work/utt.wav --vad --trim
# 离线自测（不需要说话，用 WAV 实时喂入验证断句逻辑）
python3 lab/record.py --in lab/samples/vad_demo.wav --out lab/.work/st.wav --vad --engine energy
```
输出 JSON 摘要：`duration_s / mean_volume_dB / speech_detected / speech_start_s / speech_end_s / stop_reason`。

自测结果（`--in` 回放 `lab/samples/vad_demo.wav`，7.31s 素材）：
`speech_start_s: 0.52, speech_end_s: 4.02, speech_span_s: 3.5, stop_reason: vad_endpoint, wall_s: 4.18`
→ 断句链路（检测→停录→写 WAV）实测可用，**检测后 5ms 内完成停录**；能量 VAD 直接读该文件同样得到
`0.50s → 4.20s (3.70s)` 的单句分段。

### 1.5 环境本底噪声（决定阈值）
| 统计量 | 数值（20ms 帧 RMS，1.77s 静室） |
|---|---|
| p10 | −46.2 dBFS |
| 中位数 | −43.0 dBFS |
| p90 | −37.6 dBFS |
| 峰值（样本级） | −28.3 dBFS |

---

## 2. say TTS：音色、延迟、样本、打断

### 2.1 可用英文音色（本机实测）
`say -v '?'` 共列出 **43 个 en_* 条目**；其中真正可用的系统音色（NSSpeechSynthesizer 报告、
非 eloquence 玩梗音色）只有 **6 个 compact**：

| 音色 | 语种 | 质量档 | 采样率 | 备注 |
|---|---|---|---|---|
| **Samantha** | en_US | compact | 22050 Hz | **推荐默认**，口音自然度在本机最好 |
| **Daniel** | en_GB | compact | 22050 Hz | 英式，语速略慢（同句 +0.35s） |
| Karen | en_AU | compact | 22050 Hz | 澳音 |
| Moira | en_IE | compact | 22050 Hz | 爱尔兰 |
| Rishi | en_IN | compact | 22050 Hz | 印度 |
| Tessa | en_ZA | compact | 22050 Hz | 南非 |

- **本机未安装任何 Premium / Enhanced 音色**（identifiers 全是 `com.apple.voice.compact.*`，
  生成音频一律 22050Hz/16bit mono；Premium 会输出 48kHz）。其余 30+ 个 en_US 条目是
  Albert/Bad News/Bells/Trinoids/Zarvox 等 eloquence 玩梗音色，**不适合教学场景**。
- 提升音质的最短路径：系统设置 → 辅助功能 → 朗读内容 → 系统声音 → 管理声音 →
  下载 「Samantha (Premium)」或「Daniel (Enhanced)」，`say` 命令与代码无需改动。
- 取音色质量档的办法（脚本化，不依赖列表文本）：
  ```bash
  osascript -l JavaScript -e 'ObjC.import("AppKit");var v=$.NSSpeechSynthesizer.availableVoices;for(var i=0;i<v.count;i++)console.log(ObjC.unwrap(v.objectAtIndex(i)))' | grep en-
  ```

### 2.2 延迟实测（`say -v <voice> <text> -o out.aiff`，3 次取中位）
| 音色 | 文本 | 音频时长 | 合成墙钟 | 固定开销 | RTF |
|---|---|---|---|---|---|
| Samantha | "Hi."（3 字符） | 0.42s | 0.80–0.84s | **≈0.77s** | 1.93 |
| Samantha | 中句（57 字符） | 3.55s | 0.755–0.781s | ≈0.77s | 0.21 |
| Samantha | 长句（111 字符） | 5.73s | 0.770–0.805s | ≈0.77s | **0.14** |
| Daniel | 中句 | 3.78s | 0.597–0.609s | ≈0.60s | 0.16 |
| Daniel | 长句 | 6.10s | 0.606–0.760s | ≈0.65s | 0.11 |

关键结论：**`say` 的合成耗时几乎与文本长度无关，主要是每进程固定开销**。
拆解：`say -v Samantha ""` 空文本进程启动 ≈0.39s；其余 ≈0.38s 为音色加载/合成。

### 2.3 首音延迟（text → 可听见）
| 播放路径 | 墙钟 − 音频时长 | 首音估计 | 说明 |
|---|---|---|---|
| `say -v Samantha "text"` 直接外放 | +0.84 ~ +0.87s | **≈0.7–0.85s** | 单进程，最低延迟 |
| `say -o` + `afplay` | 0.77 + 0.97 ≈ **1.8s** | ≈1.7–1.9s | afplay 固定启动太贵 |
| `say -o` + 渲染进程 Web Audio | 0.77 + ≈0.05–0.1 | ≈0.85–0.9s | 适合需要打断/耳返控制的实现 |
| `afplay` 单独播放任意长度文件 | +0.97 ~ +1.06s | ≈1.0s | 与文件长短无关；设备预热不改善；ffplay 热态降到 ≈0.29s |

> 结论：**最简单且最快的是直接 `say` 外放**；需要可控打断/预合成缓存时用 `say -o` + Web Audio，
> **不要**用 `say -o` + `afplay`（无谓多 1s）。

### 2.4 打断（barge-in）实测
| 命令 | 信号 | 杀进程后退出耗时 |
|---|---|---|
| `afplay file.aiff` | SIGTERM | **1–6 ms** |
| `say "text"` | SIGTERM | **1 ms** |

→ 打断本身不是瓶颈；真正要解决的是「停止播放后立刻开麦」与回声抑制（见风险 §6）。

### 2.5 英语对话样例（`lab/samples/`）
用 Samantha 合成 5 句练习对话（各 1–2 句，已 ffprobe 校验，可直接 `afplay` 试听）：

| 文件 | 音频时长 | 台词 |
|---|---|---|
| `dialogue_01_greeting.aiff` | 1.69s | "Hey! How's your day going?" |
| `dialogue_02_answer.aiff` | 3.81s | "Pretty good, thanks. I just finished a big project at work." |
| `dialogue_03_question.aiff` | 2.49s | "That's great. What are you working on next?" |
| `dialogue_04_advice.aiff` | 2.91s | "I'm thinking about learning Spanish. Any advice?" |
| `dialogue_05_reply.aiff` | 4.11s | "Start with ten minutes a day. Consistency matters more than intensity." |
| `voice_daniel_enGB.aiff` | 4.08s | 同一句用 Daniel（英式）对比 |
| `vad_demo.wav` | 7.31s | 断句演示素材：语音 0.5–4.2s + 3s 尾静音（16k mono） |
| `tone_440hz_1s.wav` / `silence_1s.wav` | 1.00s | 合成 440Hz 测试音 / 空样本（替代私人录音） |

> 听感说明：Samantha compact 是"清晰但偏机械、无情感起伏"的旧式 TTS，22.05kHz 带宽偏窄；
> Daniel 更沉稳、语速略慢。教学对话可用，但长期使用建议下载 Premium 音色（§2.1）。

---

## 3. 断句 / VAD

### 3.1 silencedetect 实时断句延迟（实测）
方法：把带真实停顿的 16k WAV 以 **20ms 块实时喂给** `ffmpeg -f s16le -i pipe:0 -af silencedetect`，
记录「真实语音结束位置」到「stderr 出现 silence_start」的墙钟差（3 组参数，可复现）。

| noise / d | 语音结束位置 | 检出时刻（墙钟） | 检出延迟 | 延迟 − d |
|---|---|---|---|---|
| −30dB / d=0.3 | 4.00s | 4.344s | 0.342s | +0.042s |
| −30dB / d=0.6 | 4.00s | 4.605s | **0.603s** | +0.003s |
| −30dB / d=1.0 | 4.00s | 5.042s | 1.040s | +0.040s |
| −40dB / d=0.5 | 4.01s | 4.542s | 0.528s | +0.028s |

**结论：silencedetect 的「说完」检出延迟 ≈ d + 20–40ms（帧量化）**；停录动作（关 stdin / SIGINT）
在 **5ms** 内完成（实测 `exit_after_close=0.005s`）。

⚠️ 重要坑：silencedetect 的 `noise` 阈值比较的是**每帧样本峰值**，不是 RMS。
本机静室峰值 −28 dBFS，因此 `noise=-35dB` 会把环境噪声判成"非静音"，**永远断不了句**。
必须用高于环境峰值的阈值：本机推荐 **`noise=-24 ~ -22dB`** 或使用 `record.py` 的自动标定
（先探 0.4s 环境峰值，阈值 = 峰值 + 8dB，夹在 [−50, −18] dB）。

### 3.2 推荐的断句参数（可直接落地）
| 参数 | 推荐值 | 依据 |
|---|---|---|
| 帧长 | 20ms | ffmpeg 默认帧 + 延迟与稳定性的平衡 |
| 相对门限 | 本底 +12dB（energy VAD） | 本机语音(≈−15dB) 与本底(≈−43dB) 差 28dB |
| 绝对门限 | −45 dBFS | 覆盖本机静室 p90 −37.6，防止误触发 |
| 说完判定（hangover） | **500–600ms** | d=0.6 时端到端只多 0.6s；低于 0.4s 会把句中停顿切断 |
| 起说判定 | 连续 3 帧（60ms）超门限 | 抑制鼠标/键盘单帧瞬态 |
| 最短语音 | 150ms | 过滤咳嗽/碰麦 |
| silencedetect 阈值 | −24 ~ −22dB（或自动标定） | 见 3.1 峰值语义坑 |

### 3.3 可复用实现：`lab/vad_energy.py`（纯标准库，无大模型）
- 20ms 帧 RMS；开场 400ms 中位数校准本底；**不对称跟踪**（安静帧快降、非语音帧极慢升），
  避免持续人声把本底抬高；双阈值 + 连续 N 帧起说 + hangover 断句；输出
  `speech_start / speech_end / utterance(t_start,t_end)` 事件。
- CLI 验证：
  ```bash
  python3 lab/vad_energy.py lab/samples/vad_demo.wav          # 打印分段
  python3 lab/vad_energy.py lab/samples/silence_1s.wav        # 静音：无 utterance
  ```
- 实测：`vad_demo.wav` → `0.50s → 4.20s (3.70s)`（含 0.5s 前导静音），与 silencedetect 结果一致；
  纯静音文件 → 0 个 utterance（无误触发）。
- 若噪声环境更复杂（键盘、空调、外放回声）：App 内已打包 `sherpa-onnx-node/vad.js`（Silero VAD），
  只需额外 ~2MB 的 `silero_vad.onnx`，鲁棒性明显优于能量法；接口同样支持流式。

---

## 4. 本地 TTS 备选：sherpa-onnx-node（已随 App 打包，零下载即可见）

### 4.1 事实核查（从 app.asar 解包确认）
- `/Applications/DeepSeek Harness.app/Contents/Resources/app.asar` 内 **已包含**：
  `dsh/node_modules/sherpa-onnx-node/`（v**1.13.8**）与 `sherpa-onnx-darwin-arm64/`
  （`libonnxruntime.dylib` 29.0MB、`libsherpa-onnx-c-api.dylib` 4.3MB、`sherpa-onnx.node` 659KB）。
- `non-streaming-tts.js`（3.2KB）导出 `OfflineTts`：
  - `new OfflineTts(cfg)` / `await OfflineTts.createAsync(cfg)`（非阻塞加载）
  - `tts.generate({text, sid, speed})` → `{samples: Float32Array, sampleRate}`
  - `tts.generateAsync({text, onProgress})` → 回调可拿流式 chunk（可边生成边播，降低首音延迟）
  - `tts.numSpeakers` / `tts.sampleRate`
- `types.js` 支持的模型族：**vits / matcha / kokoro / kitten / zipvoice / pocket**（config 见 §4.2），
  另有 `vad.js`、`resampler.js`、`punctuation.js`、`non-streaming-asr.js` 可一并复用。

### 4.2 接入成本
```js
const { OfflineTts } = require('sherpa-onnx-node');
const tts = new OfflineTts({ model: { vits: {
  model: '.../vits-piper-en_US-amy-low/en_US-amy-low.onnx',
  tokens: '.../tokens.txt', dataDir: '.../espeak-ng-data' } }, numThreads: 2 });
const audio = tts.generate({ text: 'Hello there.', sid: 0, speed: 1.0 }); // Float32Array
```
- 代码量：约 30–50 行（加载 + 合成 + Float32→WAV）；若直接复用 App 内的模块，**无新依赖、无网络**。
- 需要的模型体积（需自行下载，本机未下载，数值为社区模型常见量级，接入前需实测确认）：
  | 模型 | 音质 | 体积 | 备注 |
  |---|---|---|---|
  | vits-piper-en_US-amy-low | 一般（8-bit 级） | ≈**63MB** | 最快、CPU 实时，适合先跑通 |
  | vits-piper-en_US-amy-medium | 好 | ≈**79MB** | 推荐备选 |
  | vits-ljs / vits-piper 其他 en_US | 好 | 100–130MB | |
  | matcha-icefall-en_US-ljspeech | 较好 | ≈70MB + 声码器 1.4MB | 需两个文件 |
  | kokoro-en-v0_19 / kokoro-multi-lang | 很好 | **300MB+** | 体积/内存成本高 |
- 结论：**作为备用 TTS 的接入成本很低（模块已在 App 内），主要成本是下载 60–130MB 模型**；
  优势是完全离线、可商用许可（Apache-2.0）、可流式；劣势是音质不如 macOS Premium 音色，
  且要自己管模型分发。**首选仍是 `say`（零下载）**，sherpa 作为「用户不想下 Premium 音色 / 需要更强可控性」的 fallback。

---

## 5. Electron / Chromium 版本与 Web Speech API 判断

### 5.1 版本事实
| 项 | 值 | 来源 |
|---|---|---|
| App 版本 | 0.2.1-rc.3（`@deepseek-ai/dsh-desktop`） | app.asar 内 `package.json` |
| Electron | **44.7.0** | `Electron Framework` 二进制里的 `Electron/44.7.0` 字符串 |
| Chromium | **152.0.7977.130** | 同上，`Chrome/152.0.7977.130` |
| 麦克风用途声明 | `NSMicrophoneUsageDescription` 存在 | `Contents/Info.plist` |
| 语音识别用途声明 | `NSSpeechRecognitionUsageDescription` **缺失** | 同上 |
| entitlements | allow-jit / allow-unsigned-executable-memory / disable-library-validation / **audio-input** | `codesign -d --entitlements` |

> app.asar 是单文件而非目录：布局为 `[u32 4][u32 headerSize][u32 pickleSize][u32 jsonLen][JSON][数据]`，
> 数据基址 = 8 + headerSize（本机 4,748,708 → 4,748,716）。`lab/inspect_asar.mjs` 可直接读包内文件。

### 5.2 `speechSynthesis` 可用性判断（未实测 GUI，给出依据与不确定性）
**倾向可用（高概率）**，依据：
1. Chromium 在 macOS 上的 Web Speech TTS **后端就是系统原生 TTS**（`platform_speech_synthesizer_mac`，
   走 NSSpeechSynthesizer），不依赖网络、不需 Google API key，也不需要任何 TCC 权限
   （TTS 播放不需要「麦克风/语音识别」授权）。
2. Electron 44 的渲染进程保留 Web Speech API；`speechSynthesis` 属于 Chromium content 层，
   Electron 未默认关闭该能力（Electron 关闭的是 Google 语音识别所需的 API key）。
3. 本机系统层面已具备 6 个可用的 en_US/en_GB compact 音色（§2.1），原生后端有声音可用。

**不确定性（需 5 分钟 GUI 探针）**：
- 未验证 DSH 的页面 CSP / 打包配置是否禁用该 API；也未验证 Electron 构建是否带 `enable_tts` 相关开关。
- `speechSynthesis.getVoices()` 在 Chromium 中是**异步填充**的，首帧调用可能返回空数组，需监听
  `voiceschanged`（常见坑，不代表不可用）。
- 建议探针：在 App 内 DevTools Console 跑
  `speechSynthesis.getVoices().filter(v=>v.lang.startsWith('en'))` 与 `new SpeechSynthesisUtterance('hi')` 播放。

**另一个必须注意的点**：`webkitSpeechRecognition`（浏览器语音识别）在本机**不可用**——Chromium 的
SpeechRecognition 需要 Google 语音服务的 API key，且 App Info.plist 缺 `NSSpeechRecognitionUsageDescription`。
识别请继续用已就位的 SenseVoice（`~/.dsh/speech-to-text/sensevoice`，230MB）。

### 5.3 如果 speechSynthesis 可用，能省掉什么
- 省掉每次 `say` 的 0.39s 进程启动 + 0.38s 音色加载（合计 ≈0.77s 固定开销）；
- 自带 `onboundary` 词边界事件（可做逐词高亮/跟读打分）、`pause()/resume()`、`cancel()` 即时打断；
- 但音色集合与系统一致（仍是 compact），且无法离线打包指定音色。

---

## 6. 风险清单与建议

| # | 风险 | 影响 | 建议 |
|---|---|---|---|
| 1 | TCC 绑定宿主 App | 若从非 App 进程 spawn ffmpeg 会重新弹窗/被拒 | 所有音频采集都在 DeepSeek Harness.app 进程树内（main 或 renderer） |
| 2 | ffmpeg 采集启动 0.35–0.51s | 逐句 spawn 会吞掉句首音节 | 常驻采集进程 + 环形缓冲，或渲染进程 getUserMedia |
| 3 | 扬声器外放被麦克风回采（回声） | 半双工/Barge-in 误触发 | 实测回采很弱（播放中麦克风峰值仅 −22 dBFS，比本底高约 6dB，疑似系统级回声抑制）；**仍需在真实音量下复测**；保守做法：TTS 播放期间暂停 VAD，或给 AudioContext 加 AEC |
| 4 | 无 Premium/Enhanced 音色 | 机器人味重、22.05kHz，练习体验差 | 引导用户下载 Samantha (Premium)；或引入 sherpa 本地神经 TTS |
| 5 | 每句 TTS 固定 0.77s | 对话节奏偏慢 | 优先 `speechSynthesis`；其次 `say` 预合成缓存常见句 |
| 6 | `say -o` + afplay 多 1s | 首音 1.9s，体验明显差 | 不要用这条路径 |
| 7 | silencedetect 阈值是峰值语义 | 阈值用错 → 永远不断句 | 用自动标定或用能量 VAD/silero |
| 8 | Web Speech TTS 未实机验证 | 依赖它做首选方案有返工风险 | 先做 5 分钟 GUI 探针再定架构；`say` 作为确定可用的兜底 |
| 9 | 版本漂移 | Electron/Chromium 升级会改变 API 行为 | 记录基线（Electron 44.7.0 / Chromium 152），升级后重跑探针 |
| 10 | 隐私 | 录音可能含用户语音 | 采集仅落临时目录、STT 后立即删除；本报告已删除全部私人录音，仅保留合成样本 |

---

## 7. 复现命令与文件清单

```bash
cd "/Users/eastbuy/Documents/梦想草稿/练习口语"

# 录音（固定 / 自动断句 / 离线自测）
python3 lab/record.py --out lab/.work/mic.wav --duration 2
python3 lab/record.py --out lab/.work/utt.wav --vad --engine energy --max-duration 20
python3 lab/record.py --in lab/samples/vad_demo.wav --out lab/.work/st.wav --vad --engine energy

# 能量 VAD
python3 lab/vad_energy.py lab/samples/vad_demo.wav

# say 音色/延迟/样例
python3 lab/tts_say.py voices
python3 lab/tts_say.py bench
python3 lab/tts_say.py samples

# 查看 Electron/Chromium 版本与 sherpa 打包情况
/opt/homebrew/opt/node@24/bin/node lab/inspect_asar.mjs

# 复现断句延迟测量
python3 lab/bench_latency.py vad
```

| 文件 | 用途 |
|---|---|
| `lab/record.py` | 16k 单声道录音；固定时长 / silencedetect / 能量 VAD 三种模式；`--in` 离线自测 |
| `lab/vad_energy.py` | 纯标准库能量 VAD/断句器（流式事件 API + CLI） |
| `lab/tts_say.py` | 音色清单 / 延迟基准 / 对话样例合成 |
| `lab/bench_latency.py` | 复现 silencedetect 检出延迟与播放中断测量 |
| `lab/inspect_asar.mjs` | 解析 app.asar，读 package.json / 查 Electron 版本与 sherpa 模块 |
| `lab/samples/` | 5 句英语对话样例 + Daniel 对比 + 测试音/空样本（无私人录音） |
| `docs/audio-feasibility.md` | 本报告 |

---
*实验日期：2026-10-26。所有数字来自本机实测；未验证项已明确标注。*
