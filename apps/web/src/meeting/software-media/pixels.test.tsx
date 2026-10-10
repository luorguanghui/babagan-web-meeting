import { expect, it } from 'vitest';
import { rgbaToI420, encodeDimensions } from './pixels.js';
it('converts black and white RGBA to limited-range I420 with neutral chroma', () => {
  const rgba = new Uint8Array([0, 0, 0, 255, 255, 255, 255, 255, 0, 0, 0, 255, 255, 255, 255, 255]);
  expect([...rgbaToI420(rgba, 2, 2)]).toEqual([16, 235, 16, 235, 128, 128]);
});
it('caps source dimensions without upscaling or changing source aspect ratio', () => {
  expect(encodeDimensions(3840, 2160)).toEqual({ width: 1920, height: 1080 });
  expect(encodeDimensions(1280, 720)).toEqual({ width: 1280, height: 720 });
  expect(encodeDimensions(5760, 1080)).toEqual({ width: 3840, height: 720 });
  expect(() => rgbaToI420(new Uint8Array(2), 1920, 1080)).toThrow();
});
