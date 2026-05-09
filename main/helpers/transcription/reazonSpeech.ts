import { execFile } from 'child_process';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import ffmpegStatic from 'ffmpeg-static';
import { promisify } from 'util';
import { logMessage, store } from '../storeManager';
import { ensureTempDir, getMd5 } from '../fileUtils';
import { getPath } from '../whisper';
import {
  REAZON_SPEECH_K2_V2_MODEL,
  REAZON_SPEECH_K2_V2_FILES,
  type TranscriptionResult,
  type TranscriptionSegment,
} from '../../../types';
import { getAudioDurationSeconds, makeApproximateSegments } from './srt';

const execFileAsync = promisify(execFile);

export const REAZON_K2_MAX_SEGMENT_SECONDS = 28;

export const REAZON_K2_MODEL_FILES = REAZON_SPEECH_K2_V2_FILES;
const DEFAULT_REAZON_SPEECH_MODEL: typeof REAZON_SPEECH_K2_V2_MODEL =
  'reazonspeech-k2-v2';

export function getReazonSpeechModelDir(model = REAZON_SPEECH_K2_V2_MODEL) {
  return path.join(getPath('modelsPath'), model);
}

export function isReazonSpeechModelInstalled(
  model = REAZON_SPEECH_K2_V2_MODEL,
): boolean {
  const modelDir = getReazonSpeechModelDir(model);
  return REAZON_K2_MODEL_FILES.every((file) =>
    fs.existsSync(path.join(modelDir, file)),
  );
}

function getPythonCommand(): string {
  const settings = (store.get('settings') || {}) as Record<string, any>;
  return settings.reazonSpeechPythonCommand || 'python3';
}

async function ensureReazonSpeechRuntimeReady(): Promise<void> {
  const python = getPythonCommand();
  const script = `
import importlib
import json

missing = []
for module_name in ["sherpa_onnx", "reazonspeech.k2.asr"]:
    try:
        importlib.import_module(module_name)
    except Exception as exc:
        missing.append({"module": module_name, "detail": str(exc)})

if missing:
    raise SystemExit(json.dumps({
        "error": "ReazonSpeech Python runtime is not ready.",
        "missing": missing,
    }, ensure_ascii=False))

print(json.dumps({"ok": True}, ensure_ascii=False))
`.trim();

  try {
    await execFileAsync(python, ['-c', script], {
      env: {
        ...process.env,
        PYTHONIOENCODING: 'UTF-8',
      },
      maxBuffer: 1024 * 1024,
    });
  } catch (error: any) {
    const output = `${error?.stdout || ''}\n${error?.stderr || ''}`.trim();
    let detail = output || error?.message || String(error);
    try {
      const parsed = JSON.parse(output);
      if (parsed.error) {
        const missing = (parsed.missing || [])
          .map(
            (item: { module?: string; detail?: string }) =>
              `${item.module}: ${item.detail}`,
          )
          .join('; ');
        detail = `${parsed.error}${missing ? ` ${missing}` : ''}`;
      }
    } catch {
      // Keep the raw command output.
    }
    throw new Error(`ReazonSpeech 运行环境未就绪：${detail}`);
  }
}

function throwIfReazonCancelled(isCancellationRequested?: () => boolean) {
  if (isCancellationRequested?.()) {
    throw new Error('任务已取消');
  }
}

async function splitAudioForReazon(audioPath: string): Promise<string[]> {
  const duration = await getAudioDurationSeconds(audioPath);
  if (duration > 0 && duration <= REAZON_K2_MAX_SEGMENT_SECONDS + 1) {
    return [audioPath];
  }

  const ffmpegPath = ffmpegStatic.replace('app.asar', 'app.asar.unpacked');
  const chunkDir = path.join(ensureTempDir(), `reazon-${getMd5(audioPath)}`);
  await fs.emptyDir(chunkDir);

  const chunkPattern = path.join(chunkDir, 'chunk-%05d.wav');
  await execFileAsync(ffmpegPath, [
    '-y',
    '-i',
    audioPath,
    '-ar',
    '16000',
    '-ac',
    '1',
    '-c:a',
    'pcm_s16le',
    '-f',
    'segment',
    '-segment_time',
    String(REAZON_K2_MAX_SEGMENT_SECONDS),
    '-reset_timestamps',
    '1',
    chunkPattern,
  ]);

  const chunks = (await fs.readdir(chunkDir))
    .filter((file) => file.endsWith('.wav'))
    .sort()
    .map((file) => path.join(chunkDir, file));

  return chunks.length > 0 ? chunks : [audioPath];
}

function buildPythonScript(): string {
  return `
import json
import os
import sys

try:
    import sherpa_onnx
    from reazonspeech.k2.asr import transcribe, audio_from_path
except Exception as exc:
    raise SystemExit(json.dumps({
        "error": "reazonspeech.k2.asr or sherpa_onnx is not installed. Install ReazonSpeech/pkg/k2-asr first.",
        "detail": str(exc),
    }, ensure_ascii=False))

model_dir = sys.argv[1]
device = sys.argv[2]
precision = sys.argv[3]
language = sys.argv[4]
audio_files = sys.argv[5:]

if language != "ja":
    raise SystemExit(json.dumps({
        "error": "SmartSub currently downloads the Japanese ReazonSpeech K2 v2 model only.",
        "detail": f"Unsupported language: {language}",
    }, ensure_ascii=False))

files_by_precision = {
    "fp32": {
        "tokens": "tokens.txt",
        "encoder": "encoder-epoch-99-avg-1.onnx",
        "decoder": "decoder-epoch-99-avg-1.onnx",
        "joiner": "joiner-epoch-99-avg-1.onnx",
    },
    "int8": {
        "tokens": "tokens.txt",
        "encoder": "encoder-epoch-99-avg-1.int8.onnx",
        "decoder": "decoder-epoch-99-avg-1.int8.onnx",
        "joiner": "joiner-epoch-99-avg-1.int8.onnx",
    },
    "int8-fp32": {
        "tokens": "tokens.txt",
        "encoder": "encoder-epoch-99-avg-1.int8.onnx",
        "decoder": "decoder-epoch-99-avg-1.onnx",
        "joiner": "joiner-epoch-99-avg-1.int8.onnx",
    },
}

if precision not in files_by_precision:
    raise SystemExit(json.dumps({
        "error": f"Unsupported ReazonSpeech precision: {precision}",
    }, ensure_ascii=False))

files = files_by_precision[precision]
for filename in files.values():
    path = os.path.join(model_dir, filename)
    if not os.path.exists(path):
        raise SystemExit(json.dumps({
            "error": "ReazonSpeech model file is missing.",
            "detail": path,
        }, ensure_ascii=False))

model = sherpa_onnx.OfflineRecognizer.from_transducer(
    tokens=os.path.join(model_dir, files["tokens"]),
    encoder=os.path.join(model_dir, files["encoder"]),
    decoder=os.path.join(model_dir, files["decoder"]),
    joiner=os.path.join(model_dir, files["joiner"]),
    num_threads=1,
    sample_rate=16000,
    feature_dim=80,
    decoding_method="greedy_search",
    provider=device,
)
results = []
for audio_file in audio_files:
    audio = audio_from_path(audio_file)
    ret = transcribe(model, audio)
    results.append({
        "text": ret.text,
        "subwords": [
            {"seconds": float(item.seconds), "token": item.token}
            for item in getattr(ret, "subwords", [])
        ],
    })

print(json.dumps({"results": results}, ensure_ascii=False))
`.trim();
}

async function runReazonPython(
  modelDir: string,
  chunkPaths: string[],
): Promise<
  Array<{ text: string; subwords?: Array<{ seconds: number; token: string }> }>
> {
  const settings = (store.get('settings') || {}) as Record<string, any>;
  const scriptPath = path.join(ensureTempDir(), 'smartsub-reazon-k2.py');
  await fs.writeFile(scriptPath, buildPythonScript(), 'utf8');

  const python = getPythonCommand();
  const device = settings.reazonSpeechDevice || 'cpu';
  const precision = settings.reazonSpeechPrecision || 'int8';
  const language = settings.reazonSpeechLanguage || 'ja';

  try {
    const { stdout, stderr } = await execFileAsync(
      python,
      [scriptPath, modelDir, device, precision, language, ...chunkPaths],
      {
        env: {
          ...process.env,
          PYTHONIOENCODING: 'UTF-8',
          HF_HOME: path.join(getPath('modelsPath'), '.huggingface'),
        },
        maxBuffer: 20 * 1024 * 1024,
      },
    );

    if (stderr) {
      logMessage(`ReazonSpeech stderr: ${stderr}`, 'warning');
    }

    const parsed = JSON.parse(stdout.trim());
    if (parsed.error) {
      throw new Error(
        `${parsed.error}${parsed.detail ? `: ${parsed.detail}` : ''}`,
      );
    }
    return parsed.results || [];
  } catch (error: any) {
    const output = `${error?.stdout || ''}`.trim();
    if (output) {
      let parsedError: Error | null = null;
      try {
        const parsed = JSON.parse(output);
        if (parsed.error) {
          parsedError = new Error(
            `${parsed.error}${parsed.detail ? `: ${parsed.detail}` : ''}`,
          );
        }
      } catch {
        // Fall through to the original error below.
      }
      if (parsedError) throw parsedError;
    }
    throw new Error(error?.message || String(error));
  }
}

function subwordsToSegments(
  subwords: Array<{ seconds: number; token: string }>,
  offsetSeconds: number,
): TranscriptionSegment[] {
  const segments: TranscriptionSegment[] = [];
  let currentText = '';
  let start = offsetSeconds;
  let last = offsetSeconds;

  for (const item of subwords) {
    const absolute = offsetSeconds + Number(item.seconds || 0);
    if (!currentText) start = absolute;
    currentText += item.token || '';
    last = absolute;

    const shouldFlush =
      /[。！？!?]$/.test(currentText) ||
      currentText.length >= 34 ||
      last - start >= 5;

    if (shouldFlush) {
      segments.push({
        start,
        end: Math.max(last, start + 0.5),
        text: currentText,
      });
      currentText = '';
    }
  }

  if (currentText) {
    segments.push({
      start,
      end: Math.max(last, start + 0.5),
      text: currentText,
    });
  }

  return segments;
}

export async function transcribeWithReazonSpeech(
  audioPath: string,
  formData: Record<string, any>,
  onProgress?: (progress: number) => void,
  isCancellationRequested?: () => boolean,
): Promise<TranscriptionResult> {
  const model = formData.model || DEFAULT_REAZON_SPEECH_MODEL;
  if (model !== REAZON_SPEECH_K2_V2_MODEL) {
    throw new Error(`Unsupported ReazonSpeech model: ${model}`);
  }

  if (!isReazonSpeechModelInstalled(model)) {
    throw new Error('请先在模型管理中下载 ReazonSpeech K2 v2 模型');
  }

  throwIfReazonCancelled(isCancellationRequested);
  onProgress?.(5);
  await ensureReazonSpeechRuntimeReady();
  throwIfReazonCancelled(isCancellationRequested);
  onProgress?.(10);

  const modelDir = getReazonSpeechModelDir(model);
  const chunkPaths = await splitAudioForReazon(audioPath);
  throwIfReazonCancelled(isCancellationRequested);
  onProgress?.(15);

  const segments: TranscriptionSegment[] = [];
  const texts: string[] = [];
  let offsetSeconds = 0;

  for (let index = 0; index < chunkPaths.length; index++) {
    const chunkPath = chunkPaths[index];
    throwIfReazonCancelled(isCancellationRequested);
    const results = await runReazonPython(modelDir, [chunkPath]);
    throwIfReazonCancelled(isCancellationRequested);
    const result = results[0] || { text: '', subwords: [] };
    const chunkDuration =
      (await getAudioDurationSeconds(chunkPath)) ||
      REAZON_K2_MAX_SEGMENT_SECONDS;
    const offset = offsetSeconds;
    if (result.text) texts.push(result.text);

    if (result.subwords?.length) {
      segments.push(...subwordsToSegments(result.subwords, offset));
    } else if (result.text) {
      segments.push(
        ...makeApproximateSegments(result.text, chunkDuration).map(
          (segment) => ({
            ...segment,
            start: segment.start + offset,
            end: segment.end + offset,
          }),
        ),
      );
    }
    offsetSeconds += chunkDuration;
    onProgress?.(Math.round(((index + 1) / chunkPaths.length) * 80 + 15));
  }

  logMessage(
    `ReazonSpeech transcription completed on ${os.platform()}`,
    'info',
  );
  return {
    text: texts.join(''),
    segments,
  };
}
