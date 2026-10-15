import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync('apps/web/src/styles.css', 'utf8');
const rule = (selector: string) => css.split(selector + ' {').at(-1)?.split('}')[0] ?? '';

describe('content-sized viewing area CSS contracts', () => {
  it('lets the sharing shell follow media height instead of a fixed desktop band', () => {
    expect(rule('.meeting-room-sharing .meeting-stage-shell')).toContain('height: auto');
    expect(css).toContain('container-type: inline-size');
    expect(rule('.screen-stage')).toContain('100cqw / var(--stage-aspect-ratio');
  });
  it('reserves the extra audio-resume row for both mobile dock layouts', () => {
    expect(css).toContain(".meeting-room:has(.meeting-resume-audio) { --mobile-status-height: 56px; }");
    expect(css).toContain('calc(94px + var(--mobile-status-height) + env(safe-area-inset-bottom))');
    expect(css).toContain('calc(152px + var(--mobile-status-height) + env(safe-area-inset-bottom))');
  });
  it('centers the mobile stage through the available workspace and keeps fullscreen touch-sized', () => {
    expect(rule('.meeting-stage-column')).toContain('height: 100%');
    expect(rule('.screen-stage-fullscreen')).toContain('min-height: 44px');
  });
});
