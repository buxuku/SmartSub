export interface WaveformData {
  duration: number;
  /** One absolute peak per 20 ms; audio PCM is never retained. */
  peaks: Float32Array;
  step: number;
  silenceEdges: number[];
}
