import { describe, expect, it, vi, type Mock } from 'vitest';

import {
  createScreenAudioDynamics,
  SCREEN_AUDIO_GAIN_TRIM,
  SCREEN_AUDIO_LIMITER,
  type AudioContextLike
} from './screen-audio-dynamics.js';

interface FakeNode {
  connect: Mock;
  disconnect: Mock;
}

function makeNode(): FakeNode {
  return { connect: vi.fn(), disconnect: vi.fn() };
}

function makeContext(sourceError = false, state: string = 'running'): {
  context: AudioContextLike;
  source: FakeNode;
  gain: FakeNode & { gain: { value: number } };
  compressor: FakeNode;
} {
  const source = makeNode();
  const gain = { ...makeNode(), gain: { value: 1 } };
  const compressor = makeNode();
  const destination = makeNode();
  const context: AudioContextLike = {
    state,
    destination,
    createMediaElementSource: sourceError
      ? vi.fn(() => { throw new Error('element already a source'); })
      : vi.fn(() => source),
    createGain: vi.fn(() => gain),
    createDynamicsCompressor: vi.fn(() => compressor),
    resume: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined)
  };
  return { context, source, gain, compressor };
}

describe('screen audio dynamics', () => {
  it('routes element audio through a trimmed gain and a limiter into the destination', () => {
    const element = document.createElement('video');
    const { context, source, gain, compressor } = makeContext();

    const dynamics = createScreenAudioDynamics(element, context);

    expect(dynamics).toBeDefined();
    expect(context.createMediaElementSource).toHaveBeenCalledWith(element);
    expect(context.createGain).toHaveBeenCalledOnce();
    expect(context.createDynamicsCompressor).toHaveBeenCalledOnce();
    expect(gain.gain.value).toBe(SCREEN_AUDIO_GAIN_TRIM);
    expect(source.connect).toHaveBeenCalledWith(gain);
    expect(gain.connect).toHaveBeenCalledWith(compressor);
    expect(compressor.connect).toHaveBeenCalledWith(context.destination);
  });

  it('applies the exported limiter curve constants', () => {
    expect(SCREEN_AUDIO_LIMITER.threshold).toBe(-20);
    expect(SCREEN_AUDIO_LIMITER.ratio).toBeGreaterThanOrEqual(8);
  });

  it('resumes a suspended context and disposes the graph cleanly', async () => {
    const element = document.createElement('video');
    const { context, source, gain, compressor } = makeContext(false, 'suspended');

    const dynamics = createScreenAudioDynamics(element, context)!;
    await dynamics.resume();
    expect(context.resume).toHaveBeenCalledOnce();

    await dynamics.dispose();
    expect(source.disconnect).toHaveBeenCalled();
    expect(gain.disconnect).toHaveBeenCalled();
    expect(compressor.disconnect).toHaveBeenCalled();
    expect(context.close).toHaveBeenCalledOnce();
  });

  it('returns undefined instead of throwing when the graph cannot be built', () => {
    const element = document.createElement('video');
    const { context } = makeContext(true);

    expect(createScreenAudioDynamics(element, context)).toBeUndefined();
  });

  it('tolerates a close failure during dispose', async () => {
    const element = document.createElement('video');
    const { context } = makeContext();
    (context.close as Mock).mockRejectedValueOnce(new Error('already closed'));

    const dynamics = createScreenAudioDynamics(element, context)!;
    await expect(dynamics.dispose()).resolves.toBeUndefined();
  });
});
