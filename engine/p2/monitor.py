# -*- coding: utf-8 -*-
"""本地监听话路：把 Coo 合成出来的声音同时播到本机扬声器。

为什么要这个：
  KOOK 不会把你推上去的音频再播回给你。一个人测试时「她到底回没回」
  完全不可见 —— 日志打了 Coo: xxx，耳朵却是聋的。
  这条话路让单人也能形成完整闭环。

协议（stdin，每行一条）：
  play <wav路径>    播放并删除
  vol  <0~2>        音量倍率（默认 0.9）
  dev  <名字子串>   换输出设备
  quit
输出（stderr）：人看的日志
"""
import os
import queue
import sys
import threading
import wave

import numpy as np
import soundcard as sc

volume = 0.9
dev_want = None
out_q: "queue.Queue" = queue.Queue()


def log(msg):
    print(msg, file=sys.stderr, flush=True)


def pick_speaker(want):
    """每次播放重新取一遍，设备热插拔也不会卡死"""
    if want:
        for s in sc.all_speakers():
            if want.lower() in s.name.lower():
                return s
    try:
        return sc.default_speaker()
    except Exception:
        spk = sc.all_speakers()
        return spk[0] if spk else None


def read_wav(path):
    with wave.open(path, "rb") as w:
        ch, sr, sw = w.getnchannels(), w.getframerate(), w.getsampwidth()
        raw = w.readframes(w.getnframes())
    if sw != 2:
        raise ValueError(f"只支持 16bit wav，实际 {sw * 8}bit")
    a = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    a = a.reshape(-1, ch) if ch > 1 else a.reshape(-1, 1)
    return a, sr


def player():
    while True:
        path = out_q.get()
        if path is None:
            return
        try:
            a, sr = read_wav(path)
            spk = pick_speaker(dev_want)
            if spk is None:
                log("· 没有可用的输出设备")
            else:
                spk.play(np.clip(a * volume, -1.0, 1.0), samplerate=sr)
        except Exception as e:
            log(f"· 本地回放失败: {e}")
        finally:
            try:
                os.remove(path)
            except Exception:
                pass


def main():
    global volume, dev_want
    try:
        sys.stdin.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

    # 参数：monitor.py [输出设备名子串]
    if len(sys.argv) > 1:
        dev_want = sys.argv[1]

    threading.Thread(target=player, daemon=True).start()

    spk = pick_speaker(dev_want)
    log(f"· 本地监听 → {spk.name if spk else '(无设备)'}")

    for line in sys.stdin:
        cmd = line.strip()
        if not cmd:
            continue
        low = cmd.lower()
        if low in ("quit", "exit"):
            break
        if low.startswith("play "):
            out_q.put(cmd[5:].strip().strip('"'))
        elif low.startswith("vol "):
            try:
                volume = float(cmd[4:])
                log(f"· 监听音量 {volume:g}")
            except ValueError:
                pass
        elif low.startswith("dev "):
            dev_want = cmd[4:].strip() or None
            spk = pick_speaker(dev_want)
            log(f"· 监听设备 → {spk.name if spk else '(无设备)'}")

    out_q.put(None)


if __name__ == "__main__":
    main()
