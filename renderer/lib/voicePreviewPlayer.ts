/** Bounded PCM queue for an incremental three-second audition. */
export class VoicePreviewPlayer {
  private context: AudioContext;
  private sources = new Set<AudioBufferSourceNode>();
  private nextTime = 0;
  private seconds = 0;
  private ended = false;
  private stopped = false;
  private timer?: ReturnType<typeof setTimeout>;
  private resolve!: () => void;
  readonly completed = new Promise<void>((resolve) => {
    this.resolve = resolve;
  });
  received = false;

  constructor(
    private onPlaying: () => void,
    private onError: (error: unknown) => void,
  ) {
    this.context = new AudioContext();
    // Resume while still in the initiating pointer/click event.
    void this.context.resume().catch(onError);
  }

  append(pcm: Uint8Array, sampleRate: number): void {
    if (this.stopped || this.ended) return;
    if (sampleRate !== 24000 || !pcm?.byteLength || pcm.byteLength % 2)
      throw new Error('Invalid voice preview PCM chunk');
    const count = Math.min(
      pcm.byteLength / 2,
      Math.round((3 - this.seconds) * sampleRate),
    );
    if (count <= 0) return;
    const buffer = this.context.createBuffer(1, count, sampleRate);
    const target = buffer.getChannelData(0);
    const bytes = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    for (let i = 0; i < count; i++)
      target[i] = bytes.getInt16(i * 2, true) / 32768;
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.context.destination);
    source.onended = () => {
      source.disconnect();
      this.sources.delete(source);
      if (this.ended && !this.sources.size) this.stop();
    };
    this.sources.add(source);
    const start = Math.max(this.nextTime, this.context.currentTime + 0.02);
    this.nextTime = start + buffer.duration;
    this.seconds += buffer.duration;
    source.start(start);
    if (!this.received) {
      this.received = true;
      void this.context
        .resume()
        .then(() => {
          if (this.stopped) return;
          this.onPlaying();
          this.timer = setTimeout(() => this.stop(), 3000);
        })
        .catch(this.onError);
    }
  }

  finish(): Promise<void> {
    this.ended = true;
    if (!this.sources.size) this.stop();
    return this.completed;
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    clearTimeout(this.timer);
    this.sources.forEach((source) => {
      source.onended = null;
      source.stop();
      source.disconnect();
    });
    this.sources.clear();
    void this.context.close().catch(() => undefined);
    this.resolve();
  }
}
