import { vi } from 'vitest';

export interface FakeTrack {
  stop: ReturnType<typeof vi.fn>;
}

export function installBrowserFakes(options: {
  userAgent?: string;
  secure?: boolean;
  webRtc?: boolean;
  getUserMedia?: () => Promise<MediaStream>;
} = {}) {
  const track: FakeTrack = { stop: vi.fn() };
  const stream = { getTracks: () => [track] } as unknown as MediaStream;
  const getUserMedia = vi.fn(options.getUserMedia ?? (async () => stream));

  Object.defineProperty(window.navigator, 'userAgent', {
    configurable: true,
    value: options.userAgent ?? 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36'
  });
  Object.defineProperty(window, 'isSecureContext', {
    configurable: true,
    value: options.secure ?? true
  });
  if (options.webRtc === false) {
    vi.stubGlobal('RTCPeerConnection', undefined);
  } else {
    vi.stubGlobal('RTCPeerConnection', class RTCPeerConnection {});
  }
  Object.defineProperty(window.navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia }
  });

  return { getUserMedia, stream, track };
}
