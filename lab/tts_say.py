#!/usr/bin/env python3
"""tts_say.py — macOS 'say' TTS 的音色清单 / 延迟基准 / 对话样例合成。

用法:
  python3 lab/tts_say.py voices            # 列出已安装英文音色及质量档
  python3 lab/tts_say.py bench             # 首音/合成/播放/打断延迟
  python3 lab/tts_say.py samples           # 生成 lab/samples/ 对话样例
  python3 lab/tts_say.py say "text"        # 直接朗读（默认 Samantha）
"""
from __future__ import annotations

import json
import os
import re
import statistics
import subprocess
import sys

FF = os.environ.get("FFMPEG", "/opt/homebrew/bin/ffmpeg")
FFPROBE = os.environ.get("FFPROBE", "/opt/homebrew/bin/ffprobe")
SAMPLES = os.path.join(os.path.dirname(os.path.abspath(__file__)), "samples")

DIALOGUE = [
    ("dialogue_01_greeting", "Hey! How's your day going?"),
    ("dialogue_02_answer", "Pretty good, thanks. I just finished a big project at work."),
    ("dialogue_03_question", "That's great. What are you working on next?"),
    ("dialogue_04_advice", "I'm thinking about learning Spanish. Any advice?"),
    ("dialogue_05_reply", "Start with ten minutes a day. Consistency matters more than intensity."),
]


def say_bin() -> str:
    return "/usr/bin/say"


def audio_duration(path: str) -> float:
    p = subprocess.run([FFPROBE, "-v", "error", "-show_entries", "format=duration",
                        "-of", "csv=p=0", path], capture_output=True, text=True)
    try:
        return round(float(p.stdout.strip()), 3)
    except ValueError:
        return float("nan")


def voices() -> int:
    out = subprocess.run([say_bin(), "-v", "?"], capture_output=True, text=True).stdout
    rows = []
    for line in out.splitlines():
        m = re.match(r"^(.+?)\s{2,}(en_[A-Z]{2})\s+#", line)
        if m:
            rows.append((m.group(1).strip(), m.group(2)))
    # 质量档：用 NSSpeechSynthesizer 的 voice identifier（compact / enhanced / premium）
    quality = {}
    try:
        js = ('ObjC.import("AppKit");var v=$.NSSpeechSynthesizer.availableVoices;'
              'var o=[];for(var i=0;i<v.count;i++)o.push(ObjC.unwrap(v.objectAtIndex(i)));o.join("\\n")')
        ids = subprocess.run(["osascript", "-l", "JavaScript", "-e", js],
                             capture_output=True, text=True).stdout
        for v in ids.splitlines():
            m = re.search(r"com\.apple\.voice\.(compact|enhanced|premium)\.(en-[A-Z]{2})\.(.+)$", v.strip())
            if m:
                quality[m.group(3)] = (m.group(1), m.group(2).replace("-", "_"))
    except Exception:
        pass
    print(f"{'音色':<22}{'语种':<8}{'质量档':<10}")
    for name, lang in rows:
        q = quality.get(name, ("(eloquence/玩梗)", lang))[0]
        print(f"{name:<22}{lang:<8}{q:<10}")
    print(f"\n共 {len(rows)} 个 en_* 条目；quality 来自 "
          "com.apple.voice.{compact|enhanced|premium}.* （未列出=eloquence 玩梗音色）")
    return 0


def bench() -> int:
    texts = {"short": "Hi.",
             "medium": "How's it going? I'm doing pretty well, thanks for asking.",
             "long": "Could you tell me about a time when you had to solve a difficult "
                     "problem at work? I'd love to hear the details."}
    rows = []
    for voice in ("Samantha", "Daniel"):
        for name, text in texts.items():
            path = f"/tmp/dsh_ttsbench_{voice}_{name}.aiff"
            walls = []
            for _ in range(3):
                s = statistics.time if False else __import__("time").perf_counter()
                subprocess.run([say_bin(), "-v", voice, text, "-o", path], check=False)
                walls.append(__import__("time").perf_counter() - s)
            d = audio_duration(path)
            pw = []
            for _ in range(2):
                s0 = __import__("time").perf_counter()
                subprocess.run([say_bin(), "-v", voice, text], check=False)
                pw.append(__import__("time").perf_counter() - s0)
            rows.append({"voice": voice, "text": name, "audio_dur_s": d,
                         "synth_median_s": round(statistics.median(walls), 3),
                         "play_overhead_s": round(statistics.median(pw) - d, 3),
                         "rtf": round(statistics.median(walls) / d, 3)})
            os.path.exists(path) and os.remove(path)
    print(json.dumps(rows, ensure_ascii=False, indent=1))

    # 打断延迟
    path = "/tmp/dsh_ttsbench_kill.aiff"
    subprocess.run([say_bin(), "-v", "Samantha", texts["long"], "-o", path], check=False)
    kills = []
    for delay in (0.2, 0.5):
        import time as _t
        p = subprocess.Popen(["afplay", path])
        _t.sleep(delay)
        tk = _t.perf_counter()
        p.send_signal(15)
        p.wait()
        kills.append(round(_t.perf_counter() - tk, 3))
    os.remove(path)
    print("afplay SIGTERM exit_after_kill_s:", kills)
    return 0


def make_samples() -> int:
    os.makedirs(SAMPLES, exist_ok=True)
    meta = []
    for name, text in DIALOGUE:
        out = os.path.join(SAMPLES, name + ".aiff")
        subprocess.run([say_bin(), "-v", "Samantha", text, "-o", out], check=False)
        meta.append({"file": os.path.basename(out), "voice": "Samantha (en_US compact)",
                     "dur_s": audio_duration(out), "text": text})
    # 英式对比
    out = os.path.join(SAMPLES, "voice_daniel_enGB.aiff")
    subprocess.run([say_bin(), "-v", "Daniel", DIALOGUE[1][1], "-o", out], check=False)
    meta.append({"file": "voice_daniel_enGB.aiff", "voice": "Daniel (en_GB compact)",
                 "dur_s": audio_duration(out), "text": DIALOGUE[1][1]})
    print(json.dumps(meta, ensure_ascii=False, indent=1))
    return 0


def main(argv=None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    if not argv:
        argv = ["voices"]
    cmd, rest = argv[0], argv[1:]
    if cmd == "voices":
        return voices()
    if cmd == "bench":
        return bench()
    if cmd == "samples":
        return make_samples()
    if cmd == "say":
        voice = os.environ.get("VOICE", "Samantha")
        subprocess.run([say_bin(), "-v", voice, " ".join(rest)], check=False)
        return 0
    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main())
