#!/usr/bin/env python3
"""协议级 smoke test:以子进程方式拉起 main.py,验证完整协议链路。

覆盖:ping / echo / transcribe(fake, 进度+分段) / cancel / 错误链路 / shutdown 退出码。
用法:python3 smoke_test.py
"""

import json
import os
import subprocess
import sys
import threading
import time

ENGINE_DIR = os.path.dirname(os.path.abspath(__file__))


class EngineClient:
    def __init__(self):
        env = dict(os.environ, PYTHONUNBUFFERED="1", PYTHONIOENCODING="utf-8")
        self.proc = subprocess.Popen(
            [sys.executable, os.path.join(ENGINE_DIR, "main.py")],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            cwd=ENGINE_DIR,
            env=env,
            text=True,
            encoding="utf-8",
        )
        self.responses = {}  # id -> message
        self.events = []  # 推送事件(progress/segment/...)
        self._lock = threading.Lock()
        self._reader = threading.Thread(target=self._read_loop, daemon=True)
        self._reader.start()

    def _read_loop(self):
        for line in self.proc.stdout:
            message = json.loads(line)
            with self._lock:
                if "id" in message:
                    self.responses[message["id"]] = message
                else:
                    self.events.append(message)

    def send(self, message):
        self.proc.stdin.write(json.dumps(message) + "\n")
        self.proc.stdin.flush()

    def request(self, req_id, method, params=None, timeout=10.0):
        self.send({"id": req_id, "method": method, "params": params or {}})
        return self.wait_response(req_id, timeout)

    def wait_response(self, req_id, timeout=10.0):
        deadline = time.time() + timeout
        while time.time() < deadline:
            with self._lock:
                if req_id in self.responses:
                    return self.responses[req_id]
            time.sleep(0.01)
        raise AssertionError("timeout waiting response for %s" % req_id)

    def events_for(self, req_id, method=None):
        with self._lock:
            return [
                e
                for e in self.events
                if e.get("params", {}).get("id") == req_id
                and (method is None or e.get("method") == method)
            ]

    def shutdown(self, timeout=5.0):
        self.send({"method": "shutdown", "params": {}})
        try:
            self.proc.stdin.close()
        except OSError:
            pass
        return self.proc.wait(timeout=timeout)


def main():
    client = EngineClient()
    failures = []

    def check(name, condition, detail=""):
        status = "PASS" if condition else "FAIL"
        print("[%s] %s %s" % (status, name, detail))
        if not condition:
            failures.append(name)

    # 1. ping
    resp = client.request("t1", "ping")
    result = resp.get("result", {})
    check(
        "ping",
        result.get("version") and result.get("engines", {}).get("fake") is True,
        json.dumps(result, ensure_ascii=False),
    )

    # 2. echo(含中文,验证编码)
    resp = client.request("t2", "echo", {"payload": {"msg": "你好 SmartSub"}})
    check("echo", resp.get("result", {}).get("payload", {}).get("msg") == "你好 SmartSub")

    # 3. fake transcribe:结果 + 进度事件 + 分段事件
    resp = client.request(
        "t3", "transcribe", {"engine": "fake", "duration_s": 0.6, "segment_count": 4}, timeout=15
    )
    segments = resp.get("result", {}).get("segments", [])
    progress = [e["params"]["percent"] for e in client.events_for("t3", "progress")]
    check(
        "transcribe.result",
        len(segments) == 4 and segments[0]["text"] == "fake segment 1",
        "segments=%d" % len(segments),
    )
    check(
        "transcribe.progress",
        len(progress) == 4 and progress[-1] == 100 and progress == sorted(progress),
        "progress=%s" % progress,
    )
    check("transcribe.segments.events", len(client.events_for("t3", "segment")) == 4)

    # 4. cancel:长任务取消后应返回 cancelled 错误
    client.send(
        {
            "id": "t4",
            "method": "transcribe",
            "params": {"engine": "fake", "duration_s": 10, "segment_count": 10},
        }
    )
    time.sleep(0.3)
    client.send({"method": "cancel", "params": {"id": "t4"}})
    resp = client.wait_response("t4", timeout=5)
    check("cancel", resp.get("error", {}).get("code") == "cancelled", json.dumps(resp))

    # 5. 错误链路:引擎抛错 → error 响应,进程不死
    resp = client.request("t5", "transcribe", {"engine": "fake", "fail": True})
    check("error.engine", resp.get("error", {}).get("code") == "fake_failure")
    resp = client.request("t6", "transcribe", {"engine": "nope"})
    check("error.unknown_engine", resp.get("error", {}).get("code") == "engine_not_found")
    resp = client.request("t7", "nosuchmethod")
    check("error.unknown_method", resp.get("error", {}).get("code") == "method_not_found")

    # 6. faster_whisper 未安装时的友好错误(若已安装则跳过)
    resp = client.request("t8", "transcribe", {"engine": "faster_whisper"}, timeout=30)
    if "error" in resp:
        check(
            "faster_whisper.graceful",
            resp["error"]["code"] in ("engine_not_installed", "invalid_params"),
            resp["error"]["code"],
        )
    else:
        print("[SKIP] faster_whisper.graceful (faster-whisper 已安装)")

    # 7. shutdown:干净退出
    exit_code = client.shutdown()
    check("shutdown", exit_code == 0, "exit_code=%s" % exit_code)

    print()
    if failures:
        print("FAILED: %s" % ", ".join(failures))
        sys.exit(1)
    print("ALL PASS")


if __name__ == "__main__":
    main()
