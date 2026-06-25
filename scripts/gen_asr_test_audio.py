#!/usr/bin/env python3
"""Generate a Chinese ASR test clip with leading + middle + trailing silence.

Uses macOS `say` (Tingting / zh_CN) for speech and Python's stdlib `wave`
to stitch speech blocks together with precisely-sized silence gaps. Output is
16 kHz / mono / 16-bit PCM WAV — the format most ASR engines expect.

Two ways to size the middle silence:

* Weighted-to-target (default): gaps share whatever time is left so the file
  lands on exactly --target seconds. Good for a tight 60s clip.
      python3 scripts/gen_asr_test_audio.py

* Explicit gaps: pass --gaps with one duration (seconds) per gap; the total
  duration is then free (no rescaling), which guarantees long, exact pauses.
      python3 scripts/gen_asr_test_audio.py --name asr-zh-longgap \
          --gaps 3,4,5,4,6 --leading 3 --trailing 1.5
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
import tempfile
import wave

# ---- fixed audio format ---------------------------------------------------
VOICE = "Tingting"          # zh_CN female; see `say -v '?'`
SAMPLE_RATE = 16000          # ASR standard
SAMPLE_WIDTH = 2             # 16-bit
CHANNELS = 1                 # mono

# relative weights for the middle gaps in weighted-to-target mode.
GAP_WEIGHTS = [1.0, 1.4, 0.8, 1.2, 0.9, 1.1]
MIN_GAP_SECONDS = 1.0

OUT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "test-audio")

# Speech blocks: varied vocabulary, numbers, dates, codes and a phone number
# to give the recognizer something to chew on.
BLOCKS = [
    "大家好，欢迎使用智能字幕语音识别测试音频，这段录音用于验证中文识别效果。",
    "今天是二零二六年六月二十五日，星期四，天气晴朗，气温二十八摄氏度。",
    "请记录以下信息，订单编号是 A1234567，联系电话是 13800138000。",
    "人工智能技术正在快速发展，语音识别、机器翻译和自然语言处理应用十分广泛。",
    "本次会议将于下午三点半，在公司二楼第二会议室召开，请相关同事准时参加。",
    "测试内容到此结束，感谢您的聆听，祝您工作顺利，生活愉快，再见。",
]
# ---------------------------------------------------------------------------


def secs(frames: int) -> float:
    return frames / SAMPLE_RATE


def fmt_ts(frames: int) -> str:
    t = secs(frames)
    m, s = divmod(t, 60)
    return f"{int(m):02d}:{s:06.3f}"


def synth_block(text: str, path: str) -> None:
    """Render one text block to a 16 kHz mono 16-bit WAV via `say`."""
    subprocess.run(
        ["say", "-v", VOICE, "-o", path,
         "--data-format=LEI16@%d" % SAMPLE_RATE, text],
        check=True,
    )


def read_pcm(path: str) -> bytes:
    with wave.open(path, "rb") as w:
        assert w.getframerate() == SAMPLE_RATE, f"{path}: {w.getframerate()} Hz"
        assert w.getnchannels() == CHANNELS, f"{path}: {w.getnchannels()} ch"
        assert w.getsampwidth() == SAMPLE_WIDTH, f"{path}: {w.getsampwidth()} bytes"
        return w.readframes(w.getnframes())


def silence(frames: int) -> bytes:
    return b"\x00" * (max(0, frames) * SAMPLE_WIDTH * CHANNELS)


def parse_args(argv: list[str]) -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--name", default="asr-zh-60s",
                   help="output basename (writes <name>.wav and <name>.txt)")
    p.add_argument("--leading", type=float, default=2.5,
                   help="silence at the very start (seconds)")
    p.add_argument("--trailing", type=float, default=1.0,
                   help="silence at the very end (seconds)")
    p.add_argument("--target", type=float, default=60.0,
                   help="exact total duration (seconds) for weighted-gap mode; "
                        "ignored when --gaps is given")
    p.add_argument("--gaps", default="",
                   help="explicit middle-gap durations in seconds, comma-separated "
                        "(e.g. '3,4,5,4,6'); one per gap = len(BLOCKS)-1. "
                        "When set, --target is ignored and total duration is free.")
    return p.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    os.makedirs(OUT_DIR, exist_ok=True)
    out_wav = os.path.join(OUT_DIR, f"{args.name}.wav")
    out_txt = os.path.join(OUT_DIR, f"{args.name}.txt")

    n_gaps = len(BLOCKS) - 1
    explicit_gaps: list[int] = []
    if args.gaps.strip():
        vals = [float(x) for x in args.gaps.split(",") if x.strip()]
        if len(vals) != n_gaps:
            print(f"ERROR: --gaps needs exactly {n_gaps} values "
                  f"(got {len(vals)}).", file=sys.stderr)
            return 1
        explicit_gaps = [int(round(v * SAMPLE_RATE)) for v in vals]

    # 1) synthesize every block, collect raw PCM + frame counts
    speech_pcm: list[bytes] = []
    speech_frames: list[int] = []
    with tempfile.TemporaryDirectory() as tmp:
        for i, text in enumerate(BLOCKS):
            seg = os.path.join(tmp, f"seg_{i}.wav")
            synth_block(text, seg)
            pcm = read_pcm(seg)
            speech_pcm.append(pcm)
            speech_frames.append(len(pcm) // (SAMPLE_WIDTH * CHANNELS))

    total_speech = sum(speech_frames)
    leading = int(round(args.leading * SAMPLE_RATE))
    trailing = int(round(args.trailing * SAMPLE_RATE))

    # 2) decide middle gaps
    if explicit_gaps:
        gaps = explicit_gaps
        target_frames = leading + total_speech + sum(gaps) + trailing
    else:
        target_frames = int(round(args.target * SAMPLE_RATE))
        mid_budget = target_frames - total_speech - leading - trailing
        if mid_budget < n_gaps * int(MIN_GAP_SECONDS * SAMPLE_RATE):
            print(
                "ERROR: speech (%.2fs) leaves too little room for silence; "
                "raise --target or use --gaps." % secs(total_speech),
                file=sys.stderr,
            )
            return 1
        weights = (GAP_WEIGHTS * ((n_gaps // len(GAP_WEIGHTS)) + 1))[:n_gaps]
        wsum = sum(weights)
        gaps = [int(round(mid_budget * w / wsum)) for w in weights]
        # absorb rounding drift into the trailing silence -> exact target
        used = leading + total_speech + sum(gaps) + trailing
        trailing += target_frames - used

    # 3) assemble timeline: leading | block0 | gap0 | block1 | ... | trailing
    parts: list[bytes] = [silence(leading)]
    timeline: list[tuple[str, int, int, str]] = []  # (kind, start, end, label)
    cursor = 0
    timeline.append(("silence", cursor, cursor + leading, "开头静音"))
    cursor += leading

    for i, pcm in enumerate(speech_pcm):
        parts.append(pcm)
        timeline.append(("speech", cursor, cursor + speech_frames[i], BLOCKS[i]))
        cursor += speech_frames[i]
        if i < n_gaps:
            parts.append(silence(gaps[i]))
            timeline.append(("silence", cursor, cursor + gaps[i], "中间静音"))
            cursor += gaps[i]

    parts.append(silence(trailing))
    timeline.append(("silence", cursor, cursor + trailing, "结尾静音"))
    cursor += trailing

    data = b"".join(parts)
    assert cursor == target_frames, (cursor, target_frames)
    assert len(data) // (SAMPLE_WIDTH * CHANNELS) == target_frames

    # 4) write the WAV
    with wave.open(out_wav, "wb") as w:
        w.setnchannels(CHANNELS)
        w.setsampwidth(SAMPLE_WIDTH)
        w.setframerate(SAMPLE_RATE)
        w.writeframes(data)

    # 5) write a human-readable transcript + timeline (ground truth for ASR)
    lines = [
        f"# ASR 中文测试音频 ({secs(target_frames):.3f}s, 16kHz mono 16-bit)",
        f"# voice={VOICE}  file={os.path.basename(out_wav)}",
        "",
        "时间轴：",
    ]
    for kind, start, end, label in timeline:
        tag = "🔇 静音" if kind == "silence" else "🗣️ 语音"
        dur = secs(end - start)
        text = label if kind == "speech" else f"({label})"
        lines.append(f"[{fmt_ts(start)} - {fmt_ts(end)}]  {tag}  {dur:5.2f}s  {text}")
    with open(out_txt, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")

    # 6) report
    print("\n".join(lines))
    print()
    mid_gaps = [secs(g) for g in gaps]
    print(f"middle gaps  : {', '.join(f'{g:.2f}s' for g in mid_gaps)}")
    print(f"total speech : {secs(total_speech):6.2f}s")
    print(f"total silence: {secs(target_frames - total_speech):6.2f}s")
    print(f"duration     : {secs(target_frames):6.3f}s")
    print(f"written      : {out_wav}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
