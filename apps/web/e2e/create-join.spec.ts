import { expect, test } from '@playwright/test';

import { createMeeting, endMeeting, installFakeMedia, joinMeeting, localE2eMode, newParticipant, requireE2EConfiguration } from './helpers.js';

test.describe('meeting capacity and microphone controls', () => {
  test('creates a room, admits five muted people, and rejects the sixth', async ({ browser, page }) => {
    test.skip(localE2eMode, 'requires real LiveKit connection and participant events');
    requireE2EConfiguration();
    await installFakeMedia(page.context());
    const meetingUrl = await createMeeting(page);
    const participants = [];
    try {
      await joinMeeting(page, meetingUrl, 'Host');
      await expect(page.getByText('Host, you, microphone muted')).toBeVisible();
      await page.getByRole('button', { name: 'Unmute microphone' }).click();
      await expect(page.getByText('Host, you, microphone on')).toBeVisible();

      for (const nickname of ['One', 'Two', 'Three', 'Four']) {
        participants.push(await newParticipant(browser, meetingUrl, nickname));
      }
      await expect(page.getByRole('heading', { name: 'Participants (5)' })).toBeVisible();

      const sixth = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36'
      });
      try {
        await installFakeMedia(sixth);
        const sixthPage = await sixth.newPage();
        await sixthPage.goto(meetingUrl);
        await sixthPage.getByLabel('Nickname').fill('Six');
        await sixthPage.getByRole('button', { name: 'Join muted' }).click();
        await expect(sixthPage.getByRole('alert')).toContainText(/full/i);
      } finally {
        await sixth.close();
      }
    } finally {
      await endMeeting(page).catch(() => undefined);
      await Promise.all(participants.map(({ context }) => context.close()));
    }
  });
});
