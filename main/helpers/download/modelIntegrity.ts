import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { SINGLE_DOWNLOAD_CANCELLED } from './singleFileDownloader';

export interface ModelIntegrityManifest {
  archive: string;
  archive_bytes: number;
  archive_sha256: string;
  files: { path: string; bytes: number; sha256: string }[];
}

export async function verifyModelFile(
  filename: string,
  sha256: string,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) throw new Error(SINGLE_DOWNLOAD_CANCELLED);
  const hash = createHash('sha256');
  const stream = fs.createReadStream(filename, { signal });
  try {
    for await (const chunk of stream) hash.update(chunk);
  } catch (error) {
    if (signal?.aborted) throw new Error(SINGLE_DOWNLOAD_CANCELLED);
    throw error;
  }
  if (hash.digest('hex') !== sha256) {
    throw new Error(`Model checksum mismatch: ${path.basename(filename)}`);
  }
}

export async function readModelIntegrityManifest(
  filename: string,
  expected: { manifestSha256: string; archiveSha256: string },
  archiveName: string,
  requiredFiles: string[],
  signal?: AbortSignal,
): Promise<ModelIntegrityManifest> {
  await verifyModelFile(filename, expected.manifestSha256, signal);
  const manifest: ModelIntegrityManifest = JSON.parse(
    await fs.promises.readFile(filename, 'utf8'),
  );
  if (
    manifest.archive !== archiveName ||
    manifest.archive_sha256 !== expected.archiveSha256 ||
    !Number.isSafeInteger(manifest.archive_bytes) ||
    manifest.archive_bytes <= 0 ||
    !Array.isArray(manifest.files) ||
    manifest.files.some(
      (file) =>
        !file ||
        typeof file.path !== 'string' ||
        !/^[a-zA-Z0-9_.-]+$/.test(file.path) ||
        file.path === '.' ||
        file.path === '..' ||
        !Number.isSafeInteger(file.bytes) ||
        file.bytes <= 0 ||
        !/^[a-f0-9]{64}$/.test(file.sha256),
    ) ||
    new Set(manifest.files.map((file) => file.path)).size !==
      manifest.files.length ||
    requiredFiles.some(
      (name) => !manifest.files.some((file) => file.path === name),
    )
  ) {
    throw new Error(
      'Model integrity manifest does not match the selected release',
    );
  }
  return manifest;
}

export async function verifyInstalledModelFiles(
  directory: string,
  manifest: ModelIntegrityManifest,
  signal?: AbortSignal,
): Promise<void> {
  for (const file of manifest.files) {
    const filename = path.join(directory, file.path);
    const stat = await fs.promises.lstat(filename);
    if (!stat.isFile() || stat.size !== file.bytes) {
      throw new Error(`Model file size or type mismatch: ${file.path}`);
    }
    await verifyModelFile(filename, file.sha256, signal);
  }
}
