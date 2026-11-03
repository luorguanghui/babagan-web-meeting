import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { LanguageProvider } from '../i18n/i18n.js';
import { WebRtcStatsPanel } from '../components/webrtc-stats-panel.js';
import { describeH264Profile } from './h264-profile.js';

afterEach(cleanup);
describe('readable negotiated H264 profiles', () => {
  it.each([
    ['64001f', 'high', '3.1'], ['640032', 'high', '5'], ['640C1F', 'constrainedHigh', '3.1'],
    ['42e01f', 'constrainedBaseline', '3.1'], ['4de01f', 'constrainedBaseline', '3.1'],
    ['58c01f', 'constrainedBaseline', '3.1'], ['42001f', 'baseline', '3.1'],
    ['4d001f', 'main', '3.1'], ['42f00b', 'constrainedBaseline', '1b']
  ])('parses %s including constraint bits and level', (value, profile, level) => {
    expect(describeH264Profile(value)).toEqual({ profile, level });
  });
  it.each(['', '123', 'zz001f', '64011f', '000000', '6400ff'])('does not mislabel invalid or unknown %s', value => {
    expect(describeH264Profile(value)).toBeUndefined();
  });
  it.each(['en', 'zh-CN'] as const)('renders sender and receiver names without hex in %s', locale => {
    render(<LanguageProvider initialLocale={locale}><WebRtcStatsPanel requestedCodec="h264" mode="turn" snapshot={{
      sampledAt: 1, counters: {}, sender: { codec: 'H264', codecProfile: '64001f' },
      receiver: { codec: 'H264', codecProfile: '42e01f' }
    }} /></LanguageProvider>);
    expect(screen.getByText(locale === 'zh-CN' ? '高档次（High） · 级别 3.1' : 'High profile · Level 3.1')).toBeInTheDocument();
    expect(screen.getByText(locale === 'zh-CN' ? '受限基线档次（Constrained Baseline） · 级别 3.1' : 'Constrained Baseline profile · Level 3.1')).toBeInTheDocument();
    expect(screen.queryByText(/64001f|42e01f/)).not.toBeInTheDocument();
  });
});
