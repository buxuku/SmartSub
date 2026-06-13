import type {
  AddonVariant,
  CudaVersion,
  DownloadSource,
} from '../../../../types/addon';

export interface InstalledAddonInfo {
  version: AddonVariant;
  info: {
    installedAt: string;
    remoteVersion: string;
    hasDlls: boolean;
    size: number;
  };
}

export type PackageEdition = 'full' | 'lite';

export interface CudaDownloadSheetState {
  open: boolean;
  presetVersion: CudaVersion | null;
}

export type DownloadSourcePersisted = DownloadSource;
