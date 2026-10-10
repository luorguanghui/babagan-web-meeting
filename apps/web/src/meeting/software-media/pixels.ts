export function encodeDimensions(sourceWidth: number, sourceHeight: number): { width: number; height: number } {
  if (!Number.isFinite(sourceWidth) || !Number.isFinite(sourceHeight) || sourceWidth < 16 || sourceHeight < 16) throw new Error('Unsupported screen dimensions');
  const scale = Math.min(1, 1080 / Math.min(sourceWidth, sourceHeight), 3840 / sourceWidth, 2160 / sourceHeight);
  return { width: Math.floor(sourceWidth * scale / 2) * 2, height: Math.floor(sourceHeight * scale / 2) * 2 };
}
export function rgbaToI420(data: Uint8Array, width: number, height: number, stride = width * 4): Uint8Array<ArrayBuffer> {
  if (width < 2 || height < 2 || (width & 1) || (height & 1) || width > 3840 || height > 2160 || stride < width * 4 || data.length < stride * height) {
    throw new Error('Invalid RGBA frame');
  }
  const size = width * height, output = new Uint8Array(size * 3 / 2);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const offset = y * stride + x * 4;
    output[y * width + x] = ((66 * data[offset] + 129 * data[offset + 1] + 25 * data[offset + 2] + 128) >> 8) + 16;
  }
  for (let y = 0; y < height; y += 2) for (let x = 0; x < width; x += 2) {
    const top = y * stride + x * 4, bottom = top + stride;
    const r = (data[top] + data[top + 4] + data[bottom] + data[bottom + 4] + 2) >> 2;
    const g = (data[top + 1] + data[top + 5] + data[bottom + 1] + data[bottom + 5] + 2) >> 2;
    const b = (data[top + 2] + data[top + 6] + data[bottom + 2] + data[bottom + 6] + 2) >> 2;
    const chroma = y / 2 * (width / 2) + x / 2;
    output[size + chroma] = ((-38 * r - 74 * g + 112 * b + 128) >> 8) + 128;
    output[size * 5 / 4 + chroma] = ((112 * r - 94 * g - 18 * b + 128) >> 8) + 128;
  }
  return output;
}
export async function frameToI420(frame: VideoFrame, width: number, height: number): Promise<Uint8Array<ArrayBuffer>> {
  let resized: VideoFrame | undefined;
  try {
    if (frame.displayWidth !== width || frame.displayHeight !== height) {
      const canvas = new OffscreenCanvas(width, height);
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Screen conversion canvas unavailable');
      context.drawImage(frame, 0, 0, width, height);
      resized = new VideoFrame(canvas, { timestamp: frame.timestamp, alpha: 'discard' });
    }
    const source = resized ?? frame;
    const rect = source.visibleRect, color = source.colorSpace;
    // Screen capture commonly already supplies I420. Expanding it to RGBA
    // and converting every pixel back in JS dominated the encoding budget.
    // Keep RGB conversion when resampling or changing matrix/range is needed;
    // our codec package declares limited-range BT.601 output.
    if (source.format === 'I420' && rect?.width === width && rect.height === height
      && !(rect.x % 2) && !(rect.y % 2) && color.fullRange !== true
      && (color.matrix === null || color.matrix === 'smpte170m' || color.matrix === 'bt470bg')) {
      const size = width * height, output = new Uint8Array(size * 3 / 2);
      await source.copyTo(output, { layout: [
        { offset: 0, stride: width }, { offset: size, stride: width / 2 }, { offset: size * 5 / 4, stride: width / 2 }
      ] });
      return output;
    }
    const rgba = new Uint8Array(source.allocationSize({ format: 'RGBA' }));
    const layout = await source.copyTo(rgba, { format: 'RGBA' });
    return rgbaToI420(rgba.subarray(layout[0].offset), width, height, layout[0].stride);
  } finally { resized?.close(); }
}
