import fs from 'fs';
import path from 'path';
import type { SubtitleOutputFormat } from '../../types/subtitleOutput';
import { convertSubtitleContent, getFormatExtension } from './subtitleFormats';
import { atomicReplaceTextFile } from './atomicFile';

export interface SubtitleDeliverableRequest {
  kind: 'source' | 'target';
  srtPath: string;
  formats: SubtitleOutputFormat[];
}

export interface SubtitleDeliverableResult {
  kind: 'source' | 'target';
  srtPath: string;
  files: string[];
}

function pathKey(filePath: string): string {
  const resolved = path.resolve(filePath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** Validate all paths, then atomically replace individual files. Keep canonical SRTs. */
export async function writeSubtitleDeliverables(
  requests: SubtitleDeliverableRequest[],
  protectedPaths: string[] = [],
  signal?: AbortSignal,
): Promise<SubtitleDeliverableResult[]> {
  const protectedKeys = new Set(protectedPaths.map(pathKey));
  const owners = new Map<string, string>();
  for (const request of requests) {
    const key = pathKey(request.srtPath);
    if (owners.has(key))
      throw new Error('Source and translated subtitle paths overlap');
    owners.set(key, request.kind);
  }
  const results = requests.map((request) => {
    if (!/\.srt$/i.test(request.srtPath) || !request.formats.length) {
      throw new Error(
        'Subtitle export requires an SRT source and at least one format',
      );
    }
    const files = request.formats.map((format) => {
      const outputPath = request.srtPath.replace(
        /\.srt$/i,
        getFormatExtension(format),
      );
      const key = pathKey(outputPath);
      if (
        protectedKeys.has(key) ||
        (owners.has(key) && owners.get(key) !== request.kind)
      ) {
        throw new Error(
          `Subtitle export would overwrite an input or another output: ${outputPath}`,
        );
      }
      owners.set(key, request.kind);
      return outputPath;
    });
    return { kind: request.kind, srtPath: request.srtPath, files };
  });

  for (let index = 0; index < requests.length; index++) {
    signal?.throwIfAborted();
    const request = requests[index];
    const content = await fs.promises.readFile(request.srtPath, 'utf-8');
    for (let i = 0; i < request.formats.length; i++) {
      signal?.throwIfAborted();
      const outputPath = results[index].files[i];
      if (pathKey(outputPath) === pathKey(request.srtPath)) continue;
      await atomicReplaceTextFile(
        outputPath,
        convertSubtitleContent(content, 'srt', request.formats[i]),
        { signal },
      );
    }
  }
  return results;
}
