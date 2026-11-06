"""Protocol wrapper tests with an isolated fake downloaded runtime; no ML needed."""

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

BOOTSTRAP = (
    Path(__file__).resolve().parents[2] / "extraResources/python-review/bootstrap.py"
)


class BootstrapTests(unittest.TestCase):
    def run_runtime(self, enabled=False, reexec=False):
        with tempfile.TemporaryDirectory(prefix="speech-review-runtime-") as directory:
            root = Path(directory)
            (root / "engines").mkdir()
            (root / "engines/__init__.py").write_text("")
            (root / "engines/faster_whisper_engine.py").write_text("""
def transcribe(params, emit, cancelled):
 emit('progress', {'percent':50})
 return {'language':'en','segments':[{'start':0,'end':1,'text':'original','words':[]}]}
def _get_model(*args):
 raise RuntimeError('injected missing capability')
""")
            (root / "main.py").write_text("""
import json, os, sys
from engines import faster_whisper_engine
if os.environ.get('TEST_REEXEC') == '1':
 os.environ['TEST_REEXEC']='0'
 os.execve(sys.executable, [sys.executable]+sys.argv, os.environ)
def main():
 for line in sys.stdin:
  params=json.loads(line)
  events=[]
  result=faster_whisper_engine.transcribe(params,lambda m,p:events.append([m,p]),lambda:False)
  print(json.dumps({'result':result,'events':events}),flush=True)
""")
            env = {
                **os.environ,
                "TEST_REEXEC": "1" if reexec else "0",
                "PYTHONDONTWRITEBYTECODE": "1",
            }
            p = subprocess.run(
                [sys.executable, str(BOOTSTRAP), str(root / "main.py")],
                input=json.dumps({"speech_review": enabled}) + "\n",
                text=True,
                capture_output=True,
                env=env,
                timeout=10,
            )
            self.assertEqual(p.returncode, 0, p.stderr)
            return json.loads(p.stdout)

    def test_disabled_is_compatible(self):
        result = self.run_runtime()
        self.assertEqual(result["events"][0][1]["percent"], 50)
        self.assertEqual(result["result"]["segments"][0]["text"], "original")

    def test_failure_preserves_original(self):
        result = self.run_runtime(True)
        self.assertEqual(result["events"][0][1]["percent"], 45)
        self.assertEqual(result["result"]["segments"][0]["text"], "original")
        self.assertEqual(result["result"]["speechReview"]["status"], "unavailable")

    def test_cuda_reexec_keeps_wrapper(self):
        result = self.run_runtime(True, True)
        self.assertEqual(result["events"][0][1]["percent"], 45)
        self.assertEqual(result["result"]["speechReview"]["status"], "unavailable")


if __name__ == "__main__":
    unittest.main()
