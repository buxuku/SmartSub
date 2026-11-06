let maintenance = false;
export function assertTaskStorageWritable() {
  if (maintenance) throw new Error('TASK_STORAGE_MAINTENANCE');
}
export async function withTaskStorageMaintenance<T>(
  work: () => Promise<T>,
): Promise<T> {
  assertTaskStorageWritable();
  maintenance = true;
  try {
    return await work();
  } finally {
    maintenance = false;
  }
}
