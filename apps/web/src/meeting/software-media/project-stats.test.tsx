import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { ProjectMediaSection } from './project-stats.js';
import { emptyStats } from './encoder.js';
it('shows project implementation and actual counters without inventing RTP encoder statistics', () => {
  render(<ProjectMediaSection stats={{ ...emptyStats(), width: 1920, height: 1080, rawFrames: 60, encodedFrames: 44, encodedBytes: 1000000, filter: 2 }} />);
  expect(screen.getByText('OpenH264 2.6.0')).toBeTruthy();
  expect(screen.getByText('44')).toBeTruthy();
  expect(screen.getByText('1920 × 1080')).toBeTruthy();
});
