import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const webRoot = `${resolve(import.meta.dirname, '../..')}/`;
const read = (path: string) => readFileSync(`${webRoot}${path}`, 'utf8');

describe('selected brand icon delivery', () => {
  it('uses the same selected mark for the application and scalable browser icon', () => {
    const html = new DOMParser().parseFromString(read('index.html'), 'text/html');
    expect(html.querySelector('link[rel="icon"][type="image/svg+xml"]')?.getAttribute('href')).toBe('/brand/babagan-icon.svg');
    const icon = new DOMParser().parseFromString(read('public/brand/babagan-icon.svg'), 'image/svg+xml');
    expect(icon.documentElement.getAttribute('viewBox')).toBe('0 0 192 160');
    expect(read('src/components/meeting-top-bar.tsx')).toContain('src="/brand/babagan-wordmark.svg"');
  });

  it('shows the selected favicon in isolated preview tabs too', () => {
    for (const path of ['qa/preview.html', 'qa/viewport.html']) {
      const html = new DOMParser().parseFromString(read(path), 'text/html');
      expect(html.querySelector('link[rel="icon"]')?.getAttribute('href')).toBe('/brand/babagan-icon.svg');
    }
  });

  it('supplies a square home-screen icon without adding install or service-worker behavior', () => {
    const html = new DOMParser().parseFromString(read('index.html'), 'text/html');
    expect(html.querySelector('link[rel="apple-touch-icon"]')?.getAttribute('href')).toBe('/brand/apple-touch-icon.png');
    const png = readFileSync(`${webRoot}public/brand/apple-touch-icon.png`);
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([180, 180]);
    expect(html.querySelector('link[rel="manifest"]')).toBeNull();
  });
});
