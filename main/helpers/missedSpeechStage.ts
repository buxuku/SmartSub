import fs from 'fs';
import type { IFiles } from '../../types';
import { summarizeMissedSpeech } from '../../types/missedSpeech';
import type { SpeechInterval } from '../../types/missedSpeech';
import { readWavInfo } from './dubbing/audioPipeline';
import { windowFrameDb } from './wavWindowEnergy';
import { parseStartEndTime, parseSubtitleEntries } from './subtitleFormats';
import { throwIfSignalCancelled, isTaskCancelledError } from './taskContext';
import { logMessage } from './storeManager';
import {
  detectMissedSpeech,
  mergeSpeechIntervals,
  type TranscriptionDiagnostics,
} from './missedSpeechWarning';

/** Bounded reads keep long recordings out of a single large allocation. */
export async function scanSpeechEnergy(
  audioPath: string,
  signal?: AbortSignal,
) {
  const layout = readWavInfo(audioPath);
  if (
    layout.bitsPerSample !== 16 ||
    layout.channels !== 1 ||
    layout.sampleRate !== 16000
  ) {
    throw new Error('Expected transcription PCM16 mono 16kHz audio');
  }
  const segments: SpeechInterval[] = [];
  for (let offset = 0; offset < layout.durationMs; offset += 30000) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    throwIfSignalCancelled(signal);
    const frames = windowFrameDb(
      audioPath,
      layout,
      offset / 1000,
      Math.min(offset + 30000, layout.durationMs) / 1000,
    );
    if (!frames) continue;
    const sorted = [...frames.frameDb].sort((a, b) => a - b);
    const percentile = (p: number) =>
      sorted[Math.round((sorted.length - 1) * p)];
    const floor = percentile(0.15);
    const peak = percentile(0.95);
    // Sustained tones/noise are not useful speech evidence. Energy cannot distinguish all music.
    if (peak < -55 || peak - floor < 6) continue;
    const threshold = Math.max(-55, Math.min(floor + 12, peak - 6));
    const frameMs = frames.frameDurationSec * 1000;
    let start = -1;
    for (let i = 0; i <= frames.frameDb.length; i++) {
      const active =
        i < frames.frameDb.length && frames.frameDb[i] >= threshold;
      if (active && start < 0) start = i;
      if (!active && start >= 0) {
        segments.push({
          startMs: offset + start * frameMs,
          endMs: offset + i * frameMs,
        });
        start = -1;
      }
    }
  }
  throwIfSignalCancelled(signal);
  return {
    durationMs: layout.durationMs,
    energySegments: mergeSpeechIntervals(
      segments,
      layout.durationMs,
      200,
    ).filter((s) => s.endMs - s.startMs >= 120),
  };
}

export async function runMissedSpeechCheck(
  file: IFiles,
  diagnostics: TranscriptionDiagnostics,
  signal?: AbortSignal,
): Promise<void> {
  try {
    throwIfSignalCancelled(signal);
    if (!file.tempAudioFile || !file.srtFile) return;
    const audio = await scanSpeechEnergy(file.tempAudioFile, signal);
    const entries = parseSubtitleEntries(
      await fs.promises.readFile(file.srtFile, 'utf8'),
      'srt',
    );
    const cues = entries.map((entry) => ({
      id: entry.id,
      ...parseStartEndTime(entry.startEndTime),
      text: entry.content.join('\n'),
    }));
    throwIfSignalCancelled(signal);
    file.missedSpeechWarnings = detectMissedSpeech({
      ...audio,
      ...diagnostics,
      cues,
    });
    file.missedSpeechSummary = summarizeMissedSpeech(
      file.missedSpeechWarnings,
      diagnostics.vadAvailable === true,
    );
    logMessage(
      `Suspected missed speech: ${file.missedSpeechWarnings.length} ranges (${file.fileName})`,
      file.missedSpeechWarnings.length ? 'warning' : 'info',
    );
  } catch (error) {
    if (isTaskCancelledError(error) || signal?.aborted) throw error;
    logMessage(
      `Missed speech check unavailable (non-fatal): ${error}`,
      'warning',
    );
  }
}
