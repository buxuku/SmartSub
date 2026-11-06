export type ProofreadDraftStorageResult =
  | { success: true; raw: string | null }
  | { success: false; error: string };
