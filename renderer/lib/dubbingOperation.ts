interface OperationResponse {
  success: boolean;
  data?: any;
  error?: string;
  cancelled?: boolean;
  recoveryWarning?: string;
}

/** Query an accepted request after a lost acknowledgement; never submit it again. */
export async function invokeDubbingOperation(
  channel: string,
  payload: Record<string, unknown>,
  isCurrent: () => boolean,
  onUncertain: (error: string) => void,
): Promise<OperationResponse> {
  const request = { ...payload, requestId: crypto.randomUUID() };
  const response = Promise.resolve()
    .then(() => window.ipc.invoke(channel, request))
    .then(
      (result) => ({ kind: 'result' as const, result }),
      (error) => ({ kind: 'error' as const, error }),
    );
  let transportError: unknown;
  let receivedError = false;
  let statusRequest: Promise<
    { kind: 'status'; snapshot: any } | { kind: 'statusError'; error: unknown }
  > | null = null;
  for (;;) {
    if (!isCurrent()) throw new Error('Dubbing editor has changed');
    let timer: ReturnType<typeof setTimeout>;
    const pause = new Promise<{ kind: 'timeout' }>((resolve) => {
      timer = setTimeout(() => resolve({ kind: 'timeout' }), 1000);
    });
    const outcome = await (receivedError
      ? pause
      : Promise.race([response, pause]));
    clearTimeout(timer!);
    if (!isCurrent()) throw new Error('Dubbing editor has changed');
    if (outcome.kind === 'result') return outcome.result;
    if (outcome.kind === 'error') {
      transportError = outcome.error;
      receivedError = true;
    }
    if (!statusRequest)
      statusRequest = Promise.resolve()
        .then(() =>
          window.ipc.invoke('dubbing:operationStatus', {
            sessionId: payload.sessionId,
            leaseId: payload.leaseId,
            requestId: request.requestId,
          }),
        )
        .then(
          (snapshot) => ({ kind: 'status' as const, snapshot }),
          (error) => ({ kind: 'statusError' as const, error }),
        );
    const statusTimeout = new Promise<{ kind: 'timeout' }>((resolve) => {
      timer = setTimeout(() => resolve({ kind: 'timeout' }), 1000);
    });
    const checked = await Promise.race([
      statusRequest,
      statusTimeout,
      ...(!receivedError ? [response] : []),
    ]);
    clearTimeout(timer!);
    if (!isCurrent()) throw new Error('Dubbing editor has changed');
    if (checked.kind === 'result') return checked.result;
    if (checked.kind === 'error') {
      receivedError = true;
      transportError = checked.error;
      continue;
    }
    if (checked.kind === 'timeout') {
      onUncertain(
        'Dubbing status has not responded; waiting to confirm the original operation',
      );
      continue;
    }
    statusRequest = null;
    if (checked.kind === 'statusError') {
      onUncertain(String(checked.error));
      continue;
    }
    const snapshot = checked.snapshot;
    if (snapshot?.success && snapshot.data?.status === 'complete')
      return {
        ...snapshot.data.result,
        ...(snapshot.data.persistenceError
          ? { recoveryWarning: snapshot.data.persistenceError }
          : {}),
      };
    if (snapshot?.success && snapshot.data?.status === 'pending') continue;
    throw (
      transportError ||
      new Error(snapshot?.error || 'Dubbing operation could not be confirmed')
    );
  }
}
