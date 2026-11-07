/** Vite-only UI fixture. No native process, media request, or production API connection. */
import { createRoot } from 'react-dom/client';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import type { ClientHostRequest } from '@meeting/contracts';
import { App } from '../src/app.js';
import { initializeClientHost } from '../src/client/client-host.js';
import type { ClientHostWindow } from '../src/client/host-bridge.js';
import '../src/styles.css';

const params = new URLSearchParams(location.search);
const platform = params.get('platform') === 'android' ? 'android' : 'windows';
const scene = params.get('scene') ?? 'current';
const slug = 'client-ui-test-meeting-0001';
const listeners = new Set<(event: { data: unknown }) => void>();
const transport = {
  addEventListener: (_name: string, listener: (event: { data: unknown }) => void) => listeners.add(listener),
  removeEventListener: (_name: string, listener: (event: { data: unknown }) => void) => listeners.delete(listener),
  postMessage: (request: ClientHostRequest) => {
    const result = request.method === 'client.info'
      ? { platform, appVersion: '0.1.2', protocol: 1, screenCapture: true, maxScreenFrameRate: 60, systemAudio: platform === 'windows', updateState: 'current' }
      : { state: 'current' };
    queueMicrotask(() => {
      const reply = { v: 1, id: request.id, ok: true, result };
      if (platform === 'android') android.onmessage?.({ data: JSON.stringify(reply) });
      else for (const listener of listeners) listener({ data: reply });
    });
  },
};
const android = { onmessage: null as ((event: { data: string }) => void) | null, postMessage: (value: string) => transport.postMessage(JSON.parse(value) as ClientHostRequest) };
const target = Object.assign(new EventTarget(), platform === 'android' ? { BabaganAndroid: android } : { chrome: { webview: transport } });
initializeClientHost(target as unknown as ClientHostWindow);
localStorage.setItem('babagan.locale', params.get('locale') === 'en' ? 'en' : 'zh-CN');
const summary = { name: '一起看风景', status: 'active', requiresPassword: false, isFull: false };
window.fetch = async (input, init) => {
  const path = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.origin).pathname;
  if (init?.method && init.method !== 'GET') throw new Error('The isolated UI fixture never changes server state.');
  if (path === '/api/v1/meetings/current') return scene === 'error' ? new Response(null, { status: 503 })
    : Response.json({ meeting: scene === 'empty' ? null : { ...summary, slug, joinUrl: `${location.origin}/m/${slug}` } });
  if (path === `/api/v1/meetings/${slug}`) return Response.json(summary);
  throw new Error('The isolated UI fixture does not contact external services.');
};

function Fixture() {
  const navigate = useNavigate();
  return <div onClick={event => {
    const anchor = (event.target as Element).closest<HTMLAnchorElement>('a[href]');
    if (!anchor) return;
    const url = new URL(anchor.href, location.href);
    event.preventDefault();
    if (url.origin === location.origin) navigate(url.pathname + url.search);
  }}>
    <p style={{ margin: 0, padding: '6px 16px', background: '#edf1f5', color: '#48515d', font: '12px system-ui' }}>隔离界面验收 · 模拟宿主及会议数据 · 不采集屏幕，不连接实际会议</p>
    <App />
  </div>;
}
const root = createRoot(document.getElementById('root')!);
root.render(<MemoryRouter initialEntries={['/']}><Fixture /></MemoryRouter>);
import.meta.hot?.dispose(() => root.unmount());
