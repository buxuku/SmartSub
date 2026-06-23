import ct2Catalog from '../../renderer/lib/fasterWhisperModels.json';

export type Ct2CatalogEntry = {
  id: string;
  hfRepo: string;
  size: string;
  tier: 'fast' | 'balanced' | 'accurate';
  speed: number;
  quality: number;
  englishOnly?: boolean;
  distil?: boolean;
};

const catalog = ct2Catalog as Ct2CatalogEntry[];

export function getCt2Catalog(): Ct2CatalogEntry[] {
  return catalog;
}

export function getCt2HfRepo(modelId: string): string {
  const entry = catalog.find((m) => m.id === modelId);
  if (!entry?.hfRepo) {
    throw new Error(`Unknown faster-whisper model: ${modelId}`);
  }
  return entry.hfRepo;
}

export function hfRepoToCacheDirName(repoId: string): string {
  return `models--${repoId.replace(/\//g, '--')}`;
}

export function cacheDirNameToModelId(cacheDirName: string): string | null {
  for (const entry of catalog) {
    if (hfRepoToCacheDirName(entry.hfRepo) === cacheDirName) {
      return entry.id;
    }
  }
  return null;
}
