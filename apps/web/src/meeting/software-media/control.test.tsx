import { expect, it } from 'vitest';
import { parseControl } from './control.js';
it('accepts bounded decoder configuration and exact generation', () => {
  expect(parseControl(JSON.stringify({ type: 'config', generation: 12, codec: 'avc1.42c02a', width: 1920, height: 1080, audio: true }))).toMatchObject({ generation: 12 });
});
it('rejects unexpected fields, invalid codecs, dimensions and unbounded control input', () => {
  for (const config of [
    { type: 'config', generation: 12, codec: 'anything', width: 1920, height: 1080, audio: true },
    { type: 'config', generation: -1, codec: 'vp8', width: 1920, height: 1080, audio: true },
    { type: 'config', generation: 12, codec: 'vp8', width: 99999, height: 1080, audio: true },
    { type: 'config', generation: 12, codec: 'vp8', width: 1920, height: 1080, audio: true, eval: 'x' }
  ]) expect(() => parseControl(JSON.stringify(config))).toThrow();
  expect(() => parseControl('x'.repeat(20000))).toThrow();
});
