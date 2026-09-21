import fs from 'fs/promises';
import path from 'path';
import { spawn } from 'child_process';
import ffmpegStatic from 'ffmpeg-static';
import type { WaveformData } from '../../types/waveform';

const SAMPLE_RATE = 8000;
const BUCKET_SIZE = 160;
const MAX_SAMPLES = SAMPLE_RATE * 60 * 60 * 12;
const cache = new Map<string, WaveformData>();
const jobs = new Map<string, AbortController>();

/** Reduce a streaming PCM signal with bounded memory, including split samples. */
export class WaveformAccumulator {
  private peaks: number[] = [];
  private peak = 0;
  private count = 0;
  private total = 0;
  private carry: number | undefined;

  add(chunk: Buffer) {
    let offset = 0;
    const sample = (value: number) => {
      this.peak = Math.max(this.peak, Math.abs(value) / 32768);
      this.count++;
      this.total++;
      if (this.total > MAX_SAMPLES) throw new Error('WAVEFORM_DURATION_LIMIT');
      if (this.count === BUCKET_SIZE) {
        this.peaks.push(this.peak);
        this.peak = 0;
        this.count = 0;
      }
    };
    if (this.carry !== undefined && chunk.length) {
      const unsigned = this.carry | (chunk[0] << 8);
      sample(unsigned > 32767 ? unsigned - 65536 : unsigned);
      this.carry = undefined;
      offset = 1;
    }
    for (; offset + 1 < chunk.length; offset += 2)
      sample(chunk.readInt16LE(offset));
    if (offset < chunk.length) this.carry = chunk[offset];
  }

  finish(): WaveformData {
    if (this.carry !== undefined) throw new Error('WAVEFORM_INVALID_PCM');
    if (!this.total) throw new Error('WAVEFORM_NO_AUDIO');
    if (this.count) this.peaks.push(this.peak);
    const duration = this.total / SAMPLE_RATE;
    const step = BUCKET_SIZE / SAMPLE_RATE;
    const silenceEdges: number[] = [];
    let start = -1;
    for (let i = 0; i <= this.peaks.length; i++) {
      if (i < this.peaks.length && this.peaks[i] < 0.008) {
        if (start < 0) start = i;
      } else if (start >= 0) {
        if (i - start >= 6)
          silenceEdges.push(start * step, Math.min(i * step, duration));
        start = -1;
      }
    }
    return {
      duration,
      step,
      peaks: Float32Array.from(this.peaks),
      silenceEdges,
    };
  }
}

export async function extractWaveform(
  filePath: string,
  signal?: AbortSignal,
): Promise<WaveformData> {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath))
    throw new Error('WAVEFORM_INVALID_PATH');
  signal?.throwIfAborted();
  const realPath = await fs.realpath(filePath);
  const stat = await fs.stat(realPath);
  signal?.throwIfAborted();
  if (!stat.isFile()) throw new Error('WAVEFORM_INVALID_PATH');
  const key = JSON.stringify([realPath, stat.size, stat.mtimeMs, stat.ctimeMs]);
  const cached = cache.get(key);
  if (cached) return cached;
  signal?.throwIfAborted();
  const data = await new Promise<WaveformData>((resolve, reject) => {
    const child = spawn(
      ffmpegStatic.replace('app.asar', 'app.asar.unpacked'),
      [
        '-nostdin',
        '-hide_banner',
        '-loglevel',
        'error',
        '-i',
        realPath,
        '-map',
        '0:a:0',
        '-vn',
        '-ac',
        '1',
        '-ar',
        String(SAMPLE_RATE),
        '-f',
        's16le',
        'pipe:1',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
    );
    const accumulator = new WaveformAccumulator();
    let detail = '';
    let failure: unknown;
    const abort = () => child.kill('SIGKILL');
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.stdout.on('data', (chunk: Buffer) => {
      try {
        accumulator.add(chunk);
      } catch (error) {
        failure = error;
        abort();
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      detail = (detail + chunk.toString()).slice(-2000);
    });
    child.on('error', (error) => {
      failure = error;
    });
    child.on('close', (code) => {
      signal?.removeEventListener('abort', abort);
      try {
        signal?.throwIfAborted();
        if (failure) throw failure;
        if (code !== 0)
          throw new Error(detail || `WAVEFORM_PROCESS_EXIT_${code}`);
        resolve(accumulator.finish());
      } catch (error) {
        reject(error);
      }
    });
  });
  // Keep at most two decoded envelopes, never full-resolution audio.
  if (cache.size >= 2) cache.delete(cache.keys().next().value!);
  cache.set(key, data);
  return data;
}

export async function loadProofreadWaveform(
  owner: number,
  requestId: string,
  filePath: string,
) {
  if (typeof requestId !== 'string' || !requestId || requestId.length > 100)
    throw new Error('WAVEFORM_INVALID_REQUEST');
  cancelProofreadWaveforms(owner);
  const key = `${owner}:${requestId}`;
  const controller = new AbortController();
  jobs.set(key, controller);
  try {
    return await extractWaveform(filePath, controller.signal);
  } finally {
    if (jobs.get(key) === controller) jobs.delete(key);
  }
}

export function cancelProofreadWaveforms(owner?: number, requestId?: string) {
  for (const [key, controller] of jobs) {
    if (owner !== undefined && !key.startsWith(`${owner}:`)) continue;
    if (requestId !== undefined && key !== `${owner}:${requestId}`) continue;
    controller.abort();
    jobs.delete(key);
  }
}
