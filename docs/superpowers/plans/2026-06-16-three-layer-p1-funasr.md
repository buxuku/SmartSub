# P1 · FunASR / SenseVoice-Small (ONNX) Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add FunASR / SenseVoice-Small (ONNX) as a second downloadable Python ASR engine on top of the P0 three-layer runtime, giving SmartSub a fast, China-friendly, high-accuracy Chinese/Cantonese/Japanese/Korean engine — with multi-engine sidecar switching, per-engine model download, dynamic params, GPU-aware UI, full i18n, plus the two requested cleanups (engine-repo CI old-asset removal and legacy `userData/py-engine` directory removal).

**Architecture:** Reuse the existing sidecar contract (`main.py` JSON-lines dispatcher + `engines/<name>.py` modules). Add `engines/funasr_sensevoice_engine.py` that loads a **pre-exported** FSMN-VAD ONNX + SenseVoice-Small ONNX from local model dirs (no torch/funasr at runtime), runs VAD segmentation → per-segment CTC ASR → SRT segments. Parameterize the build script + CI to emit a second relocatable package `smartsub-funasr-<suffix>.tar.gz`. On the app side, generalize the single-engine Python runtime/downloader to be `engineId`-keyed: the `PythonRuntimeManager` restarts the sidecar with the target engine's `site-packages` on the `PYTHONPATH` whenever the active engine changes; a per-engine `PyEngineDownloader` installs each engine package; a new HF-tree model downloader fetches the SenseVoice + FSMN-VAD ONNX bundles into `userData/models/funasr/`. A new `funasrEngineAdapter` maps unified settings → sidecar params and formats SRT.

**Tech Stack:** Electron + TypeScript (main/renderer), Python 3.12 sidecar, `funasr-onnx` (onnxruntime + kaldi-native-fbank + sentencepiece, **no torch**), `uv` relocatable packaging, `python-build-standalone` base, GitHub Actions matrix CI, HuggingFace-mirror model hosting (`hf-mirror.com`).

---

## Key Decisions (locked by `docs/superpowers/specs/2026-06-16-three-layer-multi-engine-design.md`)

1. **Engine package = `funasr-onnx` only** (runtime path needs no `torch`/`funasr`). Loads pre-exported ONNX from a local dir. Verified via web research.
2. **Models = pre-exported ONNX**, downloaded at runtime (Layer 3):
   - ASR: HF repo `DennisHuang648/SenseVoiceSmall-onnx` (mirror of ModelScope `iic/SenseVoiceSmall-onnx`): `model_quant.onnx` (~230MB INT8), `am.mvn`, `config.yaml`, `tokens.json`, `configuration.json`.
   - VAD: HF repo `funasr/fsmn-vad-onnx`: `model.onnx`, `config.yaml`, `am.mvn`.
   - Download via `hf-mirror.com` (primary, China-fast) → `huggingface.co` (fallback), reusing the proven HF tree+resolve downloader (`download/parallelDownloader.ts`).
3. **Per-engine isolated `site-packages`** (PYTHONPATH). Switching the active engine restarts the sidecar (one cold start). Accepted in spec §4.3.
4. **CPU-first** for SenseVoice (non-autoregressive CTC, fast on CPU). `device='auto'` plumbed through; CUDA/`onnxruntime-gpu` is a later optimization (out of P1 scope) — the param exists but P1 ships CPU.
5. **Audio input**: reuse existing `tempAudioFile` (ffmpeg already produces **16kHz mono PCM s16le WAV** — exactly what FSMN-VAD/SenseVoice want). The Python engine reads it with stdlib `wave` → float32, no extra audio deps.
6. **Cleanups requested by user** ("A 带上"): (a) engine-repo `release.yml` carries only new per-engine asset naming for both engines; (b) app removes the legacy `userData/py-engine` directory (pre-three-layer single-binary layout) on startup.

## Baseline / Conventions

- Two git repos:
  - **ENGINE REPO**: `/Users/xiaodong/code/github.com/buxuku/smartsub-py-engine` (branch `feat/three-layer-p0`).
  - **APP REPO**: `/Users/xiaodong/code/github.com/buxuku/video-subtitle-master` (branch `feat/three-layer-p0`).
- App repo type-check baseline (must not regress): `main/` + `types/` = **104** pre-existing `tsc` errors. After each app task run `npx tsc --noEmit 2>&1 | rg -c "main/|types/"` and confirm it does not exceed baseline for files you touched. Renderer has 184 pre-existing errors unrelated to this work.
- i18n gate: `npm run check-i18n` (or the repo's i18n check) must pass; add zh + en keys together.
- Commit after each task in the relevant repo. Conventional-commit style messages (match existing history).

## File Structure (what each task creates/modifies)

**ENGINE REPO**

- `requirements-funasr.txt` _(new)_ — funasr engine deps.
- `requirements.txt` → rename concept to `requirements-faster-whisper.txt` _(new)_ + keep `requirements.txt` as alias OR make build read per-engine file (Task 1 picks per-engine file).
- `build_engine_package.py` _(modify)_ — accept `engine_id` arg; read `requirements-<engine_id>.txt`; assert the right top package.
- `engines/funasr_sensevoice_engine.py` _(new)_ — VAD+ASR pipeline.
- `engines/__init__.py` _(modify)_ — register `funasr` in `get_engine` + `list_engines`.
- `smoke_test.py` _(modify)_ — `--engine` aware package smoke.
- `.github/workflows/release.yml` _(modify)_ — engine matrix {faster-whisper, funasr} × 4 platforms; manifest `engines` union; cleanup old single-asset naming.
- `README.md` _(modify)_ — document funasr build/asset.
- `scripts/sync-gitcode-release.sh` _(verify)_ — already globs `smartsub-*`; confirm covers funasr.

**APP REPO**

- `types/engine.ts` _(modify)_ — `TranscriptionEngine += 'funasr'`; `PyEngineId += 'funasr'`.
- `main/helpers/pythonRuntime/manager.ts` _(modify)_ — `resolveCommand(engineId)`, `ensureStarted(engineId)`, restart-on-switch.
- `main/helpers/pythonRuntime/index.ts` _(modify)_ — `resolveEngineCommand(engineId)` per-engine command + model env; pass engineId through.
- `main/helpers/pythonRuntime/downloader.ts` _(modify)_ — `PyEngineDownloader` keyed by `engineId`; per-engine state/scratch; registry by engineId.
- `main/helpers/pythonRuntime/autoUpdateCheck.ts` _(modify)_ — accept/iterate engineId.
- `main/helpers/funasrModelCatalog.ts` _(new)_ — funasr model ids, repos, local dirs, installed-check.
- `main/helpers/funasrModelDownloader.ts` _(new)_ — HF-tree multi-file ONNX downloader (mirror fallback).
- `main/helpers/engines/funasrEngine.ts` _(new)_ — adapter (mapParams + transcribe + SRT + cancel + isAvailable).
- `main/helpers/engines/registry.ts` _(modify)_ — register `funasrEngineAdapter`.
- `main/helpers/engines/funasrParams.ts` _(new)_ — funasr param mapping + language map (kept out of the adapter for focus/testability).
- `main/helpers/ipcEngineHandlers.ts` _(modify)_ — engineId-aware download/check/uninstall/status/warmup; funasr settings.
- `main/helpers/ipcModelHandlers.ts` (or wherever model IPC lives) _(modify)_ — funasr model download/list/delete IPC.
- `main/helpers/legacyCleanup.ts` _(new)_ — remove legacy `userData/py-engine`.
- `main/background.ts` _(modify)_ — call legacy cleanup once at startup.
- `renderer/components/resources/EnginesTab.tsx` _(modify)_ — funasr card.
- `renderer/.../ModelsTab` _(modify)_ — funasr models section.
- `locales/zh/*.json` + `locales/en/*.json` _(modify)_ — funasr strings.

---

# PART A — ENGINE REPO (`smartsub-py-engine`)

> All Part A commands run with `working_directory` = `/Users/xiaodong/code/github.com/buxuku/smartsub-py-engine`.

## Task 1: Parameterize the build by engineId + add funasr requirements

**Files:**

- Create: `requirements-faster-whisper.txt`
- Create: `requirements-funasr.txt`
- Modify: `build_engine_package.py`
- Keep: `requirements.txt` (leave as-is; build no longer reads it directly but README references stay valid)

- [ ] **Step 1: Create per-engine requirements files**

`requirements-faster-whisper.txt`:

```
faster-whisper>=1.1.0
```

`requirements-funasr.txt`:

```
funasr-onnx==0.4.1
```

> Note: `funasr-onnx` pulls `onnxruntime`, `kaldi-native-fbank`, `sentencepiece`, `numpy`, `PyYAML`, `scipy`. It does NOT require `torch` for loading pre-exported ONNX. If `uv pip install` resolves `torch`/`funasr` transitively (it should not), Step 4's size assertion will catch it.

- [ ] **Step 2: Rewrite `build_engine_package.py` to take an engine id**

Replace the whole file with:

```python
#!/usr/bin/env python3
"""为指定引擎组装可重定位的依赖包（site-packages）。

用法（需 PATH 上有 uv，且当前解释器即目标 3.12）：
  uv run --python 3.12.10 -- python build_engine_package.py <OUT_DIR> <ENGINE_ID>

ENGINE_ID ∈ {faster-whisper, funasr}；读取 requirements-<ENGINE_ID>.txt。
产物布局（OUT_DIR）：
  main.py, _version.py, engines/, site-packages/<deps...>

main.py/_version.py/engines 对所有引擎相同（同一份 sidecar 源码 + 不同依赖包）。
"""
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent

# 每个引擎产物必须存在的顶层 site-packages 包（构建期断言，防止 requirements 写错）
ENGINE_ASSERT_PKG = {
    "faster-whisper": "faster_whisper",
    "funasr": "funasr_onnx",
}


def run(*args):
    print("+", " ".join(str(a) for a in args))
    subprocess.check_call(list(args))


def adhoc_resign_macos(site: Path):
    """ad-hoc 重签 site-packages 内的 Mach-O 原生库（仅 macOS，无证书兜底）。"""
    if sys.platform != "darwin":
        return
    count = 0
    for path in site.rglob("*"):
        if path.is_file() and path.suffix in (".so", ".dylib"):
            subprocess.run(
                ["codesign", "--force", "--sign", "-", str(path)],
                check=False,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            count += 1
    print(f"ad-hoc resigned {count} mach-o libs")


def main():
    if len(sys.argv) < 3:
        sys.exit("usage: build_engine_package.py <OUT_DIR> <ENGINE_ID>")
    out = Path(sys.argv[1])
    engine_id = sys.argv[2]
    if engine_id not in ENGINE_ASSERT_PKG:
        sys.exit(f"unknown engine id: {engine_id} (expected {list(ENGINE_ASSERT_PKG)})")

    req = ROOT / f"requirements-{engine_id}.txt"
    if not req.is_file():
        sys.exit(f"missing {req}")

    site = out / "site-packages"
    if out.exists():
        shutil.rmtree(out)
    site.mkdir(parents=True)

    # 依赖装进 relocatable 顶层目录，可直接进 PYTHONPATH。--python 锁定 wheel tag 到当前 3.12。
    run(
        "uv", "pip", "install",
        "--python", sys.executable,
        "--target", str(site),
        "-r", str(req),
    )

    # sidecar 源码与依赖分离（所有引擎共用同一份 main.py / engines）
    shutil.copy2(ROOT / "main.py", out / "main.py")
    shutil.copy2(ROOT / "_version.py", out / "_version.py")
    shutil.copytree(ROOT / "engines", out / "engines")

    for p in out.rglob("__pycache__"):
        shutil.rmtree(p, ignore_errors=True)

    adhoc_resign_macos(site)

    assert (out / "main.py").is_file(), "main.py missing in package"
    pkg = ENGINE_ASSERT_PKG[engine_id]
    assert (site / pkg).is_dir(), f"{pkg} missing in site-packages for {engine_id}"
    print(f"package [{engine_id}] assembled at {out}")


if __name__ == "__main__":
    main()
```

- [ ] **Step 3: Build the faster-whisper package locally (regression — old behavior still works)**

Run: `uv run --python 3.12.10 -- python build_engine_package.py dist/faster-whisper faster-whisper`
Expected: ends with `package [faster-whisper] assembled at dist/faster-whisper`; `dist/faster-whisper/site-packages/faster_whisper` exists.

- [ ] **Step 4: Build the funasr package locally + verify it is light (no torch)**

Run: `uv run --python 3.12.10 -- python build_engine_package.py dist/funasr funasr`
Expected: ends with `package [funasr] assembled at dist/funasr`.

Then verify torch is NOT present and check size:

Run: `ls dist/funasr/site-packages | rg -i "torch|^funasr$" || echo "OK: no torch/funasr"`
Expected: prints `OK: no torch/funasr` (only `funasr_onnx`, `onnxruntime`, `kaldi_native_fbank`, `sentencepiece`, `numpy`, `scipy`, `yaml`, etc.)

Run: `du -sh dist/funasr`
Expected: roughly 80–250MB (onnxruntime + scipy dominate). If it shows GBs (torch leaked in), STOP and pin deps in `requirements-funasr.txt` (add `--no-deps`-style explicit pins) before continuing.

- [ ] **Step 5: Commit**

```bash
git add requirements-faster-whisper.txt requirements-funasr.txt build_engine_package.py
git commit -m "build: parameterize engine package build by engineId; add funasr requirements"
```

---

## Task 2: Implement the FunASR / SenseVoice sidecar engine

**Files:**

- Create: `engines/funasr_sensevoice_engine.py`
- Modify: `engines/__init__.py`

**Sidecar contract (already established):** a module exposing `preload(params)` and `transcribe(params, emit_event, is_cancelled)`. `params['engine']` selects it. The app passes local model dirs via params.

**Params the app will send for funasr** (defined here, consumed in Task 9):

- `audio_file`: str (16k mono wav path)
- `asr_model_dir`: str (dir with `model_quant.onnx` + `config.yaml` + `am.mvn` + `tokens.json`)
- `vad_model_dir`: str (dir with `model.onnx` + `config.yaml` + `am.mvn`)
- `language`: one of `auto|zh|en|yue|ja|ko` (default `auto`)
- `use_itn`: bool (default `true`)
- `device`: `auto|cpu|cuda` (default `auto`; P1 maps non-cuda → CPU `device_id=-1`)
- `quantize`: bool (default `true`, loads `model_quant.onnx`)
- `vad_max_segment_ms`: int (default `30000`, SenseVoice single-segment limit)

- [ ] **Step 1: Write `engines/funasr_sensevoice_engine.py`**

```python
"""FunASR / SenseVoice-Small (ONNX) 引擎。

依赖 funasr-onnx（onnxruntime + kaldi-native-fbank + sentencepiece），不依赖 torch。
长音频先用 FSMN-VAD 切分（SenseVoice 单段上限 ~30s），逐段 CTC 识别后合并为 segments。
模型为「预导出 ONNX」，由 App 下载到本地目录后通过 *_model_dir 参数传入；
funasr-onnx 检测到本地已有 model(_quant).onnx 即直接加载，绝不触发 torch 导出。
"""

import logging
import threading
import wave

import numpy as np

from engines import EngineError

log = logging.getLogger(__name__)

_asr_cache = {}
_vad_cache = {}
_load_lock = threading.Lock()

# SmartSub 语言 → SenseVoice 语言标签
_LANG_MAP = {
    "auto": "auto",
    "zh": "zh",
    "yue": "yue",
    "en": "en",
    "ja": "ja",
    "ko": "ko",
}


def _device_id(device):
    """device='cuda' → 0（需 onnxruntime-gpu，P1 默认 CPU）；其余 → -1（CPU）。"""
    return 0 if str(device).lower() == "cuda" else -1


def _read_wav_16k_mono(audio_file):
    """读取 16k 单声道 PCM wav 为 float32 [-1,1]。SmartSub 的 tempAudioFile 即此格式。"""
    with wave.open(audio_file, "rb") as wf:
        n_channels = wf.getnchannels()
        sampwidth = wf.getsampwidth()
        framerate = wf.getframerate()
        frames = wf.readframes(wf.getnframes())
    if sampwidth != 2:
        raise EngineError("invalid_audio", f"expected 16-bit PCM, got {sampwidth*8}-bit")
    audio = np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0
    if n_channels > 1:
        audio = audio.reshape(-1, n_channels).mean(axis=1)
    if framerate != 16000:
        # tempAudioFile 始终 16k；万一不是，做线性重采样兜底（不引第三方依赖）。
        ratio = 16000.0 / float(framerate)
        idx = np.round(np.arange(0, len(audio) * ratio) / ratio).astype(np.int64)
        idx = idx[idx < len(audio)]
        audio = audio[idx]
    return audio


def _load_funasr_onnx():
    try:
        from funasr_onnx import Fsmn_vad, SenseVoiceSmall  # noqa: PLC0415
        from funasr_onnx.utils.postprocess_utils import (  # noqa: PLC0415
            rich_transcription_postprocess,
        )

        return Fsmn_vad, SenseVoiceSmall, rich_transcription_postprocess
    except ImportError as exc:
        raise EngineError(
            "engine_not_installed", "funasr-onnx is not installed: %s" % exc
        )


def _get_vad(vad_model_dir, device):
    key = (vad_model_dir, _device_id(device))
    with _load_lock:
        if key not in _vad_cache:
            Fsmn_vad, _, _ = _load_funasr_onnx()
            log.info("loading FSMN-VAD onnx from %s", vad_model_dir)
            _vad_cache[key] = Fsmn_vad(vad_model_dir, device_id=_device_id(device))
        return _vad_cache[key]


def _get_asr(asr_model_dir, device, quantize):
    key = (asr_model_dir, _device_id(device), bool(quantize))
    with _load_lock:
        if key not in _asr_cache:
            _, SenseVoiceSmall, _ = _load_funasr_onnx()
            log.info(
                "loading SenseVoice onnx from %s (quantize=%s)", asr_model_dir, quantize
            )
            _asr_cache[key] = SenseVoiceSmall(
                asr_model_dir, device_id=_device_id(device), quantize=bool(quantize)
            )
        return _asr_cache[key]


def preload(params):
    """仅加载 VAD + ASR 模型，不转写。"""
    asr_dir = params.get("asr_model_dir")
    vad_dir = params.get("vad_model_dir")
    if not asr_dir or not vad_dir:
        raise EngineError("invalid_params", "asr_model_dir and vad_model_dir are required")
    device = params.get("device", "auto")
    _get_vad(vad_dir, device)
    _get_asr(asr_dir, device, params.get("quantize", True))
    return {"engine": "funasr", "preloaded": True}


def _vad_segments(vad_model, audio):
    """运行 FSMN-VAD，返回 [[start_ms, end_ms], ...]（offline 模式）。"""
    result = vad_model(audio)
    # funasr-onnx 离线 VAD 返回 List[batch] -> List[[start_ms,end_ms]]；单输入取 [0]。
    segs = result[0] if result and isinstance(result[0], list) else result
    out = []
    for seg in segs or []:
        if isinstance(seg, (list, tuple)) and len(seg) >= 2:
            out.append([int(seg[0]), int(seg[1])])
    return out


def transcribe(params, emit_event, is_cancelled):
    audio_file = params.get("audio_file")
    if not audio_file:
        raise EngineError("invalid_params", "audio_file is required")
    asr_dir = params.get("asr_model_dir")
    vad_dir = params.get("vad_model_dir")
    if not asr_dir or not vad_dir:
        raise EngineError("invalid_params", "asr_model_dir and vad_model_dir are required")

    device = params.get("device", "auto")
    quantize = params.get("quantize", True)
    use_itn = bool(params.get("use_itn", True))
    language = _LANG_MAP.get(str(params.get("language", "auto")), "auto")

    _, _, postprocess = _load_funasr_onnx()
    vad_model = _get_vad(vad_dir, device)
    asr_model = _get_asr(asr_dir, device, quantize)

    emit_event("progress", {"percent": 0})
    audio = _read_wav_16k_mono(audio_file)
    total_samples = len(audio) or 1

    segments = vad_segments = _vad_segments(vad_model, audio)
    # VAD 无切分（极短音频或全语音）→ 整段作为一个 segment。
    if not vad_segments:
        vad_segments = [[0, int(len(audio) / 16000 * 1000)]]

    out_segments = []
    for i, (start_ms, end_ms) in enumerate(vad_segments):
        if is_cancelled():
            return None
        start_sample = max(0, int(start_ms / 1000 * 16000))
        end_sample = min(len(audio), int(end_ms / 1000 * 16000))
        if end_sample <= start_sample:
            continue
        clip = audio[start_sample:end_sample]
        try:
            raw = asr_model([clip], language=language, use_itn=use_itn)
        except Exception as exc:  # noqa: BLE001 - 单段失败不应让整文件失败
            log.warning("segment %d asr failed: %s", i, exc)
            continue
        text = postprocess(raw[0]) if raw else ""
        text = (text or "").strip()
        if not text:
            continue
        segment = {"start": start_ms / 1000.0, "end": end_ms / 1000.0, "text": text}
        out_segments.append(segment)
        emit_event("segment", segment)
        emit_event(
            "progress",
            {"percent": round(min(end_sample / total_samples * 100, 99.0), 2)},
        )

    return {
        "engine": "funasr",
        "language": language,
        "segments": out_segments,
    }
```

- [ ] **Step 2: Register funasr in `engines/__init__.py`**

Replace `get_engine` and `list_engines`:

```python
def get_engine(name):
    if name == "faster_whisper":
        from engines import faster_whisper_engine

        return faster_whisper_engine
    if name == "funasr":
        from engines import funasr_sensevoice_engine

        return funasr_sensevoice_engine
    raise EngineError("engine_not_found", "unknown engine: %s" % name)


def list_engines():
    """只探测依赖是否可导入，不真正导入（避免重依赖拖慢 ping）。"""
    return {
        "faster_whisper": importlib.util.find_spec("faster_whisper") is not None,
        "funasr": importlib.util.find_spec("funasr_onnx") is not None,
    }
```

- [ ] **Step 3: Smoke-import the engine module in the funasr package (no model needed)**

Run:

```bash
PY="$(uv python find 3.12.10)"
PYTHONHOME="" PYTHONPATH="dist/funasr/site-packages" "$PY" -c "import sys; sys.path.insert(0,'dist/funasr'); from engines import funasr_sensevoice_engine, list_engines; print(list_engines())"
```

Expected: prints `{'faster_whisper': False, 'funasr': True}` (faster_whisper False because this package only has funasr deps) and no import error.

- [ ] **Step 4: Commit**

```bash
git add engines/funasr_sensevoice_engine.py engines/__init__.py
git commit -m "feat(funasr): add SenseVoice-Small ONNX engine (VAD seg + CTC ASR)"
```

---

## Task 3: Real-model smoke test for funasr (local, gated)

**Files:**

- Modify: `smoke_test.py` (add `--engine` so CI/local can smoke either package)

> The existing `smoke_test.py --package <dir> <python>` does a ping. We extend it to also run a tiny funasr transcription **when model dirs are provided via env**, so it can be skipped on CI (where downloading 230MB is undesirable) but run locally to validate the pipeline end-to-end.

- [ ] **Step 1: Read current `smoke_test.py` and locate the `--package` branch**

Run: `rg -n "package" smoke_test.py`

- [ ] **Step 2: Add a funasr transcription smoke (env-gated) to `smoke_test.py`**

Append a helper and call it from the package-mode branch only when `SMARTSUB_FUNASR_ASR_DIR` and `SMARTSUB_FUNASR_VAD_DIR` env vars are set and `SMARTSUB_FUNASR_WAV` points to a 16k wav:

```python
def _funasr_smoke(py, package_dir):
    import os
    asr_dir = os.environ.get("SMARTSUB_FUNASR_ASR_DIR")
    vad_dir = os.environ.get("SMARTSUB_FUNASR_VAD_DIR")
    wav = os.environ.get("SMARTSUB_FUNASR_WAV")
    if not (asr_dir and vad_dir and wav):
        print("[smoke] funasr transcription skipped (set SMARTSUB_FUNASR_* to enable)")
        return
    req = {
        "id": "s1",
        "method": "transcribe",
        "params": {
            "engine": "funasr",
            "audio_file": wav,
            "asr_model_dir": asr_dir,
            "vad_model_dir": vad_dir,
            "language": "auto",
        },
    }
    import json, subprocess
    env = dict(os.environ)
    env["PYTHONHOME"] = ""
    env["PYTHONPATH"] = os.path.join(package_dir, "site-packages")
    proc = subprocess.run(
        [py, os.path.join(package_dir, "main.py")],
        input=json.dumps(req) + "\n",
        capture_output=True, text=True, env=env, timeout=600,
    )
    assert '"segments"' in proc.stdout, f"funasr smoke failed:\n{proc.stdout}\n{proc.stderr}"
    print("[smoke] funasr transcription OK")
```

Wire `_funasr_smoke(python_exe, package_dir)` into the package-mode path after the ping assertion (guard so it only runs for the funasr package — detect by `os.path.isdir(os.path.join(package_dir, 'site-packages', 'funasr_onnx'))`).

- [ ] **Step 3: Download real models locally for the smoke (one-time, into a scratch dir)**

```bash
mkdir -p /tmp/funasr-models/sensevoice /tmp/funasr-models/fsmn-vad
# ASR (model_quant.onnx + am.mvn + config.yaml + tokens.json + configuration.json)
for f in model_quant.onnx am.mvn config.yaml tokens.json configuration.json; do
  curl -fL "https://hf-mirror.com/DennisHuang648/SenseVoiceSmall-onnx/resolve/main/$f" -o "/tmp/funasr-models/sensevoice/$f"
done
# VAD (model.onnx + config.yaml + am.mvn)
for f in model.onnx config.yaml am.mvn; do
  curl -fL "https://hf-mirror.com/funasr/fsmn-vad-onnx/resolve/main/$f" -o "/tmp/funasr-models/fsmn-vad/$f"
done
ls -lh /tmp/funasr-models/sensevoice /tmp/funasr-models/fsmn-vad
```

Expected: `model_quant.onnx` ~230MB, `model.onnx` (vad) ~1–2MB; all files non-empty.

> If `funasr-onnx`'s `SenseVoiceSmall` errors that `chn_jpn_yue_eng_ko_spectok.bpe.model` is missing, also fetch it from the base repo: `curl -fL "https://hf-mirror.com/FunAudioLLM/SenseVoiceSmall/resolve/main/chn_jpn_yue_eng_ko_spectok.bpe.model" -o /tmp/funasr-models/sensevoice/chn_jpn_yue_eng_ko_spectok.bpe.model` and add this filename to the app's download list in Task 8.

- [ ] **Step 4: Create a 16k mono test wav (5–10s of speech) and run the smoke**

If you have a sample video/audio, extract 16k mono:

```bash
ffmpeg -y -i <any-audio-with-speech> -ar 16000 -ac 1 -c:a pcm_s16le /tmp/funasr-test.wav
```

Run the smoke:

```bash
PY="$(uv python find 3.12.10)"
SMARTSUB_FUNASR_ASR_DIR=/tmp/funasr-models/sensevoice \
SMARTSUB_FUNASR_VAD_DIR=/tmp/funasr-models/fsmn-vad \
SMARTSUB_FUNASR_WAV=/tmp/funasr-test.wav \
"$PY" smoke_test.py --package dist/funasr "$PY"
```

Expected: `[smoke] funasr transcription OK` and recognizable transcript text in stderr logs.

> This step is the **critical validation** that funasr-onnx loads pre-exported ONNX without torch and the VAD→ASR pipeline works. If it fails on a missing model file, fix the download list (Step 3 note) and rerun before moving on.

- [ ] **Step 5: Commit**

```bash
git add smoke_test.py
git commit -m "test(funasr): env-gated package transcription smoke"
```

---

## Task 4: CI — build both engines × 4 platforms; manifest union; cleanups

**Files:**

- Modify: `.github/workflows/release.yml`
- Modify: `README.md`
- Verify: `scripts/sync-gitcode-release.sh`, `scripts/sync-gitcode-from-github.sh`

> Current `release.yml` builds one engine (`ENGINE_ID: faster-whisper`) across 4 platforms and writes `manifest.json` with `engines: ["faster_whisper"]`. We turn the platform matrix into a **platform × engine** matrix, build both packages, and union the engines list. **Cleanup**: the manifest's hardcoded `engines: ["faster_whisper"]` and the single `ENGINE_ID` env are removed in favor of per-engine values.

- [ ] **Step 1: Replace the `build_engine` job's matrix (explicit engine × platform cross-product)**

In `.github/workflows/release.yml`, remove the top-level `env.ENGINE_ID`, keep `env.PYTHON_VERSION`, and use a two-axis matrix (`engine_id` × `target`) so each {engine, platform} pair is one job:

```yaml
env:
  PYTHON_VERSION: '3.12.10'

jobs:
  build_engine:
    name: ${{ matrix.engine_id }} ${{ matrix.target.artifact_suffix }}
    runs-on: ${{ matrix.target.os }}
    strategy:
      fail-fast: false
      matrix:
        engine_id: [faster-whisper, funasr]
        target:
          - { os: macos-latest, artifact_suffix: macos-arm64 }
          - { os: macos-15-intel, artifact_suffix: macos-x64 }
          - { os: windows-2022, artifact_suffix: windows-x64 }
          - { os: ubuntu-22.04, artifact_suffix: linux-x64 }
```

This yields 8 jobs (2 engines × 4 platforms).

- [ ] **Step 2: Update build/smoke/archive/upload steps to use `matrix.engine_id` + `matrix.target.artifact_suffix`**

```yaml
- name: Build relocatable engine package
  run: uv run --python ${{ env.PYTHON_VERSION }} -- python build_engine_package.py dist/package ${{ matrix.engine_id }}

- name: Smoke test (package mode)
  shell: bash
  run: |
    PY="$(uv python find ${PYTHON_VERSION})"
    "$PY" smoke_test.py --package dist/package "$PY"

- name: Archive (contents at top level, no wrapper dir)
  shell: bash
  run: tar -czf smartsub-${{ matrix.engine_id }}-${{ matrix.target.artifact_suffix }}.tar.gz -C dist/package .

- uses: actions/upload-artifact@v4
  with:
    name: py-engine-${{ matrix.engine_id }}-${{ matrix.target.artifact_suffix }}
    path: smartsub-${{ matrix.engine_id }}-${{ matrix.target.artifact_suffix }}.tar.gz
    if-no-files-found: error
```

- [ ] **Step 3: Update `publish_latest` manifest generation to enumerate both engines**

Replace the manifest python heredoc so artifacts + per-engine engines are derived from the files present. Pass the engine list and per-engine→sidecar-name map:

```yaml
- name: Generate checksums and manifest
  shell: bash
  env:
    PYTHON_VERSION: ${{ env.PYTHON_VERSION }}
  run: |
    cd artifacts
    sha256sum smartsub-*.tar.gz > checksums.sha256
    cat checksums.sha256
    ENGINE_VERSION=$(python3 -c "import sys; sys.path.insert(0,'../src'); import _version; print(_version.ENGINE_VERSION)")
    PROTOCOL_VERSION=$(python3 -c "import sys; sys.path.insert(0,'../src'); import _version; print(_version.PROTOCOL_VERSION)")
    BUILT_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    GIT_SHA=$(echo "${GITHUB_SHA}" | cut -c1-7)
    python3 - "$ENGINE_VERSION" "$PROTOCOL_VERSION" "$BUILT_AT" "$GIT_SHA" "$PYTHON_VERSION" <<'PY'
    import json, os, sys, hashlib
    engine_version, protocol_version, built_at, git_sha, python_version = sys.argv[1:6]
    # engineId -> sidecar engine key (list_engines 名)
    engine_sidecar = {"faster-whisper": "faster_whisper", "funasr": "funasr"}
    suffixes = ["windows-x64", "macos-arm64", "macos-x64", "linux-x64"]
    per_engine = {}
    engines_present = []
    for eid, sidecar in engine_sidecar.items():
        arts = {}
        for suf in suffixes:
            fname = f"smartsub-{eid}-{suf}.tar.gz"
            if not os.path.exists(fname):
                continue
            data = open(fname, "rb").read()
            arts[suf] = {"sizeBytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}
        if arts:
            per_engine[eid] = arts
            engines_present.append(sidecar)
    manifest = {
        "engineVersion": engine_version,
        "protocolVersion": int(protocol_version),
        "pythonVersion": python_version,
        "pythonAbi": "cp312",
        "builtAt": built_at,
        "gitSha": git_sha,
        "engines": engines_present,
        # 兼容旧字段：顶层 artifacts 给 faster-whisper（保持 P0 读取路径不破）
        "artifacts": per_engine.get("faster-whisper", {}),
        # 新增：按引擎分桶，供 App 多引擎下载读取
        "enginePackages": {
            eid: {"engineId": eid, "sidecar": engine_sidecar[eid], "artifacts": arts}
            for eid, arts in per_engine.items()
        },
    }
    json.dump(manifest, open("manifest.json", "w"), indent=2)
    print(json.dumps(manifest, indent=2))
    PY
```

- [ ] **Step 4: Verify gitcode sync scripts cover both engines**

Run: `rg -n "smartsub-" scripts/sync-gitcode-release.sh scripts/sync-gitcode-from-github.sh`
Expected: they reference `smartsub-*` globs (covers both engines). If any hardcodes `smartsub-faster-whisper-*`, broaden to `smartsub-*`. Make the edit if needed.

- [ ] **Step 5: Update README**

In `README.md`, document: build command now takes an engine id (`build_engine_package.py <out> <faster-whisper|funasr>`), assets are `smartsub-<engineId>-<suffix>.tar.gz`, and the manifest carries `enginePackages`.

- [ ] **Step 6: Commit + push (triggers CI on `main`; on `feat/three-layer-p0` it builds via workflow_dispatch only)**

```bash
git add .github/workflows/release.yml README.md scripts/sync-gitcode-release.sh scripts/sync-gitcode-from-github.sh
git commit -m "ci: build faster-whisper + funasr packages; manifest enginePackages; per-engine assets"
```

> Push timing: push when ready to publish a release that the app can download. The app tasks below can be developed against the locally-built `dist/funasr` package (copied into userData, see Task 12) without waiting for CI.

---

# PART B — APP REPO (`video-subtitle-master`)

> All Part B commands run with `working_directory` = `/Users/xiaodong/code/github.com/buxuku/video-subtitle-master`.

## Task 5: Extend engine types

**Files:**

- Modify: `types/engine.ts:1`, `types/engine.ts:51`

- [ ] **Step 1: Add `funasr` to the engine unions**

In `types/engine.ts`, change line 1:

```typescript
export type TranscriptionEngine =
  | 'builtin'
  | 'fasterWhisper'
  | 'funasr'
  | 'localCli';
```

And change the `PyEngineId` definition (currently line ~51):

```typescript
/** 可独立下载的 Python 引擎包标识（与引擎仓产物 engineId 一一对应）。 */
export type PyEngineId = 'faster-whisper' | 'funasr';
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit 2>&1 | rg -c "main/|types/"`
Expected: ≤ 104 (baseline). Adding a union member may surface a few `switch`/record exhaustiveness errors in files we will touch in later tasks; if any new error appears in a file NOT in this plan, note it and address in the relevant later task.

- [ ] **Step 3: Commit**

```bash
git add types/engine.ts
git commit -m "feat(types): add 'funasr' to TranscriptionEngine and PyEngineId"
```

---

## Task 6: Multi-engine Python runtime (restart-on-switch)

**Files:**

- Modify: `main/helpers/pythonRuntime/manager.ts` (constructor, `ensureStarted`, `start`, add `currentEngineId`)
- Modify: `main/helpers/pythonRuntime/index.ts` (`resolveEngineCommand(engineId)`, pass engineId through manager)

**Behavior:** The singleton manager tracks which engineId the running sidecar serves. `ensureStarted(engineId)` returns the cached ping iff the running engine matches; otherwise it stops the current sidecar and starts a new one with that engine's `site-packages` on `PYTHONPATH`.

- [ ] **Step 1: Change `PythonRuntimeManager` to be engineId-aware (`manager.ts`)**

Replace the constructor field + `ensureStarted` + `start` signature:

```typescript
import type { PyEngineId } from '../../../types/engine';

// ...inside the class, replace the resolveCommand field type and add currentEngineId:
export class PythonRuntimeManager {
  private resolveCommand: (engineId: PyEngineId) => EngineCommand;
  private currentEngineId: PyEngineId | null = null;
  // ...rest unchanged...

  constructor(
    resolveCommand: (engineId: PyEngineId) => EngineCommand,
    logger?: EngineLogger,
  ) {
    this.resolveCommand = resolveCommand;
    this.logger = logger || (() => {});
  }

  get activeEngineId(): PyEngineId | null {
    return this.currentEngineId;
  }

  async ensureStarted(engineId: PyEngineId = 'faster-whisper'): Promise<PingResult> {
    // 已在跑且就是目标引擎 → 直接复用缓存 ping。
    if (this.proc && this.lastPingInfo && this.currentEngineId === engineId) {
      return this.lastPingInfo;
    }
    // 在跑但引擎不同 → 切换：停旧 sidecar，换 PYTHONPATH 重启。
    if (this.proc && this.currentEngineId !== engineId) {
      this.logger(
        `Switching python engine ${this.currentEngineId} -> ${engineId}; restarting sidecar`,
        'info',
      );
      await this.stop();
    }
    if (!this.startingPromise) {
      const target = engineId;
      this.startingPromise = this.start(target).finally(() => {
        this.startingPromise = null;
      });
    }
    return this.startingPromise;
  }

  private async start(engineId: PyEngineId): Promise<PingResult> {
    this.currentEngineId = engineId;
    // ...existing body, but call this.resolveCommand(engineId) instead of this.resolveCommand()...
  }
```

Inside `start`, change the single call site:

```typescript
    const attempt = async (): Promise<PingResult> => {
      const cmd = this.resolveCommand(engineId);
      // ...unchanged...
```

Also in `handleExit`, clear `currentEngineId`:

```typescript
  private handleExit(reason: string): void {
    if (!this.proc) return;
    this.proc = null;
    this.lastPingInfo = null;
    this.currentEngineId = null;
    // ...unchanged...
```

- [ ] **Step 2: Update `index.ts` `resolveEngineCommand` to take engineId + per-engine model env**

Replace `resolveEngineCommand` and the manager construction:

```typescript
import path from 'path';
import { logMessage } from '../storeManager';
import { getFasterWhisperModelsPath } from '../modelCatalog';
import { getFunasrModelsRoot } from '../funasrModelCatalog';
import { PythonRuntimeManager, type EngineCommand } from './manager';
import {
  resolvePyBaseDir,
  getPyBasePythonPath,
  isPyBaseReady,
  getEngineDir,
  getEngineMainPy,
  getEngineSitePackages,
  isEnginePackageInstalled,
} from './paths';
import type { PyEngineId } from '../../../types/engine';

export * from './protocol';
export { PythonRuntimeManager, PythonEngineError } from './manager';

const NOT_READY_MSG =
  'Python engine not ready. Ensure the base runtime is bundled and the engine package is downloaded (Resource Hub > Engines), or set PYTHON_ENGINE_CMD for local development.';

function resolveEngineCommand(engineId: PyEngineId): EngineCommand {
  const override = process.env.PYTHON_ENGINE_CMD;
  if (override) {
    const parts = override.split(' ').filter(Boolean);
    return { command: parts[0], args: parts.slice(1) };
  }

  if (!isPyBaseReady() || !isEnginePackageInstalled(engineId)) {
    throw new Error(NOT_READY_MSG);
  }

  const baseDir = resolvePyBaseDir();
  // 模型缓存环境按引擎分桶；funasr 用本地 onnx 目录，不依赖 HF_HOME，但仍设隔离缓存目录。
  const env: Record<string, string> =
    engineId === 'faster-whisper'
      ? {
          HF_HOME: getFasterWhisperModelsPath(),
          HF_HUB_CACHE: path.join(getFasterWhisperModelsPath(), 'hub'),
        }
      : {
          HF_HOME: getFunasrModelsRoot(),
          MODELSCOPE_CACHE: path.join(getFunasrModelsRoot(), '.modelscope'),
        };

  return {
    command: getPyBasePythonPath(baseDir),
    args: [getEngineMainPy(engineId)],
    cwd: getEngineDir(engineId),
    pythonHome: baseDir,
    pythonPath: getEngineSitePackages(engineId),
    env,
  };
}

let manager: PythonRuntimeManager | null = null;

export function getPythonRuntimeManager(): PythonRuntimeManager {
  if (!manager) {
    manager = new PythonRuntimeManager(resolveEngineCommand, (msg, level) =>
      logMessage(msg, level),
    );
  }
  return manager;
}

export async function shutdownPythonRuntime(): Promise<void> {
  if (manager) {
    await manager.stop();
    manager = null;
  }
}
```

> `getFunasrModelsRoot` is defined in Task 8. Implement Task 8 before type-checking this file, or stub it temporarily. To keep tasks independently committable, do Task 8's `funasrModelCatalog.ts` creation FIRST if you hit a missing-import error here — see ordering note below.

**Ordering note:** Task 8 creates `funasrModelCatalog.ts`. Either reorder (do Task 8 Step 1 before Task 6 Step 2) or add the import after Task 8. Recommended: create `funasrModelCatalog.ts` (Task 8 Step 1) now, then continue.

- [ ] **Step 3: Update the faster-whisper adapter call site to pass engineId**

In `main/helpers/engines/fasterWhisperEngine.ts`, the `manager.ensureStarted()` call (line ~70) becomes `manager.ensureStarted('faster-whisper')`:

```typescript
engineInfo = await manager.ensureStarted('faster-whisper');
```

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit 2>&1 | rg -n "pythonRuntime/(manager|index)\.ts|engines/fasterWhisperEngine\.ts"`
Expected: no errors in these files (assuming `funasrModelCatalog.ts` exists from Task 8 Step 1).

- [ ] **Step 5: Commit**

```bash
git add main/helpers/pythonRuntime/manager.ts main/helpers/pythonRuntime/index.ts main/helpers/engines/fasterWhisperEngine.ts
git commit -m "feat(runtime): engineId-aware sidecar with restart-on-switch"
```

---

## Task 7: Parameterize the engine-package downloader by engineId

**Files:**

- Modify: `main/helpers/pythonRuntime/downloader.ts` (remove module-level `ENGINE_ID`; key everything by an instance `engineId`; registry by engineId)
- Modify: `main/helpers/pythonRuntime/autoUpdateCheck.ts` (iterate installed engines)

- [ ] **Step 1: Make `PyEngineDownloader` carry an `engineId` and key all paths/state by it**

In `downloader.ts`:

1. Remove `const ENGINE_ID: PyEngineId = 'faster-whisper';`.
2. Change the scratch/state helpers to take an engineId:

```typescript
function getDownloadStatePath(engineId: PyEngineId): string {
  return path.join(
    app.getPath('userData'),
    `py-engine-download-state-${engineId}.json`,
  );
}

function getPyEngineScratchRoot(): string {
  return path.join(getPyEnginesRoot(), '.cache');
}
function getPyEngineDownloadsDir(): string {
  return path.join(getPyEngineScratchRoot(), 'downloads');
}
function getPyEngineStagingDir(engineId: PyEngineId): string {
  return path.join(getPyEngineScratchRoot(), 'staging', engineId);
}
function getPyEnginePreviousDir(engineId: PyEngineId): string {
  return path.join(getPyEngineScratchRoot(), 'previous', engineId);
}
function getTempTarPath(engineId: PyEngineId): string {
  return path.join(getPyEngineDownloadsDir(), `${engineId}.tar.gz`);
}
function getArtifactFileName(engineId: PyEngineId): string {
  return getEngineArtifactName(engineId);
}
```

3. Update `readDownloadState`/`saveDownloadState` to take `engineId` and call `getDownloadStatePath(engineId)`.

4. Add `private engineId: PyEngineId;` to the class; set it in the constructor:

```typescript
  constructor(engineId: PyEngineId, mainWindow?: BrowserWindow) {
    this.engineId = engineId;
    this.mainWindow = mainWindow || null;
    this.core = new MirrorDownloader((p) => {
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send('py-engine-download-progress', {
          ...(p as PyEngineDownloadProgress),
          engineId: this.engineId,
        });
      }
    });
  }
```

5. Replace every `ENGINE_ID` usage in the class methods with `this.engineId`, and every state/scratch call with the engineId variant. Specifically:

   - `downloadFromSource`: `getEngineDownloadUrl(source, this.engineId, resolvedTag)`, `getTempTarPath(this.engineId)`, `readDownloadState(this.engineId)`, `saveDownloadState(..., this.engineId)`.
   - `checkUpdate`: `readEngineManifest(this.engineId)`, `isEnginePackageInstalled(this.engineId)`, `getArtifactFileName(this.engineId)`.
   - `buildLocalManifest`: `engineId: this.engineId`.
   - `verifyExtractAndInstall`: `getArtifactFileName(this.engineId)`, `getPyEngineStagingDir(this.engineId)`.
   - `installFromStaging`: `getEngineDir(this.engineId)`, `getPyEnginePreviousDir(this.engineId)`, `writeEngineManifest(..., this.engineId)`, and self-check `getPythonRuntimeManager().ensureStarted(this.engineId)`.
   - `rollback`: `getEngineDir(this.engineId)`, `getPyEnginePreviousDir(this.engineId)`, `ensureStarted(this.engineId)`.

6. Replace the singleton factory with a per-engine registry:

```typescript
const downloaderInstances = new Map<PyEngineId, PyEngineDownloader>();

export function getPyEngineDownloader(
  engineId: PyEngineId = 'faster-whisper',
  mainWindow?: BrowserWindow,
): PyEngineDownloader {
  let inst = downloaderInstances.get(engineId);
  if (!inst) {
    inst = new PyEngineDownloader(engineId, mainWindow);
    downloaderInstances.set(engineId, inst);
  } else if (mainWindow) {
    inst.setMainWindow(mainWindow);
  }
  return inst;
}
```

> **Compat for existing callers:** `getPyEngineDownloader(mainWindow)` was called with a window in `ipcEngineHandlers.setMainWindowForEngine`. Update those call sites in Task 9. The default `engineId='faster-whisper'` keeps `checkUpdate`/`cancel`/`getProgress` calls that pass no engine working for faster-whisper, but Task 9 makes IPC pass engineId explicitly.

- [ ] **Step 2: Add `engineId` to the progress payload type**

In `types/engine.ts`, extend `PyEngineDownloadProgress`:

```typescript
export interface PyEngineDownloadProgress {
  status:
    | 'idle'
    | 'downloading'
    | 'extracting'
    | 'verifying'
    | 'completed'
    | 'error';
  progress: number;
  downloaded: number;
  total: number;
  speed: number;
  eta: number;
  error?: string;
  engineId?: PyEngineId;
}
```

- [ ] **Step 3: Update `autoUpdateCheck.ts` to consider both engines**

Run: `rg -n "isEnginePackageInstalled|getPyEngineDownloader|faster-whisper" main/helpers/pythonRuntime/autoUpdateCheck.ts`

Change the daily check to iterate installed engines:

```typescript
import type { PyEngineId } from '../../../types/engine';
const MANAGED_ENGINES: PyEngineId[] = ['faster-whisper', 'funasr'];

// inside maybeAutoCheckPyEngineUpdate (or equivalent), replace the single-engine
// installed check + checkUpdate with a loop:
for (const engineId of MANAGED_ENGINES) {
  if (!isEnginePackageInstalled(engineId)) continue;
  try {
    const info = await getPyEngineDownloader(engineId).checkUpdate(source);
    // ...existing per-engine notify logic, including engineId in any emitted event...
  } catch (e) {
    logMessage(`auto update check failed for ${engineId}: ${e}`, 'warning');
  }
}
```

> Read the actual file first; keep its existing notification shape, just add the loop + engineId. If it emits an IPC event for "update available", include `engineId` in the payload.

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit 2>&1 | rg -n "pythonRuntime/(downloader|autoUpdateCheck)\.ts"`
Expected: no errors in these files.

- [ ] **Step 5: Commit**

```bash
git add main/helpers/pythonRuntime/downloader.ts main/helpers/pythonRuntime/autoUpdateCheck.ts types/engine.ts
git commit -m "feat(downloader): key engine-package install/update by engineId"
```

---

## Task 8: FunASR model catalog + ONNX model downloader + model IPC

**Files:**

- Create: `main/helpers/funasrModelCatalog.ts`
- Create: `main/helpers/funasrModelDownloader.ts`
- Modify: model IPC registration file (find it in Step 5)

**Model layout (userData):**

```
userData/models/funasr/
  sensevoice-small/   # model_quant.onnx, am.mvn, config.yaml, tokens.json, configuration.json
  fsmn-vad/           # model.onnx, config.yaml, am.mvn
```

- [ ] **Step 1: Create `funasrModelCatalog.ts`**

```typescript
import path from 'path';
import fs from 'fs';
import { app } from 'electron';

/** funasr 模型根目录：userData/models/funasr */
export function getFunasrModelsRoot(): string {
  const root = path.join(app.getPath('userData'), 'models', 'funasr');
  if (!fs.existsSync(root)) fs.mkdirSync(root, { recursive: true });
  return root;
}

/** funasr 子模型标识（与本地子目录一一对应）。 */
export type FunasrModelId = 'sensevoice-small' | 'fsmn-vad';

export interface FunasrModelSpec {
  id: FunasrModelId;
  /** HF（镜像）仓库 id */
  repo: string;
  /** 本地子目录名 */
  dirName: string;
  /** 判定「已安装」必须存在的关键文件 */
  requiredFiles: string[];
}

export const FUNASR_MODELS: Record<FunasrModelId, FunasrModelSpec> = {
  'sensevoice-small': {
    id: 'sensevoice-small',
    repo: 'DennisHuang648/SenseVoiceSmall-onnx',
    dirName: 'sensevoice-small',
    requiredFiles: ['model_quant.onnx', 'am.mvn', 'config.yaml', 'tokens.json'],
  },
  'fsmn-vad': {
    id: 'fsmn-vad',
    repo: 'funasr/fsmn-vad-onnx',
    dirName: 'fsmn-vad',
    requiredFiles: ['model.onnx', 'config.yaml', 'am.mvn'],
  },
};

export function getFunasrModelDir(id: FunasrModelId): string {
  const dir = path.join(getFunasrModelsRoot(), FUNASR_MODELS[id].dirName);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function isFunasrModelInstalled(id: FunasrModelId): boolean {
  const dir = path.join(getFunasrModelsRoot(), FUNASR_MODELS[id].dirName);
  return FUNASR_MODELS[id].requiredFiles.every((f) =>
    fs.existsSync(path.join(dir, f)),
  );
}

/** funasr 转写就绪 = ASR + VAD 两个模型都已安装。 */
export function isFunasrReady(): boolean {
  return (
    isFunasrModelInstalled('sensevoice-small') &&
    isFunasrModelInstalled('fsmn-vad')
  );
}

export function deleteFunasrModel(id: FunasrModelId): void {
  const dir = path.join(getFunasrModelsRoot(), FUNASR_MODELS[id].dirName);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}
```

- [ ] **Step 2: Create `funasrModelDownloader.ts` (HF-tree multi-file, mirror fallback)**

This mirrors `fasterWhisperModelDownloader.ts`'s proven HF tree+resolve + `downloadFileParallel` approach, but downloads a whole repo's files into a flat model dir.

```typescript
import { BrowserWindow } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import * as http from 'http';
import { logMessage } from './storeManager';
import type { ModelDownloadProgress } from './modelDownloader';
import {
  FUNASR_MODELS,
  FunasrModelId,
  getFunasrModelDir,
  isFunasrModelInstalled,
} from './funasrModelCatalog';
import {
  downloadFileParallel,
  RangeNotSupportedError,
} from './download/parallelDownloader';

interface HfTreeEntry {
  path: string;
  type: 'file' | 'directory';
  size?: number;
}

const CONNECT_TIMEOUT = 30_000;

/** 进度 key：funasr:<modelId>，与 ct2:<id> 同构，渲染层按前缀路由。 */
export function getFunasrProgressKey(id: FunasrModelId): string {
  return `funasr:${id}`;
}

/** 镜像优先：hf-mirror.com（国内快）→ huggingface.co。 */
function getHosts(source?: string): string[] {
  if (source === 'huggingface') return ['huggingface.co', 'hf-mirror.com'];
  return ['hf-mirror.com', 'huggingface.co'];
}

function resolveRedirectUrl(currentUrl: string, location: string): string {
  return new URL(location, currentUrl).href;
}

function fetchJson<T>(url: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const protocol = parsed.protocol === 'https:' ? https : http;
    const request = protocol.get(
      url,
      { headers: { 'User-Agent': 'SmartSub-Electron' } },
      (response) => {
        if (
          response.statusCode &&
          response.statusCode >= 300 &&
          response.statusCode < 400 &&
          response.headers.location
        ) {
          fetchJson<T>(resolveRedirectUrl(url, response.headers.location))
            .then(resolve)
            .catch(reject);
          return;
        }
        if (!response.statusCode || response.statusCode >= 400) {
          reject(new Error(`HTTP Error: ${response.statusCode}`));
          return;
        }
        const chunks: Buffer[] = [];
        response.on('data', (c) => chunks.push(c));
        response.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as T);
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    request.on('error', reject);
    request.setTimeout(CONNECT_TIMEOUT);
  });
}

export class FunasrModelDownloader {
  private abortController: AbortController | null = null;
  private mainWindow: BrowserWindow | null = null;
  private currentKey: string | null = null;
  private progress: ModelDownloadProgress = {
    status: 'idle',
    progress: 0,
    downloaded: 0,
    total: 0,
    speed: 0,
    eta: 0,
  };

  constructor(mainWindow?: BrowserWindow) {
    this.mainWindow = mainWindow || null;
  }

  setMainWindow(window: BrowserWindow): void {
    this.mainWindow = window;
  }

  cancel(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    this.progress = { ...this.progress, status: 'idle' };
    this.currentKey = null;
  }

  private send(): void {
    if (this.mainWindow && !this.mainWindow.isDestroyed() && this.currentKey) {
      const ratio =
        this.progress.total > 0
          ? this.progress.downloaded / this.progress.total
          : 0;
      this.mainWindow.webContents.send(
        'downloadProgress',
        this.currentKey,
        Math.min(ratio, 0.99),
      );
      this.mainWindow.webContents.send(
        'modelDownloadDetail',
        this.currentKey,
        this.progress,
      );
    }
  }

  private update(p: Partial<ModelDownloadProgress>): void {
    this.progress = { ...this.progress, ...p };
    if (this.progress.total > 0) {
      this.progress.progress =
        (this.progress.downloaded / this.progress.total) * 100;
    }
    this.send();
  }

  async download(id: FunasrModelId, source?: string): Promise<boolean> {
    if (isFunasrModelInstalled(id)) return true;
    const spec = FUNASR_MODELS[id];
    const destDir = getFunasrModelDir(id);
    const key = getFunasrProgressKey(id);
    this.currentKey = key;
    this.abortController = new AbortController();

    let lastError: unknown = null;
    for (const host of getHosts(source)) {
      try {
        const info = await fetchJson<{ sha?: string }>(
          `https://${host}/api/models/${spec.repo}`,
        );
        const revision = info.sha || 'main';
        const tree = await fetchJson<HfTreeEntry[]>(
          `https://${host}/api/models/${spec.repo}/tree/${revision}?recursive=true`,
        );
        const files = tree.filter(
          (e) =>
            e.type === 'file' &&
            e.path &&
            !e.path.startsWith('.') &&
            (e.size ?? 0) > 0,
        );
        if (files.length === 0) throw new Error('empty tree');

        const total = files.reduce((s, f) => s + (f.size ?? 0), 0);
        let downloaded = 0;
        this.update({
          status: 'downloading',
          downloaded: 0,
          total,
          progress: 0,
          error: undefined,
        });

        for (const f of files) {
          const dest = path.join(destDir, f.path);
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          if (
            fs.existsSync(dest) &&
            fs.statSync(dest).size === (f.size ?? -1)
          ) {
            downloaded += f.size ?? 0;
            this.update({ downloaded });
            continue;
          }
          const url = `https://${host}/${spec.repo}/resolve/${revision}/${f.path}`;
          try {
            await downloadFileParallel({
              url,
              destPath: dest,
              signal: this.abortController?.signal,
              headers: { 'User-Agent': 'SmartSub-Electron' },
              onProgress: (thisFile) =>
                this.update({ downloaded: downloaded + thisFile, total }),
              log: (m, l) => logMessage(m, l),
            });
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            if (msg === 'Download cancelled') throw error;
            if (error instanceof RangeNotSupportedError) {
              await this.downloadSingle(
                url,
                dest,
                this.abortController?.signal,
              );
            } else {
              throw error;
            }
          }
          downloaded += f.size ?? 0;
          this.update({ downloaded });
        }

        // 全部下完后校验关键文件齐全。
        if (!isFunasrModelInstalled(id)) {
          throw new Error(
            `download finished but required files missing for ${id}: ${spec.requiredFiles.join(', ')}`,
          );
        }
        this.progress = {
          ...this.progress,
          status: 'completed',
          progress: 100,
          downloaded: total,
          total,
        };
        this.sendFinal(key, 1);
        this.currentKey = null;
        logMessage(`funasr model ${id} downloaded from ${host}`, 'info');
        return true;
      } catch (error) {
        lastError = error;
        const msg = error instanceof Error ? error.message : String(error);
        if (msg === 'Download cancelled') {
          this.progress = { ...this.progress, status: 'idle' };
          this.sendFinal(key, 1);
          this.currentKey = null;
          throw error;
        }
        logMessage(`funasr model ${id} from ${host} failed: ${msg}`, 'warning');
      }
    }
    this.progress = {
      ...this.progress,
      status: 'error',
      error: lastError instanceof Error ? lastError.message : String(lastError),
    };
    this.sendFinal(key, 0);
    this.currentKey = null;
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private sendFinal(key: string, value: number): void {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send('downloadProgress', key, value);
      this.mainWindow.webContents.send(
        'modelDownloadDetail',
        key,
        this.progress,
      );
    }
  }

  private downloadSingle(
    url: string,
    destPath: string,
    signal?: AbortSignal,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const parsed = new URL(url);
      const protocol = parsed.protocol === 'https:' ? https : http;
      const onAbort = () => {
        req.destroy();
        reject(new Error('Download cancelled'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      const req = protocol.get(
        url,
        { headers: { 'User-Agent': 'SmartSub-Electron' } },
        (response) => {
          if (
            response.statusCode &&
            response.statusCode >= 300 &&
            response.statusCode < 400 &&
            response.headers.location
          ) {
            signal?.removeEventListener('abort', onAbort);
            this.downloadSingle(
              resolveRedirectUrl(url, response.headers.location),
              destPath,
              signal,
            )
              .then(resolve)
              .catch(reject);
            return;
          }
          if (!response.statusCode || response.statusCode >= 400) {
            reject(new Error(`HTTP Error: ${response.statusCode}`));
            return;
          }
          const out = fs.createWriteStream(destPath, { flags: 'w' });
          response.pipe(out);
          out.on('finish', () => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
          });
          out.on('error', reject);
        },
      );
      req.on('error', reject);
      req.setTimeout(CONNECT_TIMEOUT);
    });
  }
}

let instance: FunasrModelDownloader | null = null;

export function getFunasrModelDownloader(
  mainWindow?: BrowserWindow,
): FunasrModelDownloader {
  if (!instance) instance = new FunasrModelDownloader(mainWindow);
  else if (mainWindow) instance.setMainWindow(mainWindow);
  return instance;
}
```

- [ ] **Step 3: Verify `downloadFileParallel`'s option shape matches usage**

Run: `rg -n "export (async )?function downloadFileParallel|interface .*Options" main/helpers/download/parallelDownloader.ts`
Confirm the call object keys used above (`url`, `destPath`, `signal`, `headers`, `onProgress`, `log`) match the actual signature (they match `fasterWhisperModelDownloader.ts`). If `onProgress` provides `(downloaded, total)` adjust the lambda accordingly.

- [ ] **Step 4: Type-check the two new files**

Run: `npx tsc --noEmit 2>&1 | rg -n "funasrModel(Catalog|Downloader)\.ts"`
Expected: no errors. (`ModelDownloadProgress` import path must match `fasterWhisperModelDownloader.ts`.)

- [ ] **Step 5: Find the model IPC registration and add funasr handlers**

Run: `rg -n "getFasterWhisperModelDownloader|ipcMain.handle\('download" main/helpers/*.ts main/background.ts`
Identify the file registering CT2 model download IPC (e.g., `ipcModelHandlers.ts` or inline in `background.ts`). Add, alongside the CT2 handlers:

```typescript
import { getFunasrModelDownloader } from './funasrModelDownloader';
import {
  FUNASR_MODELS,
  FunasrModelId,
  isFunasrModelInstalled,
  isFunasrReady,
  deleteFunasrModel,
} from './funasrModelCatalog';

ipcMain.handle(
  'funasr-model:download',
  async (_e, { id, source }: { id: FunasrModelId; source?: string }) => {
    try {
      getFunasrModelDownloader(mainWindow || undefined)
        .download(id, source)
        .catch((err) =>
          logMessage(`funasr model download failed: ${err}`, 'error'),
        );
      return { success: true, started: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  },
);

ipcMain.handle('funasr-model:cancel', async () => {
  getFunasrModelDownloader().cancel();
  return { success: true };
});

ipcMain.handle('funasr-model:status', async () => ({
  success: true,
  ready: isFunasrReady(),
  models: (Object.keys(FUNASR_MODELS) as FunasrModelId[]).map((id) => ({
    id,
    installed: isFunasrModelInstalled(id),
  })),
}));

ipcMain.handle(
  'funasr-model:delete',
  async (_e, { id }: { id: FunasrModelId }) => {
    try {
      deleteFunasrModel(id);
      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  },
);
```

> Use the same `mainWindow` reference the file already holds for the CT2 downloader. If model IPC lives in a function with a `mainWindow` param, follow that.

- [ ] **Step 6: Expose the new channels in the preload bridge (if the repo uses a typed bridge)**

Run: `rg -n "funasr-model:|start-py-engine-download|downloadProgress" main/preload.ts renderer/**/preload* 2>/dev/null`
If there's an allowlist of IPC channels in `preload.ts`, add `funasr-model:download|cancel|status|delete`. If the repo uses a generic `ipcRenderer.invoke` passthrough, nothing to do.

- [ ] **Step 7: Type-check + commit**

Run: `npx tsc --noEmit 2>&1 | rg -c "main/|types/"` → ≤ baseline for touched files.

```bash
git add main/helpers/funasrModelCatalog.ts main/helpers/funasrModelDownloader.ts main/helpers/ipcModelHandlers.ts main/preload.ts
git commit -m "feat(funasr): SenseVoice + FSMN-VAD ONNX model download (hf-mirror) + IPC"
```

---

## Task 9: FunASR transcription adapter + registry + settings IPC

**Files:**

- Create: `main/helpers/engines/funasrParams.ts`
- Create: `main/helpers/engines/funasrEngine.ts`
- Modify: `main/helpers/engines/registry.ts`
- Modify: `main/helpers/ipcEngineHandlers.ts` (engineId-aware download/check/uninstall/warmup + funasr settings)

- [ ] **Step 1: Create `funasrParams.ts` (pure mapping, testable)**

```typescript
/** funasr/SenseVoice 专属参数映射：SmartSub 统一 settings → sidecar funasr 参数。 */

/** SmartSub 语言 → SenseVoice 语言标签（auto|zh|yue|en|ja|ko）。 */
export function getFunasrLanguage(language?: string): string {
  if (!language || language === 'auto') return 'auto';
  const n = language.toLowerCase();
  if (n.startsWith('yue') || n === 'zh-hk' || n === 'zh-yue') return 'yue';
  if (n.startsWith('zh')) return 'zh';
  if (n.startsWith('en')) return 'en';
  if (n.startsWith('ja')) return 'ja';
  if (n.startsWith('ko')) return 'ko';
  return 'auto';
}

export interface FunasrEngineSettings {
  funasrUseItn?: boolean;
  funasrDevice?: 'auto' | 'cpu' | 'cuda';
}

/** 组装 funasr sidecar 的可选参数（不含 audio_file / 模型目录，由 adapter 注入）。 */
export function buildFunasrParams(
  settings: Record<string, unknown>,
  sourceLanguage?: string,
): {
  language: string;
  use_itn: boolean;
  device: string;
  quantize: boolean;
} {
  const s = settings as FunasrEngineSettings;
  return {
    language: getFunasrLanguage(sourceLanguage),
    use_itn: s.funasrUseItn !== false, // 默认开 ITN
    device: s.funasrDevice || 'auto',
    quantize: true,
  };
}
```

- [ ] **Step 2: Create `funasrEngine.ts` adapter (mirror fasterWhisperEngine structure)**

```typescript
import fs from 'fs';
import type { EngineStatus, PyEngineManifest } from '../../../types/engine';
import {
  isPyBaseReady,
  isEnginePackageInstalled,
  readEngineManifest,
} from '../pythonRuntime/paths';
import { getFunasrModelDir, isFunasrReady } from '../funasrModelCatalog';
import { formatSrtContent } from '../fileUtils';
import { logMessage, store } from '../storeManager';
import { getPythonRuntimeManager } from '../pythonRuntime';
import { getTaskContext, TaskCancelledError } from '../taskContext';
import { secondsToSrtTime } from './transcribeShared';
import { buildFunasrParams } from './funasrParams';
import type { TranscribeContext, TranscriptionEngineAdapter } from './types';

let activeFunasrTranscribeId: string | null = null;

function cancelFunasrTranscription(): void {
  if (activeFunasrTranscribeId) {
    getPythonRuntimeManager().cancel(activeFunasrTranscribeId);
    activeFunasrTranscribeId = null;
  }
}

function formatInstalledVersion(
  manifest: PyEngineManifest | null,
): string | undefined {
  if (!manifest) return undefined;
  if (manifest.engineVersion) return manifest.engineVersion;
  if (manifest.version && manifest.version !== 'latest')
    return manifest.version;
  if (manifest.sha256) return manifest.sha256.slice(0, 7);
  return undefined;
}

async function transcribeFunasr(ctx: TranscribeContext): Promise<string> {
  const { event, file, formData } = ctx;
  event.sender.send('taskFileChange', { ...file, extractSubtitle: 'loading' });

  const { tempAudioFile, srtFile } = file;
  const { sourceLanguage } = formData as { sourceLanguage?: string };
  const settings = store.get('settings');

  const manager = getPythonRuntimeManager();
  let engineInfo;
  try {
    engineInfo = await manager.ensureStarted('funasr');
  } catch (error) {
    throw new Error(`funasr engine unavailable: ${error?.message || error}`);
  }
  if (!engineInfo?.engines?.funasr) {
    throw new Error('funasr is not available in the python engine runtime');
  }
  if (!isFunasrReady()) {
    throw new Error(
      'funasr models not installed. Download SenseVoice + FSMN-VAD from Resource Hub > Models.',
    );
  }

  const params = {
    engine: 'funasr',
    audio_file: tempAudioFile,
    asr_model_dir: getFunasrModelDir('sensevoice-small'),
    vad_model_dir: getFunasrModelDir('fsmn-vad'),
    ...buildFunasrParams(settings, sourceLanguage),
  };
  logMessage(`funasrParams: ${JSON.stringify(params, null, 2)}`, 'info');
  event.sender.send('taskProgressChange', file, 'extractSubtitle', 0);

  const { id, result } = manager.transcribe(params, {
    onProgress: (percent) =>
      event.sender.send('taskProgressChange', file, 'extractSubtitle', percent),
  });
  activeFunasrTranscribeId = id;

  const signal = ctx.signal ?? getTaskContext()?.signal;
  const onAbort = () => {
    if (activeFunasrTranscribeId === id) manager.cancel(id);
  };
  if (signal?.aborted) manager.cancel(id);
  else signal?.addEventListener('abort', onAbort, { once: true });

  let transcription;
  try {
    transcription = await result;
  } catch (error) {
    if (signal?.aborted || (error as { code?: string })?.code === 'cancelled') {
      throw new TaskCancelledError();
    }
    throw error;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    activeFunasrTranscribeId = null;
  }

  if (signal?.aborted) throw new TaskCancelledError();

  const formattedSrt = formatSrtContent(
    (transcription?.segments || []).map(
      (segment) =>
        [
          secondsToSrtTime(segment.start),
          secondsToSrtTime(segment.end),
          segment.text || '',
        ] as [string, string, string],
    ),
  );
  await fs.promises.writeFile(srtFile, formattedSrt);

  event.sender.send('taskProgressChange', file, 'extractSubtitle', 100);
  event.sender.send('taskFileChange', { ...file, extractSubtitle: 'done' });
  logMessage(
    `generate subtitle done (funasr, language=${transcription?.language})`,
    'info',
  );
  return srtFile;
}

export const funasrEngineAdapter: TranscriptionEngineAdapter = {
  id: 'funasr',
  displayName: 'FunASR (SenseVoice)',
  requiresRuntime: true,

  async isAvailable(): Promise<EngineStatus> {
    if (!isPyBaseReady()) {
      return {
        state: 'error',
        message: 'Python base runtime missing; reinstall or update SmartSub',
      };
    }
    if (!isEnginePackageInstalled('funasr')) {
      return {
        state: 'not_installed',
        message: 'funasr engine package not installed',
      };
    }
    // 引擎包在但模型缺：仍报 not_installed（资源中心可下模型），消息区分。
    if (!isFunasrReady()) {
      return {
        state: 'not_installed',
        message: 'funasr models not downloaded',
      };
    }
    const manifest = readEngineManifest('funasr');
    return { state: 'ready', version: formatInstalledVersion(manifest) };
  },

  async transcribe(ctx: TranscribeContext): Promise<string> {
    return transcribeFunasr(ctx);
  },

  cancelActive(): void {
    cancelFunasrTranscription();
  },
};
```

- [ ] **Step 3: Register the adapter in `registry.ts`**

```typescript
import { builtinEngineAdapter } from './builtinEngine';
import { fasterWhisperEngineAdapter } from './fasterWhisperEngine';
import { funasrEngineAdapter } from './funasrEngine';
import { localCliEngineAdapter } from './localCliEngine';
// ...
const adapters: TranscriptionEngineAdapter[] = [
  builtinEngineAdapter,
  fasterWhisperEngineAdapter,
  funasrEngineAdapter,
  localCliEngineAdapter,
];
```

- [ ] **Step 4: Make engine IPC handlers engineId-aware + add funasr settings (`ipcEngineHandlers.ts`)**

1. `setMainWindowForEngine`: warm both downloaders:

```typescript
export function setMainWindowForEngine(window: BrowserWindow): void {
  mainWindow = window;
  getPyEngineDownloader('faster-whisper', window);
  getPyEngineDownloader('funasr', window);
}
```

2. `set-transcription-engine`: gate funasr like faster-whisper + warm the right engine:

```typescript
if (engine === 'fasterWhisper' && !isEnginePackageInstalled('faster-whisper')) {
  return { success: false, error: 'engine_not_installed' };
}
if (engine === 'funasr' && !isEnginePackageInstalled('funasr')) {
  return { success: false, error: 'engine_not_installed' };
}
// ...store.set unchanged...
if (engine === 'fasterWhisper') {
  void getPythonRuntimeManager()
    .ensureStarted('faster-whisper')
    .catch((e) =>
      logMessage(`engine warmup failed (non-fatal): ${e}`, 'warning'),
    );
} else if (engine === 'funasr') {
  void getPythonRuntimeManager()
    .ensureStarted('funasr')
    .catch((e) =>
      logMessage(`engine warmup failed (non-fatal): ${e}`, 'warning'),
    );
}
```

3. `start-py-engine-download` / `check-py-engine-update` / `cancel-py-engine-download` / `get-py-engine-download-progress` / `uninstall-py-engine`: accept an `engineId` param (default `'faster-whisper'` for back-compat):

```typescript
ipcMain.handle(
  'start-py-engine-download',
  async (
    _e,
    {
      source,
      engineId = 'faster-whisper',
    }: { source: PyEngineDownloadSource; engineId?: PyEngineId },
  ) => {
    try {
      if (isTranscriptionBusy())
        return { success: false, error: 'engine_busy' };
      getPyEngineDownloader(engineId, mainWindow || undefined)
        .download(source)
        .catch((error) =>
          logMessage(
            `Py-engine[${engineId}] download failed: ${error}`,
            'error',
          ),
        );
      return { success: true, started: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  },
);
```

Apply the same `engineId = 'faster-whisper'` destructure to `check-py-engine-update` (`getPyEngineDownloader(engineId).checkUpdate(source)`), `cancel-py-engine-download` (`getPyEngineDownloader(engineId).cancel()`), `get-py-engine-download-progress` (`getPyEngineDownloader(engineId).getProgress()`), and `uninstall-py-engine` (`getEngineDir(engineId)`; also shutdown runtime). Import `PyEngineId`.

4. Add funasr settings handler:

```typescript
ipcMain.handle(
  'set-funasr-settings',
  async (
    _event,
    { device, useItn }: { device?: 'auto' | 'cpu' | 'cuda'; useItn?: boolean },
  ) => {
    try {
      const settings = store.get('settings');
      store.set('settings', {
        ...settings,
        ...(device !== undefined ? { funasrDevice: device } : {}),
        ...(useItn !== undefined ? { funasrUseItn: useItn } : {}),
      });
      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  },
);
```

5. `python-engine:ping`: ping the active engine:

```typescript
ipcMain.handle('python-engine:ping', async () => {
  try {
    const active = resolveTranscriptionEngine(store.get('settings'));
    const engineId: PyEngineId =
      active === 'funasr' ? 'funasr' : 'faster-whisper';
    await getPythonRuntimeManager().ensureStarted(engineId);
    return { success: true };
  } catch (error) {
    return { success: false, error: String(error) };
  }
});
```

- [ ] **Step 5: Verify `resolveTranscriptionEngine` accepts funasr**

Run: `rg -n "fasterWhisper|funasr|TranscriptionEngine" main/helpers/transcriptionEngine.ts`
If it whitelists engine ids, add `'funasr'`. If it just reads `settings.transcriptionEngine` and validates membership against a set, add `'funasr'` to that set.

- [ ] **Step 6: Type-check + commit**

Run: `npx tsc --noEmit 2>&1 | rg -c "main/|types/"` → ≤ baseline for touched files.

```bash
git add main/helpers/engines/funasrParams.ts main/helpers/engines/funasrEngine.ts main/helpers/engines/registry.ts main/helpers/ipcEngineHandlers.ts main/helpers/transcriptionEngine.ts
git commit -m "feat(funasr): transcription adapter + engineId-aware engine IPC + settings"
```

---

## Task 10: Renderer — Engines card, Models section, params, i18n

**Files:**

- Modify: `renderer/components/resources/EnginesTab.tsx`
- Modify: the models tab component (find in Step 3)
- Modify: `locales/zh/*.json`, `locales/en/*.json`

> Goal: list FunASR as a downloadable engine (download/enable/uninstall + status), surface its 2 models in the Models tab (download/delete + progress via `funasr:<id>` keys), and show FunASR-specific params (ITN toggle, device). Reuse existing components; do not restructure.

- [ ] **Step 1: Read `EnginesTab.tsx` to learn the faster-whisper card pattern**

Run: `rg -n "fasterWhisper|start-py-engine-download|check-py-engine-update|uninstall-py-engine|engineStatus|displayName" renderer/components/resources/EnginesTab.tsx`

- [ ] **Step 2: Add a FunASR card mirroring the faster-whisper card**

Reuse whatever card/list the faster-whisper engine uses. The card must:

- Read status from `get-engine-status` (now includes `funasr`).
- Download button → `ipcRenderer.invoke('start-py-engine-download', { source, engineId: 'funasr' })`.
- Update check → `invoke('check-py-engine-update', { source, engineId: 'funasr' })`.
- Uninstall → `invoke('uninstall-py-engine', { engineId: 'funasr' })`.
- Progress events: filter `py-engine-download-progress` by `payload.engineId === 'funasr'`.
- Enable → `invoke('set-transcription-engine', 'funasr')` (handle `engine_not_installed`).
- Device select (auto/cpu) → `invoke('set-funasr-settings', { device })`.
- ITN toggle → `invoke('set-funasr-settings', { useItn })`.

If the existing tab renders engines by iterating a config array, add a `funasr` entry to that array with `engineId: 'funasr'`, `displayName: 'FunASR (SenseVoice)'`, and any per-engine flags; only add a bespoke card if the tab hardcodes faster-whisper.

- [ ] **Step 3: Add FunASR models to the Models tab**

Run: `rg -n "ct2:|getCt2ProgressKey|faster-whisper.*model|downloadProgress" renderer/components -l`
In the models tab, add a FunASR models group listing `sensevoice-small` and `fsmn-vad`:

- Status from `invoke('funasr-model:status')`.
- Download → `invoke('funasr-model:download', { id })`.
- Cancel → `invoke('funasr-model:cancel')`.
- Delete → `invoke('funasr-model:delete', { id })`.
- Progress: subscribe to `downloadProgress`/`modelDownloadDetail` filtering keys with prefix `funasr:`.

- [ ] **Step 4: Add i18n keys (zh + en together)**

Run: `rg -n "fasterWhisper" locales/zh -l` to find the right namespace file(s). Add parallel keys, e.g. in the engines/models namespace:

zh:

```json
{
  "engine.funasr.name": "FunASR（SenseVoice）",
  "engine.funasr.desc": "达摩院 SenseVoice-Small，中文/粤语/日语/韩语高准确度，CPU 即可流畅，推荐中文场景。",
  "engine.funasr.itn": "数字/标点归一化（ITN）",
  "engine.funasr.modelsRequired": "需下载 SenseVoice 与 FSMN-VAD 两个模型",
  "model.funasr.sensevoice-small": "SenseVoice-Small（ONNX，约 230MB）",
  "model.funasr.fsmn-vad": "FSMN-VAD（语音分段，约 2MB）"
}
```

en:

```json
{
  "engine.funasr.name": "FunASR (SenseVoice)",
  "engine.funasr.desc": "DAMO SenseVoice-Small: high-accuracy Chinese/Cantonese/Japanese/Korean, fast on CPU. Recommended for Chinese.",
  "engine.funasr.itn": "Inverse Text Normalization (ITN)",
  "engine.funasr.modelsRequired": "Requires SenseVoice + FSMN-VAD models",
  "model.funasr.sensevoice-small": "SenseVoice-Small (ONNX, ~230MB)",
  "model.funasr.fsmn-vad": "FSMN-VAD (segmentation, ~2MB)"
}
```

Match the existing key naming convention in the repo (prefix/namespace) rather than inventing new ones — inspect neighbors first.

- [ ] **Step 5: i18n gate + renderer build sanity**

Run: `npm run check-i18n`
Expected: pass (zh/en parity for new keys).

Run: `npx tsc -p renderer/tsconfig.json 2>&1 | rg -n "EnginesTab|Models"`
Expected: no NEW errors in the files you touched (renderer has 184 pre-existing unrelated errors; only ensure your files are clean).

- [ ] **Step 6: Commit**

```bash
git add renderer locales
git commit -m "feat(funasr): Resource Hub engine card + models section + i18n"
```

---

## Task 11: Cleanup — remove legacy `userData/py-engine` directory

**Files:**

- Create: `main/helpers/legacyCleanup.ts`
- Modify: `main/background.ts` (call once at startup)

> Pre-three-layer builds installed a single binary under `userData/py-engine/`. Three-layer uses `userData/py-engines/<id>/`. Remove the stale `py-engine` dir (and its old download-state file) once, so it doesn't waste disk or confuse diagnostics. Safe because there are no released users (spec §1.3).

- [ ] **Step 1: Create `legacyCleanup.ts`**

```typescript
import path from 'path';
import fs from 'fs';
import { app } from 'electron';
import { logMessage } from './storeManager';

/**
 * 一次性清理三层架构之前的遗留物：
 * - userData/py-engine（旧单二进制 onedir 布局；新布局是 py-engines/<id>）
 * - userData/py-engine-download-state.json（旧单引擎下载状态）
 * 无老用户，删除安全（spec §1.3）。
 */
export function cleanupLegacyPyEngine(): void {
  try {
    const userData = app.getPath('userData');
    const legacyDir = path.join(userData, 'py-engine'); // 注意：非 py-engines
    if (fs.existsSync(legacyDir) && fs.statSync(legacyDir).isDirectory()) {
      fs.rmSync(legacyDir, { recursive: true, force: true });
      logMessage(`Removed legacy py-engine dir: ${legacyDir}`, 'info');
    }
    const legacyState = path.join(userData, 'py-engine-download-state.json');
    if (fs.existsSync(legacyState)) {
      fs.unlinkSync(legacyState);
      logMessage(`Removed legacy py-engine download state`, 'info');
    }
  } catch (error) {
    logMessage(
      `legacy py-engine cleanup failed (non-fatal): ${error}`,
      'warning',
    );
  }
}
```

- [ ] **Step 2: Call it once at startup in `background.ts`**

Run: `rg -n "app.whenReady|createWindow|registerEngineIpcHandlers" main/background.ts`
Add an import and a call early in the ready handler (after `app.whenReady()` resolves, before/after window creation — order doesn't matter):

```typescript
import { cleanupLegacyPyEngine } from './helpers/legacyCleanup';
// ...inside the ready/init path:
cleanupLegacyPyEngine();
```

- [ ] **Step 3: Type-check + commit**

Run: `npx tsc --noEmit 2>&1 | rg -n "legacyCleanup\.ts|background\.ts"`
Expected: no errors in these files.

```bash
git add main/helpers/legacyCleanup.ts main/background.ts
git commit -m "chore: remove legacy userData/py-engine dir on startup"
```

---

## Task 12: End-to-end verification (local, no CI dependency)

**Goal:** Prove the whole funasr path works in the app using the locally-built engine package + real models, without waiting for CI.

- [ ] **Step 1: Install the locally-built funasr engine package into userData (no-download path)**

Find the dev userData path (macOS dev = `~/Library/Application Support/SmartSub-dev`):

```bash
APPDIR="$HOME/Library/Application Support/SmartSub-dev"
mkdir -p "$APPDIR/py-engines/funasr"
cp -R "/Users/xiaodong/code/github.com/buxuku/smartsub-py-engine/dist/funasr/." "$APPDIR/py-engines/funasr/"
ls "$APPDIR/py-engines/funasr"   # main.py, _version.py, engines/, site-packages/
```

Write a minimal manifest so `readEngineManifest('funasr')` and status show "ready":

```bash
cat > "$APPDIR/py-engines/funasr/manifest.json" <<'JSON'
{ "version": "0.2.0", "platform": "macos-arm64", "sha256": "local-dev", "installedAt": "2026-06-16T00:00:00Z", "engineVersion": "0.2.0", "protocolVersion": 1, "engineId": "funasr", "pythonAbi": "cp312" }
JSON
```

- [ ] **Step 2: Install models into userData (reuse Task 3 downloads)**

```bash
APPDIR="$HOME/Library/Application Support/SmartSub-dev"
mkdir -p "$APPDIR/models/funasr/sensevoice-small" "$APPDIR/models/funasr/fsmn-vad"
cp /tmp/funasr-models/sensevoice/* "$APPDIR/models/funasr/sensevoice-small/"
cp /tmp/funasr-models/fsmn-vad/* "$APPDIR/models/funasr/fsmn-vad/"
```

- [ ] **Step 3: Build the app + run type checks/gates**

Run: `npx tsc --noEmit 2>&1 | rg -c "main/|types/"`
Expected: ≤ 104 (baseline) for main/types.

Run: `npm run check-i18n`
Expected: pass.

- [ ] **Step 4: Launch dev app, switch engine to FunASR, transcribe a short clip**

Run the app (use the repo's dev command, e.g. `npm run dev`). In the UI:

1. Resource Hub → Engines: FunASR shows "ready" (package + models present).
2. Set active engine = FunASR.
3. Add a short video/audio with Chinese speech → start transcription.
4. Confirm: progress advances, segments stream, SRT is written, text is Chinese and reasonable.

Expected logs: `funasrParams: {...}`, `Python engine ready: ... engines={"faster_whisper":false,"funasr":true}`, `generate subtitle done (funasr, ...)`.

- [ ] **Step 5: Regression — switch back to faster-whisper or whisper.cpp**

1. Switch active engine to faster-whisper (if installed) → confirm sidecar restarts with faster-whisper PYTHONPATH (log: `Switching python engine funasr -> faster-whisper`) and transcription works.
2. Switch to built-in whisper.cpp → confirm unaffected.

- [ ] **Step 6: Bundle size gate (if building installer)**

Run: `npm run size:check` (after a build) OR confirm the size gate from P0 still passes (funasr package is downloaded, NOT bundled, so the installer size is unchanged).
Expected: installer ≤ 200MB (unchanged from P0; only the base is bundled).

- [ ] **Step 7: Final commit (if any verification fixups were needed)**

```bash
git add -A
git commit -m "test(funasr): e2e verification fixups"
```

---

## Self-Review Checklist (run after implementing)

1. **Spec coverage (P1 deliverables, spec §12 P1 + §6.2 + §7 + §8 + §13):**
   - funasr engine package (onnxruntime + funasr-onnx) → Task 1, 2, 4.
   - `funasr_sensevoice_engine.py` (VAD seg → ASR → SRT) → Task 2.
   - app `funasr` adapter + params mapping → Task 9.
   - model download (China-friendly mirror) → Task 8.
   - Engines Tab + Models tab + params + i18n → Task 10.
   - GPU device param plumbed (CPU-first, cuda value accepted) → Task 9 (`buildFunasrParams.device`), Python `_device_id` → Task 2.
   - whisper.cpp always保底 / regression → Task 12 Step 5.
   - Cleanups (release.yml old asset removal; legacy userData dir) → Task 4, Task 11.
2. **Placeholder scan:** none — every code step has full code.
3. **Type consistency:**
   - `ensureStarted(engineId)` signature used identically in manager (Task 6), faster-whisper adapter (Task 6 Step 3), funasr adapter (Task 9), IPC (Task 9 Step 4).
   - `getPyEngineDownloader(engineId, mainWindow?)` signature used identically in downloader (Task 7), IPC (Task 9).
   - `PyEngineId = 'faster-whisper' | 'funasr'` (Task 5) used by paths/downloader/runtime.
   - `FunasrModelId = 'sensevoice-small' | 'fsmn-vad'` consistent across catalog (Task 8), downloader (Task 8), IPC (Task 8), adapter (Task 9 via `getFunasrModelDir`).
   - sidecar engine key is `'funasr'` everywhere: Python `get_engine('funasr')`/`list_engines()['funasr']` (Task 2), `params.engine='funasr'` (Task 9), `engineInfo.engines.funasr` (Task 9), manifest `enginePackages.funasr.sidecar='funasr'` (Task 4).
4. **Ordering dependency:** Task 6 Step 2 imports `getFunasrModelsRoot` from Task 8 Step 1 — create `funasrModelCatalog.ts` before type-checking Task 6 (noted inline).

## Risks & Mitigations (P1-specific)

- **funasr-onnx needs a model file we didn't list (e.g. `chn_jpn_yue_eng_ko_spectok.bpe.model`).** Mitigation: Task 3 Step 4 smoke validates real load; if it errors on a missing file, add it to `FUNASR_MODELS['sensevoice-small'].requiredFiles` + it's already in the repo tree so the downloader fetches it automatically (downloader pulls ALL repo files; `requiredFiles` is only the install-complete gate).
- **funasr-onnx transitively pulls torch.** Mitigation: Task 1 Step 4 asserts no torch + size sanity; pin deps if needed.
- **VAD output shape differs across funasr-onnx versions.** Mitigation: `_vad_segments` defensively handles `List[batch]` vs flat; pinned `funasr-onnx==0.4.1`.
- **Engine switch race (two transcriptions on different engines).** Out of scope: SmartSub serializes transcription (task queue, `isTranscriptionBusy`); switching mid-run is blocked by `engine_busy` on install and by single active task.
- **hf-mirror availability.** Mitigation: `getHosts` falls back to `huggingface.co`.
