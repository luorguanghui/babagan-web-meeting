import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test';

export const adminPassword = process.env.E2E_ADMIN_PASSWORD;

export function requireE2EConfiguration(): string {
  if (!adminPassword) throw new Error('E2E_ADMIN_PASSWORD is required; start the Compose test stack and provide its test admin password.');
  return adminPassword;
}

export async function installFakeMedia(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const devices = navigator.mediaDevices;
    if (!devices) return;
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: devices.getUserMedia.bind(devices),
        enumerateDevices: devices.enumerateDevices.bind(devices),
        getDisplayMedia: async () => {
          const canvas = document.createElement('canvas');
          canvas.width = 1920;
          canvas.height = 1080;
          const drawing = canvas.getContext('2d');
          drawing?.fillRect(0, 0, canvas.width, canvas.height);
          return canvas.captureStream(60);
        }
      }
    });
  });
}

export async function createMeeting(page: Page, password = requireE2EConfiguration()): Promise<string> {
  await page.goto('/create');
  await page.getByLabel('Meeting name').fill(`E2E ${Date.now()}`);
  await page.getByLabel('Admin password').fill(password);
  await page.getByRole('button', { name: 'Create meeting' }).click();
  const hostLink = page.getByRole('link', { name: 'Enter as host' });
  await expect(hostLink).toBeVisible();
  const href = await hostLink.getAttribute('href');
  if (!href) throw new Error('Created meeting did not expose a host link.');
  return href;
}

export async function joinMeeting(page: Page, meetingUrl: string, nickname: string): Promise<void> {
  await page.goto(meetingUrl);
  await page.getByLabel('Nickname').fill(nickname);
  await page.getByRole('button', { name: 'Join muted' }).click();
  await expect(page.getByRole('status', { name: /Connection: connected/i })).toBeVisible();
}

export async function newParticipant(browser: Browser, meetingUrl: string, nickname: string): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36'
  });
  await installFakeMedia(context);
  const page = await context.newPage();
  await joinMeeting(page, meetingUrl, nickname);
  return { context, page };
}

export async function endMeeting(page: Page): Promise<void> {
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'End meeting' }).click();
  await expect(page.getByRole('heading', { name: 'Ready when you are' })).toBeVisible();
}
