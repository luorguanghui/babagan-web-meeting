/** Preserve a 1080px short side without upscaling smaller captures. */
export function computeResolutionScale(settings: { width?: number; height?: number }): number | undefined {
  const { width, height } = settings;
  if (width === undefined || height === undefined || width <= 0 || height <= 0) return undefined;
  const scale = Math.min(width, height) / 1080;
  return scale > 1 ? scale : undefined;
}
