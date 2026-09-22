"""App-owned optional review, executed with the downloaded runtime's interpreter.

Keep the runtime entrypoint (CUDA setup, protocol, cancellation and model cache).
Never rewrite downloaded files or require a separate runtime release.
"""

import os
import importlib.util
import sys

runtime_main = os.path.abspath(sys.argv[1])
sys.path.insert(0, os.path.dirname(runtime_main))
from engines import faster_whisper_engine as engine

original = engine.transcribe


def transcribe(params, emit_event, is_cancelled):
    enabled = params.get("speech_review") is True

    def emit(method, data):
        if enabled and method == "progress":
            data = {**data, "percent": min(90, float(data.get("percent", 0)) * 0.9)}
        emit_event(method, data)

    result = original(params, emit, is_cancelled)
    if not enabled or not result or is_cancelled():
        return result
    try:
        from speech_review import review

        model = engine._get_model(
            params.get("model", "base"),
            params.get("device", "auto"),
            params.get("compute_type", "auto"),
            params.get("download_root"),
        )
        return review(model, result, params, emit_event, is_cancelled)
    except Exception as error:
        if type(error).__name__ == "ReviewCancelled" or is_cancelled():
            return None
        import logging

        logging.getLogger(__name__).exception(
            "speech review unavailable; preserving original recognition"
        )
        return {
            **result,
            "speechReview": {"status": "unavailable", "reason": type(error).__name__},
        }


engine.transcribe = transcribe
# runpy temporarily replaces argv[0], which would lose the bootstrap on the
# runtime's Linux CUDA re-exec. Import by file and invoke main explicitly.
spec = importlib.util.spec_from_file_location("smartsub_runtime", runtime_main)
runtime = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runtime)
runtime.main()
