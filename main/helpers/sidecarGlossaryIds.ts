export interface SidecarGlossaryData {
  meta: {
    glossaryIds?: string[];
  };
}

export type SidecarGlossaryReader = (
  filePath: string,
) => Promise<SidecarGlossaryData>;

/**
 * Missing sidecars preserve the standalone-proofread fallback. Once a path is
 * present, read/parse errors deliberately propagate so callers cannot confuse
 * corrupt task state with the legacy "use all globally enabled" state.
 */
export async function loadSidecarGlossaryIds(
  proofreadDataFile: string | undefined,
  readSidecar: SidecarGlossaryReader,
): Promise<string[] | undefined> {
  if (!proofreadDataFile) return undefined;
  const data = await readSidecar(proofreadDataFile);
  return data.meta.glossaryIds;
}
