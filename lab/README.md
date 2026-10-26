# lab/ — macOS 音频链路实验脚本

配套报告：[docs/audio-feasibility.md](../docs/audio-feasibility.md)

| 文件 | 说明 |
|---|---|
| `record.py` | 16k 单声道录音。`--duration` 固定时长；`--vad --engine energy\|silencedetect` 自动断句；`--in file.wav` 离线自测；`--trim` 去首尾静音；`--json` 输出摘要 |
| `vad_energy.py` | 纯标准库能量 VAD/断句器（流式事件 API + CLI），无需大模型 |
| `tts_say.py` | `voices` 列音色质量档 / `bench` 延迟基准 / `samples` 生成对话样例 |
| `bench_latency.py` | `vad` 复现 silencedetect 检出延迟；`play` 复现 afplay 启动与打断延迟 |
| `inspect_asar.mjs` | 只读解析 app.asar：读 package.json、Electron/Chromium 版本、sherpa 模块 |
| `samples/` | 5 句 Samantha 对话 + Daniel 英式对比 + vad 演示素材 + 测试音/空样本（无私人录音） |

常用：
```bash
python3 lab/record.py --out lab/.work/mic.wav --duration 2
python3 lab/record.py --out lab/.work/utt.wav --vad --engine energy --max-duration 20
python3 lab/record.py --in lab/samples/vad_demo.wav --out lab/.work/st.wav --vad --engine energy
python3 lab/vad_energy.py lab/samples/vad_demo.wav
python3 lab/tts_say.py voices && python3 lab/tts_say.py bench
python3 lab/bench_latency.py vad
/opt/homebrew/opt/node@24/bin/node lab/inspect_asar.mjs
```

依赖：`ffmpeg`/`ffprobe`（默认 /opt/homebrew/bin）、`say`/`afplay`、python3 标准库；Node 仅 `inspect_asar.mjs` 需要。
