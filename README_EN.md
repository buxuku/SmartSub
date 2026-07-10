<div align="center">

<img src="./resources/icon.png" width="88" alt="SmartSub" />

# SmartSub

**Generate, translate, dub, and burn subtitles — an all-in-one open-source desktop app**

Make every frame speak beautifully

<a href="https://trendshift.io/repositories/14079?utm_source=repository-badge&amp;utm_medium=badge&amp;utm_campaign=badge-repository-14079" target="_blank" rel="noopener noreferrer"><img src="https://trendshift.io/api/badge/repositories/14079" alt="buxuku%2FSmartSub | Trendshift" width="250" height="55"/></a>
<a href="https://trendshift.io/repositories/14079?utm_source=trendshift-badge&amp;utm_medium=badge&amp;utm_campaign=badge-trendshift-14079" target="_blank" rel="noopener noreferrer"><img src="https://trendshift.io/api/badge/trendshift/repositories/14079/daily?language=TypeScript" alt="buxuku%2FSmartSub | Trendshift" width="250" height="55"/></a>

[![Release](https://img.shields.io/github/v/release/buxuku/SmartSub?style=flat-square&logo=github&color=blue&label=Release)](https://github.com/buxuku/SmartSub/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/buxuku/SmartSub/total?style=flat-square&logo=github&label=Downloads&color=brightgreen)](https://github.com/buxuku/SmartSub/releases)
[![Platform](https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Linux-blue?style=flat-square&logo=electron&logoColor=white)](https://github.com/buxuku/SmartSub/releases)
[![License](https://img.shields.io/badge/License-MIT-green.svg?style=flat-square)](https://github.com/buxuku/SmartSub/blob/master/LICENSE)

[中文](README.md) | [English](README_EN.md) | [日本語](README_JA.md)

[Download](#download-and-install) · [Features](#features) · [Free Workflow](#a-completely-free-workflow) · [FAQ](#faq) · [Changelog](https://github.com/buxuku/SmartSub/releases)

</div>

![SmartSub home screen](./resources/preview/home-en.png)

## What is SmartSub?

SmartSub is an open-source subtitle and dubbing tool that packs the whole pipeline — **speech-to-text → subtitle translation → proofreading → AI dubbing → burn-in** — into one desktop app. Transcription runs on local models (whisper.cpp, sherpa-onnx and more), so your files never leave your machine. It handles batch jobs, accelerates on NVIDIA / AMD / Intel / Apple Silicon GPUs, and runs on Windows, macOS, and Linux.

If you've been juggling separate tools for transcription, translation, text-to-speech, and burning subtitles with ffmpeg, SmartSub is a free, offline-friendly way to do all of it in one place. **The entire pipeline can run at zero cost**: local Whisper transcription, built-in free translation sources, local TTS dubbing with voice cloning, and local ffmpeg burn-in — no API keys required, no usage caps on local processing. When you want more, plug in any of 20 translation services, 8 cloud transcription providers, and 5 cloud TTS services.

## What can it do for you?

| Your goal                                     | How SmartSub handles it                                                              |
| --------------------------------------------- | ------------------------------------------------------------------------------------ |
| Watch foreign videos or lectures without subs | Drop in the video, transcribe locally, translate — get bilingual subtitles instantly |
| Localize content for other markets            | Translate subtitles, then dub them into a new audio track with TTS                   |
| Narrate videos in your own voice              | Record a short sample, clone your voice, and have it read the whole video            |
| Archive podcasts, courses, meeting recordings | Batch-transcribe into SRT files for editing, search, or archiving                    |
| Ship videos with polished subtitles           | Proofread line by line, then hardcode or soft-mux with WYSIWYG styling               |

## Features

Media → **transcribe** → **translate** → **proofread** → **dub** → **export**. Use each step on its own, or chain them into a batch pipeline.

### Subtitle generation (transcription)

- Batch subtitle generation for a wide range of video / audio formats, with configurable concurrency
- 7 engine families, switchable per task: built-in `whisper.cpp`, `faster-whisper`, `FunASR`, `Qwen3-ASR`, `FireRedASR`, your local `Whisper CLI`, plus GPU-free Cloud ASR (8 providers)
- Local engines are fully offline — nothing gets uploaded; FunASR / FireRedASR shine on Chinese content
- Simplified/Traditional Chinese conversion, custom subtitle file naming (for player auto-loading), optional punctuation removal for Chinese subtitles

### Subtitle translation

- 20 translation services: built-in free translation (Bing / Google free endpoints with automatic fallback and rate limiting), Baidu, Aliyun, Tencent, iFlytek, Volcano Engine, Doubao, NiuTrans, DeepLX, Azure, Google, plus LLM services such as Ollama (local models), DeepSeek, Gemini, Qwen, SiliconFlow, Azure OpenAI, and [DeerAPI](https://api.deerapi.com/register?aff=QvHM)
- Compatible with any OpenAI-style API — bring your own endpoint
- Output translation only, or bilingual "original + translation" subtitles
- Per-service custom request parameters configured right in the UI, with import/export — no code changes

### Subtitle proofreading

- Built-in editor to review and fix lines side by side with the video
- Undo/redo; per-line delete with restore
- One-click AI polish

### TTS dubbing and voice cloning

- A dedicated dubbing workbench: one subtitle file plus an optional video, synthesized line by line and aligned to the timeline automatically
- Local engines, offline and free: Kokoro multilingual (103 voices), VITS Chinese (174 voices)
- Voice cloning: local ZipVoice zero-shot cloning (one reference clip and it's ready), plus Volcengine Voice Cloning 2.0 and ElevenLabs instant cloning
- Cloud services: Edge TTS free tier, OpenAI-compatible endpoints (OpenAI / SiliconFlow and others), Azure Speech, Volcengine Doubao, ElevenLabs
- Timeline alignment: speech-rate pre-control, measured re-checks, borrowing from silent gaps; lines over the limit go to a review list (edit the text, regenerate the line, or accept a tempo change)
- Per-line preview, voice switching, and re-synthesis; keep the original track muted or ducked under the dub
- Export audio only (wav / mp3), replace the audio track, mix into the video, or produce a dual-audio MKV — with the aligned subtitles alongside

### Video synthesis (subtitle burn-in)

- Hardcode: burn subtitles permanently into the picture — visible in any player
- Soft-mux: losslessly embed a switchable subtitle track via stream copy
- Font, size, color, outline, shadow, 9-grid positioning, and style presets
- Real-time WYSIWYG preview

### Privacy and hardware acceleration

- Local processing — files never leave your machine; every cloud service is opt-in with a first-run privacy confirmation
- GPU acceleration: NVIDIA CUDA, AMD / Intel Vulkan, Apple Core ML / Metal
- Acceleration packs download in-app — no manual CUDA Toolkit install; automatic CPU fallback on failure

## Screenshots

| Video synthesis (burn-in)                  | Subtitle proofreading                             |
| ------------------------------------------ | ------------------------------------------------- |
| ![merge](./resources/preview/merge-en.png) | ![proofread](./resources/preview/profread-en.png) |

## A completely free workflow

If you're cost-conscious, this route costs nothing and requires no sign-ups:

| Step          | Free option                                                                       | Notes                                     |
| ------------- | --------------------------------------------------------------------------------- | ----------------------------------------- |
| Transcription | whisper.cpp / faster-whisper / FunASR / Qwen3-ASR / FireRedASR local models       | Download a model once, works offline      |
| Translation   | Built-in free translation (Bing / Google endpoints with fallback), Ollama, DeepLX | Free translation works with zero setup    |
| TTS dubbing   | Local Kokoro / VITS / ZipVoice voice cloning; Edge TTS free tier                  | Local synthesis is offline, no usage caps |
| Burn-in       | Bundled ffmpeg                                                                    | Fully local                               |

Paid cloud services (OpenAI, ElevenLabs, Volcengine, Tencent Cloud, and others) are optional upgrades — use them only if you want them.

## Download and install

Pick the package for your system and chip. GPU acceleration packs are not part of the download — fetch them in-app after installing.

| System  | Chip  | Package     | Notes                                                  |
| ------- | ----- | ----------- | ------------------------------------------------------ |
| Windows | x64   | windows-x64 | NVIDIA → CUDA, AMD / Intel → Vulkan, downloaded in-app |
| macOS   | Apple | mac-arm64   | Core ML / Metal acceleration enabled automatically     |
| macOS   | Intel | mac-x64     | CPU only, no GPU acceleration                          |
| Linux   | x64   | linux-x64   | NVIDIA → CUDA, AMD / Intel → Vulkan, downloaded in-app |

Get it from [GitHub Releases](https://github.com/buxuku/SmartSub/releases), or the [Quark](https://pan.quark.cn/s/0b16479b40ca) mirror.

On macOS, Homebrew is the easiest way — it picks the right build for your chip:

```bash
brew tap buxuku/tap          # once
brew install --cask smartsub # install
brew upgrade --cask smartsub # upgrade
```

### Up and running in three steps

1. After installing, follow the onboarding guide to download a speech model (no GPU or no model? Configure Cloud ASR instead)
2. Pick a task from the launchpad, drop in media or subtitle files, and set source language, target language, and other options
3. Start processing — then proofread, dub, or burn in the results

## Going deeper

<details>
<summary><b>Transcription engines compared</b></summary>

<br/>

The engine is a per-task choice. Manage runtimes and models from the "Engines & Models" page:

| Engine                     | Notes                                                                | How it runs                                      |
| -------------------------- | -------------------------------------------------------------------- | ------------------------------------------------ |
| **whisper.cpp (built-in)** | Default engine; ggml quantized models and GPU acceleration           | Bundled, works out of the box                    |
| **faster-whisper**         | CTranslate2-based, faster; models fetched on demand from HuggingFace | Self-contained Python runtime (in-app download)  |
| **FunASR**                 | SenseVoice (zh/en/ja/ko/yue) and Paraformer-zh; great for Chinese    | Bundled sherpa-onnx native library               |
| **Qwen3-ASR**              | Qwen speech recognition (qwen3-asr-0.6b)                             | Bundled sherpa-onnx native library               |
| **FireRedASR**             | FireRedASR-AED large (zh-en); great for Chinese                      | Bundled sherpa-onnx native library               |
| **Local Whisper CLI**      | Calls a whisper-compatible command you installed yourself            | Uses your system command                         |
| **Cloud ASR (online)**     | 8 providers, no GPU needed, multi-provider and multi-instance        | Online service (audio uploaded to your endpoint) |

FunASR / Qwen3-ASR / FireRedASR all run on the bundled sherpa-onnx native library with no extra setup; faster-whisper downloads a self-contained runtime inside the app.

</details>

<details>
<summary><b>Cloud ASR: the 8 providers</b></summary>

<br/>

Cloud ASR lives in the "Cloud ASR" group of the Engines & Models sidebar. Each provider has its own entry — select it, fill in the credentials, and use "Test connection" to verify. Transcription uploads audio to the endpoint you configure; a privacy confirmation appears on first run. Avoid sensitive content and mind each provider's usage costs.

- **OpenAI-compatible**: the `audio/transcriptions` protocol (`whisper-1`, `gpt-4o-transcribe`, and the like). OpenAI / Groq / SiliconFlow presets sit right in the sidebar; any other compatible endpoint (self-hosted, proxies) connects via "Add custom", as many as you need
- **ElevenLabs Scribe**: the `scribe_v1` model
- **Deepgram**: `nova-2` / `nova-3` models
- **Volcengine Doubao**: flash file recognition (bigmodel). Uses an API key issued under "API Key management" in the Doubao Speech console (activate the model first; Volcano Ark API keys are not interchangeable); billed by duration
- **Tencent Cloud**: flash file recognition. Uses the AppID / SecretId / SecretKey from the ASR console (activate first; 5 free hours per month). The recognition language follows the task's source language; the model picker only chooses the tier — standard, or large (better accuracy, higher price, free-tier concurrency capped at 5)
- **Alibaba Cloud**: flash file recognition. Uses a RAM AccessKey ID / Secret plus the Appkey of a project in the Intelligent Speech Interaction console. The recognition language is set in the project's configuration (the task's source language has no effect); the default Mandarin model also handles mixed Chinese-English. Note this service is **commercial-only (no free trial)** — billed by duration after activation
- **iFlytek**: LLM-based audio file transcription. Asynchronous orders that survive app restarts
- **Gladia**: solaria models, 100+ languages, 10 free hours per month

</details>

<details>
<summary><b>Choosing a whisper model</b></summary>

<br/>

whisper.cpp / faster-whisper use the whisper model family. Bigger models are more accurate but slower and hungrier for VRAM:

- Low-end devices or integrated GPUs: `tiny` / `base` — fast and lightweight
- Typical computers: start with `small` / `base` to balance accuracy and resources
- High-performance GPUs / workstations: the `large` series for top accuracy
- English-only media: pick a model with the `en` suffix, optimized for English
- Tight on disk: `q5` / `q8` quantized variants trade a little accuracy for a much smaller footprint

</details>

<details>
<summary><b>GPU acceleration</b></summary>

<br/>

SmartSub ships with a built-in acceleration-pack manager — no manual CUDA Toolkit install. GPU acceleration is managed on the "Engines & Models" page; the app detects your GPU and recommends an option.

| Platform                      | Backend             | Notes                                                                              |
| ----------------------------- | ------------------- | ---------------------------------------------------------------------------------- |
| Windows / Linux + NVIDIA      | **CUDA**            | Supports CUDA 11.8.0 / 12.2.0 / 12.4.0 / 13.0.2; download the matching pack in-app |
| Windows / Linux + AMD / Intel | **Vulkan**          | Vulkan acceleration pack ships with the app                                        |
| macOS (Apple Silicon)         | **Core ML / Metal** | Enabled automatically with the mac arm64 build                                     |
| Any platform                  | **CPU**             | Automatic fallback when no GPU is available                                        |

- Acceleration modes: Auto / GPU-only / CPU-only; on load failure it falls back to CPU and explains why in the diagnostics panel
- If the app crashes after enabling acceleration, switch to CPU-only mode or try a different transcription engine

</details>

<details>
<summary><b>Translation services and custom parameters</b></summary>

<br/>

Cloud translation services need their own API keys or configuration. For obtaining keys for services like Baidu Translation and Volcano Engine, see [Bob's service guide](https://bobtranslate.com/service/) — thanks to [Bob](https://bobtranslate.com/), an excellent app, for the documentation.

AI translation quality depends heavily on the model and the prompt; experiment to find the combination that works for your content.

Every AI translation service supports custom parameter configuration for precise control over model behavior:

- Add and manage parameters directly in the UI — no code changes
- Types: String, Float, Boolean, Array, Object, Integer
- Real-time validation to prevent invalid configurations
- Import/export for sharing and backup

</details>

<details>
<summary><b>Dubbing engines and output modes</b></summary>

<br/>

Local engines run on sherpa-onnx, fully offline and free:

| Model                 | Languages | Voices       | Notes                                                       |
| --------------------- | --------- | ------------ | ----------------------------------------------------------- |
| Kokoro multilingual   | zh / en   | 103          | Multilingual model with balanced English and Chinese voices |
| VITS Chinese AIShell3 | zh        | 174          | Chinese speaker library                                     |
| ZipVoice cloning      | zh / en   | user-created | Zero-shot cloning: one reference clip plus its transcript   |

Cloud providers, all optional:

| Service           | Notes                                                                                                         |
| ----------------- | ------------------------------------------------------------------------------------------------------------- |
| Edge TTS          | Free, no key; a reverse-engineered trial tier with no availability guarantee — switch engines if it goes down |
| OpenAI-compatible | The `audio/speech` protocol; OpenAI / SiliconFlow presets built in, plus custom endpoints                     |
| Azure Speech      | Microsoft Neural voices (700+), SSML rate control                                                             |
| Volcengine Doubao | Doubao TTS voices, plus Voice Cloning 2.0 for cloned voices                                                   |
| ElevenLabs        | Multilingual models with instant voice cloning (IVC)                                                          |

Timeline alignment: speech rate is pre-set from the target duration, the result is measured and re-checked (local engines re-synthesize for free, cloud output is tempo-adjusted with atempo), and remaining overruns borrow time from adjacent silent gaps. Lines still past the 1.5x rate limit land on a review list where you can edit the text, regenerate the line, or accept the tempo change.

When you create a cloned voice, the reference audio is automatically quality-checked (duration, signal-to-noise ratio, clipping, volume) with pinpointed issues and suggested fixes.

</details>

<details>
<summary><b>Manually downloading and importing models</b></summary>

<br/>

Model files are large; if in-app downloads struggle, download manually and import. Whisper model sources:

1. Mirror (faster in some regions): https://hf-mirror.com/ggerganov/whisper.cpp/tree/main
2. Hugging Face: https://huggingface.co/ggerganov/whisper.cpp/tree/main

On Apple Silicon, also download the model's `encoder.mlmodelc` file and unzip it next to the model (not needed for `q5` / `q8` variants).

To import: on the "Engines & Models" page click "Import Model" and pick the downloaded file — or copy it straight into the model directory.

Models for FunASR / Qwen3-ASR / FireRedASR download on demand inside the "Engines & Models" page (multiple sources: ModelScope, GitHub, and more).

</details>

## FAQ

<details>
<summary><b>macOS says "the application is damaged and can't be opened"</b></summary>

<br/>

Run this in the terminal, then launch the app again:

```bash
sudo xattr -dr com.apple.quarantine /Applications/SmartSub.app
```

</details>

<details>
<summary><b>Model downloads are slow or failing</b></summary>

<br/>

Download the model manually and import it — see [Going deeper](#going-deeper). The hf-mirror source is faster in some regions.

</details>

<details>
<summary><b>The app crashes after enabling GPU acceleration</b></summary>

<br/>

On the "Engines & Models" page, switch the acceleration mode to CPU-only, or try a different transcription engine; the diagnostics panel shows the failure reason.

</details>

## Contributing

Issues and pull requests are welcome.

<details>
<summary><b>Building locally</b></summary>

<br/>

1. Clone the project and install dependencies (an install hook automatically fetches the whisper addon and the sherpa-onnx native libraries):

```bash
git clone https://github.com/buxuku/SmartSub.git
cd SmartSub
yarn install
```

2. Start the dev environment:

```bash
yarn dev
```

If the native dependencies fail to download automatically (e.g. restricted network), run `yarn native:fetch` manually to retry.

</details>

## Community and support

If this project helps you, a star is appreciated — or buy the author a coffee (please mention your GitHub account). For usage questions, the WeChat group is open to everyone.

| Alipay                                            | WeChat donation                                   | WeChat group                                  |
| ------------------------------------------------- | ------------------------------------------------- | --------------------------------------------- |
| ![Alipay donation](./resources/donate_alipay.jpg) | ![WeChat donation](./resources/donate_wechat.jpg) | ![WeChat group](./resources/WechatIMG428.png) |

## Acknowledgements

- [whisper.cpp](https://github.com/ggerganov/whisper.cpp) — the foundation of local transcription
- [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) — runtime for FunASR / Qwen3-ASR / FireRedASR and local TTS
- [FFmpeg](https://ffmpeg.org/) — media processing and subtitle burn-in
- [Bob](https://bobtranslate.com/) — documentation on translation service signup

## License

MIT — see the [LICENSE](LICENSE) file for details.

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=buxuku/SmartSub&type=Date)](https://star-history.com/#buxuku/SmartSub&Date)
