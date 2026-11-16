import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { LanguageProvider } from '../i18n/i18n.js';
import { WebRtcStatsPanel } from './webrtc-stats-panel.js';

afterEach(cleanup);

describe('MoQ media statistics', () => {
  it('shows measured sender values, including zero, and hides stale WebRTC data', () => {
    render(<LanguageProvider initialLocale="en"><WebRtcStatsPanel
      embedded mode="cloudflare-moq" requestedCodec="auto"
      snapshot={{ sampledAt: 1, counters: {}, sender: { codec: 'stale-codec', selectedCandidateType: 'relay' } }}
      moqStats={{
        role: 'sender', protocol: 'moqt-18', codec: 'avc1.640028', width: 1920, height: 1080,
        frameRate: 0, videoMbps: 0, audioMbps: 0.128, relayMbps: 1.25, hasAudio: true
      }}
    /></LanguageProvider>);

    expect(screen.getByRole('heading', { name: 'MoQ statistics Cloudflare MoQ' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Sender' })).toBeInTheDocument();
    expect(rowValue('Video codec')).toHaveTextContent('avc1.640028');
    expect(rowValue('Resolution')).toHaveTextContent('1920×1080');
    expect(rowValue('Encoded frame rate')).toHaveTextContent(/^0 fps$/);
    expect(rowValue('Encoded video bitrate')).toHaveTextContent(/^0 Mbps$/);
    expect(rowValue('Encoded audio bitrate')).toHaveTextContent(/^0.13 Mbps$/);
    expect(rowValue('Upload to relay')).toHaveTextContent(/^1.25 Mbps$/);
    expect(rowValue('Shared audio')).toHaveTextContent('Yes');
    expect(screen.queryByText('Round-trip time to relay')).not.toBeInTheDocument();
    expect(screen.queryByText(/stale-codec|Selected candidate|Requested codec|NACK/)).not.toBeInTheDocument();
  });

  it('renders viewer readings in Chinese', () => {
    render(<LanguageProvider initialLocale="zh-CN"><WebRtcStatsPanel
      embedded mode="cloudflare-moq" requestedCodec="h264"
      moqStats={{
        role: 'viewer', protocol: 'moqt-18', frameRate: 58.7, renderedFps: 55,
        droppedFrames: 0, videoMbps: 3.45, relayRttMs: 18, hasAudio: false
      }}
    /></LanguageProvider>);

    expect(screen.getByRole('heading', { name: '接收端' })).toBeInTheDocument();
    expect(rowValue('接收视频帧率')).toHaveTextContent('58.7 fps');
    expect(rowValue('播放帧率')).toHaveTextContent('55 fps');
    expect(rowValue('丢帧数')).toHaveTextContent(/^0$/);
    expect(rowValue('接收视频码率')).toHaveTextContent('3.45 Mbps');
    expect(rowValue('到中继的往返时延')).toHaveTextContent('18 ms');
    expect(rowValue('共享音频')).toHaveTextContent('否');
    expect(screen.queryByText(/接收音频码率|端到端/)).not.toBeInTheDocument();
  });

  it.each([
    [true, 'Collecting statistics…'],
    [false, 'No active screen-share data.']
  ] as const)('shows the correct empty state when MoQ active is %s', (active, message) => {
    render(<LanguageProvider initialLocale="en"><WebRtcStatsPanel
      embedded mode="cloudflare-moq" active={active} requestedCodec="auto"
    /></LanguageProvider>);
    expect(screen.getByText(message)).toBeInTheDocument();
    expect(screen.queryByText('Protocol')).not.toBeInTheDocument();
  });
});

function rowValue(label: string): Element {
  const value = screen.getByText(label, { selector: 'dt', exact: true }).nextElementSibling;
  if (!value) throw new Error('Missing statistics row value');
  return value;
}
