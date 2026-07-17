import { useCallback, useEffect, useState } from 'react';
import type {
  Glossary,
  GlossaryEntry,
  GlossaryFileFormat,
} from '../../types/glossary';

export interface GlossaryIpcResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  canceled?: boolean;
}

export function useGlossaries() {
  const [glossaries, setGlossaries] = useState<Glossary[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const list: Glossary[] | undefined =
        await window?.ipc?.invoke('glossaries:list');
      setGlossaries(Array.isArray(list) ? list : []);
      return Array.isArray(list) ? list : [];
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const create = useCallback(
    async (input: { name: string; description?: string }) => {
      const result = (await window.ipc.invoke(
        'glossaries:create',
        input,
      )) as GlossaryIpcResult<Glossary>;
      if (result.success) await refresh();
      return result;
    },
    [refresh],
  );

  const update = useCallback(
    async (
      id: string,
      patch: { name?: string; description?: string; enabled?: boolean },
    ) => {
      const result = (await window.ipc.invoke('glossaries:update', {
        id,
        patch,
      })) as GlossaryIpcResult<Glossary>;
      if (result.success) await refresh();
      return result;
    },
    [refresh],
  );

  const remove = useCallback(
    async (id: string) => {
      const result = (await window.ipc.invoke(
        'glossaries:delete',
        id,
      )) as GlossaryIpcResult;
      if (result.success) await refresh();
      return result;
    },
    [refresh],
  );

  const move = useCallback(async (id: string, direction: -1 | 1) => {
    const result = (await window.ipc.invoke('glossaries:move', {
      id,
      direction,
    })) as GlossaryIpcResult<Glossary[]>;
    if (result.success && Array.isArray(result.data)) {
      setGlossaries(result.data);
    }
    return result;
  }, []);

  const saveEntry = useCallback(
    async (glossaryId: string, entry: Partial<GlossaryEntry>) => {
      const result = (await window.ipc.invoke('glossaries:save-entry', {
        glossaryId,
        entry,
      })) as GlossaryIpcResult<GlossaryEntry>;
      if (result.success) await refresh();
      return result;
    },
    [refresh],
  );

  const deleteEntry = useCallback(
    async (glossaryId: string, entryId: string) => {
      const result = (await window.ipc.invoke('glossaries:delete-entry', {
        glossaryId,
        entryId,
      })) as GlossaryIpcResult;
      if (result.success) await refresh();
      return result;
    },
    [refresh],
  );

  const importEntries = useCallback(
    async (glossaryId: string) => {
      const result = (await window.ipc.invoke(
        'glossaries:import',
        glossaryId,
      )) as GlossaryIpcResult<{
        glossary: Glossary;
        added: number;
        updated: number;
        skipped: number;
      }>;
      if (result.success) await refresh();
      return result;
    },
    [refresh],
  );

  const exportEntries = useCallback(
    async (glossaryId: string, format: GlossaryFileFormat) =>
      (await window.ipc.invoke('glossaries:export', {
        glossaryId,
        format,
      })) as GlossaryIpcResult<{ filePath: string }>,
    [],
  );

  const exportTemplate = useCallback(
    async () =>
      (await window.ipc.invoke(
        'glossaries:export-template',
      )) as GlossaryIpcResult<{ filePath: string }>,
    [],
  );

  return {
    glossaries,
    loading,
    refresh,
    create,
    update,
    remove,
    move,
    saveEntry,
    deleteEntry,
    importEntries,
    exportEntries,
    exportTemplate,
  };
}
