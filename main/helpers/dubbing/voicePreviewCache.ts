import fs from 'fs';
import { createHash } from 'crypto';
import { TaskCancelledError } from '../taskContext';
import type { ClonedVoice } from '../../../types/voiceClone';

export function previewCloneIdentity(voice: ClonedVoice | undefined): unknown {
  if (!voice) return null;
  let reference: unknown = null;
  if (voice.refWavPath) {
    try {
      const stat = fs.statSync(voice.refWavPath, { bigint: true });
      reference = [stat.size, stat.mtimeNs, stat.ctimeNs].map(String);
    } catch {
      reference = 'missing';
    }
  }
  return { voice, reference };
}

interface Preview {
  wavPath: string;
  durationMs: number;
}
interface Entry extends Preview {
  expires: number;
}

/** Window-local, bounded samples. Cancellation never reaches another window. */
export class VoicePreviewCache {
  private owners = new Map<
    number,
    {
      cache: Map<string, Entry>;
      active?: { id: string; abort: AbortController };
    }
  >();
  constructor(
    private limit = 24,
    private ttl = 10 * 60_000,
  ) {}

  cancel(owner: number, id?: string): void {
    const active = this.owners.get(owner)?.active;
    if (active && (!id || active.id === id)) active.abort.abort();
  }

  private remove(entry: Preview): void {
    try {
      fs.unlinkSync(entry.wavPath);
    } catch {
      /* already removed */
    }
  }

  dispose(owner: number): void {
    const state = this.owners.get(owner);
    if (!state) return;
    state.active?.abort.abort();
    state.cache.forEach((entry) => this.remove(entry));
    this.owners.delete(owner);
  }

  async get(
    owner: number,
    id: string,
    identity: unknown,
    create: (signal: AbortSignal) => Promise<Preview>,
  ): Promise<Preview> {
    if (typeof id !== 'string' || !id || id.length > 128)
      throw new Error('Invalid preview request ID');
    let state = this.owners.get(owner);
    if (!state) {
      state = { cache: new Map() };
      this.owners.set(owner, state);
    }
    state.active?.abort.abort();
    const active = { id, abort: new AbortController() };
    state.active = active;
    const key = createHash('sha256')
      .update(JSON.stringify(identity))
      .digest('hex');
    state.cache.forEach((entry, cachedKey) => {
      if (entry.expires <= Date.now() || !fs.existsSync(entry.wavPath)) {
        this.remove(entry);
        state!.cache.delete(cachedKey);
      }
    });
    const cached = state.cache.get(key);
    if (cached) {
      state.cache.delete(key);
      state.cache.set(key, cached);
      state.active = undefined;
      return { wavPath: cached.wavPath, durationMs: cached.durationMs };
    }
    try {
      const preview = await create(active.abort.signal);
      if (active.abort.signal.aborted || this.owners.get(owner) !== state) {
        this.remove(preview);
        throw new TaskCancelledError();
      }
      state.cache.set(key, { ...preview, expires: Date.now() + this.ttl });
      while (state.cache.size > this.limit) {
        const oldest = state.cache.entries().next().value!;
        this.remove(oldest[1]);
        state.cache.delete(oldest[0]);
      }
      return preview;
    } finally {
      if (state.active === active) state.active = undefined;
    }
  }
}
