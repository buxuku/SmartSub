# longgap：多语种「长静音」真机回归 harness

验证内置 whisper.cpp 时间轴管道

在 **多语种 × VAD on/off × 长静音** 下的表现，量化四个维度：

| 指标           | 含义                                               | 期望                  |
| -------------- | -------------------------------------------------- | --------------------- |
| `cues`         | 字幕条数（分段粒度）                               | 接近真实句/子句数     |
| `gaps(>0.4s)`  | 句间停顿数（停顿还原 = 无声不显字幕，#55）         | > 0，接近真实长停顿数 |
| `inSilence`    | 与所有语音段零重叠的 cue（VAD-off 多为深静音幻觉） | ≈ 0（或贴边界真实词） |
| `short(<0.8s)` | 文本 ≥2 字却一闪而过的过短 cue（D15）              | 0                     |

> 这是 **macOS 手动冒烟测试**（需 whisper 模型 + 原生 addon），不进 CI。纯逻辑单测见
> `scripts/test-engine-units.ts`（`npm run test:engines`）。

## 文件

- `fixtures.ts` — 单一数据源：zh/en/ja 朗读脚本 + 句间 `[[slnc ms]]` 长静音布局 + `say` 音色。
- `gen-audio.ts` — 用 macOS `say` + 项目自带 ffmpeg 合成 16k 单声道 WAV 到 `.longgap/audio/`（gitignored）。
- `run.ts` — 逐语种 × 模型 × VAD on/off 跑完整管道，输出对照 + 汇总表 + SRT 到 `.longgap/out/`。

## 前置条件

1. **macOS**（依赖系统 `say`；音色 `Tingting`/`Samantha`/`Kyoko`，`say -v '?'` 可查）。
   非 macOS：自备 `.longgap/audio/<lang>.wav`（16k 单声道）。
2. **whisper 模型** `ggml-<model>.bin` 放在 `LONGGAP_MODELS_DIR`（默认 `~/Downloads/translate/models`）。
3. **extraResources/**：`addons/addon.node`、`ggml-silero-v6.2.0.bin`、`sherpa/native|vad|worker`
   （随仓库或本地构建；Silero 不可用时自动回退能量法）。

## 运行

```bash
# 一键：缺音频自动合成 → 跑三语种 × medium,base-q8_0 × VAD on/off
npm run test:longgap

# 仅（重新）生成音频
npm run longgap:gen

# 自定义范围
LONGGAP_LANGS=en,ja LONGGAP_MODELS=medium npm run test:longgap
LONGGAP_MODELS_DIR=/path/to/models npm run test:longgap
```

可调环境变量：`LONGGAP_LANGS` `LONGGAP_MODELS` `LONGGAP_MODELS_DIR` `LONGGAP_AUDIO_DIR` `LONGGAP_OUT_DIR`。

## 解读

- **VAD-on** 走 `retime→group→clamp→merge→minDisp`；**VAD-off** 走 `group→clampDom→merge→drop→minDisp`。
- VAD-off 还列出 `drop-only` / `clamp+drop(旧)` / `clampDom+drop(D13)` 对照，凸显为何选 clampDom。
- `raw VAD-off token gaps` 诊断 token 时间轴连续性（**与语言相关**：zh/ja 常为 0、en 可能 >0）。
- 结尾汇总表给出各语种生产管道的 cues/gaps/inSilence/short，一眼看泛化是否达标。
