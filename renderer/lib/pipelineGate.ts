interface GateRequest {
  projectId: string;
  gate: 'subtitle' | 'dubbing';
  fileUuids?: string[];
  leaseId?: string;
}

/** Reconcile only the original target set; a lost reply must not release later arrivals. */
export async function releasePipelineGate(
  payload: GateRequest,
  isCurrent: () => boolean,
  onUncertain: (error: string) => void,
  onTargets?: (ids: string[]) => void,
) {
  const field = payload.gate === 'dubbing' ? 'dubbingGate' : 'subtitleGate';
  const before = await window.ipc.invoke('getWorkItem', payload.projectId);
  if (!isCurrent()) throw new Error('Gate editor has changed');
  if (!Array.isArray(before?.pipelineFiles)) throw new Error('Task not found');
  const ids: string[] = payload.fileUuids
    ? Array.from(new Set(payload.fileUuids))
    : before.pipelineFiles
        .filter((file) => file[field] === 'review')
        .map((file) => file.uuid);
  const confirmed = (item: any) =>
    ids.every((id) =>
      item?.pipelineFiles?.some(
        (file: any) => file.uuid === id && file[field] === 'passed',
      ),
    );
  onTargets?.(ids);
  if (!ids.length || confirmed(before)) return;
  const request = Promise.resolve()
    .then(() =>
      window.ipc.invoke('pipeline:releaseGate', { ...payload, fileUuids: ids }),
    )
    .then(
      (result) => ({ kind: 'result' as const, result }),
      (error) => ({ kind: 'error' as const, error }),
    );
  let transportError: unknown;
  let query: Promise<any> | undefined;
  for (;;) {
    if (!isCurrent()) throw new Error('Gate editor has changed');
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<{ kind: 'timeout' }>((resolve) => {
      timer = setTimeout(() => resolve({ kind: 'timeout' }), 1000);
    });
    const result = await Promise.race([
      timeout,
      ...(!transportError ? [request] : []),
      ...(query ? [query] : []),
    ]);
    clearTimeout(timer!);
    if (!isCurrent()) throw new Error('Gate editor has changed');
    if (result.kind === 'result') {
      if (result.result?.success === true) return;
      throw new Error(result.result?.error || 'Release was not acknowledged');
    }
    if (result.kind === 'error')
      transportError =
        result.error || new Error('Release acknowledgement lost');
    if (result.kind === 'status') {
      query = undefined;
      if (confirmed(result.item)) return;
      if (transportError) throw transportError;
    }
    if (result.kind === 'statusError') {
      query = undefined;
      onUncertain(String(result.error));
    }
    if (!query) {
      // Wait before retrying a failed/unchanged query, keeping one request in flight.
      if (result.kind === 'status' || result.kind === 'statusError') continue;
      query = Promise.resolve()
        .then(() => window.ipc.invoke('getWorkItem', payload.projectId))
        .then(
          (item) => ({ kind: 'status', item }),
          (error) => ({ kind: 'statusError', error }),
        );
    } else if (result.kind === 'timeout') {
      onUncertain(
        'Release confirmation is pending; checking the original task',
      );
    }
  }
}
