import { devices, expect, test, type FrameLocator, type Page } from '@playwright/test';
import fs from 'node:fs';

// The demo build runs the whole app in the page, with sample Kajang shops.
// Here it runs in a sandboxed iframe under a strict Content-Security-Policy,
// with no network and with alert/confirm blocked, the way it is shared.

let problems: string[] = [];

test.beforeEach(async ({ page }) => {
  problems = [];
  // Runs in the iframe too: report anything the browser blocked or that broke.
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) =>
      console.error(`Blocked by CSP: ${e.violatedDirective} ${e.blockedURI}`),
    );
    window.addEventListener('unhandledrejection', (e) => console.error(`Unhandled rejection: ${String(e.reason)}`));
  });
  page.on('console', (msg) => {
    if (msg.type() === 'error') problems.push(msg.text());
  });
  page.on('pageerror', (error) => problems.push(error.message));
  // "Add to calendar" opens Google Calendar; it is answered here so the tests stay offline.
  await page.context().route('https://calendar.google.com/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<title>Google Calendar</title>' }),
  );
});

test.afterEach(() => {
  expect(problems).toEqual([]);
});

async function snap(page: Page, name: string) {
  const dir = process.env.SCREENSHOTS;
  if (!dir) return;
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${dir}/${name}.png` });
}

const button = (app: FrameLocator | Page, name: string | RegExp) =>
  app.getByRole('button', { name, exact: typeof name === 'string' });

async function open(page: Page) {
  await page.goto('/host');
  const app = page.frameLocator('#app');
  await expect(app.getByText('Try it with sample shops in Kajang')).toBeVisible();
  return app;
}

/** Presses an "Add to calendar" button and returns the Google Calendar link it opened in a new tab. */
async function addsToGoogleCalendar(page: Page, press: () => Promise<void>) {
  const [tab] = await Promise.all([page.context().waitForEvent('page'), press()]);
  await tab.waitForLoadState();
  const url = new URL(tab.url());
  await tab.close();
  expect(`${url.origin}${url.pathname}`).toBe('https://calendar.google.com/calendar/render');
  expect(url.searchParams.get('action')).toBe('TEMPLATE');
  expect(url.searchParams.get('dates')).toMatch(/^\d{8}T\d{6}Z\/\d{8}T\d{6}Z$/);
  expect(url.searchParams.get('ctz')).toBe('Asia/Kuala_Lumpur');
  return url.searchParams;
}

test('a customer books a cut, it survives a reload, then cancels it', async ({ page }) => {
  const app = await open(page);
  await snap(page, 'demo-01-welcome');
  await button(app, 'Try as a customer').click();

  await expect(app.getByText('Ali Barber Sungai Chua')).toBeVisible();
  await expect(app.getByText('Kemas Barber Kajang')).toBeVisible();
  await snap(page, 'demo-02-explore');
  await app.getByText('Ali Barber Sungai Chua').click();

  await app.getByRole('radio', { name: /^Haircut RM/ }).click();
  await app.getByRole('radio', { name: /^Tomorrow/ }).click();
  const time = app.getByRole('radio', { name: /^\d{1,2}:\d{2}\s?(am|pm)$/i }).first();
  await expect(time).toBeVisible();
  await time.click();
  await snap(page, 'demo-03-shop');
  await button(app, 'Confirm booking').click();
  await expect(app.getByText('You’re booked!')).toBeVisible();
  await snap(page, 'demo-04-booked');
  // On Android, and in a frame like this one, it opens Google Calendar's add-event page.
  const event = await addsToGoogleCalendar(page, () => button(app, 'Add to calendar').click());
  expect(event.get('text')).toBe('Haircut at Ali Barber Sungai Chua');
  expect(event.get('location')).toBe('No. 12, Jalan Sungai Chua 3/1, 43000 Kajang');
  expect(event.get('details')).toMatch(/^Barber: (Ali|Danial)\nRM20 · Pay at the shop\.\n/);

  await button(app, 'See my bookings').click();
  const booked = app.getByText(/^Haircut with (Ali|Danial) · RM20$/);
  await expect(booked).toBeVisible();
  await expect(app.getByText(/^Skin fade with (Ali|Danial) · RM25$/)).toBeVisible();
  await snap(page, 'demo-05-my-bookings');
  // Each upcoming booking has the button too.
  await expect(button(app, 'Add to calendar')).toHaveCount(2);
  const fromList = await addsToGoogleCalendar(page, () => button(app, 'Add to calendar').last().click());
  expect(fromList.get('text')).toMatch(/^(Haircut|Skin fade) at Ali Barber Sungai Chua$/);

  // Everything is kept in this browser, so a reload changes nothing.
  await page.reload();
  await page.frameLocator('#app').getByRole('tab', { name: /My bookings/ }).click();
  await expect(booked).toBeVisible();

  await button(app, 'Cancel').first().click();
  await expect(app.getByRole('alertdialog')).toBeVisible();
  await expect(app.getByRole('alertdialog').getByText(/Added it to your calendar\? Delete it there too\.$/)).toBeVisible();
  await snap(page, 'demo-06-confirm');
  await app.getByRole('alertdialog').getByRole('button', { name: 'Cancel booking', exact: true }).click();
  await expect(booked).toHaveCount(0);
  await expect(app.getByText('Cancelled', { exact: true }).first()).toBeVisible();
});

test('a customer moves their cut, and can put the new time in their calendar', async ({ page }) => {
  const app = await open(page);
  await button(app, 'Try as a customer').click();
  await app.getByRole('tab', { name: /My bookings/ }).click();
  await expect(app.getByText(/^Skin fade with (Ali|Danial) · RM25$/)).toBeVisible();
  const before = await addsToGoogleCalendar(page, () => button(app, 'Add to calendar').click());

  await button(app, 'Change time').click();
  await expect(app.getByText('Changing your booking')).toBeVisible();
  // The booking's own time is marked as current, so the first plain time is a new one.
  await app.getByRole('radio', { name: /^\d{1,2}:\d{2}\s?(am|pm)$/i }).first().click();
  await button(app, 'Move to this time').click();
  await expect(app.getByText('Booking moved')).toBeVisible();
  await expect(app.getByText('Added it to your calendar before? Delete the old one there.')).toBeVisible();
  await snap(page, 'demo-06b-moved');
  const after = await addsToGoogleCalendar(page, () => button(app, 'Add to calendar').click());
  expect(after.get('text')).toBe('Skin fade at Ali Barber Sungai Chua');
  expect(after.get('dates')).not.toBe(before.get('dates'));
});

test('one tap across to the barber side, and the demo starts over cleanly', async ({ page }) => {
  const app = await open(page);
  await button(app, 'Try as a customer').click();
  await app.getByRole('tab', { name: /Account/ }).click();
  await button(app, 'See the barber side').click();

  await expect(app.getByText('Bookings').first()).toBeVisible();
  await app.getByRole('radio', { name: /^Tomorrow/ }).click();
  await expect(app.getByText('Hakim', { exact: true })).toBeVisible();
  await expect(app.getByText('“Same as last time”')).toBeVisible();
  await snap(page, 'demo-07-barber-day');

  await app.getByRole('tab', { name: /My shop/ }).click();
  await expect(app.getByText('You are live')).toBeVisible();
  await expect(app.getByText(/Free trial: 2\d days left/)).toBeVisible();
  await snap(page, 'demo-08-my-shop');

  // Pause bookings, then start over: the shop is live again.
  await button(app, 'Pause bookings').click();
  await app.getByRole('alertdialog').getByRole('button', { name: 'Pause bookings', exact: true }).click();
  await expect(app.getByText('Not live yet')).toBeVisible();
  await button(app, 'See the customer side').click();
  await expect(app.getByText('Kemas Barber Kajang')).toBeVisible();
  await expect(app.getByText('Ali Barber Sungai Chua')).toHaveCount(0);

  await app.getByRole('tab', { name: /Account/ }).click();
  await button(app, 'Sign out').click();
  await button(app, 'Start the demo again').click();
  await app.getByRole('alertdialog').getByRole('button', { name: 'Start again', exact: true }).click();
  await button(app, 'Try as a customer').click();
  await expect(app.getByText('Ali Barber Sungai Chua')).toBeVisible();
});

test.describe('on an iPhone', () => {
  // Chromium, telling the app it is Safari on an iPhone.
  test.use({ userAgent: devices['iPhone 13'].userAgent });

  test('Add to calendar saves a calendar file, which Safari hands to Apple Calendar', async ({ page }) => {
    // The page on its own, not in a frame: a frame may not be allowed to download, so there it opens Google Calendar.
    await page.goto('/artifact/demo-page/index.html');
    await expect(page.getByText('Try it with sample shops in Kajang')).toBeVisible();
    await button(page, 'Try as a customer').click();
    await expect(page.getByText('Ali Barber Sungai Chua')).toBeVisible();
    await page.getByRole('tab', { name: /My bookings/ }).click();
    await expect(page.getByText(/^Skin fade with (Ali|Danial) · RM25$/)).toBeVisible();

    const [download] = await Promise.all([page.waitForEvent('download'), button(page, 'Add to calendar').click()]);
    expect(download.suggestedFilename()).toBe('skin-fade-at-ali-barber-sungai-chua.ics');
    const ics = fs.readFileSync(await download.path(), 'utf8');
    expect(ics).toMatch(/^BEGIN:VCALENDAR\r\n/);
    expect(ics).toMatch(/\r\nEND:VCALENDAR\r\n$/);
    expect(ics).toContain('\r\nSUMMARY:Skin fade at Ali Barber Sungai Chua\r\n');
    expect(ics).toMatch(/\r\nDTSTART:\d{8}T\d{6}Z\r\nDTEND:\d{8}T\d{6}Z\r\n/);
    expect(ics).toContain('\r\nTRIGGER:-PT1H\r\n');
  });
});
