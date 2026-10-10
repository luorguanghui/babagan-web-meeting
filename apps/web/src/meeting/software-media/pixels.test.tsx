import { expect, it, vi } from 'vitest';
import { rgbaToI420, encodeDimensions, frameToI420 } from './pixels.js';
it('converts black and white RGBA to limited-range I420 with neutral chroma', () => {
  const rgba = new Uint8Array([0, 0, 0, 255, 255, 255, 255, 255, 0, 0, 0, 255, 255, 255, 255, 255]);
  expect([...rgbaToI420(rgba, 2, 2)]).toEqual([16, 235, 16, 235, 128, 128]);
});
it.each([null, 'smpte170m', 'bt470bg'])('copies compatible %s I420 planes without a lossy RGB round trip', async matrix => {
  const pixels = new Uint8Array([16, 64, 128, 235, 80, 180]);
  const copyTo = vi.fn(async (destination: Uint8Array) => { destination.set(pixels); return []; });
  const frame = { format: 'I420', displayWidth: 2, displayHeight: 2,
    visibleRect: { x: 2, y: 2, width: 2, height: 2 }, colorSpace: { matrix, fullRange: matrix === null ? null : false },
    allocationSize() { throw new Error('I420 must not be expanded to RGBA'); }, copyTo };
  expect(await frameToI420(frame as unknown as VideoFrame, 2, 2)).toEqual(pixels);
  expect(copyTo).toHaveBeenCalledWith(expect.any(Uint8Array), { layout: [
    { offset: 0, stride: 2 }, { offset: 4, stride: 1 }, { offset: 5, stride: 1 }
  ] });
});
it.each([
  { format: 'RGBA', matrix: null, fullRange: null },
  { format: 'I420', matrix: 'bt709', fullRange: false },
  { format: 'I420', matrix: 'smpte170m', fullRange: true }
])('preserves RGB conversion for incompatible source $format/$matrix/$fullRange', async color => {
  const allocationSize = vi.fn(() => 16);
  const copyTo = vi.fn(async (destination: Uint8Array) => { destination.fill(0); return [{ offset: 0, stride: 8 }]; });
  const frame = { format: color.format, displayWidth: 2, displayHeight: 2,
    visibleRect: { x: 0, y: 0, width: 2, height: 2 }, colorSpace: color, allocationSize, copyTo };
  expect([...await frameToI420(frame as unknown as VideoFrame, 2, 2)]).toEqual([16, 16, 16, 16, 128, 128]);
  expect(copyTo).toHaveBeenCalledWith(expect.any(Uint8Array), { format: 'RGBA' });
});
it('caps source dimensions without upscaling or changing source aspect ratio', () => {
  expect(encodeDimensions(3840, 2160)).toEqual({ width: 1920, height: 1080 });
  expect(encodeDimensions(1280, 720)).toEqual({ width: 1280, height: 720 });
  expect(encodeDimensions(5760, 1080)).toEqual({ width: 3840, height: 720 });
  expect(() => rgbaToI420(new Uint8Array(2), 1920, 1080)).toThrow();
});
