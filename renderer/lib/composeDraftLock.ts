/** Chromium releases the lock when its renderer exits, including crashes. */
export function acquireComposeDraftLock(
  key: string,
  onAcquired: () => void,
  onError: (cause: unknown) => void,
): () => void {
  const controller = new AbortController();
  let release: (() => void) | undefined;
  let closed = false;
  try {
    if (!navigator.locks) throw new Error('Compose draft locking unavailable');
    void navigator.locks
      .request(key, { signal: controller.signal }, async () => {
        if (closed) return;
        const held = new Promise<void>((resolve) => {
          release = resolve;
        });
        onAcquired();
        await held;
      })
      .catch((cause) => {
        if (!closed) onError(cause);
      });
  } catch (cause) {
    onError(cause);
  }
  return () => {
    closed = true;
    controller.abort();
    release?.();
  };
}
