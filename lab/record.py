#!/usr/bin/env python3
"""record.py — macOS 麦克风录音（16k 单声道 WAV），可选自动断句。

两种录制模式
  --duration N      固定录 N 秒（最稳，插件里可先缓冲再裁剪）
  --vad             自动断句：检测到"说完"就停
      --engine silencedetect  （默认）ffmpeg 内建 silencedetect 看 stderr 事件
      --engine energy         python 能量 VAD（自适应本底噪声，推荐）

依赖：ffmpeg / ffprobe（默认 /opt/homebrew/bin）；--engine energy 额外用到同目录下
      vad_energy.py 的 Endpointer（纯标准库）。
权限：麦克风 TCC 属于宿主 App（DeepSeek Harness.app）。从已授权 App 派生的子进程
      可继承授权；若报 "Input/output error" 或被拒，去
      系统设置 → 隐私与安全性 → 麦克风 给 DeepSeek Harness.app 勾选。

用法：
  python3 lab/record.py --out lab/.work/mic.wav --duration 2
  python3 lab/record.py --out lab/.work/utt.wav --vad --engine energy --max-duration 20
  python3 lab/record.py --out lab/.work/utt.wav --vad --noise -22dB --trim
  python3 lab/record.py --list-devices

实测参数（详见 docs/audio-feasibility.md）：
  本机安静室内麦克风：本底 RMS≈-43 dBFS、峰值≈-28 dBFS
  silencedetect 比较的是"样本峰值"，因此 noise 阈值必须高于环境峰值：
  --noise auto（默认）会先做 0.4s 探针，自动取 峰值+8dB（上限 -18dB）。
"""
from __future__ import annotations

import argparse
import array
import json
import math
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
import wave


def _find(binary: str, fallback: str) -> str:
    p = os.environ.get(binary.upper())
    if p and os.path.exists(p):
        return p
    if os.path.exists(fallback):
        return fallback
    w = shutil.which(binary)
    if w:
        return w
    raise SystemExit(f"找不到 {binary}，请安装或用环境变量 {binary.upper()} 指定")


FFMPEG = _find("ffmpeg", "/opt/homebrew/bin/ffmpeg")
FFPROBE = _find("ffprobe", "/opt/homebrew/bin/ffprobe")


# ---------------------------------------------------------------- 工具
def list_devices() -> int:
    p = subprocess.run([FFMPEG, "-hide_banner", "-f", "avfoundation",
                        "-list_devices", "true", "-i", ""],
                       capture_output=True, text=True)
    print(p.stderr)
    return 0


def probe(path: str) -> dict:
    info: dict = {"path": path}
    if not os.path.exists(path):
        return info
    info["bytes"] = os.path.getsize(path)
    p = subprocess.run([FFPROBE, "-v", "error", "-show_entries",
                        "format=duration:stream=sample_rate,channels,codec_name",
                        "-of", "json", path], capture_output=True, text=True)
    try:
        j = json.loads(p.stdout or "{}")
        st = (j.get("streams") or [{}])[0]
        info["duration_s"] = round(float(j["format"]["duration"]), 3)
        info["sample_rate"] = st.get("sample_rate")
        info["channels"] = st.get("channels")
    except Exception:
        pass
    p2 = subprocess.run([FFMPEG, "-hide_banner", "-i", path, "-af", "volumedetect",
                         "-f", "null", "-"], capture_output=True, text=True)
    for key in ("mean_volume", "max_volume"):
        m = re.search(rf"{key}: ([-\d.]+) dB", p2.stderr)
        if m and key + "_dB" not in info:
            info[key + "_dB"] = float(m.group(1))
    return info


def trim_silence(path: str, threshold_db: float = -50.0) -> bool:
    """去掉首尾静音（原地替换）。"""
    tmp = path + ".trim.wav"
    subprocess.run([FFMPEG, "-hide_banner", "-loglevel", "error", "-y", "-i", path,
                    "-af", (f"silenceremove=start_periods=1:start_threshold={threshold_db}dB:start_silence=0.05,"
                            "areverse,"
                            f"silenceremove=start_periods=1:start_threshold={threshold_db}dB:start_silence=0.10,"
                            "areverse"),
                    "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", tmp], check=False)
    if os.path.exists(tmp) and os.path.getsize(tmp) > 512:
        os.replace(tmp, path)
        return True
    if os.path.exists(tmp):
        os.remove(tmp)
    return False


def calibrate_noise(device: str, rate: int, probe_s: float = 0.4,
                    margin_db: float = 8.0, cap_db: float = -18.0,
                    floor_db: float = -50.0) -> float:
    """录 0.4s 环境音，返回 silencedetect 建议阈值（样本峰值 + margin）。"""
    fd, tmp = tempfile.mkstemp(suffix=".wav")
    os.close(fd)
    try:
        subprocess.run([FFMPEG, "-hide_banner", "-loglevel", "error", "-y",
                        "-f", "avfoundation", "-i", device, "-t", str(probe_s),
                        "-ar", str(rate), "-ac", "1", "-c:a", "pcm_s16le", tmp],
                       check=False)
        p = subprocess.run([FFMPEG, "-hide_banner", "-i", tmp, "-af", "volumedetect",
                            "-f", "null", "-"], capture_output=True, text=True)
        m = re.search(r"max_volume: ([-\d.]+) dB", p.stderr)
        peak = float(m.group(1)) if m else -40.0
    except Exception:
        peak = -40.0
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)
    return round(min(max(peak + margin_db, floor_db), cap_db), 1)


# ---------------------------------------------------------------- 引擎 1：silencedetect
def _input_args(device: str, rate: int, input_file: str | None = None) -> list[str]:
    if input_file:
        return ["-re", "-i", input_file]
    return ["-f", "avfoundation", "-i", device]


def _record_silencedetect(out: str, device: str, rate: int, max_duration: float,
                          noise: float, silence_dur: float, quiet: bool,
                          input_file: str | None = None) -> dict:
    cmd = [FFMPEG, "-hide_banner", "-nostats", "-loglevel", "info", "-y"]
    cmd += _input_args(device, rate, input_file)
    cmd += ["-ar", str(rate), "-ac", "1", "-c:a", "pcm_s16le",
            "-af", f"silencedetect=noise={noise}dB:d={silence_dur}",
            "-t", str(max_duration), out]
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL,
                            stderr=subprocess.PIPE, bufsize=0)
    stop = threading.Event()
    st = {"speech_seen": False, "speech_start_s": None, "speech_end_s": None,
          "stop_reason": None}

    def reader() -> None:
        assert proc.stderr is not None
        for raw in proc.stderr:
            line = raw.decode("utf-8", "replace")
            if not quiet:
                sys.stderr.write(line)
            m = re.search(r"silence_start: ([\d.]+)", line)
            if m and st["speech_seen"] and not stop.is_set():
                st["speech_end_s"] = float(m.group(1))
                st["stop_reason"] = "vad_endpoint"
                stop.set()
            m = re.search(r"silence_end: ([\d.]+)", line)
            if m and not st["speech_seen"]:
                st["speech_seen"] = True
                st["speech_start_s"] = float(m.group(1))

    th = threading.Thread(target=reader, daemon=True)
    th.start()
    stop.wait(timeout=max_duration + 3.0)
    if not stop.is_set():
        st["stop_reason"] = "max_duration"
    try:
        proc.send_signal(signal.SIGINT)     # ffmpeg 收到 SIGINT 会正常收尾写 WAV
    except ProcessLookupError:
        pass
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.terminate()
        try:
            proc.wait(timeout=2)
        except subprocess.TimeoutExpired:
            proc.kill()
    th.join(timeout=1)
    return st


# ---------------------------------------------------------------- 引擎 2：能量 VAD
def _record_energy(out: str, device: str, rate: int, max_duration: float,
                   hangover_ms: int, rel_db: float, abs_db: float,
                   input_file: str | None = None) -> dict:
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from vad_energy import Endpointer

    cmd = [FFMPEG, "-hide_banner", "-loglevel", "error"]
    cmd += _input_args(device, rate, input_file)
    cmd += ["-ar", str(rate), "-ac", "1", "-f", "s16le", "-"]
    proc = subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                            stderr=subprocess.DEVNULL, bufsize=0)
    ep = Endpointer(sample_rate=rate, hangover_ms=hangover_ms,
                    rel_threshold_db=rel_db, abs_threshold_db=abs_db)
    pcm = bytearray()
    st = {"speech_seen": False, "speech_start_s": None, "speech_end_s": None,
          "stop_reason": None}
    t0 = time.perf_counter()
    chunk = int(rate * 0.1) * 2   # 100ms
    assert proc.stdout is not None
    try:
        while True:
            if time.perf_counter() - t0 > max_duration:
                st["stop_reason"] = "max_duration"
                break
            data = proc.stdout.read(chunk)
            if not data:
                st["stop_reason"] = st["stop_reason"] or "capture_ended"
                break
            pcm.extend(data)
            for ev in ep.push(data):
                if ev.kind == "speech_start" and not st["speech_seen"]:
                    st["speech_seen"] = True
                    st["speech_start_s"] = ev.t
                elif ev.kind == "utterance":
                    st["speech_end_s"] = ev.end
                    st["stop_reason"] = "vad_endpoint"
                    raise StopIteration
    except StopIteration:
        pass
    finally:
        proc.kill()
        try:
            proc.wait(timeout=2)
        except subprocess.TimeoutExpired:
            pass
    with wave.open(out, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(bytes(pcm))
    return st


# ---------------------------------------------------------------- 入口
def record(out: str, device: str = ":0", rate: int = 16000,
           duration: float | None = None, vad: bool = False,
           engine: str = "silencedetect", max_duration: float = 30.0,
           noise: float | None = None, silence_dur: float = 0.6,
           rel_db: float = 12.0, abs_db: float = -45.0,
           trim: bool = False, quiet: bool = False,
           input_file: str | None = None) -> dict:
    os.makedirs(os.path.dirname(os.path.abspath(out)) or ".", exist_ok=True)
    t0 = time.perf_counter()
    calib = None
    if not vad:
        limit = duration or 3.0
        cmd = [FFMPEG, "-hide_banner", "-loglevel", "error", "-y"]
        cmd += _input_args(device, rate, input_file)
        cmd += ["-ar", str(rate), "-ac", "1", "-c:a", "pcm_s16le",
                "-t", str(limit), out]
        subprocess.run(cmd, check=False)
        st = {"stop_reason": "fixed_duration", "speech_seen": False,
              "speech_start_s": None, "speech_end_s": None}
    elif engine == "energy":
        st = _record_energy(out, device, rate, max_duration,
                            hangover_ms=int(silence_dur * 1000), rel_db=rel_db,
                            abs_db=abs_db, input_file=input_file)
        st["engine"] = "energy"
    else:
        if noise is None:
            if input_file:
                noise = -40.0
            else:
                calib = calibrate_noise(device, rate)
                noise = calib
        st = _record_silencedetect(out, device, rate, max_duration, noise,
                                   silence_dur, quiet, input_file=input_file)
        st["engine"] = "silencedetect"
        st["noise_db"] = noise
        st["noise_calibrated"] = calib is not None
    wall = time.perf_counter() - t0

    if trim and os.path.exists(out):
        trim_silence(out)

    info = probe(out)
    info.update(st)
    info.update({"wall_s": round(wall, 2), "device": device,
                 "vad": {"enabled": vad, "engine": engine,
                         "silence_dur_s": silence_dur}})
    if info.get("speech_start_s") is not None and info.get("speech_end_s") is not None:
        info["speech_span_s"] = round(info["speech_end_s"] - info["speech_start_s"], 2)
    return info


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="macOS 16k 单声道录音 + 自动断句")
    ap.add_argument("--out", help="输出 WAV 路径")
    ap.add_argument("--duration", type=float, default=3.0, help="固定录音秒数（非 VAD 模式）")
    ap.add_argument("--vad", action="store_true", help="自动断句")
    ap.add_argument("--engine", choices=["silencedetect", "energy"], default="silencedetect")
    ap.add_argument("--max-duration", type=float, default=30.0, help="VAD 模式兜底最长秒数")
    ap.add_argument("--device", default=":0", help="avfoundation 设备，默认 :0")
    ap.add_argument("--in", dest="input_file", default=None,
                    help="离线自测：用 WAV 文件代替麦克风实时喂入（验证 VAD 逻辑用）")
    ap.add_argument("--rate", type=int, default=16000)
    ap.add_argument("--noise", default="auto",
                    help="silencedetect 噪声阈值，如 -22dB；auto=先探测环境（默认）")
    ap.add_argument("--silence-dur", type=float, default=0.6,
                    help="判定说完所需的最短静音秒数（也是 VAD hangover）")
    ap.add_argument("--rel-db", type=float, default=12.0, help="energy 引擎相对本底门限")
    ap.add_argument("--abs-db", type=float, default=-45.0, help="energy 引擎绝对门限 dBFS")
    ap.add_argument("--trim", action="store_true", help="去掉首尾静音")
    ap.add_argument("--list-devices", action="store_true")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--quiet", action="store_true", help="不转发 ffmpeg stderr")
    args = ap.parse_args(argv)

    if args.list_devices:
        return list_devices()
    if not args.out:
        ap.error("--out 必填（除非 --list-devices）")

    noise = None
    if args.noise != "auto":
        noise = float(args.noise.replace("dB", ""))

    info = record(args.out, device=args.device, rate=args.rate, duration=args.duration,
                  vad=args.vad, engine=args.engine, max_duration=args.max_duration,
                  noise=noise, silence_dur=args.silence_dur, rel_db=args.rel_db,
                  abs_db=args.abs_db, trim=args.trim, quiet=args.quiet,
                  input_file=args.input_file)
    print(json.dumps(info, ensure_ascii=False, indent=1 if args.json else None))
    return 0


if __name__ == "__main__":
    sys.exit(main())
