import fs from 'fs';
import type { SubtitleOutputFormat } from '../../types/subtitleOutput';
import { convertSubtitleContent, getFormatExtension } from './subtitleFormats';
import { atomicReplaceTextFile } from './atomicFile';
import {
  createSubtitlePathIdentity,
  type SubtitlePathOperations,
} from './subtitlePathIdentity';

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

/** Validate all paths, then atomically replace individual files. Keep canonical SRTs. */
export async function writeSubtitleDeliverables(
  requests: SubtitleDeliverableRequest[],
  protectedPaths: string[] = [],
  signal?: AbortSignal,
  pathOperations?: SubtitlePathOperations,
): Promise<SubtitleDeliverableResult[]> {
  signal?.throwIfAborted();
  if (!requests.length) return [];
  const identify = createSubtitlePathIdentity(pathOperations);
  const keys = async (filePath: string) => {
    const identity = await identify(filePath);
    return [
      `name:${identity.name}`,
      ...(identity.inode ? [`inode:${identity.inode}`] : []),
    ];
  };
  const protectedKeys = new Set<string>();
  for (const protectedPath of protectedPaths) {
    for (const key of await keys(protectedPath)) protectedKeys.add(key);
  }
  const owners = new Map<string, number>();
  const canonicalKeys: string[][] = [];
  for (let index = 0; index < requests.length; index++) {
    canonicalKeys[index] = await keys(requests[index].srtPath);
    for (const key of canonicalKeys[index]) {
      if (owners.has(key))
        throw new Error('Source and translated subtitle paths overlap');
      owners.set(key, index);
    }
  }
  const results: SubtitleDeliverableResult[] = [];
  for (let index = 0; index < requests.length; index++) {
    const request = requests[index];
    if (!/\.srt$/i.test(request.srtPath) || !request.formats.length) {
      throw new Error(
        'Subtitle export requires an SRT source and at least one format',
      );
    }
    const files: string[] = [];
    for (const format of request.formats) {
      const outputPath = request.srtPath.replace(
        /\.srt$/i,
        getFormatExtension(format),
      );
      const outputKeys = await keys(outputPath);
      for (const key of outputKeys) {
        if (
          protectedKeys.has(key) ||
          (owners.has(key) && owners.get(key) !== index)
        ) {
          throw new Error(
            `Subtitle export would overwrite an input or another output: ${outputPath}`,
          );
        }
        owners.set(key, index);
      }
      files.push(
        outputKeys[0] === canonicalKeys[index][0]
          ? request.srtPath
          : outputPath,
      );
    }
    results.push({ kind: request.kind, srtPath: request.srtPath, files });
  }

  for (let index = 0; index < requests.length; index++) {
    signal?.throwIfAborted();
    const request = requests[index];
    const content = await fs.promises.readFile(request.srtPath, 'utf-8');
    for (let i = 0; i < request.formats.length; i++) {
      signal?.throwIfAborted();
      const outputPath = results[index].files[i];
      if (outputPath === request.srtPath) continue;
      await atomicReplaceTextFile(
        outputPath,
        convertSubtitleContent(content, 'srt', request.formats[i]),
        { signal },
      );
    }
  }
  return results;
}
