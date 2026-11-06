"""Opt-in cancellation check against the installed runtime and a local tiny model."""

import argparse, json, os, queue, subprocess, threading, time
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("--runtime", required=True)
parser.add_argument("--model", required=True)
parser.add_argument("--audio", required=True)
args = parser.parse_args()
runtime = Path(args.runtime)
env = {
    **os.environ,
    "PYTHONHOME": str(runtime),
    "PYTHONPATH": str(runtime / "site-packages"),
}
process = subprocess.Popen(
    [
        str(runtime / "bin/python3"),
        str(
            Path(__file__).resolve().parents[2]
            / "extraResources/python-review/bootstrap.py"
        ),
        str(runtime / "main.py"),
    ],
    stdin=subprocess.PIPE,
    stdout=subprocess.PIPE,
    stderr=subprocess.DEVNULL,
    text=True,
    env=env,
)
messages = queue.Queue()


def read():
    for line in process.stdout:
        try:
            messages.put(json.loads(line))
        except ValueError:
            pass


threading.Thread(target=read, daemon=True).start()


def send(message):
    process.stdin.write(json.dumps(message) + "\n")
    process.stdin.flush()


try:
    send(
        {
            "id": "cancel-review",
            "method": "transcribe",
            "params": {
                "engine": "faster_whisper",
                "model": args.model,
                "audio_file": args.audio,
                "device": "cpu",
                "compute_type": "int8",
                "language": "en",
                "word_timestamps": True,
                "speech_review": True,
            },
        }
    )
    deadline = time.monotonic() + 180
    sent = False
    cancelled = False
    while time.monotonic() < deadline:
        m = messages.get(timeout=max(0.1, deadline - time.monotonic()))
        if m.get("method") == "review" and not sent:
            send({"method": "cancel", "params": {"id": "cancel-review"}})
            sent = True
        if m.get("id") == "cancel-review":
            assert sent, m
            assert m.get("error", {}).get("code") == "cancelled", m
            cancelled = True
            break
    assert cancelled, "No cancellation result"
    send({"id": "alive", "method": "ping", "params": {}})
    while True:
        m = messages.get(timeout=10)
        if m.get("id") == "alive":
            assert m.get("result", {}).get("engines", {}).get("faster_whisper"), m
            break
    print("PASS: cancelled during automatic review; same runtime still answers ping")
finally:
    process.terminate()
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait()
