import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
const css = readFileSync('apps/web/src/pages/meeting-room-layout.css', 'utf8');
describe('current meeting workspace geometry', () => {
  it('clears obsolete fixed-dock space even with wrapped controls', () => {
    expect(css).toContain(".meeting-room.meeting-room:has(.meeting-controls[data-mobile-wrapped='true'])");
    expect(css).toContain('height: 100dvh');
    expect(css).toContain('min-height: 0');
  });
  it('restores the bounded light idle card', () => {
    expect(css).toContain('.meeting-room:not(.meeting-room-sharing) .meeting-stage-shell');
    expect(css).toContain('max-width: 48rem');
    expect(css).toContain('flex: 0 1 auto; position: static; overflow: visible');
    expect(css).not.toContain('radial-gradient');
  });
  it('keeps a roster escape hatch and bounds panels above the dynamic dock', () => {
    expect(css).toContain('[data-members-expanded] .meeting-members-sidebar');
    expect(css).toContain('grid-row: 1 / -2');
    expect(css).toContain('(min-height: 600px)');
    expect(css).toContain('grid-template-rows: minmax(0,auto) minmax(0,1fr) auto');
  });
  it('fits mobile media using its source ratio without cropping', () => {
    expect(css).toContain('100cqw / var(--stage-aspect-ratio');
    expect(css).toContain('container-type: size');
  });
});
