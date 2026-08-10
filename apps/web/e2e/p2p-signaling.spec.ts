import { expect, test, type Browser, type Page } from '@playwright/test';
import WebSocket from 'ws';

import {
  createMeeting,
  e2eOrigin,
  installFakeMedia,
  requireE2EConfiguration
} from './helpers.js';

/**
 * P2P signaling E2E (local mode, no real LiveKit): the harness in
 * `apps/api/test/local-e2e-server.ts` stands in a fake media service for
 * LiveKit, so the whole signaling + media path runs for real between two
 * Chromium pages on the loopback origin (host-candidate ICE).
 *
 * Scope notes (coordinator resolution): the LiveKit/SFU side is not exercised
 * locally; the "Share screen" button is LiveKit-connection-gated, so test 1
 * force-enables it before clicking (the underlying flow — grant → capture →
 * P2P publish → signaling → media — runs unmodified).
 */

interface SignalingFrames {
  received: string[];
  sent: string[];
}

type ParsedFrame = { type?: string; from?: string; peer?: { identity: string; nickname: string }; peers?: Array<{ identity: string; nickname: string }>; code?: string; [key: string]: unknown };

function captureSignaling(page: Page): SignalingFrames {
  const frames: SignalingFrames = { received: [], sent: [] };
  page.on('websocket', (socket) => {
    socket.on('framereceived', (event) => frames.received.push(String(event.payload)));
    socket.on('framesent', (event) => frames.sent.push(String(event.payload)));
  });
  return frames;
}

function parseFrames(raw: string[]): ParsedFrame[] {
  return raw
    .map((frame) => { try { return JSON.parse(frame) as ParsedFrame; } catch { return null; } })
    .filter((frame): frame is ParsedFrame => frame !== null && typeof frame === 'object');
}

async function waitForFrame(page: Page, frames: SignalingFrames, predicate: (frame: ParsedFrame) => boolean, timeout = 10_000): Promise<ParsedFrame> {
  await expect.poll(() => parseFrames(frames.received).find(predicate), { timeout, message: 'expected P2P signaling frame' }).toBeTruthy();
  return parseFrames(frames.received).find(predicate) as ParsedFrame;
}

function findPeer(frames: SignalingFrames, nickname: string): { identity: string; nickname: string } | undefined {
  for (const frame of parseFrames(frames.received)) {
    if (frame.type === 'welcome') {
      const peer = frame.peers?.find((entry) => entry.nickname === nickname);
      if (peer) return peer;
    }
    if (frame.type === 'peer-joined' && frame.peer?.nickname === nickname) return frame.peer;
  }
  return undefined;
}

/**
 * Local-mode join: waits for the meeting-room page to render. The shared
 * `joinMeeting` helper waits for the LiveKit connection status
 * ("Connection: connected"), which can never happen locally; the room itself
 * renders regardless (P2P is best-effort and independent of LiveKit).
 */
async function joinLocalRoom(page: Page, meetingUrl: string, nickname: string): Promise<void> {
  await page.goto(meetingUrl);
  await page.getByLabel('Nickname').fill(nickname);
  await page.getByRole('button', { name: 'Join muted' }).click();
  await expect(page.getByRole('heading', { name: `${nickname}, you are in` })).toBeVisible();
}

async function joinWithSignalingCapture(browser: Browser, meetingUrl: string, nickname: string): Promise<{ context: import('@playwright/test').BrowserContext; page: Page; frames: SignalingFrames }> {
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36'
  });
  await installFakeMedia(context);
  const page = await context.newPage();
  const frames = captureSignaling(page);
  await joinLocalRoom(page, meetingUrl, nickname);
  return { context, page, frames };
}

const apiHeaders = { origin: e2eOrigin };

/** Ends any leftover meeting from an aborted run (only one meeting can be active). */
async function recoverStaleMeeting(page: Page): Promise<void> {
  const response = await page.request.get('/api/v1/meetings/current');
  if (!response.ok()) return;
  const body = (await response.json()) as { meeting: { slug: string } | null };
  if (body.meeting) {
    await page.request.post(`/api/v1/meetings/${body.meeting.slug}/admin-end`, {
      headers: apiHeaders,
      data: { adminPassword: requireE2EConfiguration() }
    }).catch(() => undefined);
  }
}

/** Ends the meeting via the admin password (no host session needed). */
async function adminEnd(page: Page, slug: string): Promise<void> {
  await page.request.post(`/api/v1/meetings/${slug}/admin-end`, {
    headers: apiHeaders,
    data: { adminPassword: requireE2EConfiguration() }
  }).catch(() => undefined);
}

function p2pWsUrl(slug: string): string {
  const url = new URL(e2eOrigin);
  const protocol = url.protocol === 'https:' ? 'wss' : 'ws';
  return `${protocol}://${url.host}/api/v1/meetings/${slug}/p2p`;
}

/** Collects server frames on a raw socket until the first `welcome`. */
async function connectRawP2p(slug: string, cookie?: string): Promise<{ socket: WebSocket; frames: string[] }> {
  const socket = new WebSocket(p2pWsUrl(slug), { headers: cookie ? { cookie } : undefined });
  const frames: string[] = [];
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('P2P signaling welcome timeout')), 10_000);
    socket.on('message', (raw) => {
      const frame = String(raw);
      frames.push(frame);
      if (JSON.parse(frame).type === 'welcome') {
        clearTimeout(timer);
        resolve();
      }
    });
    socket.on('error', (error) => { clearTimeout(timer); reject(error); });
  });
  return { socket, frames };
}

test.describe('P2P signaling flow (local mode)', () => {
  test('host grant → sharer UI share → real offer/answer/ICE → viewer media → stop cleanup', async ({ browser, page }) => {
    requireE2EConfiguration();
    await recoverStaleMeeting(page);
    await installFakeMedia(page.context());
    const hostFrames = captureSignaling(page);
    const meetingUrl = await createMeeting(page);
    const slug = new URL(meetingUrl).pathname.split('/').pop() ?? '';
    const guest = await joinWithSignalingCapture(browser, meetingUrl, 'Guest');
    try {
      await test.step('host joins and signaling establishes', async () => {
        await joinLocalRoom(page, meetingUrl, 'Host');
        await waitForFrame(page, hostFrames, (frame) => frame.type === 'welcome');
        await expect.poll(() => findPeer(hostFrames, 'Guest')).toBeTruthy();
      });

      await test.step('host grants share to guest', async () => {
        const guestIdentity = findPeer(hostFrames, 'Guest')!.identity;
        // Runs in the browser: the host cookie is Secure, and the node-side
        // request fixture would not send it over plain HTTP to 127.0.0.1.
        const grantStatus = await page.evaluate(async ({ slugValue, identity }) => {
          const response = await fetch(`/api/v1/meetings/${slugValue}/share-grant`, {
            method: 'PUT',
            credentials: 'include',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ participantIdentity: identity })
          });
          return response.status;
        }, { slugValue: slug, identity: guestIdentity });
        expect(grantStatus).toBe(204);
      });

      await test.step('guest starts the share (UI flow)', async () => {
        // The guest must have the host in its P2P roster before sharing, or
        // the share starts over the SFU fallback with no online viewers.
        await expect.poll(() => findPeer(guest.frames, 'Host')).toBeTruthy();

        // The button is gated on the LiveKit connection state, which never
        // reaches `connected` locally, so it is force-enabled for this run.
        // DOM clicks do not reach React's delegation on this page under the
        // harness (the LiveKit retry loop keeps re-rendering the dock), so the
        // React onClick handler is invoked directly.
        const shareButton = guest.page.getByRole('button', { name: 'Share screen' });
        await expect(shareButton).toBeVisible();
        await shareButton.evaluate((element: HTMLButtonElement) => {
          element.disabled = false;
          const reactKey = Object.keys(element).find((key) => key.startsWith('__reactProps'));
          const props = reactKey ? (element as unknown as Record<string, { onClick?: () => void }>)[reactKey] : undefined;
          props?.onClick?.();
        });
        await expect(guest.page.getByRole('button', { name: 'Stop sharing' })).toBeVisible();
      });

      await test.step('signaling wire: offer/answer/ice', async () => {
        await waitForFrame(page, hostFrames, (frame) => frame.type === 'offer');
        await waitForFrame(page, hostFrames, (frame) => frame.type === 'ice');
        await expect.poll(() => parseFrames(hostFrames.sent).some((frame) => frame.type === 'answer')).toBe(true);
        await expect.poll(() => parseFrames(hostFrames.sent).some((frame) => frame.type === 'ice')).toBe(true);
      });

      await test.step('viewer renders and plays P2P media', async () => {
        // Real media: the viewer's P2P stream renders on the host stage (only
        // the `p2p` state shows the P2P stream) and actually plays.
        const stageVideo = page.locator('.screen-stage video');
        await expect(stageVideo).toBeVisible();
        await expect.poll(async () => stageVideo.evaluate((video: HTMLVideoElement) => {
          if (video.readyState < 2) return 'loading';
          return video.currentTime > 0 ? 'playing' : 'ready';
        })).toBe('playing');
      });

      await test.step('sharer stops; viewer cleans up', async () => {
        // The sharer stops → bye → the viewer's session closes and the stage clears.
        // Same LiveKit-gated disabled button as start: invoke the handler directly.
        await guest.page.getByRole('button', { name: 'Stop sharing' }).evaluate((element: HTMLButtonElement) => {
          const reactKey = Object.keys(element).find((key) => key.startsWith('__reactProps'));
          const props = reactKey ? (element as unknown as Record<string, { onClick?: () => void }>)[reactKey] : undefined;
          props?.onClick?.();
        });
        await expect(page.getByText('No screen is being shared.')).toBeVisible();
        await expect(guest.page.getByRole('button', { name: 'Share screen' })).toBeVisible();
        await waitForFrame(page, hostFrames, (frame) => frame.type === 'bye');
      });
    } finally {
      // adminEnd (not the UI End meeting button, which lives inside the
      // collapsed management details) so cleanup cannot hang a failed run.
      await adminEnd(page, slug);
      await guest.context.close();
    }
  });

  test('rejects a P2P signaling upgrade without a participant cookie (401)', async ({ page }) => {
    requireE2EConfiguration();
    await recoverStaleMeeting(page);
    const created = await page.request.post('/api/v1/meetings', {
      headers: { origin: e2eOrigin },
      data: { adminPassword: requireE2EConfiguration(), name: 'P2P 401 check' }
    });
    expect(created.status()).toBe(201);
    const slug = ((await created.json()) as { slug: string }).slug;
    try {
      const status = await new Promise<number>((resolve, reject) => {
        const socket = new WebSocket(p2pWsUrl(slug));
        const timer = setTimeout(() => { socket.terminate(); reject(new Error('no unexpected-response (401) received')); }, 10_000);
        socket.on('unexpected-response', (_request, response) => {
          clearTimeout(timer);
          resolve(response.statusCode ?? 0);
        });
        socket.on('open', () => { clearTimeout(timer); reject(new Error('upgrade unexpectedly succeeded without a cookie')); });
      });
      expect(status).toBe(401);
    } finally {
      await adminEnd(page, slug);
    }
  });

  test('rejects offers from a non-sharer with P2P_FORBIDDEN and never forwards them', async ({ page }) => {
    requireE2EConfiguration();
    await recoverStaleMeeting(page);
    await installFakeMedia(page.context());
    const hostFrames = captureSignaling(page);
    const meetingUrl = await createMeeting(page);
    const slug = new URL(meetingUrl).pathname.split('/').pop() ?? '';
    try {
      await joinLocalRoom(page, meetingUrl, 'Host');
      await waitForFrame(page, hostFrames, (frame) => frame.type === 'welcome');

      // An intruder joins by API (no UI) and opens a raw signaling socket.
      const joined = await page.request.post(`/api/v1/meetings/${slug}/join`, {
        headers: { origin: e2eOrigin },
        data: { nickname: 'Intruder' }
      });
      expect(joined.status()).toBe(200);
      const setCookie = joined.headers()['set-cookie'] ?? '';
      const participantToken = setCookie.split(';')[0].split('=')[1] ?? '';
      expect(participantToken).not.toBe('');

      const { socket, frames } = await connectRawP2p(slug, `wm_participant=${participantToken}`);
      try {
        const parsed = parseFrames(frames);
        const hostIdentity = parsed.find((frame) => frame.type === 'welcome')?.peers?.[0]?.identity;
        expect(hostIdentity).toBeTruthy();

        // The intruder is not the sharer (no grant was made): the offer must be
        // rejected server-side with P2P_FORBIDDEN.
        socket.send(JSON.stringify({ type: 'offer', to: hostIdentity, sdp: 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96' }));
        const forbidden = await new Promise<ParsedFrame | undefined>((resolve) => {
          const timer = setTimeout(() => resolve(undefined), 5_000);
          socket.on('message', (raw) => {
            const frame = JSON.parse(String(raw)) as ParsedFrame;
            if (frame.type === 'error' && frame.code === 'P2P_FORBIDDEN') {
              clearTimeout(timer);
              resolve(frame);
            }
          });
        });
        expect(forbidden?.code).toBe('P2P_FORBIDDEN');

        // And the intended target (the host page's signaling socket) received nothing.
        await page.waitForTimeout(1_500);
        expect(parseFrames(hostFrames.received).filter((frame) => frame.type === 'offer')).toHaveLength(0);
      } finally {
        socket.terminate();
      }
    } finally {
      await adminEnd(page, slug);
    }
  });
});
