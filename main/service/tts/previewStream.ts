import { spawn } from 'child_process';
import { Readable } from 'stream';
import ffmpeg from 'ffmpeg-static';
import type { TtsSegmentRequest } from '../../../types/ttsProvider';
import { assertDubbingSpeakerSettings } from '../../../types/dubbing';
import {
  buildAtempoChain,
  writePcmAsWav,
} from '../../helpers/dubbing/audioPipeline';
import { TaskCancelledError } from '../../helpers/taskContext';
import type { TtsSynthesizeResult } from './types';

/** Decode provider bytes incrementally. Only three seconds of output are retained. */
export async function streamPreviewAudio(
  body: ReadableStream<Uint8Array> | Readable | null,
  request: TtsSegmentRequest,
  rawPcm = false,
): Promise<TtsSynthesizeResult> {
  if (!body || !request.preview)
    throw new Error('Missing preview audio stream');
  if (request.signal?.aborted) throw new TaskCancelledError();
  const settings = request.preview.settings || { speed: 1, pitch: 0 };
  assertDubbingSpeakerSettings(settings);
  const rate = 24000;
  const shifted = Math.round(rate * 2 ** (settings.pitch / 12));
  const filters = [
    'aresample=24000',
    `asetrate=${shifted}`,
    'aresample=24000',
    ...buildAtempoChain(settings.speed / (shifted / rate)).map(
      (factor) => `atempo=${factor}`,
    ),
  ];
  const source =
    body instanceof Readable ? body : Readable.fromWeb(body as any);
  return new Promise((resolve, reject) => {
    const child = spawn(
      ffmpeg.replace('app.asar', 'app.asar.unpacked'),
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-probesize',
        '32768',
        '-analyzeduration',
        '0',
        ...(rawPcm ? ['-f', 's16le', '-ar', String(rate), '-ac', '1'] : []),
        '-i',
        'pipe:0',
        '-vn',
        '-af',
        filters.join(','),
        '-t',
        '3',
        '-ar',
        String(rate),
        '-ac',
        '1',
        '-f',
        's16le',
        '-acodec',
        'pcm_s16le',
        '-flush_packets',
        '1',
        'pipe:1',
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const chunks: Buffer[] = [];
    let total = 0;
    let tail = Buffer.alloc(0);
    let stderr = '';
    let failure: Error | undefined;
    const stop = (error: Error) => {
      failure ||= error;
      source.unpipe(child.stdin);
      source.destroy();
      child.kill('SIGKILL');
    };
    const onAbort = () => stop(new TaskCancelledError());
    const timeout = setTimeout(
      () => stop(new Error('Voice preview stream timed out')),
      60_000,
    );
    request.signal?.addEventListener('abort', onAbort, { once: true });
    child.stderr.on('data', (data: Buffer) => {
      stderr = (stderr + data.toString()).slice(-4096);
    });
    child.stdout.on('data', (data: Buffer) => {
      if (failure || request.signal?.aborted) return;
      const joined = Buffer.concat([tail, data]);
      const length = Math.min(
        joined.length - (joined.length % 2),
        rate * 2 * 3 - total,
      );
      tail = joined.subarray(length);
      if (!length) return;
      const pcm = Buffer.from(joined.subarray(0, length));
      chunks.push(pcm);
      total += pcm.length;
      try {
        request.preview!.onPcm(pcm, rate);
      } catch (error) {
        stop(error instanceof Error ? error : new Error(String(error)));
      }
    });
    source.on('error', (error) => stop(error));
    child.stdin.on('error', (error: NodeJS.ErrnoException) => {
      // FFmpeg deliberately closes input at the three-second output boundary.
      if (error.code !== 'EPIPE') stop(error);
    });
    child.on('error', (error) => {
      failure ||= error;
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      request.signal?.removeEventListener('abort', onAbort);
      source.unpipe(child.stdin);
      source.destroy();
      if (failure || code !== 0 || !total) {
        reject(
          failure ||
            new Error(`Voice preview decoding failed: ${stderr || code}`),
        );
        return;
      }
      try {
        const durationMs = writePcmAsWav(
          Buffer.concat(chunks),
          rate,
          request.outWavPath,
        );
        resolve({ wavPath: request.outWavPath, durationMs });
      } catch (error) {
        reject(error);
      }
    });
    source.pipe(child.stdin);
  });
}
