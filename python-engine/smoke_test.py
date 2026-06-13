#!/usr/bin/env python3
"""对冻结产物或 dev main.py 做 ping 冒烟。"""
import json
import subprocess
import sys


def run_smoke(command, args):
    proc = subprocess.Popen(
        [command, *args],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    proc.stdin.write(json.dumps({"id": "1", "method": "ping", "params": {}}) + "\n")
    proc.stdin.flush()
    line = proc.stdout.readline()
    proc.stdin.write(json.dumps({"method": "shutdown", "params": {}}) + "\n")
    proc.stdin.flush()
    proc.wait(timeout=10)
    data = json.loads(line)
    assert "result" in data, data
    assert "engines" in data["result"], data
    print("smoke ok:", data["result"])


if __name__ == "__main__":
    if len(sys.argv) > 1:
        run_smoke(sys.argv[1], sys.argv[2:])
    else:
        run_smoke(sys.executable, ["main.py"])
