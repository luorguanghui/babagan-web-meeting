import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const webRoot = `${resolve(import.meta.dirname, '../..')}/`;
const read = (path: string) => readFileSync(`${webRoot}${path}`, 'utf8');

describe('selected brand icon delivery', () => {
  it('keeps the browser icon and the same character mark across application headers', () => {
    const html = new DOMParser().parseFromString(read('index.html'), 'text/html');
    expect(html.querySelector('link[rel="icon"][type="image/png"]')?.getAttribute('href')).toBe('/theme/favicon-32.png');
    const icon = readFileSync(`${webRoot}public/theme/favicon-32.png`);
    expect([icon.readUInt32BE(16), icon.readUInt32BE(20)]).toEqual([32, 32]);
    expect(read('src/components/meeting-top-bar.tsx')).toContain('src="/theme/sigrika-avatar.png"');
    expect(read('src/components/app-shell.tsx')).toContain('src="/theme/sigrika-avatar.png"');
  });

  it('shows the selected favicon in isolated preview tabs too', () => {
    for (const path of ['qa/preview.html', 'qa/viewport.html']) {
      const html = new DOMParser().parseFromString(read(path), 'text/html');
      expect(html.querySelector('link[rel="icon"]')?.getAttribute('href')).toBe('/theme/favicon-32.png');
    }
  });

  it('supplies a square home-screen icon without adding install or service-worker behavior', () => {
    const html = new DOMParser().parseFromString(read('index.html'), 'text/html');
    expect(html.querySelector('link[rel="apple-touch-icon"]')?.getAttribute('href')).toBe('/theme/apple-touch-icon.png');
    const png = readFileSync(`${webRoot}public/theme/apple-touch-icon.png`);
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([180, 180]);
    expect(html.querySelector('link[rel="manifest"]')).toBeNull();
  });
});
