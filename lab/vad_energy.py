#!/usr/bin/env python3
"""vad_energy.py — 纯 Python 能量 VAD / 断句器（不依赖大模型、不依赖 ffmpeg 运行时）。

设计目标：给"边说边判"的口语插件提供低成本 endpointing：
  1) 逐帧(20ms)能量估算，自适应本底噪声；
  2) 双阈值 + hangover（尾音保持）避免词尾被切断；
  3) 输出 speech_start / speech_end / utterance 事件，可直接驱动"说完就送 STT"。

用法：
  python3 lab/vad_energy.py some.wav                 # 打印分段
  python3 lab/vad_energy.py some.wav --json          # 机器可读
  # 作为库：
  from vad_energy import Endpointer
  ep = Endpointer()
  for ev in ep.push(pcm_s16le_bytes): ...

注意：能量 VAD 在噪声大/有回声时不如 Silero VAD；参数需按房间实测标定
（见 docs/audio-feasibility.md 的 noise_floor 实测值）。
"""
from __future__ import annotations

import argparse
import array
import json
import math
import sys
import wave
from dataclasses import dataclass, asdict
from typing import Iterable


@dataclass
class VadEvent:
    kind: str          # speech_start | speech_end | utterance
    t: float           # 事件时间（秒，相对流起点）
    start: float | None = None   # utterance 专用
    end: float | None = None     # utterance 专用
    rms_db: float | None = None


class Endpointer:
    """流式能量断句器。

    push() 接受 s16le 单声道 PCM bytes（可任意长度），返回事件列表。
    """

    def __init__(self, sample_rate: int = 16000, frame_ms: int = 20,
                 rel_threshold_db: float = 12.0, abs_threshold_db: float = -45.0,
                 min_speech_ms: int = 150, hangover_ms: int = 600,
                 onset_frames: int = 3, calibrate_ms: int = 400):
        self.sr = sample_rate
        self.frame = max(1, int(sample_rate * frame_ms / 1000))
        self.frame_ms = frame_ms
        self.rel_threshold_db = rel_threshold_db
        self.abs_threshold_db = abs_threshold_db
        self.min_speech_frames = max(1, int(min_speech_ms / frame_ms))
        self.hangover_frames = max(1, int(hangover_ms / frame_ms))
        self.onset_frames = max(1, onset_frames)

        # 开场校准：先收集 calibrate_ms 的帧，用中位数当初始本底噪声
        self.calibrate_frames = max(1, int(calibrate_ms / frame_ms))
        self._calib: list[float] = []
        self.noise_floor_db = -60.0
        self._calibrated = False
        self._bytes_leftover = b""

        self.t = 0.0                    # 已处理到的时间
        self.state = "silence"          # silence | speech
        self._speech_run = 0
        self._silence_run = 0
        self._utt_start = None
        self._utt_last_voiced = None

    # ---------- 基本工具 ----------
    @staticmethod
    def _rms_db(frame: array.array) -> float:
        if not frame:
            return -120.0
        s = 0.0
        for v in frame:
            s += float(v) * float(v)
        return 10.0 * math.log10(s / len(frame) / (32768.0 ** 2) + 1e-12)

    def _adapt_noise(self, db: float, voiced: bool) -> None:
        # 不对称跟踪：安静帧快速下探，非语音帧极慢上升（约 0.5dB/s），
        # 防止持续人声把本底噪声"抬高"导致断句失效。
        if db < self.noise_floor_db:
            self.noise_floor_db = 0.7 * self.noise_floor_db + 0.3 * db
        elif not voiced:
            self.noise_floor_db += 0.0005

    def threshold_db(self) -> float:
        return max(self.noise_floor_db + self.rel_threshold_db, self.abs_threshold_db)

    # ---------- 流式入口 ----------
    def push(self, pcm: bytes) -> list[VadEvent]:
        if self._bytes_leftover:
            pcm = self._bytes_leftover + pcm
            self._bytes_leftover = b""
        nbytes = self.frame * 2
        usable = len(pcm) - (len(pcm) % nbytes)
        if usable <= 0:
            self._bytes_leftover = pcm
            return []
        self._bytes_leftover = pcm[usable:]
        buf = array.array("h")
        buf.frombytes(pcm[:usable])
        events: list[VadEvent] = []
        for i in range(0, len(buf), self.frame):
            events.extend(self._step(buf[i:i + self.frame]))
        return events

    def flush(self) -> list[VadEvent]:
        out: list[VadEvent] = []
        if self.state == "speech" and self._utt_start is not None:
            out.append(VadEvent("speech_end", round(self.t, 3), end=round(self.t, 3)))
            out.append(VadEvent("utterance", round(self.t, 3),
                                start=round(self._utt_start, 3), end=round(self.t, 3)))
            self.state = "silence"
            self._utt_start = None
        return out

    # ---------- 单帧状态机 ----------
    def _step(self, frame: array.array) -> list[VadEvent]:
        db = self._rms_db(frame)
        if not self._calibrated:
            self._calib.append(db)
            if len(self._calib) < self.calibrate_frames:
                self.t = round(self.t + self.frame_ms / 1000.0, 6)
                return []
            calib = sorted(self._calib)
            self.noise_floor_db = calib[len(calib) // 2]   # 中位数
            self._calibrated = True
            self._calib = []
            self.t = round(self.t + self.frame_ms / 1000.0, 6)
            return []
        thresh = self.threshold_db()
        voiced = db >= thresh
        self._adapt_noise(db, voiced)
        t = self.t
        self.t = round(self.t + self.frame_ms / 1000.0, 6)
        out: list[VadEvent] = []

        if self.state == "silence":
            self._speech_run = self._speech_run + 1 if voiced else 0
            if self._speech_run >= self.onset_frames:
                self.state = "speech"
                self._silence_run = 0
                self._utt_start = t - (self._speech_run - 1) * self.frame_ms / 1000.0
                self._utt_start = max(0.0, self._utt_start)
                self._utt_last_voiced = t
                out.append(VadEvent("speech_start", round(self._utt_start, 3), rms_db=round(db, 1)))
                self._speech_run = 0
        else:  # speech
            if voiced:
                self._silence_run = 0
                self._utt_last_voiced = t
            else:
                self._silence_run += 1
                if self._silence_run >= self.hangover_frames:
                    dur = (self._utt_last_voiced or t) - (self._utt_start or t)
                    end = round((self._utt_last_voiced or t) + self.frame_ms / 1000.0, 3)
                    # 太短的"咔哒"声不算一句话：回退成静音，不发 utterance
                    if dur * 1000 >= self.min_speech_frames * self.frame_ms:
                        out.append(VadEvent("speech_end", end, end=end))
                        out.append(VadEvent("utterance", end,
                                            start=round(self._utt_start, 3), end=end))
                    self.state = "silence"
                    self._utt_start = None
                    self._silence_run = 0
        return out


# ---------------- CLI：把 wav 当流喂进去做验证 ----------------
def read_wav_mono(path: str) -> tuple[int, bytes]:
    with wave.open(path, "rb") as w:
        if w.getsampwidth() != 2:
            raise SystemExit("只支持 16-bit PCM WAV")
        if w.getnchannels() != 1:
            raise SystemExit("只支持单声道 WAV（可先用 ffmpeg -ac 1 转换）")
        return w.getframerate(), w.readframes(w.getnframes())


def main(argv: Iterable[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="纯能量 VAD / 断句器")
    ap.add_argument("wav", nargs="?")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--rel-db", type=float, default=12.0, help="高于本底噪声多少 dB 视为说话")
    ap.add_argument("--abs-db", type=float, default=-45.0, help="绝对门限 dBFS")
    ap.add_argument("--hangover-ms", type=int, default=600, help="静音多久判定说完")
    ap.add_argument("--min-speech-ms", type=int, default=150)
    args = ap.parse_args(list(argv) if argv is not None else None)
    if not args.wav:
        ap.print_help()
        return 2

    sr, pcm = read_wav_mono(args.wav)
    ep = Endpointer(sample_rate=sr, rel_threshold_db=args.rel_db,
                    abs_threshold_db=args.abs_db, hangover_ms=args.hangover_ms,
                    min_speech_ms=args.min_speech_ms)
    chunk = sr * 2 // 50  # 20ms
    events: list[VadEvent] = []
    for i in range(0, len(pcm), chunk):
        events.extend(ep.push(pcm[i:i + chunk]))
    events.extend(ep.flush())

    if args.json:
        print(json.dumps({"file": args.wav, "sample_rate": sr,
                          "noise_floor_db": round(ep.noise_floor_db, 1),
                          "events": [asdict(e) for e in events]}, ensure_ascii=False, indent=1))
    else:
        print(f"file={args.wav} sr={sr} noise_floor={ep.noise_floor_db:.1f}dBFS "
              f"threshold={ep.threshold_db():.1f}dBFS")
        for e in events:
            if e.kind == "utterance":
                print(f"  [utterance] {e.start:6.2f}s -> {e.end:6.2f}s  ({(e.end - e.start):.2f}s)")
            elif e.kind == "speech_start":
                print(f"  [start]     {e.t:6.2f}s (rms {e.rms_db} dBFS)")
            elif e.kind == "speech_end":
                print(f"  [end]       {e.t:6.2f}s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
