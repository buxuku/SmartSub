import fs from 'node:fs';
import path from 'node:path';
import { resolveModelRoot, type StorageKind } from '../storagePaths';

/** Installed model files are identified separately from mutable machine preferences. */
export function captureModelIdentity(
  config: Record<string, any>,
  settings: Record<string, any>,
  userData: string,
) {
  const engine = config.transcriptionEngine || 'builtin';
  const kind = (
    {
      builtin: 'ggml',
      fasterWhisper: 'ct2',
      funasr: 'funasr',
      qwen: 'qwen',
      fireRedAsr: 'firered',
      parakeet: 'parakeet',
    } as Record<string, StorageKind>
  )[engine];
  if (!kind) return { engine, model: config.model, files: [] };
  const root = resolveModelRoot(kind, settings, userData).path;
  const files: Array<{
    path: string;
    size: number;
    mtimeMs: number;
    ctimeMs: number;
  }> = [];
  const visit = (target: string) => {
    if (!fs.existsSync(target)) return;
    const stat = fs.statSync(target);
    if (stat.isDirectory())
      for (const child of fs.readdirSync(target).sort())
        visit(path.join(target, child));
    else if (stat.isFile())
      files.push({
        path: path.relative(root, target),
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        ctimeMs: stat.ctimeMs,
      });
  };
  if (kind === 'ggml')
    visit(path.join(root, `ggml-${path.basename(config.model || '')}.bin`));
  else {
    const selected = path.join(root, path.basename(config.model || ''));
    visit(fs.existsSync(selected) ? selected : root);
  }
  return { engine, model: config.model, root, files };
}
