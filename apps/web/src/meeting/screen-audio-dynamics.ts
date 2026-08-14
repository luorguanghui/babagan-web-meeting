/**
 * Receive-side dynamics processing for shared computer audio.
 *
 * Production symptom: the shared system/tab audio occasionally arrives far
 * louder than the sharer's own level — Windows loopback capture runs before
 * the system volume stage, and handover/AGC transients add intermittent
 * spikes. The stage element therefore routes remote screen audio through a
 * fixed soft trim plus a compressor/limiter so shared content sits near
 * speech level instead of overwhelming the meeting mix.
 */

/** Fixed output trim (-6 dB) applied before the limiter. */
export const SCREEN_AUDIO_GAIN_TRIM = 0.5;
/** Limiter curve: tame peaks without pumping the quiet passages. */
export const SCREEN_AUDIO_LIMITER: {
  threshold: number;
  knee: number;
  ratio: number;
  attack: number;
  release: number;
} = {
  threshold: -20,
  knee: 24,
  ratio: 10,
  attack: 0.002,
  release: 0.3
};

/** Minimal WebAudio surface; `AudioContext` satisfies it structurally and tests inject fakes. */
export interface AudioGraphNode {
  connect(destination: AudioGraphNode): unknown;
  disconnect(): void;
}

export interface AudioContextLike {
  readonly state: string;
  readonly destination: AudioGraphNode;
  createMediaElementSource(element: HTMLMediaElement): AudioGraphNode;
  createGain(): AudioGraphNode & { gain: { value: number } };
  createDynamicsCompressor(): AudioGraphNode;
  resume(): Promise<void>;
  close(): Promise<void>;
}

export interface ScreenAudioDynamics {
  /** Resumes the context (autoplay policy may start it suspended). */
  resume(): Promise<void>;
  dispose(): Promise<void>;
}

/**
 * Builds the processing graph for a media element's audio:
 * `element -> gain (trim) -> compressor (limiter) -> context destination`.
 * Returns `undefined` when the graph cannot be built (a context is created
 * once per element per browser context, so a failure must not throw).
 */
export function createScreenAudioDynamics(
  element: HTMLMediaElement,
  context: AudioContextLike
): ScreenAudioDynamics | undefined {
  try {
    const source = context.createMediaElementSource(element);
    const gain = context.createGain();
    gain.gain.value = SCREEN_AUDIO_GAIN_TRIM;
    const compressor = context.createDynamicsCompressor();
    source.connect(gain);
    gain.connect(compressor);
    compressor.connect(context.destination);
    return {
      resume: async () => {
        if (context.state !== 'running') await context.resume();
      },
      dispose: async () => {
        try {
          source.disconnect();
          gain.disconnect();
          compressor.disconnect();
        } catch {
          // Nodes may already be disconnected after an element swap.
        }
        await context.close().catch(() => undefined);
      }
    };
  } catch {
    return undefined;
  }
}
