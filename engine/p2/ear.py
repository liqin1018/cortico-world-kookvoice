#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Coo 的耳朵：从系统环回设备采集声音 → VAD 切句 → 本地识别 → 输出 JSON 行

用法：
  python ear.py --list                     # 列出所有可采集的环回设备（带音量）
  python ear.py --file a.wav               # 离线识别一个文件，用于验证
  python ear.py                            # 自动选正在出声的设备，实时听
  python ear.py --device "MCHOSE"          # 指定设备（名字子串匹配）

输出（stdout，每行一个 JSON）：
  {"type":"device","name":"..."}
  {"type":"ready"}
  {"type":"text","text":"...","dur":1.8,"cost":0.4}
  {"type":"error","message":"..."}

半双工：从 stdin 读一行 "mute" / "unmute"，静音期间直接丢弃音频（防止听见自己）。
"""
import argparse
import json
import os
import queue
import sys
import threading
import time
import warnings

import numpy as np

# soundcard 在同时开多个录音器时会狂刷「data discontinuity」，
# 这是它的缓冲警告，不影响音频内容，静音掉免得刷屏
warnings.filterwarnings("ignore")

HERE = os.path.dirname(os.path.abspath(__file__))

# 模型放哪：
#   ① COO_DATA_DIR 里有（插件下发的用户数据目录）→ 用它，重装插件不会丢
#   ② 否则用引擎自带的 p2/models（开发环境，或者用户把模型放在插件里）
# 两个位置都支持，免得「文件明明在、程序却找不到」。
_DATA = os.environ.get("COO_DATA_DIR", "").strip()
_ROOT = HERE
if _DATA:
    _cand = os.path.join(_DATA, "kookvoice", "models", "sense-voice", "model.int8.onnx")
    if os.path.exists(_cand):
        _ROOT = os.path.join(_DATA, "kookvoice")
MODEL_DIR = os.path.join(_ROOT, "models", "sense-voice")
VAD_MODEL = os.path.join(_ROOT, "models", "vad", "silero_vad.onnx")
SR = 16000


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def log(msg):
    sys.stderr.write(str(msg) + "\n")
    sys.stderr.flush()


# ── 设备 ────────────────────────────────────────────────────────
def loopback_devices():
    import soundcard as sc
    return [m for m in sc.all_microphones(include_loopback=True) if m.isloopback]


def probe_levels(seconds=1.2, concurrent=True):
    """同时打开所有环回设备录音，算各自的峰值。

    串行探测要 N×seconds 秒，太长；轮询读一遍所有设备只要 seconds 秒，
    这样才能在「她正在说话的那两秒」里完成探测。
    """
    import soundcard as sc

    devs = loopback_devices()
    opened = []
    for m in devs:
        try:
            r = m.recorder(samplerate=SR, channels=1, blocksize=1600)
            r.__enter__()
            opened.append([m, r, 0.0])
        except Exception as e:
            log(f"  打开 {m.name} 失败: {e}")

    if not opened:
        return []

    block = 1600
    end = time.time() + seconds
    while time.time() < end:
        for item in opened:
            try:
                d = item[1].record(numframes=block)
            except Exception:
                continue
            if d is None or len(d) == 0:
                continue
            pk = float(np.abs(d).max())
            if pk > item[2]:
                item[2] = pk

    for item in opened:
        try:
            item[1].__exit__(None, None, None)
        except Exception:
            pass

    return [(item[0].name, item[2]) for item in opened]


def pick_device(want=None, probe_seconds=1.5):
    import soundcard as sc

    if want:
        for m in loopback_devices():
            if want.lower() in m.name.lower():
                return m
        raise SystemExit(f"没找到名称包含「{want}」的环回设备。用 --list 看有哪些。")

    levels = probe_levels(probe_seconds)
    levels.sort(key=lambda x: x[1], reverse=True)
    for name, lv in levels:
        log(f"    {lv:.3f}  {name}")
    if levels and levels[0][1] > 0.002:
        chosen = levels[0][0]
        log(f"· 自动选择正在出声的设备: {chosen}（峰值 {levels[0][1]:.3f}）")
        for m in loopback_devices():
            if m.name == chosen:
                return m

    d = sc.default_speaker()
    log(f"· 没有设备明显在出声，用默认扬声器环回: {d.name}")
    for m in loopback_devices():
        if d.name in m.name:
            return m
    return loopback_devices()[0]


# ── 识别引擎 ────────────────────────────────────────────────────
def build_recognizer(num_threads=4, language="zh"):
    import sherpa_onnx

    model = os.path.join(MODEL_DIR, "model.int8.onnx")
    tokens = os.path.join(MODEL_DIR, "tokens.txt")
    if not (os.path.exists(model) and os.path.exists(tokens)):
        raise SystemExit(f"模型缺失：{MODEL_DIR}")

    kwargs = dict(model=model, tokens=tokens, num_threads=num_threads, use_itn=True, debug=False)
    try:
        return sherpa_onnx.OfflineRecognizer.from_sense_voice(language=language, **kwargs)
    except TypeError:
        # 老版本没有 language 参数
        return sherpa_onnx.OfflineRecognizer.from_sense_voice(**kwargs)


def transcribe(rec, samples):
    stream = rec.create_stream()
    stream.accept_waveform(SR, samples)
    rec.decode_stream(stream)
    return (stream.result.text or "").strip()


# ── VAD ─────────────────────────────────────────────────────────
def build_vad():
    import sherpa_onnx

    if not os.path.exists(VAD_MODEL):
        return None
    cfg = sherpa_onnx.VadModelConfig()
    cfg.silero_vad.model = VAD_MODEL
    cfg.silero_vad.threshold = 0.5
    # 0.45 太短：正常说话中间喘口气就被切断，一句「今天天气不错，我们出去走走吧，
    # 顺便买点水果回来」会被切成四段，每段都触发一次大模型，既慢又听不懂上下文。
    # 0.9 秒能容忍自然的思考停顿，代价只是回复晚 0.45 秒。
    cfg.silero_vad.min_silence_duration = float(os.environ.get("COO_VAD_SILENCE", "0.9"))
    cfg.silero_vad.min_speech_duration = 0.3
    cfg.silero_vad.window_size = 512
    cfg.sample_rate = SR
    try:
        return sherpa_onnx.VoiceActivityDetector(cfg, buffer_size_in_seconds=30)
    except TypeError:
        return sherpa_onnx.VoiceActivityDetector(cfg, 30)


# ── 文件模式 ────────────────────────────────────────────────────
def run_file(path):
    import wave

    with wave.open(path, "rb") as w:
        sr = w.getframerate()
        ch = w.getnchannels()
        raw = w.readframes(w.getnframes())
    pcm = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    if ch > 1:
        pcm = pcm.reshape(-1, ch).mean(axis=1)
    if sr != SR:
        # 简单的线性重采样（文件测试够用）
        n = int(len(pcm) * SR / sr)
        pcm = np.interp(np.linspace(0, len(pcm), n, endpoint=False), np.arange(len(pcm)), pcm).astype(np.float32)

    rec = build_recognizer()
    t0 = time.time()
    text = transcribe(rec, pcm)
    emit({"type": "text", "text": text, "dur": round(len(pcm) / SR, 2), "cost": round(time.time() - t0, 2)})


# ── 实时模式 ────────────────────────────────────────────────────
def open_mic(want=None):
    """主人的麦克风。KOOK 不会把「你自己的声音」播回给你，
    所以只听环回的话，屋里只有你一个人时她永远是聋的。"""
    import soundcard as sc

    if want:
        for m in sc.all_microphones(include_loopback=False):
            if want.lower() in m.name.lower():
                return m
        log(f"· 没找到麦克风「{want}」，改用默认麦克风")
    try:
        return sc.default_microphone()
    except Exception as e:
        log(f"· 没有可用麦克风: {e}")
        return None


def run_live(device, mic=None, show_partial=False):
    rec = build_recognizer()
    vad = build_vad()
    if vad is None:
        raise SystemExit("缺少 VAD 模型 models/vad/silero_vad.onnx")

    devices = list(device) if isinstance(device, (list, tuple)) else [device]
    emit({"type": "device", "name": " + ".join(d.name for d in devices)})
    if mic is not None:
        log(f"· 混音源：环回 {' + '.join(d.name for d in devices)} + 麦克风 {mic.name}")
    emit({"type": "ready"})

    muted = threading.Event()
    stop = threading.Event()
    ignore_until = 0.0  # 刚解除静音的一小段时间内丢弃片段（防她自己的尾音漏进来）

    def read_stdin():
        nonlocal ignore_until
        for line in sys.stdin:
            cmd = line.strip().lower()
            if cmd == "mute":
                muted.set()
                log("· 已静音采集（她在说话）")
            elif cmd == "unmute":
                muted.clear()
                ignore_until = time.time() + 0.5
                log("· 恢复采集")
            elif cmd in ("quit", "exit"):
                stop.set()
                break

    threading.Thread(target=read_stdin, daemon=True).start()

    block = 1600  # 100ms @16k
    speech_t0 = None

    from contextlib import ExitStack

    with ExitStack() as stack:
        # 每路环回一个 recorder，全部打开；哪路打不开就跳过（有的虚设备会报错）
        recs = []
        for d in devices:
            try:
                recs.append((d.name, stack.enter_context(d.recorder(samplerate=SR, channels=1, blocksize=block))))
            except Exception as e:
                log(f"· 跳过环回 {d.name}：{e}")
        if not recs:
            raise SystemExit("一个环回设备都打不开")
        mr = None
        if mic is not None:
            try:
                mr = stack.enter_context(mic.recorder(samplerate=SR, channels=1, blocksize=block))
            except Exception as e:
                log(f"· 麦克风打开失败，只用环回: {e}")
                mr = None
        while not stop.is_set():
            # 多路环回逐路取，加起来。只有一路在播时就是它本身，等价于单选。
            samples = None
            for _name, r in recs:
                try:
                    data = r.record(numframes=block)
                except Exception:
                    continue
                if data is None or len(data) == 0:
                    continue
                s = np.ascontiguousarray(data[:, 0], dtype=np.float32)
                samples = s if samples is None else samples + s
            if samples is None:
                samples = np.zeros(block, dtype=np.float32)
            else:
                # 多路叠加后要压回去，避免两个设备同时出声时削波
                samples = np.clip(samples * 0.75, -1.0, 1.0).astype(np.float32)

            # 混入麦克风：环回里只有「别人」的声音，主人自己说的不会回来
            if mr is not None:
                try:
                    mdata = mr.record(numframes=block)
                    if mdata is not None and len(mdata):
                        ms = np.ascontiguousarray(mdata[:, 0], dtype=np.float32)
                        n = min(len(samples), len(ms))
                        samples = np.clip(samples[:n] * 0.75 + ms[:n] * 1.0, -1.0, 1.0).astype(np.float32)
                except Exception:
                    pass

            # 麦克风电平常常被系统/驱动/会议软件压得很低（实测有人只有 0.02，
            # 而 silero VAD 是在 0.1~0.8 的正常录音电平上训的，这么小它判不出语音，
            # 表现就是「我说话了她一点反应都没有，日志里连『识别为空』都没有」）。
            # 这里做一次软提升：只在小信号时放大，最多 8 倍，放大后留 0.95 余量防削波；
            # 底噪（<0.001）不放大，免得把风扇声也喂给 VAD。
            _pk = float(np.abs(samples).max())
            if 0.001 < _pk < 0.08:
                samples = np.clip(samples * min(8.0, 0.22 / _pk), -0.95, 0.95).astype(np.float32)

            if muted.is_set():
                # 静音期间喂静音，让 VAD 正常收尾，但不产出文本
                vad.accept_waveform(np.zeros_like(samples))
                while not vad.empty():
                    vad.pop()
                continue

            vad.accept_waveform(samples)

            while not vad.empty():
                seg = vad.front
                frames = seg.samples
                vad.pop()
                if muted.is_set():
                    continue
                audio = np.asarray(frames, dtype=np.float32)
                if len(audio) < SR * 0.2:  # 太短的多半是咳嗽/噪声
                    continue
                if time.time() < ignore_until:
                    log(f"· 忽略静音解除后的残音（{len(audio)/SR:.2f}s）")
                    continue
                peak = float(np.abs(audio).max())
                # 前后各补 0.25s 静音：VAD 切得很紧时，头尾的辅音容易被截断，识别会崩
                pad = np.zeros(int(SR * 0.25), dtype=np.float32)
                audio = np.concatenate([pad, audio, pad])
                t0 = time.time()
                text = transcribe(rec, audio)
                cost = time.time() - t0
                dur = len(audio) / SR
                if text:
                    emit({"type": "text", "text": text, "dur": round(dur, 2), "cost": round(cost, 2), "peak": round(peak, 3)})
                else:
                    log(f"· 识别为空（{dur:.2f}s，峰值 {peak:.3f}）")


def main():
    # Windows 控制台默认 GBK，中文 JSON 会炸；强制 UTF-8
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

    ap = argparse.ArgumentParser()
    ap.add_argument("--list", action="store_true", help="列出环回设备与音量")
    ap.add_argument("--file", help="识别一个 wav 文件")
    ap.add_argument("--device", help="环回设备名字子串")
    ap.add_argument("--probe", type=float, default=1.5, help="自动选设备时的探测秒数")
    ap.add_argument("--threads", type=int, default=4)
    ap.add_argument("--mix", action="store_true", help="同时采集麦克风（你自己说的话不会从扬声器出来，只听环回会听不到自己）")
    ap.add_argument("--mic", help="指定麦克风名字子串，隐含 --mix")
    ap.add_argument("--no-mix", action="store_true", help="只用环回，不采麦克风")
    args = ap.parse_args()

    if args.list:
        for name, lv in probe_levels(args.probe):
            print(f"{lv:>7.3f}  {name}")
        return

    if args.file:
        run_file(args.file)
        return

    if args.device:
        device = pick_device(args.device, args.probe)
    else:
        emit({"type": "probe-start"})
        # 默认把**所有环回**都采上，混在一起。
        # 这样中途把 KOOK 的输出从耳机换到显示器、或者换一条 HDMI，都不用改配置 ——
        # 哪条路在出声就自然被采到。只有一路在播时，混音和单选完全等价；
        # 多路同时播会叠加变响（少见，且前面有 clip 兜底不会爆音）。
        device = loopback_devices()
        log(f"· 采集全部 {len(device)} 个环回（换设备不用改配置）")

    mic = None
    if not args.no_mix:
        mic = open_mic(args.mic)
    run_live(device, mic=mic)


if __name__ == "__main__":
    main()
