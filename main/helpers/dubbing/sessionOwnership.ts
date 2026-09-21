export interface DubbingSessionOwner {
  windowId: number;
  leaseId: string;
}

/** Each editor load owns a lease; a late request cannot act as its successor. */
export class DubbingSessionOwnership {
  private owners = new Map<string, DubbingSessionOwner>();
  private retired = new Map<number, Set<string>>();
  private pipeline = new Map<string, symbol>();

  acquirePipeline(sessionId: string): () => void {
    if (this.owners.has(sessionId) || this.pipeline.has(sessionId))
      throw new Error(
        'Dubbing project is open in an editor or running in a pipeline; close the editor and retry',
      );
    const token = Symbol(sessionId);
    this.pipeline.set(sessionId, token);
    return () => {
      if (this.pipeline.get(sessionId) === token)
        this.pipeline.delete(sessionId);
    };
  }

  isBusy(sessionId: string): boolean {
    return this.owners.has(sessionId) || this.pipeline.has(sessionId);
  }

  isRetired(windowId: number, leaseId: string): boolean {
    return this.retired.get(windowId)?.has(leaseId) ?? false;
  }

  retire(windowId: number, leaseId: string): string[] {
    const leases = this.retired.get(windowId) || new Set<string>();
    leases.add(leaseId);
    this.retired.set(windowId, leases);
    return this.releaseOwner(windowId, leaseId);
  }

  forgetWindow(windowId: number): void {
    this.retired.delete(windowId);
  }

  acquire(sessionId: string, windowId: number, leaseId: string): boolean {
    if (
      typeof leaseId !== 'string' ||
      !leaseId ||
      leaseId.length > 128 ||
      this.isRetired(windowId, leaseId) ||
      this.pipeline.has(sessionId)
    )
      return false;
    const current = this.owners.get(sessionId);
    if (current && !this.owns(sessionId, windowId, leaseId)) return false;
    this.owners.set(sessionId, { windowId, leaseId });
    return true;
  }

  owns(sessionId: string, windowId: number, leaseId: string): boolean {
    const current = this.owners.get(sessionId);
    return (
      !!current && current.windowId === windowId && current.leaseId === leaseId
    );
  }

  owner(sessionId: string): DubbingSessionOwner | undefined {
    return this.owners.get(sessionId);
  }

  release(sessionId: string, windowId: number, leaseId: string): boolean {
    if (!this.owns(sessionId, windowId, leaseId)) return false;
    this.owners.delete(sessionId);
    return true;
  }

  releaseOwner(windowId: number, leaseId?: string): string[] {
    const released: string[] = [];
    for (const [id, current] of this.owners) {
      if (
        current.windowId !== windowId ||
        (leaseId !== undefined && current.leaseId !== leaseId)
      )
        continue;
      this.owners.delete(id);
      released.push(id);
      const leases = this.retired.get(windowId) || new Set<string>();
      leases.add(current.leaseId);
      this.retired.set(windowId, leases);
    }
    return released;
  }
}

export const dubbingSessionOwnership = new DubbingSessionOwnership();
