import { expect, test } from '@playwright/test';

import { createMeeting, endMeeting, installFakeMedia, joinMeeting, localE2eMode, newParticipant, requireE2EConfiguration } from './helpers.js';

test.describe('host controls', () => {
  test('grants sharing, kicks a participant, then terminally redirects everyone', async ({ browser, page }) => {
    test.skip(localE2eMode, 'requires real LiveKit connection and participant events');
    requireE2EConfiguration();
    await installFakeMedia(page.context());
    const meetingUrl = await createMeeting(page);
    const guest = await newParticipant(browser, meetingUrl, 'Guest');
    try {
      await joinMeeting(page, meetingUrl, 'Host');
      await expect(page.getByRole('heading', { name: 'Host controls' })).toBeVisible();
      await page.getByRole('button', { name: 'Grant screen sharing to Guest' }).click();
      await expect(guest.page.getByRole('button', { name: 'Share screen' })).toBeEnabled();

      await page.getByRole('button', { name: 'Kick Guest' }).click();
      await expect(guest.page.getByRole('status', { name: /Connection: disconnected/i })).toBeVisible();

      await endMeeting(page);
      await guest.page.reload();
      await expect(guest.page.getByRole('heading', { name: 'Ready when you are' })).toBeVisible();
    } finally {
      await page.getByRole('button', { name: 'End meeting' }).isVisible().then((visible) => visible && endMeeting(page)).catch(() => undefined);
      await guest.context.close();
    }
  });
});
