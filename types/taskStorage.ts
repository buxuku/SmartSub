export interface TaskStorageRootStatus {
  path: string;
  bytes: number;
  available: boolean;
}
export interface TaskStorageStatus {
  root: string;
  roots: TaskStorageRootStatus[];
  migration?: { id: string; phase: string; error?: string };
}
export interface TaskStorageMigrationPreview {
  id: string;
  target: string;
  sources: string[];
  files: number;
  bytes: number;
  blockers: string[];
}
export interface TaskStorageCleanupResult {
  files: number;
  bytes: number;
  errors: string[];
}
