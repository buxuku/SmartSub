#!/usr/bin/env python3
"""SmartSub Python 推理引擎 sidecar。

协议:stdin/stdout 上的 JSON-lines(每行一条消息),JSON-RPC 风格:

  请求(Electron -> Python):   {"id": "req-1", "method": "transcribe", "params": {...}}
  通知(Electron -> Python):   {"method": "cancel", "params": {"id": "req-1"}}        # 无 id,不期待应答
  成功响应(Python -> Electron): {"id": "req-1", "result": {...}}
  错误响应(Python -> Electron): {"id": "req-1", "error": {"code": "...", "message": "..."}}
  事件推送(Python -> Electron): {"method": "progress", "params": {"id": "req-1", "percent": 42.5}}

约束:
  - stdout 专用于协议消息,任何日志必须走 stderr(logging 已配置)。
  - transcribe 在 worker 线程中执行,主循环始终保持响应(用于 cancel/ping)。

手动调试:
  echo '{"id":"1","method":"ping","params":{}}' | python3 main.py
"""

import json
import logging
import sys
import threading
import traceback

from engines import get_engine, list_engines

ENGINE_VERSION = "0.1.0"

logging.basicConfig(
    stream=sys.stderr,
    level=logging.INFO,
    format="[py-engine] %(asctime)s %(levelname)s %(message)s",
)
log = logging.getLogger(__name__)

_stdout_lock = threading.Lock()
# 进行中请求的取消标记: request_id -> threading.Event
_cancel_events = {}
_cancel_lock = threading.Lock()
_shutdown = threading.Event()


def emit(message):
    """线程安全地向 stdout 写出一条协议消息。"""
    line = json.dumps(message, ensure_ascii=False)
    with _stdout_lock:
        sys.stdout.write(line + "\n")
        sys.stdout.flush()


def emit_event(method, params):
    emit({"method": method, "params": params})


def emit_result(req_id, result):
    emit({"id": req_id, "result": result})


def emit_error(req_id, code, message):
    emit({"id": req_id, "error": {"code": code, "message": message}})


def handle_ping(req_id, params):
    emit_result(
        req_id,
        {
            "version": ENGINE_VERSION,
            "python": sys.version.split()[0],
            "frozen": bool(getattr(sys, "frozen", False)),
            "engines": list_engines(),
        },
    )


def handle_preload(req_id, params):
    """在 worker 线程中预加载模型（仅 _get_model，不转写）。"""

    def worker():
        engine_name = params.get("engine", "faster_whisper")
        try:
            engine = get_engine(engine_name)
            result = engine.preload(params)
            emit_result(req_id, result)
        except Exception as exc:  # noqa: BLE001
            code = getattr(exc, "engine_error_code", "internal_error")
            log.error("preload failed: %s\n%s", exc, traceback.format_exc())
            emit_error(req_id, code, str(exc))

    threading.Thread(target=worker, name="preload-%s" % req_id, daemon=True).start()


def handle_transcribe(req_id, params):
    """在 worker 线程中执行转写,逐段上报 progress/segment 事件。"""
    cancel_event = threading.Event()
    with _cancel_lock:
        _cancel_events[req_id] = cancel_event

    def worker():
        engine_name = params.get("engine", "faster_whisper")
        try:
            engine = get_engine(engine_name)
            result = engine.transcribe(
                params,
                emit_event=lambda method, p: emit_event(method, dict(p, id=req_id)),
                is_cancelled=cancel_event.is_set,
            )
            if cancel_event.is_set():
                emit_error(req_id, "cancelled", "transcription cancelled by client")
            else:
                emit_result(req_id, result)
        except Exception as exc:  # noqa: BLE001 - 协议边界,任何异常都要转成 error 响应
            code = getattr(exc, "engine_error_code", "internal_error")
            log.error("transcribe failed: %s\n%s", exc, traceback.format_exc())
            emit_error(req_id, code, str(exc))
        finally:
            with _cancel_lock:
                _cancel_events.pop(req_id, None)

    threading.Thread(target=worker, name="transcribe-%s" % req_id, daemon=True).start()


def handle_cancel(params):
    target_id = params.get("id")
    with _cancel_lock:
        event = _cancel_events.get(target_id)
    if event:
        event.set()
        log.info("cancel requested for %s", target_id)


HANDLERS = {
    "ping": handle_ping,
    "preload": handle_preload,
    "transcribe": handle_transcribe,
}


def dispatch(message):
    method = message.get("method")
    params = message.get("params") or {}
    req_id = message.get("id")

    if method == "shutdown":
        _shutdown.set()
        return
    if method == "cancel":
        handle_cancel(params)
        return

    if req_id is None:
        log.warning("notification with unknown method ignored: %s", method)
        return

    handler = HANDLERS.get(method)
    if handler is None:
        emit_error(req_id, "method_not_found", "unknown method: %s" % method)
        return
    handler(req_id, params)


def main():
    log.info("engine started (version=%s, python=%s)", ENGINE_VERSION, sys.version.split()[0])
    for line in sys.stdin:
        if _shutdown.is_set():
            break
        line = line.strip()
        if not line:
            continue
        try:
            message = json.loads(line)
        except json.JSONDecodeError as exc:
            log.error("invalid json line: %s (%s)", line[:200], exc)
            continue
        try:
            dispatch(message)
        except Exception:  # noqa: BLE001 - 主循环绝不能死
            log.error("dispatch crashed:\n%s", traceback.format_exc())
        if _shutdown.is_set():
            break
    log.info("engine exiting")


if __name__ == "__main__":
    main()
