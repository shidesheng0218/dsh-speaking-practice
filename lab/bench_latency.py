#!/usr/bin/env python3
"""bench_latency.py — 复现断句延迟与播放打断测量。

用法:
  python3 lab/bench_latency.py vad     # 实时喂流，测 silencedetect "说完"检出延迟
  python3 lab/bench_latency.py play    # 测 afplay 固定启动开销与 SIGTERM 打断延迟
"""
from __future__ import annotations

import json
import os
import re
import statistics
import subprocess
import sys
import threading
import time
import wave

FF = os.environ.get("FFMPEG", "/opt/homebrew/bin/ffmpeg")
HERE = os.path.dirname(os.path.abspath(__file__))


def _build_demo(path: str) -> None:
    """用 say 合成一段语音 + 3s 尾静音（确定性素材，不含私人录音）。"""
    if os.path.exists(path):
        return
    tmp = path + ".speech.aiff"
    subprocess.run(["/usr/bin/say", "-v", "Samantha",
                    "How's it going? I'm doing pretty well, thanks for asking.",
                    "-o", tmp], check=False)
    subprocess.run([FF, "-hide_banner", "-loglevel", "error", "-y", "-i", tmp,
                    "-af", "adelay=500,apad=pad_dur=3", "-ar", "16000", "-ac", "1",
                    "-c:a", "pcm_s16le", path], check=False)
    if os.path.exists(tmp):
        os.remove(tmp)


def vad() -> int:
    work = os.path.join(HERE, ".work")
    os.makedirs(work, exist_ok=True)
    wav = os.path.join(work, "bench_vad.wav")
    _build_demo(wav)
    w = wave.open(wav, "rb")
    sr = w.getframerate()
    pcm = w.readframes(w.getnframes())
    chunk = int(0.02 * sr) * 2

    def run(noise: str, d: float):
        p = subprocess.Popen([FF, "-hide_banner", "-nostats", "-f", "s16le",
                              "-ar", str(sr), "-ac", "1", "-i", "pipe:0",
                              "-af", f"silencedetect=noise={noise}:d={d}",
                              "-f", "null", "-"],
                             stdin=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=0)
        t0 = time.perf_counter()
        events = []

        def reader():
            for raw in p.stderr:
                m = re.search(rb"silence_(start|end): ([\d.]+)", raw)
                if m:
                    events.append((m.group(1).decode(), float(m.group(2)),
                                   time.perf_counter() - t0))
        th = threading.Thread(target=reader, daemon=True)
        th.start()
        for i in range(0, len(pcm), chunk):
            target = i / 2 / sr
            now = time.perf_counter() - t0
            if target > now:
                time.sleep(target - now)
            try:
                p.stdin.write(pcm[i:i + chunk])
                p.stdin.flush()
            except (BrokenPipeError, OSError):
                break
        try:
            p.stdin.close()
        except Exception:
            pass
        p.wait()
        th.join(timeout=1)
        # 取"语音结束"后的第一个 silence_start（跳过开头的静音段）
        cand = [e for e in events if e[0] == "start" and e[1] > 1.0]
        if not cand:
            return None
        _, pos, wall = cand[0]
        return round(wall - pos, 3)

    rows = []
    for noise, d in (("-30dB", 0.3), ("-30dB", 0.6), ("-30dB", 1.0), ("-40dB", 0.5)):
        lat = run(noise, d)
        rows.append({"noise": noise, "d_s": d, "detect_delay_s": lat,
                     "delay_minus_d_s": None if lat is None else round(lat - d, 3)})
    print(json.dumps(rows, indent=1))
    return 0


def play() -> int:
    work = os.path.join(HERE, ".work")
    os.makedirs(work, exist_ok=True)
    files = []
    for name, text in (("short", "Hi."),
                       ("medium", "How's it going? I'm doing pretty well, thanks for asking.")):
        p = os.path.join(work, f"bench_{name}.aiff")
        subprocess.run(["/usr/bin/say", "-v", "Samantha", text, "-o", p], check=False)
        files.append(p)
    rows = []
    for p in files:
        dur = float(subprocess.run([os.environ.get("FFPROBE", "/opt/homebrew/bin/ffprobe"),
                                    "-v", "error", "-show_entries", "format=duration",
                                    "-of", "csv=p=0", p], capture_output=True,
                                   text=True).stdout.strip())
        walls = []
        for _ in range(2):
            s = time.perf_counter()
            subprocess.run(["afplay", p], check=False)
            walls.append(time.perf_counter() - s)
        rows.append({"file": os.path.basename(p), "audio_dur_s": round(dur, 3),
                     "afplay_wall_s": [round(x, 3) for x in walls],
                     "startup_overhead_s": round(statistics.median(walls) - dur, 3)})
    # 打断延迟
    long_p = files[-1]
    kills = []
    for delay in (0.2, 0.6):
        pr = subprocess.Popen(["afplay", long_p])
        time.sleep(delay)
        tk = time.perf_counter()
        pr.send_signal(15)
        pr.wait()
        kills.append(round(time.perf_counter() - tk, 3))
    print(json.dumps({"playback": rows, "sigterm_exit_s": kills}, indent=1))
    return 0


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "vad"
    sys.exit(vad() if cmd == "vad" else play() if cmd == "play" else 2)
