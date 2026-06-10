"""模拟引擎:不依赖任何三方库,用于验证协议链路(进度/分段/取消/异常)。"""

import time

from engines import EngineError


def transcribe(params, emit_event, is_cancelled):
    """模拟一次转写。

    params:
      duration_s:     模拟总耗时(秒),默认 2.0
      segment_count:  产出分段数量,默认 5
      fail:           为 True 时抛错,用于验证错误链路
    """
    duration_s = float(params.get("duration_s", 2.0))
    segment_count = max(int(params.get("segment_count", 5)), 1)

    if params.get("fail"):
        raise EngineError("fake_failure", "simulated engine failure")

    audio_duration = segment_count * 3.0  # 假装音频每段 3 秒
    step = duration_s / segment_count
    segments = []

    for index in range(segment_count):
        # 分片睡眠,保证 cancel 能在 ~50ms 内生效
        slept = 0.0
        while slept < step:
            if is_cancelled():
                return None
            chunk = min(0.05, step - slept)
            time.sleep(chunk)
            slept += chunk

        start = index * 3.0
        end = start + 3.0
        segment = {
            "start": start,
            "end": end,
            "text": "fake segment %d" % (index + 1),
        }
        segments.append(segment)
        emit_event("segment", segment)
        emit_event("progress", {"percent": round((index + 1) / segment_count * 100, 2)})

    return {
        "engine": "fake",
        "language": "zh",
        "duration": audio_duration,
        "segments": segments,
    }
